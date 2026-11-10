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
import { STAGE_THEMES, type Model, type Node, type ViewportOptions, type MultiViewStageOptions, type ModelViewConfig, type StageThemeId, type StageThemeConfig } from './types.js';
import { CustomDialog } from './custom-dialog.js';

export type GridPreset = '1x1' | '1x2' | '2x1' | '2x2';
export type ViewportViewType = '3D_VIEWPORT' | '2D_CONTOUR' | '1D_CHART' | 'RESOURCE_MONITOR';
export type { StageThemeId, StageThemeConfig };
export { STAGE_THEMES };

interface ViewportPane {
    id: string;
    index: number;
    container: HTMLElement;
    header: HTMLElement;
    content: HTMLElement;
    typeSelect: HTMLSelectElement;
    modelSelect?: HTMLSelectElement;
    viewSelect?: HTMLSelectElement;
    inlineControlsHost?: HTMLElement;
    hudElement?: HTMLElement | null;
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
    private panes: ViewportPane[] = [];
    private maximizedPaneId: string | null = null;
    private focusedPaneId: string | null = null;
    private titleElement: HTMLElement | null = null;
    private stateListener: () => void;
    private inPlaceListener: (nodeId: string, params: Record<string, any>) => void;
    private statusListener: (modelId: string, status: any) => void;

    /** True while the constructor's buildStage() is running. Prevents saveStageOptions
     *  from calling updatePanelOptions synchronously during initialisation, which would
     *  immediately trigger notifyListeners → LayoutManager.render → new WorkspaceManager
     *  → buildStage → saveStageOptions → ... (infinite recursion / CPU spin). */
    private _initializing: boolean = false;

    private stlGeometries: Map<string, Map<string, { vertices: Float32Array | null, meshId: string }>> = new Map();
    private obstacleGeometries: Map<string, { vertices: Float32Array | null, cells: Int32Array | null, meshId: string }> = new Map();
    private windowResizeListener: (() => void) | null = null;
    private themeListener: ((e: any) => void) | null = null;

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
        this.inPlaceListener = (_nodeId: string, _params: Record<string, any>) => {
            this.panes.forEach(pane => {
                if (pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') {
                    this.syncPaneWorkerConfig(pane);
                }
            });
        };
        this.statusListener = (modelId?: string, status?: string) => {
            if (!modelId) return;
            this.panes.forEach(pane => {
                if (pane.modelId === modelId && (pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART')) {
                    if (status === 'UNINITIALIZED' && !this.hasModelBinaryTelemetry(modelId)) {
                        pane.worker?.postMessage({ type: 'clearData' });
                    }
                    this.syncPaneWorkerConfig(pane);
                }
            });
        };
        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.onModelStatusChange(this.statusListener);

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
        // Skip the state mutation entirely while we're still inside the constructor's
        // buildStage() call. The options are already reflected in this.savedOptions (passed
        // in from the persisted layout), so there is nothing new to write yet. Writing here
        // would trigger notifyListeners → LayoutManager.render → new WorkspaceManager →
        // buildStage → saveStageOptions → … causing an infinite synchronous recursion.
        if (this._initializing) return;
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
        if (types.some(t => ['CFDSolver3D', 'MarineHarbourDomain', 'MPMDomain3D', 'FEMDomain3D', 'FSICoupler3D', 'FEMFSICoupler3D', 'Telemetry3DViewport', 'STLGeometry', 'DomainMesh3D'].includes(t))) {
            return '3D_VIEWPORT';
        }
        if (types.some(t => ['CFDSolver2D', 'MPMDomain2D', 'MPMObject2D', 'FSICoupler2D', 'ThePainter', 'TelemetryContour', 'DomainMesh2D', 'Obstacle', 'Charge2D', 'Remap1DTo2DNode'].includes(t))) {
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
                pane.worker.postMessage({ type: 'setConfig', showGridlines: this.showStudioGrid });
            } else if (pane.viewType === '1D_CHART' && pane.worker) {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGrid: this.showStudioGrid };
                pane.worker.postMessage({ type: 'setConfig', showGrid: this.showStudioGrid });
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
            const paneModelId = (this.activePreset === '1x1' || savedPane?.modelId === undefined || !allModels.some(m => m.id === savedPane.modelId))
                ? activeModelId
                : savedPane.modelId;
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
        const paneId = `stage-pane-${index}`;
        paneContainer.id = paneId;
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
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
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
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
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

        const inlineControlsHost = document.createElement('div');
        inlineControlsHost.className = 'stage-pane-inline-controls';
        inlineControlsHost.style.display = 'flex';
        inlineControlsHost.style.alignItems = 'center';
        inlineControlsHost.style.gap = '4px';
        inlineControlsHost.style.flexWrap = 'wrap';
        headerControlsLeft.appendChild(inlineControlsHost);

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
            inlineControlsHost,
            hudElement: null,
            modelId: initialModelId,
            viewId: initialViewId || null,
            viewType: initialViewType,
            instance: null,
            worker: null,
            resizeObserver: null,
            cleanupListeners: null,
            isMaximized: false,
            workerConfigOverrides: {}
        };

        modelSelect.addEventListener('change', () => {
            pane.modelId = modelSelect.value;
            pane.viewId = null;
            this.mountViewInstance(pane);
            this.updatePaneViewSelector(pane);
            this.saveStageOptions();
            if (pane.modelId) {
                this.stateManager.setActiveModel(pane.modelId);
            }
            this.updateStageTitle();
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

    private buildContourConfig(model: Model | null, overrides: Record<string, any> = {}): Record<string, any> {
        const solverNode = model?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D');
        const meshNode = model?.nodes.find(n => n.type === 'DomainMesh2D' || n.type === 'MPMDomain2D' || n.type === 'DomainMesh');
        const contourNode = model?.nodes.find(n => n.type === 'TelemetryContour');
        const chargeNode = model?.nodes.find(n => n.type === 'Charge2D' || n.type === 'Charge1D');
        const detNode = model?.nodes.find(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation');
        const gaugesNode = model?.nodes.find(n => n.type === 'VirtualGauges');

        const max_r = Number(meshNode?.parameters?.max_r ?? meshNode?.parameters?.domain_radius ?? meshNode?.parameters?.domain_width ?? 1.0) || 1.0;
        const max_z = Number(meshNode?.parameters?.max_z ?? meshNode?.parameters?.domain_height ?? max_r) || max_r;
        const cellSize = Number(meshNode?.parameters?.cell_size) || 0.05;
        const calculatedNr = Math.max(8, Math.round(max_r / cellSize) || 128);
        const calculatedNz = Math.max(8, Math.round(max_z / cellSize) || 128);
        const meshType = String(solverNode?.parameters?.mesh_type || 'regular');
        const baseNr = (meshType === 'amr') ? Math.ceil(calculatedNr / 16) * 16 : calculatedNr;
        const baseNz = (meshType === 'amr') ? Math.ceil(calculatedNz / 16) * 16 : calculatedNz;

        const chargeMass = Number(chargeNode?.parameters?.charge_mass ?? 0);
        const chargeShape = String(chargeNode?.parameters?.shape ?? 'Sphere');
        let chargeRadius = Number(chargeNode?.parameters?.explosive_r ?? chargeNode?.parameters?.explosive_radius ?? 0);
        if (chargeMass > 0 && chargeRadius <= 0) {
            const rho0 = 1630.0;
            const vol = chargeMass / rho0;
            chargeRadius = Math.pow((3.0 * vol) / (4.0 * Math.PI), 1.0 / 3.0);
        }
        const chargeHeight = Number(chargeNode?.parameters?.charge_height ?? (chargeRadius * 2.0));
        const chargeZOffset = Number(chargeNode?.parameters?.z_offset ?? chargeNode?.parameters?.center_z ?? (max_z * 0.5));
        const detonatorR = Number(detNode?.parameters?.detonator_r ?? detNode?.parameters?.r ?? 0.0);
        const detonatorZ = Number(detNode?.parameters?.detonator_z ?? detNode?.parameters?.z ?? chargeZOffset);

        const obstacles = (model?.nodes || [])
            .filter(n => n.type === 'Obstacle')
            .map(n => ({
                min_r: Number(n.parameters?.min_r ?? 0),
                max_r: Number(n.parameters?.max_r ?? 0),
                min_z: Number(n.parameters?.min_z ?? 0),
                max_z: Number(n.parameters?.max_z ?? 0),
                label: String(n.parameters?.name || n.id)
            }))
            .filter(o => o.max_r > o.min_r && o.max_z > o.min_z);

        const mpmObjects = (model?.nodes || [])
            .filter(n => n.type === 'MPMObject2D')
            .map(n => ({
                shape: String(n.parameters?.shape ?? 'Box'),
                min_x: Number(n.parameters?.min_x ?? 0),
                max_x: Number(n.parameters?.max_x ?? 0),
                min_y: Number(n.parameters?.min_y ?? 0),
                max_y: Number(n.parameters?.max_y ?? 0),
                center_x: Number(n.parameters?.center_x ?? 0),
                center_y: Number(n.parameters?.center_y ?? 0),
                radius: Number(n.parameters?.radius ?? 0),
                label: String(n.parameters?.name || n.id)
            }));

        const rawGauges = Array.isArray(gaugesNode?.parameters?.gauges)
            ? gaugesNode!.parameters.gauges
            : (Array.isArray(meshNode?.parameters?.gauges) ? meshNode!.parameters.gauges : []);
        const gauges = rawGauges.map((g: any, idx: number) => ({
            id: String(g.id || `G${idx + 1}`),
            r: Number(g.r ?? g.x ?? 0),
            z: Number(g.z ?? g.y ?? 0)
        }));

        const defaultChannel = (model && model.nodes.some(n => n.type === 'MPMDomain2D') && !model.nodes.some(n => n.type === 'CFDSolver2D')) ? 7 : 0;

        return {
            type: 'setConfig',
            channel: Number(overrides.channel ?? contourNode?.parameters?.channel ?? defaultChannel),
            stride: Number(overrides.stride ?? contourNode?.parameters?.stride ?? 1),
            refreshRate: Number(overrides.refreshRate ?? contourNode?.parameters?.refresh_rate ?? 0.0),
            logScale: Boolean(overrides.logScale ?? contourNode?.parameters?.log_scale ?? false),
            autoScale: overrides.autoScale !== undefined ? Boolean(overrides.autoScale) : (contourNode?.parameters?.auto_scale !== false),
            minVal: Number(overrides.minVal ?? contourNode?.parameters?.min_val ?? 0),
            maxVal: Number(overrides.maxVal ?? contourNode?.parameters?.max_val ?? 1000000),
            colormap: String(overrides.colormap ?? contourNode?.parameters?.colormap ?? 'turbo'),
            showColorbar: overrides.showColorbar !== undefined ? Boolean(overrides.showColorbar) : (contourNode?.parameters?.show_colorbar !== false),
            showGridlines: overrides.showGridlines !== undefined ? Boolean(overrides.showGridlines) : Boolean(contourNode?.parameters?.show_gridlines ?? this.showStudioGrid),
            interpolate: overrides.interpolate !== undefined ? Boolean(overrides.interpolate) : Boolean(contourNode?.parameters?.interpolate ?? false),
            isAxisymmetric: meshNode?.parameters?.coordinate_system !== 'Cartesian' && meshNode?.type !== 'MPMDomain2D',
            max_r,
            max_z,
            meshType,
            amrMaxLevels: Math.max(1, Number(solverNode?.parameters?.amr_max_levels ?? 3)),
            baseNr,
            baseNz,
            chargeShape,
            chargeRadius,
            chargeHeight,
            chargeZOffset,
            detonatorR,
            detonatorZ,
            obstacles,
            mpmObjects,
            gauges
        };
    }

    private buildChartConfig(model: Model | null, overrides: Record<string, any> = {}): Record<string, any> {
        const graphNode = model?.nodes.find(n => n.type === 'TelemetryGraph');
        const meshNode = model?.nodes.find(n => n.type === 'DomainMesh');
        const chargeNode = model?.nodes.find(n => n.type === 'Charge1D');
        const detNode = model?.nodes.find(n => n.type === 'DetonatorLocation');
        const gaugesNode = model?.nodes.find(n => n.type === 'VirtualGauges');

        const domainRadius = Number(meshNode?.parameters?.domain_radius ?? 1.0) || 1.0;
        const chargeMass = Number(chargeNode?.parameters?.charge_mass ?? 0);
        let chargeRadius = Number(chargeNode?.parameters?.explosive_radius ?? chargeNode?.parameters?.explosive_r ?? 0);
        if (chargeMass > 0 && chargeRadius <= 0) {
            const rho0 = 1630.0;
            const vol = chargeMass / rho0;
            chargeRadius = Math.pow((3.0 * vol) / (4.0 * Math.PI), 1.0 / 3.0);
        }
        const detonatorR = Number(detNode?.parameters?.detonator_r ?? detNode?.parameters?.r ?? 0);

        const rawGauges = Array.isArray(gaugesNode?.parameters?.gauges)
            ? gaugesNode!.parameters.gauges
            : (Array.isArray(meshNode?.parameters?.gauges) ? meshNode!.parameters.gauges : []);
        const gauges = rawGauges.map((g: any, idx: number) => ({
            id: String(g.id || `G${idx + 1}`),
            r: Number(g.r ?? g.x ?? 0)
        }));

        return {
            type: 'setConfig',
            channel: Number(overrides.channel ?? graphNode?.parameters?.channel ?? 0),
            color: String(overrides.color ?? graphNode?.parameters?.color ?? '#38bdf8'),
            autoScaleY: overrides.autoScaleY !== undefined ? Boolean(overrides.autoScaleY) : (graphNode?.parameters?.auto_scale_y !== false),
            min: Number(overrides.min ?? graphNode?.parameters?.min_y ?? 0),
            max: Number(overrides.max ?? graphNode?.parameters?.max_y ?? 1000000),
            showGrid: overrides.showGrid !== undefined ? Boolean(overrides.showGrid) : (graphNode?.parameters?.show_grid !== false),
            showAxes: true,
            xAxisMode: 'radius',
            domainRadius,
            chargeRadius,
            detonatorR,
            gauges
        };
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
            const channelNames = ['Pressure (Pa)', 'Density (kg/m³)', 'Radial Vel u_r (m/s)', 'Axial Vel u_z (m/s)', 'Internal Energy (J/kg)', 'Phase α₁', 'Phase α₂', 'MPM von Mises (Pa)', 'MPM Plastic Strain'];
            if (pane.hudElement) {
                pane.hudElement.textContent = `2D Contour • ${channelNames[cfg.channel] || 'Pressure'} • ${String(cfg.colormap).toUpperCase()}${cfg.meshType === 'amr' ? ' • AMR' : ''}`;
            }
        } else if (pane.viewType === '1D_CHART') {
            const cfg = this.buildChartConfig(model, pane.workerConfigOverrides || {});
            pane.worker.postMessage(cfg);
            const channelNames = ['Pressure (Pa)', 'Density (kg/m³)', 'Velocity u_r (m/s)', 'Internal Energy (J/kg)', 'Phase α₁'];
            if (pane.hudElement) {
                pane.hudElement.textContent = `1D Radial Profile • ${channelNames[cfg.channel] || 'Pressure'} • R_max=${cfg.domainRadius}m`;
            }
        }
    }

    private populateInlinePaneControls(pane: ViewportPane, model: Model | null): void {
        if (!pane.inlineControlsHost) return;
        pane.inlineControlsHost.innerHTML = '';

        const makeSelect = (options: { value: string; label: string }[], currentVal: string, title: string, onChange: (val: string) => void) => {
            const sel = document.createElement('select');
            sel.className = 'stage-pane-type-select';
            sel.title = title;
            sel.style.background = '#141822';
            sel.style.color = '#e2e8f0';
            sel.style.border = '1px solid rgba(255, 255, 255, 0.14)';
            sel.style.borderRadius = '4px';
            sel.style.padding = '2px 5px';
            sel.style.fontSize = '10px';
            sel.style.cursor = 'pointer';
            options.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label;
                if (o.value === currentVal) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => onChange(sel.value));
            return sel;
        };

        const makeToggleBtn = (label: string, title: string, active: boolean, onClick: (next: boolean) => void) => {
            let state = active;
            const btn = document.createElement('button');
            btn.className = 'stage-pane-tool-btn';
            btn.textContent = label;
            btn.title = title;
            btn.style.fontSize = '10px';
            btn.style.padding = '2px 6px';
            const applyStyle = () => {
                btn.style.background = state ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.04)';
                btn.style.color = state ? '#38bdf8' : '#94a3b8';
                btn.style.borderColor = state ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.1)';
            };
            applyStyle();
            btn.addEventListener('click', () => {
                state = !state;
                applyStyle();
                onClick(state);
            });
            return btn;
        };

        if (pane.viewType === '2D_CONTOUR') {
            const cfg = this.buildContourConfig(model, pane.workerConfigOverrides || {});
            const channelSel = makeSelect([
                { value: '0', label: '🌡️ Pressure' },
                { value: '1', label: '🧱 Density' },
                { value: '2', label: '💨 Vel u_r / |u|' },
                { value: '3', label: '⬆️ Vel u_z' },
                { value: '4', label: '⚡ Int. Energy' },
                { value: '5', label: '🧪 Phase α₁' },
                { value: '6', label: '💧 Phase α₂' },
                { value: '7', label: '🔩 MPM von Mises' },
                { value: '8', label: '🔧 MPM Plastic ε_p' }
            ], String(cfg.channel), 'Select 2D Contour Field', (val) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: Number(val) };
                this.syncPaneWorkerConfig(pane);
            });

            const cmapSel = makeSelect([
                { value: 'turbo', label: '🎨 Turbo' },
                { value: 'viridis', label: '🎨 Viridis' },
                { value: 'inferno', label: '🎨 Inferno' },
                { value: 'plasma', label: '🎨 Plasma' },
                { value: 'magma', label: '🎨 Magma' },
                { value: 'coolwarm', label: '🎨 CoolWarm' },
                { value: 'rainbow', label: '🎨 Rainbow' },
                { value: 'jet', label: '🎨 Jet' },
                { value: 'grayscale', label: '🎨 Grayscale' }
            ], String(cfg.colormap), 'Select Colormap', (val) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), colormap: val };
                this.syncPaneWorkerConfig(pane);
            });

            const autoBtn = makeToggleBtn('Auto', 'Toggle Auto-Scale Color Range', Boolean(cfg.autoScale), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), autoScale: next };
                this.syncPaneWorkerConfig(pane);
            });

            const logBtn = makeToggleBtn('Log', 'Toggle Logarithmic Scale', Boolean(cfg.logScale), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), logScale: next };
                this.syncPaneWorkerConfig(pane);
            });

            const gridBtn = makeToggleBtn('Grid', 'Toggle 2D Mesh / AMR Tile Gridlines', Boolean(cfg.showGridlines), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGridlines: next };
                this.syncPaneWorkerConfig(pane);
            });

            const interpBtn = makeToggleBtn('Smooth', 'Toggle Bilinear Interpolation', Boolean(cfg.interpolate), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), interpolate: next };
                this.syncPaneWorkerConfig(pane);
            });

            const resetBtn = document.createElement('button');
            resetBtn.className = 'stage-pane-tool-btn';
            resetBtn.textContent = '⟲';
            resetBtn.title = 'Reset 2D Pan & Zoom';
            resetBtn.style.fontSize = '11px';
            resetBtn.style.padding = '2px 6px';
            resetBtn.addEventListener('click', () => {
                pane.worker?.postMessage({ type: 'resetView' });
            });

            pane.inlineControlsHost.appendChild(channelSel);
            pane.inlineControlsHost.appendChild(cmapSel);
            pane.inlineControlsHost.appendChild(autoBtn);
            pane.inlineControlsHost.appendChild(logBtn);
            pane.inlineControlsHost.appendChild(gridBtn);
            pane.inlineControlsHost.appendChild(interpBtn);
            pane.inlineControlsHost.appendChild(resetBtn);
        } else if (pane.viewType === '1D_CHART') {
            const cfg = this.buildChartConfig(model, pane.workerConfigOverrides || {});
            const channelSel = makeSelect([
                { value: '0', label: '📈 Pressure (Pa)' },
                { value: '1', label: '🧱 Density (kg/m³)' },
                { value: '2', label: '💨 Velocity u_r (m/s)' },
                { value: '3', label: '⚡ Int. Energy (J/kg)' },
                { value: '4', label: '🧪 Phase α₁' }
            ], String(cfg.channel), 'Select 1D Radial Profile Channel', (val) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: Number(val) };
                this.syncPaneWorkerConfig(pane);
            });

            const autoBtn = makeToggleBtn('Auto Y', 'Toggle Auto-Scale Y Axis', Boolean(cfg.autoScaleY), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), autoScaleY: next };
                this.syncPaneWorkerConfig(pane);
            });

            const gridBtn = makeToggleBtn('Grid', 'Toggle Chart Gridlines', Boolean(cfg.showGrid), (next) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGrid: next };
                this.syncPaneWorkerConfig(pane);
            });

            const resetBtn = document.createElement('button');
            resetBtn.className = 'stage-pane-tool-btn';
            resetBtn.textContent = '⟲';
            resetBtn.title = 'Reset 1D Chart Zoom';
            resetBtn.style.fontSize = '11px';
            resetBtn.style.padding = '2px 6px';
            resetBtn.addEventListener('click', () => {
                pane.worker?.postMessage({ type: 'resetView' });
            });

            pane.inlineControlsHost.appendChild(channelSel);
            pane.inlineControlsHost.appendChild(autoBtn);
            pane.inlineControlsHost.appendChild(gridBtn);
            pane.inlineControlsHost.appendChild(resetBtn);
        }
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
        } else if (pane.viewType === '1D_CHART') {
            this.mountChartView(pane, targetModel);
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
        pane.hudElement = hud;

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

        this.populateInlinePaneControls(pane, model);
        this.syncPaneWorkerConfig(pane);

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

        // Send cached telemetry if available (single dispatch)
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
        hud.textContent = '1D Radial Profile View';
        host.appendChild(hud);
        pane.hudElement = hud;

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

        this.populateInlinePaneControls(pane, model);
        this.syncPaneWorkerConfig(pane);

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

        const cached = this.getCachedModelBinaryTelemetry(model);
        if (cached) {
            const copy = cached.slice(0);
            worker.postMessage(copy, [copy]);
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
     * Update telemetry domain bounds and configurations on active 3D viewports.
     */
    public updateTelemetry(data: any, modelId?: string): void {
        this.panes.forEach(pane => {
            if (modelId && pane.modelId && modelId !== pane.modelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance && typeof pane.instance.updateTelemetry === 'function') {
                pane.instance.updateTelemetry(data, modelId);
            }
        });
    }

    public setFocusedPane(paneId: string): void {
        this.focusedPaneId = paneId;
        this.panes.forEach(p => {
            if (p.id === paneId) {
                p.container.style.boxShadow = 'inset 0 0 0 2px #00adff';
                if (p.modelId && p.modelId !== this.stateManager.getActiveWorkspace()?.activeModelId) {
                    this.stateManager.setActiveModel(p.modelId);
                }
            } else {
                p.container.style.boxShadow = 'none';
            }
        });
    }

    public getTargetPanes(): ViewportPane[] {
        if (this.focusedPaneId) {
            const focused = this.panes.find(p => p.id === this.focusedPaneId);
            if (focused && focused.viewType === '3D_VIEWPORT' && focused.instance) {
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
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') && pane.worker && preset === 'reset') {
                pane.worker.postMessage({ type: 'resetView' });
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
                    ...(min !== undefined ? { minVal: min } : {}),
                    ...(max !== undefined ? { maxVal: max } : {})
                };
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
                    'density': 1,
                    'velocity': 2,
                    'ur': 2,
                    'uz': 3,
                    'energy': 4,
                    'alpha1': 5,
                    'species1': 5,
                    'alpha2': 6,
                    'species2': 6,
                    'vonmises': 7,
                    'von_mises': 7,
                    'plasticstrain': 8,
                    'plastic_strain': 8,
                    'damage': 8
                };
                const ch = channelMap[quantity.toLowerCase()] ?? 0;
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: ch };
                this.syncPaneWorkerConfig(pane);
            } else if (pane.viewType === '1D_CHART' && pane.worker) {
                const channelMap1D: Record<string, number> = {
                    'pressure': 0,
                    'density': 1,
                    'velocity': 2,
                    'ur': 2,
                    'energy': 3,
                    'alpha1': 4,
                    'species1': 4
                };
                const ch = channelMap1D[quantity.toLowerCase()] ?? 0;
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: ch };
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
                if (layer === 'grid' || layer === 'slices') {
                    pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGridlines: active };
                    this.syncPaneWorkerConfig(pane);
                }
            } else if (pane.viewType === '1D_CHART' && pane.worker) {
                if (layer === 'grid') {
                    pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGrid: active };
                    this.syncPaneWorkerConfig(pane);
                }
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
     * Set shading config on all active viewports (3D, 2D Contour, and 1D Chart).
     */
    public setShadingConfig(config: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setShadingConfig?.(config);
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker && config) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                if (config.autoScale !== undefined) overrides.autoScale = Boolean(config.autoScale);
                if (config.minVal !== undefined) overrides.minVal = Number(config.minVal);
                if (config.maxVal !== undefined) overrides.maxVal = Number(config.maxVal);
                if (config.logScale !== undefined) overrides.logScale = Boolean(config.logScale);
                if (config.showColorbar !== undefined) overrides.showColorbar = Boolean(config.showColorbar);
                if (config.showMeshLines !== undefined) overrides.showGridlines = Boolean(config.showMeshLines);
                if (config.interpolate !== undefined) overrides.interpolate = Boolean(config.interpolate);
                pane.workerConfigOverrides = overrides;
                this.syncPaneWorkerConfig(pane);
            } else if (pane.viewType === '1D_CHART' && pane.worker && config) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                if (config.autoScale !== undefined) overrides.autoScaleY = Boolean(config.autoScale);
                if (config.minVal !== undefined) overrides.min = Number(config.minVal);
                if (config.maxVal !== undefined) overrides.max = Number(config.maxVal);
                if (config.showMeshLines !== undefined) overrides.showGrid = Boolean(config.showMeshLines);
                pane.workerConfigOverrides = overrides;
                this.syncPaneWorkerConfig(pane);
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
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') && pane.worker) {
                pane.worker.postMessage({ type: 'clearData' });
                this.syncPaneWorkerConfig(pane);
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
                    if (pane.viewType !== smartType && pane.viewType !== 'RESOURCE_MONITOR') {
                        pane.viewType = smartType;
                        pane.typeSelect.value = smartType;
                        this.mountViewInstance(pane);
                        this.saveStageOptions();
                    }
                }
            }
            this.syncPaneWorkerConfig(pane);
            this.updatePaneModelSelector(pane);
            this.updatePaneViewSelector(pane);
        });
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
        if (this.themeListener) {
            window.removeEventListener('blastdemon-theme-change', this.themeListener);
            this.themeListener = null;
        }
        if (this.windowResizeListener) {
            window.removeEventListener('resize', this.windowResizeListener);
            this.windowResizeListener = null;
        }
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.offModelStatusChange(this.statusListener);
        this.panes.forEach(p => this.destroyPaneInstance(p));
        this.panes = [];
        this.stlGeometries.clear();
        this.obstacleGeometries.clear();
        this.container.innerHTML = '';
    }
}
