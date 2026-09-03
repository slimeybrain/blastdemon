/**
 * BlastDaemon PipelineBrowser
 * ParaView-style hierarchical pipeline tree managing multi-physics models,
 * parent-child entity nesting, visibility toggles, filter pipelines, and execution.
 */

import { StateManager, prepareModelSavePayload, getSliceAxisLabel } from './state-manager.js';
import { Model, Node, NodeType, SimulationStatus } from './types.js';
import { PlatformBridge } from './PlatformBridge.js';
import { CustomDialog } from './custom-dialog.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { GaugeManagerModal } from './gauge-manager-modal.js';

interface EntityCategory {
    id: string;
    label: string;
    icon: string;
    color: string;
    types: NodeType[];
}

const CATEGORIES: EntityCategory[] = [
    {
        id: 'domain_mesh',
        label: 'Domain & Grid Meshes',
        icon: '📐',
        color: '#4fc3f7',
        types: ['DomainMesh', 'DomainMesh2D', 'DomainMesh3D', 'RefinementMesh3D']
    },
    {
        id: 'materials',
        label: 'Materials & Equations of State',
        icon: '🧪',
        color: '#81c784',
        types: ['Material', 'MPMMaterialSteel' as any, 'MPMMaterial' as any]
    },
    {
        id: 'charges',
        label: 'Charges & Detonators',
        icon: '💥',
        color: '#ff8a65',
        types: ['Charge1D', 'Charge2D', 'Charge3D', 'DetonatorLocation', 'DetonatorLocation3D']
    },
    {
        id: 'solvers',
        label: 'Physics Solvers & Kernels',
        icon: '⚡',
        color: '#ba68c8',
        types: ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MPMDomain2D', 'MPMDomain3D', 'FEMDomain3D']
    },
    {
        id: 'geometry',
        label: 'Geometry & Obstacles',
        icon: '🧊',
        color: '#80deea',
        types: ['STLGeometry', 'PrimitiveGeometry3D']
    },
    {
        id: 'structures',
        label: 'Structural Bodies & Parts',
        icon: '🏗️',
        color: '#ffd54f',
        types: ['MPMObject2D', 'MPMObject3D', 'FEMObject3D', 'LSDynaImporter3D']
    },
    {
        id: 'couplers',
        label: 'Multiphysics Couplers',
        icon: '🔗',
        color: '#ce93d8',
        types: ['FSICoupler2D', 'FSICoupler3D', 'FEMFSICoupler3D']
    },
    {
        id: 'remap',
        label: 'Remap & Initial State',
        icon: '🔄',
        color: '#a1887f',
        types: ['RemapNode', 'Remap1DTo2DNode', 'Remap1DTo3DNode', 'Remap2DTo3DNode', 'ThePainter']
    },
    {
        id: 'sinks',
        label: 'Telemetry, Viewports & Sinks',
        icon: '📊',
        color: '#4db6ac',
        types: ['Telemetry3DViewport', 'TelemetryContour', 'TelemetryGraph', 'TelemetryText', 'VirtualGauges', 'VTKOutput', 'HardwareConfig']
    }
];

const EYE_OPEN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

const PIPELINE_VIEW_MODE_KEY = 'blast_pipeline_view_mode';
const PIPELINE_COLLAPSED_CATS_KEY = 'blast_pipeline_collapsed_categories';
const PIPELINE_COLLAPSED_MODELS_KEY = 'blast_pipeline_collapsed_models';
const PIPELINE_COLLAPSED_GROUPS_KEY = 'blast_pipeline_collapsed_groups';
const PIPELINE_ACTIVE_MODEL_KEY = 'blast_pipeline_active_model_id';

export interface PipelineHierarchyGroup {
    id: string;
    name: string;
    isMultiModel: boolean;
    models: Model[];
    remapLinks: Map<string, { sourceModel: Model; remapType: string }>;
}

export class PipelineBrowser {
    private container: HTMLElement;
    private stateManager: StateManager;
    private rootElement!: HTMLElement;
    private collapsedCategories: Set<string> = new Set();
    private collapsedModels: Set<string> = new Set();
    private collapsedPipelineGroups: Set<string> = new Set();
    private viewMode: 'ALL_MODELS' | 'FOCUSED_ONLY' = 'ALL_MODELS';
    private activeModelId: string | null = null;
    public selectedGaugeIndex: number | null = null;
    private stateListener: () => void;
    private selectionListener: (nodeId: string | null) => void;
    private sliceSelectionListener: (sliceIdx: number | null) => void;
    private gaugeSelectionListener: (gaugeIdx: number | null) => void;
    private modelStatusListener: (modelId: string, status: SimulationStatus) => void;

    // Optional callbacks
    private onSimCommand?: (cmd: string, modelId: string) => void;
    private renderRafId: number | null = null;

    constructor(
        container: HTMLElement | string,
        stateManager: StateManager,
        options: { onSimCommand?: (cmd: string, modelId: string) => void } = {}
    ) {
        if (typeof container === 'string') {
            const el = document.getElementById(container);
            if (!el) throw new Error(`[PipelineBrowser] Container #${container} not found`);
            this.container = el;
        } else {
            this.container = container;
        }

        this.stateManager = stateManager;
        this.onSimCommand = options.onSimCommand;

        this.loadSettings();

        this.stateListener = () => {
            if (this.renderRafId !== null) return;
            this.renderRafId = requestAnimationFrame(() => {
                this.renderRafId = null;
                this.render();
            });
        };
        this.selectionListener = (nodeId: string | null) => {
            if (this.stateManager.selectedNodeId === null) {
                this.selectedGaugeIndex = null;
            }
            this.handleSelectionChange(nodeId, null, null);
        };
        this.sliceSelectionListener = (sliceIdx: number | null) => {
            if (sliceIdx !== null) {
                this.selectedGaugeIndex = null;
            }
            const nodeId = this.stateManager.selectedNodeId;
            this.handleSelectionChange(nodeId, sliceIdx, null);
        };
        this.gaugeSelectionListener = (gaugeIdx: number | null) => {
            if (gaugeIdx !== null) {
                this.stateManager.setSelectedSliceIndex(null);
            }
            this.selectedGaugeIndex = gaugeIdx;
            const nodeId = this.stateManager.selectedNodeId;
            this.handleSelectionChange(nodeId, null, gaugeIdx);
        };
        this.modelStatusListener = () => this.renderHeader();

        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onSelectionChange(this.selectionListener);
        this.stateManager.onSliceSelectionChange(this.sliceSelectionListener);
        this.stateManager.onGaugeSelectionChange(this.gaugeSelectionListener);
        this.stateManager.onModelStatusChange(this.modelStatusListener);

        this.buildBaseUI();
        this.render();
    }

    private loadSettings(): void {
        try {
            const savedViewMode = localStorage.getItem(PIPELINE_VIEW_MODE_KEY);
            if (savedViewMode === 'ALL_MODELS' || savedViewMode === 'FOCUSED_ONLY') {
                this.viewMode = savedViewMode;
            }

            const savedCats = localStorage.getItem(PIPELINE_COLLAPSED_CATS_KEY);
            if (savedCats) {
                const parsed = JSON.parse(savedCats);
                if (Array.isArray(parsed)) {
                    this.collapsedCategories = new Set(parsed);
                }
            }

            const savedModels = localStorage.getItem(PIPELINE_COLLAPSED_MODELS_KEY);
            if (savedModels) {
                const parsed = JSON.parse(savedModels);
                if (Array.isArray(parsed)) {
                    this.collapsedModels = new Set(parsed);
                }
            }

            const savedGroups = localStorage.getItem(PIPELINE_COLLAPSED_GROUPS_KEY);
            if (savedGroups) {
                const parsed = JSON.parse(savedGroups);
                if (Array.isArray(parsed)) {
                    this.collapsedPipelineGroups = new Set(parsed);
                }
            }

            const savedActiveModel = localStorage.getItem(PIPELINE_ACTIVE_MODEL_KEY);
            if (savedActiveModel) {
                this.activeModelId = savedActiveModel;
            }
        } catch (e) {
            console.warn('[PipelineBrowser] Failed to load settings from localStorage:', e);
        }
    }

    private saveSettings(): void {
        try {
            localStorage.setItem(PIPELINE_VIEW_MODE_KEY, this.viewMode);
            localStorage.setItem(PIPELINE_COLLAPSED_CATS_KEY, JSON.stringify(Array.from(this.collapsedCategories)));
            localStorage.setItem(PIPELINE_COLLAPSED_MODELS_KEY, JSON.stringify(Array.from(this.collapsedModels)));
            localStorage.setItem(PIPELINE_COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(this.collapsedPipelineGroups)));
            if (this.activeModelId) {
                localStorage.setItem(PIPELINE_ACTIVE_MODEL_KEY, this.activeModelId);
            }
        } catch (e) {
            console.warn('[PipelineBrowser] Failed to save settings to localStorage:', e);
        }
    }

    private buildBaseUI(): void {
        this.container.innerHTML = '';
        this.rootElement = document.createElement('div');
        this.rootElement.className = 'pipeline-browser';
        this.rootElement.tabIndex = 0; // Enable keyboard focus
        this.container.appendChild(this.rootElement);

        this.rootElement.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.selectedGaugeIndex = null;
                this.stateManager.setSelectedSliceIndex(null);
                this.stateManager.setSelectedNode(null);
                this.updateSelectionHighlight();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
                e.preventDefault();
                const visibleItems = Array.from(this.rootElement.querySelectorAll('.pipeline-node-item')) as HTMLElement[];
                if (visibleItems.length === 0) return;
                const currentIdx = visibleItems.findIndex(el => el.classList.contains('selected'));
                let nextIdx = 0;
                if (e.key === 'ArrowDown') {
                    nextIdx = currentIdx === -1 ? 0 : Math.min(visibleItems.length - 1, currentIdx + 1);
                } else {
                    nextIdx = currentIdx === -1 ? visibleItems.length - 1 : Math.max(0, currentIdx - 1);
                }
                const target = visibleItems[nextIdx];
                if (target) {
                    target.click();
                    this.ensureElementInView(target, true);
                }
                return;
            }
            if (e.key === 'F2') {
                const selectedId = this.stateManager.selectedNodeId;
                const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
                const selectedGaugeIdx = this.selectedGaugeIndex;
                const models = this.stateManager.getWorkspaceModels();
                const activeModel = models.find(m => m.id === this.activeModelId) || models[0];

                if (selectedId && activeModel) {
                    const node = activeModel.nodes.find((n: Node) => n.id === selectedId);
                    if (node) {
                        // 1. Check if a slice plane is selected
                        if (selectedSliceIdx !== null && node.parameters?.slices?.[selectedSliceIdx]) {
                            const sliceEl = this.rootElement.querySelector(`[data-node-id="${selectedId}"][data-slice-index="${selectedSliceIdx}"] .pipeline-node-label`) as HTMLElement;
                            if (sliceEl) {
                                e.preventDefault();
                                this.startInPlaceSliceRename(node, selectedSliceIdx, node.parameters.slices[selectedSliceIdx], sliceEl);
                                return;
                            }
                        }

                        // 2. Check if a virtual gauge probe is selected
                        if (selectedGaugeIdx !== null && node.parameters?.gauges?.[selectedGaugeIdx]) {
                            const gaugeEl = this.rootElement.querySelector(`[data-node-id="${selectedId}"][data-gauge-index="${selectedGaugeIdx}"] .pipeline-node-label`) as HTMLElement;
                            if (gaugeEl) {
                                e.preventDefault();
                                this.startInPlaceGaugeRename(node, selectedGaugeIdx, node.parameters.gauges[selectedGaugeIdx], gaugeEl);
                                return;
                            }
                        }

                        // 3. Regular node entity
                        const labelEl = this.rootElement.querySelector(`[data-node-id="${selectedId}"]:not([data-slice-index]):not([data-gauge-index]) .pipeline-node-label`) as HTMLElement;
                        if (labelEl) {
                            e.preventDefault();
                            this.startInPlaceRename(node, labelEl);
                            return;
                        }
                    }
                }

                // 4. Model rename fallback
                const modelNameEl = this.rootElement.querySelector(`[data-model-id="${activeModel?.id}"] .pipeline-model-name`) as HTMLElement;
                if (modelNameEl && activeModel) {
                    e.preventDefault();
                    this.startModelRename(activeModel, modelNameEl);
                    return;
                }

                const modelSelectEl = this.rootElement.querySelector('.pipeline-model-select') as HTMLElement;
                if (activeModel && modelSelectEl) {
                    e.preventDefault();
                    this.startModelRename(activeModel, modelSelectEl);
                }
            }
        });
    }

    public attachTo(container: HTMLElement): void {
        this.container = container;
        if (!this.container.contains(this.rootElement)) {
            this.container.innerHTML = '';
            this.container.appendChild(this.rootElement);
        }
        this.render();
    }

    public render(options: { scrollSelectedIntoView?: boolean; targetScrollTop?: number } = {}): void {
        const existingTree = this.rootElement.querySelector('.pipeline-tree-container') as HTMLElement;
        const savedScrollTop = options.targetScrollTop !== undefined
            ? options.targetScrollTop
            : (existingTree ? existingTree.scrollTop : 0);

        const activeWs = this.stateManager.getActiveWorkspace();
        const models = this.stateManager.getWorkspaceModels();

        if (models.length === 0) {
            this.rootElement.innerHTML = '';
            const header = this.createEmptyHeader();
            this.rootElement.appendChild(header);
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'pipeline-empty';
            emptyMsg.innerHTML = `<div style="padding: 24px 16px; text-align: center; color: #888; font-size: 11px;">
                <div style="margin-bottom: 10px;">No models in this workspace.</div>
                <button class="header-button primary" id="btn-empty-add-model" style="padding: 5px 12px; font-size: 11px; cursor: pointer; background: #007acc; color: #fff; border: 1px solid #0098ff; border-radius: 4px;">➕ Create New Model</button>
            </div>`;
            this.rootElement.appendChild(emptyMsg);
            emptyMsg.querySelector('#btn-empty-add-model')?.addEventListener('click', () => {
                this.createNewModel();
            });
            return;
        }

        // Determine active model from stateManager or saved settings
        let currentModelId = this.activeModelId;
        if (activeWs?.activeModelId && models.some(m => m.id === activeWs.activeModelId)) {
            currentModelId = activeWs.activeModelId;
        } else if (!currentModelId || !models.some(m => m.id === currentModelId)) {
            currentModelId = models[0].id;
        }

        this.activeModelId = currentModelId;
        if (activeWs && activeWs.activeModelId !== this.activeModelId) {
            this.stateManager.setActiveModel(this.activeModelId);
        }
        this.saveSettings();

        const model = models.find(m => m.id === this.activeModelId) || models[0];

        this.rootElement.innerHTML = '';

        // 1. Pipeline Header & Model Selector
        const header = this.createHeader(model, models);
        this.rootElement.appendChild(header);

        // 2. Action Toolbar (+ Add Entity, Delete, Run Pipeline, View Mode)
        const toolbar = this.createToolbar(model, models);
        this.rootElement.appendChild(toolbar);

        // 3. Tree View Container
        const treeContainer = document.createElement('div');
        treeContainer.className = 'pipeline-tree-container';

        const groups = this.buildPipelineGroups(models);

        if (this.viewMode === 'ALL_MODELS' || groups.some(g => g.isMultiModel)) {
            // Render pipeline groups (multi-model remap pipelines and standalone models)
            groups.forEach(group => {
                if (group.isMultiModel) {
                    const groupCard = this.createPipelineGroupCard(group, models);
                    treeContainer.appendChild(groupCard);
                } else if (this.viewMode === 'ALL_MODELS' || group.models.some(m => m.id === this.activeModelId)) {
                    const card = this.createModelCard(group.models[0], models);
                    treeContainer.appendChild(card);
                }
            });
        } else {
            // Render focused model categories (single model workspace with no remap)
            for (const cat of CATEGORIES) {
                const catNodes = model.nodes.filter(n => cat.types.includes(n.type));
                if (catNodes.length > 0) {
                    const catGroup = this.createCategoryGroup(cat, catNodes, model);
                    treeContainer.appendChild(catGroup);
                }
            }

            // Uncategorized fallback
            const categorizedTypes = new Set(CATEGORIES.flatMap(c => c.types));
            const uncategorizedNodes = model.nodes.filter(n => !categorizedTypes.has(n.type));
            if (uncategorizedNodes.length > 0) {
                const fallbackCat: EntityCategory = {
                    id: 'other',
                    label: 'Other Components',
                    icon: '📦',
                    color: '#90a4ae',
                    types: []
                };
                const catGroup = this.createCategoryGroup(fallbackCat, uncategorizedNodes, model);
                treeContainer.appendChild(catGroup);
            }
        }

        treeContainer.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (
                target === treeContainer ||
                target.classList.contains('pipeline-tree-container') ||
                target.classList.contains('pipeline-model-body') ||
                target.classList.contains('pipeline-node-list') ||
                target.classList.contains('pipeline-child-list')
            ) {
                this.selectedGaugeIndex = null;
                this.stateManager.setSelectedSliceIndex(null);
                this.stateManager.setSelectedNode(null);
                this.updateSelectionHighlight();
            }
        });

        treeContainer.addEventListener('contextmenu', (e) => {
            const target = e.target as HTMLElement;
            if (
                target === treeContainer ||
                target.classList.contains('pipeline-tree-container') ||
                target.classList.contains('pipeline-model-body') ||
                target.classList.contains('pipeline-node-list') ||
                target.classList.contains('pipeline-child-list')
            ) {
                e.preventDefault();
                this.showBackgroundContextMenu(e, model);
            }
        });

        this.rootElement.appendChild(treeContainer);

        // Restore scroll position
        if (savedScrollTop > 0) {
            treeContainer.scrollTop = savedScrollTop;
            requestAnimationFrame(() => {
                if (treeContainer) {
                    treeContainer.scrollTop = savedScrollTop;
                }
            });
        }

        this.updateSelectionHighlight(options.scrollSelectedIntoView ?? false);
    }

    private renderHeader(): void {
        const headerEl = this.rootElement.querySelector('.pipeline-header');
        if (headerEl) {
            const models = this.stateManager.getWorkspaceModels();
            if (models.length === 0) {
                const newHeader = this.createEmptyHeader();
                headerEl.replaceWith(newHeader);
            } else {
                const model = models.find(m => m.id === this.activeModelId) || models[0];
                if (model) {
                    const newHeader = this.createHeader(model, models);
                    headerEl.replaceWith(newHeader);
                }
            }
        }
    }

    private createEmptyHeader(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'pipeline-header';

        const titleRow = document.createElement('div');
        titleRow.className = 'pipeline-title-row';

        const title = document.createElement('span');
        title.className = 'pipeline-title';
        title.innerHTML = `<strong>Pipeline Browser</strong>`;

        titleRow.appendChild(title);
        header.appendChild(titleRow);

        // Workspace Controls Row
        const wsRow = document.createElement('div');
        wsRow.className = 'pipeline-ws-row';

        const wsLabel = document.createElement('span');
        wsLabel.className = 'pipeline-ws-label';
        wsLabel.textContent = 'Workspace:';

        const wsControlContainer = document.createElement('div');
        wsControlContainer.className = 'pipeline-ws-controls';

        const wsSelect = document.createElement('select');
        wsSelect.className = 'pipeline-ws-select';
        const allWorkspaces = this.stateManager.getAllWorkspaces();
        const activeWs = this.stateManager.getActiveWorkspace();
        allWorkspaces.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.id;
            const count = ws.modelIds?.length || 0;
            opt.textContent = `${ws.name} (${count} model${count === 1 ? '' : 's'})`;
            if (ws.id === activeWs?.id) opt.selected = true;
            wsSelect.appendChild(opt);
        });
        wsSelect.addEventListener('change', () => {
            this.stateManager.switchWorkspace(wsSelect.value);
        });

        const newWsBtn = document.createElement('button');
        newWsBtn.className = 'pipeline-model-rename-btn';
        newWsBtn.innerHTML = '➕';
        newWsBtn.title = 'Create New Workspace';
        newWsBtn.setAttribute('aria-label', 'Create New Workspace');
        newWsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.stateManager.createWorkspace();
        });

        wsControlContainer.appendChild(wsSelect);
        wsControlContainer.appendChild(newWsBtn);
        wsRow.appendChild(wsLabel);
        wsRow.appendChild(wsControlContainer);
        header.appendChild(wsRow);

        return header;
    }

    private createHeader(model: Model, models: Model[]): HTMLElement {
        const header = document.createElement('div');
        header.className = 'pipeline-header';

        const titleRow = document.createElement('div');
        titleRow.className = 'pipeline-title-row';

        const title = document.createElement('span');
        title.className = 'pipeline-title';
        title.innerHTML = `<strong>Pipeline Browser</strong>`;

        titleRow.appendChild(title);
        header.appendChild(titleRow);

        // Workspace Controls Row
        const wsRow = document.createElement('div');
        wsRow.className = 'pipeline-ws-row';

        const wsLabel = document.createElement('span');
        wsLabel.className = 'pipeline-ws-label';
        wsLabel.textContent = 'Workspace:';

        const wsControlContainer = document.createElement('div');
        wsControlContainer.className = 'pipeline-ws-controls';

        const wsSelect = document.createElement('select');
        wsSelect.className = 'pipeline-ws-select';
        const allWorkspaces = this.stateManager.getAllWorkspaces();
        const activeWs = this.stateManager.getActiveWorkspace();
        allWorkspaces.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.id;
            const count = ws.modelIds?.length || 0;
            opt.textContent = `${ws.name} (${count} model${count === 1 ? '' : 's'})`;
            if (ws.id === activeWs?.id) opt.selected = true;
            wsSelect.appendChild(opt);
        });
        wsSelect.addEventListener('change', () => {
            this.stateManager.switchWorkspace(wsSelect.value);
        });

        const newWsBtn = document.createElement('button');
        newWsBtn.className = 'pipeline-model-rename-btn';
        newWsBtn.innerHTML = '➕';
        newWsBtn.title = 'Create New Workspace';
        newWsBtn.setAttribute('aria-label', 'Create New Workspace');
        newWsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.stateManager.createWorkspace();
        });

        wsControlContainer.appendChild(wsSelect);
        wsControlContainer.appendChild(newWsBtn);
        wsRow.appendChild(wsLabel);
        wsRow.appendChild(wsControlContainer);
        header.appendChild(wsRow);

        // Model Controls Row
        const modelRow = document.createElement('div');
        modelRow.className = 'pipeline-model-row';

        const modelLabel = document.createElement('span');
        modelLabel.className = 'pipeline-model-label';
        modelLabel.textContent = 'Model:';

        const modelControlContainer = document.createElement('div');
        modelControlContainer.className = 'pipeline-model-controls';

        const modelSelect = document.createElement('select');
        modelSelect.className = 'pipeline-model-select';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            if (m.id === model.id) opt.selected = true;
            modelSelect.appendChild(opt);
        });
        modelSelect.addEventListener('change', () => {
            this.activeModelId = modelSelect.value;
            this.stateManager.setActiveModel(this.activeModelId);
            this.saveSettings();
            this.render();
        });
        modelSelect.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.startModelRename(model, modelSelect);
        });

        const renameBtn = document.createElement('button');
        renameBtn.className = 'pipeline-model-rename-btn';
        renameBtn.innerHTML = '✏️';
        renameBtn.title = 'Rename Active Model (or Double-Click)';
        renameBtn.setAttribute('aria-label', 'Rename Model');
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startModelRename(model, modelSelect);
        });

        const newModelBtn = document.createElement('button');
        newModelBtn.className = 'pipeline-model-rename-btn';
        newModelBtn.innerHTML = '➕';
        newModelBtn.title = 'Create New Model in Workspace';
        newModelBtn.setAttribute('aria-label', 'Create New Model');
        newModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.createNewModel();
        });

        const saveModelBtn = document.createElement('button');
        saveModelBtn.className = 'pipeline-model-rename-btn';
        saveModelBtn.innerHTML = '💾';
        saveModelBtn.title = 'Save / Export Model JSON';
        saveModelBtn.setAttribute('aria-label', 'Save Model JSON');
        saveModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportModel(model);
        });

        const loadModelBtn = document.createElement('button');
        loadModelBtn.className = 'pipeline-model-rename-btn';
        loadModelBtn.innerHTML = '📂';
        loadModelBtn.title = 'Load / Import Model JSON';
        loadModelBtn.setAttribute('aria-label', 'Load Model JSON');
        loadModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.importModel();
        });

        const deleteModelBtn = document.createElement('button');
        deleteModelBtn.className = 'pipeline-model-rename-btn';
        deleteModelBtn.innerHTML = '✖';
        deleteModelBtn.title = 'Delete / Close Active Model';
        deleteModelBtn.setAttribute('aria-label', 'Delete Active Model');
        deleteModelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeModel(model);
        });

        modelControlContainer.appendChild(modelSelect);
        modelControlContainer.appendChild(renameBtn);
        modelControlContainer.appendChild(newModelBtn);
        modelControlContainer.appendChild(saveModelBtn);
        modelControlContainer.appendChild(loadModelBtn);
        modelControlContainer.appendChild(deleteModelBtn);

        modelRow.appendChild(modelLabel);
        modelRow.appendChild(modelControlContainer);
        header.appendChild(modelRow);

        // Status & Progress Row
        const statusRow = document.createElement('div');
        statusRow.className = 'pipeline-status-row';

        const status = this.stateManager.getModelStatus(model.id);
        const statusBadge = document.createElement('span');
        statusBadge.className = `pipeline-status-badge status-${status.toLowerCase()}`;
        statusBadge.textContent = status;

        const step = this.stateManager.getModelStep(model.id);
        const simTime = this.stateManager.getModelSimTime(model.id);
        const timeReadout = document.createElement('span');
        timeReadout.className = 'pipeline-time-readout';
        const timeMs = (simTime * 1000).toFixed(3);
        timeReadout.textContent = `Step ${step} | ${timeMs} ms`;

        statusRow.appendChild(statusBadge);
        statusRow.appendChild(timeReadout);

        header.appendChild(titleRow);
        header.appendChild(statusRow);
        return header;
    }

    private createNewModel(): void {
        const models = this.stateManager.getAllModels();
        const newId = 'model-' + Date.now().toString(36);
        const newName = `Model ${models.length + 1}`;
        const newModel: Model = {
            id: newId,
            name: newName,
            filename: null,
            nodes: [
                {
                    id: `mesh-${newId}`,
                    type: 'DomainMesh3D',
                    x: 50,
                    y: 50,
                    displayMode: 'expanded',
                    inputs: this.stateManager.getDefaultInputs('DomainMesh3D'),
                    outputs: this.stateManager.getDefaultOutputs('DomainMesh3D'),
                    parameters: this.stateManager.getDefaultParameters('DomainMesh3D')
                }
            ],
            connections: []
        };
        this.stateManager.addModelToWorkspace(newModel);
        this.activeModelId = newId;
        this.stateManager.setActiveModel(newId);
        this.saveSettings();
        this.render();
    }

    private async exportModel(model: Model): Promise<void> {
        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            if (model.filename && model.filename.includes('/')) {
                const prepared = prepareModelSavePayload(model, model.filename);
                net.send({
                    command: "SAVE_MODEL_FILE",
                    modelId: model.id,
                    filePath: model.filename,
                    fileContent: prepared.modelJson,
                    resources: prepared.resources
                });
                return;
            }

            const browser = new HostFileBrowserModal(net, {
                title: 'Save Model As (Host)',
                mode: 'save',
                defaultFilename: model.filename || `${(model.name || model.id).toLowerCase().replace(/\s+/g, '_')}.json`,
                filters: [
                    { label: 'JSON Model Files (*.json)', extensions: ['.json'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: (path) => {
                    const prepared = prepareModelSavePayload(model, path);
                    net.send({
                        command: "SAVE_MODEL_FILE",
                        modelId: model.id,
                        filePath: path,
                        fileContent: prepared.modelJson,
                        resources: prepared.resources
                    });
                }
            });
            browser.open(model.filename || "");
            return;
        }

        const bridge = PlatformBridge.getInstance();
        const jsonStr = JSON.stringify(model, null, 2);
        const filename = `${(model.name || model.id).toLowerCase().replace(/\s+/g, '_')}.json`;
        await bridge.saveFileDialog(filename, jsonStr, 'application/json');
    }

    private async importModel(): Promise<void> {
        const bridge = PlatformBridge.getInstance();
        const res = await bridge.openFileDialog([{ name: 'BlastDaemon Model JSON', extensions: ['json'] }]);
        if (res && res.data) {
            try {
                let text = '';
                if (typeof res.data === 'string') text = res.data;
                else text = new TextDecoder().decode(res.data);
                const parsed = JSON.parse(text);
                if (parsed && Array.isArray(parsed.nodes)) {
                    const newId = 'model-' + Date.now().toString(36);
                    parsed.id = newId;
                    if (!parsed.name) parsed.name = res.filename.replace('.json', '');
                    if (parsed.filename === undefined) parsed.filename = null;
                    this.stateManager.addModelToWorkspace(parsed);
                    this.activeModelId = newId;
                    this.stateManager.setActiveModel(newId);
                    this.saveSettings();
                    this.render();
                } else if (parsed && parsed.models) {
                    Object.values(parsed.models).forEach((m: any) => {
                        if (m.filename === undefined) m.filename = null;
                        this.stateManager.addModelToWorkspace(m);
                    });
                    this.saveSettings();
                    this.render();
                }
            } catch (err) {
                console.error('[PipelineBrowser] Failed to import model:', err);
                CustomDialog.alert('Failed to parse model JSON file: ' + String(err), 'Import Error');
            }
        }
    }

    private async closeModel(model: Model): Promise<void> {
        const models = this.stateManager.getWorkspaceModels();
        if (models.length <= 1) {
            CustomDialog.alert('Cannot delete the last remaining model in the workspace.', 'Cannot Delete');
            return;
        }
        const confirmed = await CustomDialog.confirm(`Are you sure you want to delete model "${model.name || model.id}" from the workspace?`, 'Delete Model');
        if (confirmed) {
            this.stateManager.removeModelFromWorkspace(model.id);
            const remaining = this.stateManager.getWorkspaceModels();
            this.activeModelId = remaining[0]?.id || null;
            if (this.activeModelId) {
                this.stateManager.setActiveModel(this.activeModelId);
            }
            this.saveSettings();
            this.render();
        }
    }

    private getModelSolverSummary(model: Model): { label: string; color: string } {
        if (model.nodes.some(n => n.type === 'FEMFSICoupler3D')) return { label: 'FEM-FSI 3D', color: '#f59e0b' };
        if (model.nodes.some(n => n.type === 'FEMDomain3D')) return { label: 'FEM 3D', color: '#ec4899' };
        if (model.nodes.some(n => n.type === 'FSICoupler3D')) return { label: 'FSI 3D', color: '#f59e0b' };
        if (model.nodes.some(n => n.type === 'MPMDomain3D')) return { label: 'MPM 3D', color: '#10b981' };
        if (model.nodes.some(n => n.type === 'CFDSolver3D')) return { label: 'CFD 3D', color: '#8b5cf6' };
        if (model.nodes.some(n => n.type === 'FSICoupler2D')) return { label: 'FSI 2D', color: '#f59e0b' };
        if (model.nodes.some(n => n.type === 'MPMDomain2D')) return { label: 'MPM 2D', color: '#10b981' };
        if (model.nodes.some(n => n.type === 'CFDSolver2D')) return { label: 'CFD 2D', color: '#06b6d4' };
        if (model.nodes.some(n => n.type === 'CFDSolver')) return { label: 'CFD 1D', color: '#3b82f6' };
        return { label: 'Generic Model', color: '#64748b' };
    }

    private getRemapSourceInfo(model: Model, allModels: Model[]): { sourceModel: Model; remapType: string } | null {
        const remapNode = model.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode' || n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode');
        if (!remapNode) return null;

        const ws = this.stateManager.getActiveWorkspace();
        if (ws && ws.connections) {
            for (const conn of ws.connections) {
                if (conn.toNode === remapNode.id) {
                    const sourceModel = allModels.find(m => m.nodes.some(n => n.id === conn.fromNode));
                    if (sourceModel && sourceModel.id !== model.id) {
                        const remapType = remapNode.type === 'Remap2DTo3DNode' ? '2D ➔ 3D' : (remapNode.type === 'Remap1DTo3DNode' ? '1D ➔ 3D' : '1D ➔ 2D');
                        return { sourceModel, remapType };
                    }
                }
            }
        }

        if (remapNode.type === 'Remap2DTo3DNode') {
            const src = allModels.find(m => m.id !== model.id && m.nodes.some(n => n.type === 'CFDSolver2D'));
            if (src) return { sourceModel: src, remapType: '2D ➔ 3D (Auto-Linked)' };
        } else if (remapNode.type === 'RemapNode' || remapNode.type === 'Remap1DTo2DNode' || remapNode.type === 'Remap1DTo3DNode') {
            const src = allModels.find(m => m.id !== model.id && m.nodes.some(n => n.type === 'CFDSolver'));
            if (src) return { sourceModel: src, remapType: '1D ➔ 2D (Auto-Linked)' };
        }
        return null;
    }

    public buildPipelineGroups(allModels: Model[]): PipelineHierarchyGroup[] {
        if (allModels.length === 0) return [];

        const remapMap = new Map<string, { sourceModel: Model; remapType: string }>();
        const incomingEdges = new Map<string, string[]>(); // targetId -> [sourceIds]
        const outgoingEdges = new Map<string, string[]>(); // sourceId -> [targetIds]

        for (const m of allModels) {
            incomingEdges.set(m.id, []);
            outgoingEdges.set(m.id, []);
        }

        for (const m of allModels) {
            const info = this.getRemapSourceInfo(m, allModels);
            if (info) {
                remapMap.set(m.id, info);
                incomingEdges.get(m.id)?.push(info.sourceModel.id);
                outgoingEdges.get(info.sourceModel.id)?.push(m.id);
            }
        }

        // Find connected components (undirected)
        const visited = new Set<string>();
        const groups: PipelineHierarchyGroup[] = [];

        for (const model of allModels) {
            if (visited.has(model.id)) continue;

            const componentModelIds: string[] = [];
            const queue: string[] = [model.id];
            visited.add(model.id);

            while (queue.length > 0) {
                const currentId = queue.shift()!;
                componentModelIds.push(currentId);

                const inNeigh = incomingEdges.get(currentId) || [];
                const outNeigh = outgoingEdges.get(currentId) || [];
                for (const nId of [...inNeigh, ...outNeigh]) {
                    if (!visited.has(nId)) {
                        visited.add(nId);
                        queue.push(nId);
                    }
                }
            }

            const componentModels = componentModelIds
                .map(id => allModels.find(m => m.id === id)!)
                .filter(Boolean);

            // Topological sort within component
            const inDegrees = new Map<string, number>();
            componentModels.forEach(m => inDegrees.set(m.id, 0));
            componentModels.forEach(m => {
                const srcInfo = remapMap.get(m.id);
                if (srcInfo && inDegrees.has(srcInfo.sourceModel.id)) {
                    inDegrees.set(m.id, (inDegrees.get(m.id) || 0) + 1);
                }
            });

            const sorted: Model[] = [];
            const readyQueue = componentModels.filter(m => (inDegrees.get(m.id) || 0) === 0);

            while (readyQueue.length > 0) {
                const curr = readyQueue.shift()!;
                sorted.push(curr);
                const outN = outgoingEdges.get(curr.id) || [];
                for (const outId of outN) {
                    if (inDegrees.has(outId)) {
                        inDegrees.set(outId, (inDegrees.get(outId) || 0) - 1);
                        if (inDegrees.get(outId) === 0) {
                            const targetM = componentModels.find(m => m.id === outId);
                            if (targetM) readyQueue.push(targetM);
                        }
                    }
                }
            }

            // Append any remaining models if cycles existed
            componentModels.forEach(m => {
                if (!sorted.includes(m)) sorted.push(m);
            });

            const isMulti = sorted.length > 1;
            const groupName = isMulti
                ? `Remap Pipeline: ${sorted.map(m => m.name || m.id).join(' ➔ ')}`
                : (sorted[0].name || sorted[0].id);

            const groupId = isMulti
                ? `pipe-${sorted.map(m => m.id).join('-')}`
                : `pipe-${sorted[0].id}`;

            groups.push({
                id: groupId,
                name: groupName,
                isMultiModel: isMulti,
                models: sorted,
                remapLinks: remapMap
            });
        }

        return groups;
    }

    private createPipelineGroupCard(group: PipelineHierarchyGroup, allModels: Model[]): HTMLElement {
        const card = document.createElement('div');
        const hasActive = group.models.some(m => m.id === this.activeModelId);
        card.className = `pipeline-hierarchy-group ${hasActive ? 'has-active-stage' : ''}`;
        card.dataset.groupId = group.id;

        const isCollapsed = this.collapsedPipelineGroups.has(group.id);

        const header = document.createElement('div');
        header.className = 'pipeline-hierarchy-header';
        header.addEventListener('click', () => {
            if (this.collapsedPipelineGroups.has(group.id)) {
                this.collapsedPipelineGroups.delete(group.id);
            } else {
                this.collapsedPipelineGroups.add(group.id);
            }
            this.saveSettings();
            this.render();
        });

        const leftGroup = document.createElement('div');
        leftGroup.className = 'pipeline-hierarchy-header-left';

        const caret = document.createElement('span');
        caret.className = 'pipeline-caret';
        caret.textContent = isCollapsed ? '▶' : '▼';
        caret.title = isCollapsed ? `Expand pipeline group (${group.name})` : `Collapse pipeline group (${group.name})`;
        caret.setAttribute('aria-label', isCollapsed ? `Expand pipeline group` : `Collapse pipeline group`);
        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.collapsedPipelineGroups.has(group.id)) {
                this.collapsedPipelineGroups.delete(group.id);
            } else {
                this.collapsedPipelineGroups.add(group.id);
            }
            this.saveSettings();
            this.render();
        });

        const icon = document.createElement('span');
        icon.className = 'pipeline-hierarchy-icon';
        icon.textContent = '🔄';

        const title = document.createElement('span');
        title.className = 'pipeline-hierarchy-title';
        title.textContent = group.name;
        title.title = `${group.name} (${group.models.length} chained simulation stages)`;

        const stagePill = document.createElement('span');
        stagePill.className = 'pipeline-hierarchy-tag';
        const flowStr = group.models.map(m => this.getModelSolverSummary(m).label).join(' ➔ ');
        stagePill.textContent = flowStr;
        stagePill.title = `Chained Multi-Stage Execution: ${flowStr}`;

        leftGroup.appendChild(caret);
        leftGroup.appendChild(icon);
        leftGroup.appendChild(title);
        leftGroup.appendChild(stagePill);

        const rightGroup = document.createElement('div');
        rightGroup.className = 'pipeline-hierarchy-header-right';

        const statuses = group.models.map(m => this.stateManager.getModelStatus(m.id));
        let compositeStatus: SimulationStatus = 'UNINITIALIZED';
        if (statuses.some(s => s === 'RUNNING')) compositeStatus = 'RUNNING';
        else if (statuses.some(s => s === 'ERROR')) compositeStatus = 'ERROR';
        else if (statuses.some(s => s === 'PAUSED')) compositeStatus = 'PAUSED';
        else if (statuses.every(s => s === 'INITIALIZED')) compositeStatus = 'INITIALIZED';

        const statusBadge = document.createElement('span');
        statusBadge.className = `pipeline-status-badge status-${compositeStatus.toLowerCase()}`;
        statusBadge.textContent = compositeStatus;
        rightGroup.appendChild(statusBadge);

        // Run entire workspace / multi-stage pipeline button
        const runBtn = document.createElement('button');
        runBtn.className = 'pipeline-model-rename-btn';
        runBtn.innerHTML = '⚡';
        runBtn.title = 'Execute full multi-stage remap pipeline sequentially';
        runBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if ((window as any).executeWorkspacePipeline) {
                (window as any).executeWorkspacePipeline();
            } else if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(group.models[0].id, 'EXEC_ALL');
            }
        });
        rightGroup.appendChild(runBtn);

        header.appendChild(leftGroup);
        header.appendChild(rightGroup);

        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showPipelineGroupContextMenu(e, group);
        });

        card.appendChild(header);

        if (!isCollapsed) {
            const body = document.createElement('div');
            body.className = 'pipeline-hierarchy-body';

            group.models.forEach((m, idx) => {
                const remapInfo = group.remapLinks.get(m.id);
                if (idx > 0 && remapInfo) {
                    const divider = document.createElement('div');
                    divider.className = 'pipeline-stage-divider';
                    divider.innerHTML = `<span>⬇ REMAP & FIELD TRANSFER (${remapInfo.remapType})</span>`;
                    body.appendChild(divider);
                }

                const stageCard = this.createModelCard(m, allModels, {
                    stageIndex: idx + 1,
                    totalStages: group.models.length,
                    isChildStage: true,
                    remapType: remapInfo?.remapType
                });
                body.appendChild(stageCard);
            });

            card.appendChild(body);
        }

        return card;
    }

    private createModelCard(
        model: Model,
        allModels: Model[],
        stageInfo?: { stageIndex: number; totalStages: number; isChildStage?: boolean; remapType?: string }
    ): HTMLElement {
        const card = document.createElement('div');
        const isActive = model.id === this.activeModelId;
        const isChildStage = stageInfo?.isChildStage ?? false;
        card.className = `pipeline-model-card ${isActive ? 'active-model' : ''} ${isChildStage ? 'pipeline-stage-card' : ''}`;
        card.dataset.modelId = model.id;

        const isCollapsed = this.collapsedModels.has(model.id);

        const header = document.createElement('div');
        header.className = 'pipeline-model-card-header';
        header.addEventListener('click', () => {
            this.activeModelId = model.id;
            this.stateManager.setActiveModel(model.id);
            this.saveSettings();
            this.render();
        });

        const leftGroup = document.createElement('div');
        leftGroup.className = 'pipeline-model-header-left';

        const caret = document.createElement('span');
        caret.className = 'pipeline-caret';
        caret.textContent = isCollapsed ? '▶' : '▼';
        caret.title = isCollapsed ? `Expand model (${model.name || model.id})` : `Collapse model (${model.name || model.id})`;
        caret.setAttribute('aria-label', isCollapsed ? `Expand model` : `Collapse model`);
        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.collapsedModels.has(model.id)) {
                this.collapsedModels.delete(model.id);
            } else {
                this.collapsedModels.add(model.id);
            }
            this.saveSettings();
            this.render();
        });

        leftGroup.appendChild(caret);

        if (stageInfo?.isChildStage) {
            const stageBadge = document.createElement('span');
            stageBadge.className = 'pipeline-stage-badge';
            stageBadge.textContent = `Stage ${stageInfo.stageIndex}/${stageInfo.totalStages}`;
            stageBadge.title = stageInfo.stageIndex === 1
                ? 'Stage 1: Upstream Source Model'
                : `Stage ${stageInfo.stageIndex}: Remapped Target Model`;
            leftGroup.appendChild(stageBadge);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'pipeline-model-name';
        nameEl.textContent = model.name || model.id;
        nameEl.title = `Double-click or press F2 to rename ${model.name || model.id}`;
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startModelRename(model, nameEl);
        });
        leftGroup.appendChild(nameEl);

        const solverSummary = this.getModelSolverSummary(model);
        const solverPill = document.createElement('span');
        solverPill.className = 'pipeline-solver-pill';
        solverPill.textContent = solverSummary.label;
        solverPill.style.color = solverSummary.color;
        solverPill.style.borderColor = solverSummary.color;
        leftGroup.appendChild(solverPill);

        if (isActive) {
            const activeBadge = document.createElement('span');
            activeBadge.className = 'pipeline-active-badge';
            activeBadge.textContent = '● ACTIVE';
            activeBadge.title = 'Currently focused / editing model';
            leftGroup.appendChild(activeBadge);
        }

        const rightGroup = document.createElement('div');
        rightGroup.className = 'pipeline-model-header-right';

        const status = this.stateManager.getModelStatus(model.id);
        const statusBadge = document.createElement('span');
        statusBadge.className = `pipeline-status-badge status-${status.toLowerCase()}`;
        statusBadge.textContent = status;
        rightGroup.appendChild(statusBadge);

        // Execution Action Deck
        const actionDeck = document.createElement('div');
        actionDeck.className = 'pipeline-model-actions';
        actionDeck.style.display = 'inline-flex';
        actionDeck.style.alignItems = 'center';
        actionDeck.style.gap = '3px';

        // Init Button
        const initBtn = document.createElement('button');
        initBtn.className = 'pipeline-model-rename-btn';
        initBtn.innerHTML = '⚡';
        initBtn.title = `Initialize solver process for ${model.name || model.id}`;
        initBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeModelId = model.id;
            this.stateManager.setActiveModel(model.id);
            this.saveSettings();
            if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(model.id, 'INIT');
            } else if (this.onSimCommand) {
                this.onSimCommand('INIT', model.id);
            }
        });
        actionDeck.appendChild(initBtn);

        // Run / Step Button
        const runBtn = document.createElement('button');
        runBtn.className = 'pipeline-model-rename-btn';
        runBtn.innerHTML = '▶';
        runBtn.title = `Run simulation for ${model.name || model.id}`;
        runBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeModelId = model.id;
            this.stateManager.setActiveModel(model.id);
            this.saveSettings();
            if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(model.id, 'EXEC_ALL');
            } else if (this.onSimCommand) {
                this.onSimCommand('EXEC_ALL', model.id);
            }
        });
        actionDeck.appendChild(runBtn);

        // Pause Button
        if (status === 'RUNNING') {
            const pauseBtn = document.createElement('button');
            pauseBtn.className = 'pipeline-model-rename-btn';
            pauseBtn.innerHTML = '⏸';
            pauseBtn.title = `Pause simulation for ${model.name || model.id}`;
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if ((window as any).executeModelCommand) {
                    (window as any).executeModelCommand(model.id, 'PAUSE');
                } else if (this.onSimCommand) {
                    this.onSimCommand('PAUSE', model.id);
                }
            });
            actionDeck.appendChild(pauseBtn);
        }

        // Terminate Button
        if (status !== 'UNINITIALIZED' && status !== 'TERMINATED') {
            const termBtn = document.createElement('button');
            termBtn.className = 'pipeline-model-rename-btn';
            termBtn.innerHTML = '⏹';
            termBtn.title = `Terminate solver process for ${model.name || model.id}`;
            termBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if ((window as any).executeModelCommand) {
                    (window as any).executeModelCommand(model.id, 'TERMINATE');
                } else if (this.onSimCommand) {
                    this.onSimCommand('TERMINATE', model.id);
                }
            });
            actionDeck.appendChild(termBtn);
        }

        rightGroup.appendChild(actionDeck);

        header.appendChild(leftGroup);
        header.appendChild(rightGroup);

        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showModelContextMenu(e, model);
        });

        card.appendChild(header);

        // Remap Connection Info
        const remapInfo = this.getRemapSourceInfo(model, allModels);
        if (remapInfo) {
            const remapEl = document.createElement('div');
            remapEl.className = 'pipeline-remap-link';
            remapEl.title = `Click to focus upstream remap source (${remapInfo.sourceModel.name || remapInfo.sourceModel.id})`;
            remapEl.innerHTML = `<span class="pipeline-remap-link-icon">🔄</span> <span>Remapped from: <strong>${remapInfo.sourceModel.name || remapInfo.sourceModel.id}</strong> (${remapInfo.remapType})</span>`;
            remapEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this.activeModelId = remapInfo.sourceModel.id;
                this.stateManager.setActiveModel(remapInfo.sourceModel.id);
                this.saveSettings();
                this.render();
            });
            card.appendChild(remapEl);
        }

        // Expanded Body with Categorized Node Groups
        if (!isCollapsed) {
            const body = document.createElement('div');
            body.className = 'pipeline-model-body';

            for (const cat of CATEGORIES) {
                const catNodes = model.nodes.filter(n => cat.types.includes(n.type));
                if (catNodes.length > 0) {
                    const catGroup = this.createCategoryGroup(cat, catNodes, model);
                    body.appendChild(catGroup);
                }
            }

            const categorizedTypes = new Set(CATEGORIES.flatMap(c => c.types));
            const uncategorizedNodes = model.nodes.filter(n => !categorizedTypes.has(n.type));
            if (uncategorizedNodes.length > 0) {
                const fallbackCat: EntityCategory = {
                    id: 'other',
                    label: 'Other Components',
                    icon: '📦',
                    color: '#90a4ae',
                    types: []
                };
                const catGroup = this.createCategoryGroup(fallbackCat, uncategorizedNodes, model);
                body.appendChild(catGroup);
            }

            card.appendChild(body);
        }

        return card;
    }

    private createToolbar(model: Model, models?: Model[]): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'pipeline-toolbar';

        // Add Entity Dropdown
        const addBtn = document.createElement('button');
        addBtn.className = 'pipeline-tool-btn add-btn';
        addBtn.textContent = '+ Add Filter';
        addBtn.title = 'Add physical solver, material, charge, or sink entity';
        addBtn.addEventListener('click', (e) => this.showAddEntityMenu(e, model));

        // Delete Selected Node
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'pipeline-tool-btn del-btn';
        deleteBtn.textContent = '🗑 Delete';
        deleteBtn.title = 'Delete selected entity';
        deleteBtn.addEventListener('click', () => {
            if (this.stateManager.selectedNodeId) {
                this.deleteNode(model, this.stateManager.selectedNodeId);
            }
        });

        // Run Entire Workspace Pipeline button
        const runAllBtn = document.createElement('button');
        runAllBtn.className = 'pipeline-tool-btn pipeline-run-all-btn';
        runAllBtn.textContent = '⚡ Run Pipeline';
        runAllBtn.title = 'Execute entire workspace multi-stage simulation pipeline sequentially';
        runAllBtn.addEventListener('click', () => {
            if ((window as any).executeWorkspacePipeline) {
                (window as any).executeWorkspacePipeline();
            } else if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(model.id, 'EXEC_ALL');
            }
        });

        toolbar.appendChild(addBtn);
        toolbar.appendChild(deleteBtn);
        toolbar.appendChild(runAllBtn);

        // Collapse All / Expand All Toggle
        const allExpanded = this.areAllExpanded();
        const toggleCollapseBtn = document.createElement('button');
        toggleCollapseBtn.className = `pipeline-tool-btn collapse-toggle-btn ${!allExpanded ? 'is-collapsed' : ''}`;
        toggleCollapseBtn.title = allExpanded ? 'Collapse all categories, models and pipelines' : 'Expand all categories, models and pipelines';
        toggleCollapseBtn.innerHTML = allExpanded
            ? '<span class="pipeline-btn-icon">▶</span> <span>Collapse All</span>'
            : '<span class="pipeline-btn-icon">▼</span> <span>Expand All</span>';
        toggleCollapseBtn.addEventListener('click', () => {
            this.toggleCollapseAll();
        });
        toolbar.appendChild(toggleCollapseBtn);

        // View Mode Toggle (if multiple models)
        const allModels = models || this.stateManager.getWorkspaceModels();
        if (allModels.length > 1) {
            const toggleBtn = document.createElement('button');
            toggleBtn.className = `pipeline-mode-toggle-btn ${this.viewMode === 'ALL_MODELS' ? 'active' : ''}`;
            toggleBtn.textContent = this.viewMode === 'ALL_MODELS' ? '🌐 All Models' : '🎯 Focused';
            toggleBtn.title = 'Toggle between full workspace pipeline tree and focused model only';
            toggleBtn.addEventListener('click', () => {
                this.viewMode = this.viewMode === 'ALL_MODELS' ? 'FOCUSED_ONLY' : 'ALL_MODELS';
                this.saveSettings();
                this.render();
            });
            toolbar.appendChild(toggleBtn);
        }

        return toolbar;
    }

    public areAllExpanded(): boolean {
        const allModels = this.stateManager.getWorkspaceModels();
        if (this.collapsedPipelineGroups.size > 0) return false;
        if (this.viewMode === 'ALL_MODELS' && allModels.length > 1) {
            if (this.collapsedModels.size > 0) return false;
        }
        return this.collapsedCategories.size === 0;
    }

    public collapseAll(): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const groups = this.buildPipelineGroups(allModels);
        groups.forEach(g => this.collapsedPipelineGroups.add(g.id));
        allModels.forEach(m => this.collapsedModels.add(m.id));
        CATEGORIES.forEach(c => this.collapsedCategories.add(c.id));
        this.collapsedCategories.add('other');
        this.saveSettings();
        this.render();
    }

    public expandAll(): void {
        this.collapsedPipelineGroups.clear();
        this.collapsedModels.clear();
        this.collapsedCategories.clear();
        this.saveSettings();
        this.render();
    }

    public toggleCollapseAll(): void {
        if (this.areAllExpanded()) {
            this.collapseAll();
        } else {
            this.expandAll();
        }
    }

    private createCategoryGroup(cat: EntityCategory, nodes: Node[], model: Model): HTMLElement {
        const group = document.createElement('div');
        group.className = 'pipeline-group';

        const isCollapsed = this.collapsedCategories.has(cat.id);

        const header = document.createElement('div');
        header.className = 'pipeline-group-header';
        header.addEventListener('click', () => {
            if (this.collapsedCategories.has(cat.id)) {
                this.collapsedCategories.delete(cat.id);
            } else {
                this.collapsedCategories.add(cat.id);
            }
            this.saveSettings();
            this.render();
        });
        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showCategoryContextMenu(e, cat, model);
        });

        const caret = document.createElement('span');
        caret.className = 'pipeline-caret';
        caret.textContent = isCollapsed ? '▶' : '▼';
        caret.title = isCollapsed ? `Expand ${cat.label}` : `Collapse ${cat.label}`;
        caret.setAttribute('aria-label', isCollapsed ? `Expand ${cat.label}` : `Collapse ${cat.label}`);
        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.collapsedCategories.has(cat.id)) {
                this.collapsedCategories.delete(cat.id);
            } else {
                this.collapsedCategories.add(cat.id);
            }
            this.saveSettings();
            this.render();
        });

        const catIcon = document.createElement('span');
        catIcon.className = 'pipeline-cat-icon';
        catIcon.textContent = cat.icon;

        const catLabel = document.createElement('span');
        catLabel.className = 'pipeline-cat-label';
        catLabel.textContent = `${cat.label} (${nodes.length})`;

        header.appendChild(caret);
        header.appendChild(catIcon);
        header.appendChild(catLabel);
        group.appendChild(header);

        if (!isCollapsed) {
            const list = document.createElement('div');
            list.className = 'pipeline-node-list';

            nodes.forEach(node => {
                const nodeItem = this.createNodeItem(node, cat, model);
                list.appendChild(nodeItem);
            });

            group.appendChild(list);
        }

        return group;
    }

    private createNodeItem(node: Node, cat: EntityCategory, model: Model): HTMLElement {
        const nodeContainer = document.createElement('div');
        nodeContainer.className = 'pipeline-node-entry';

        const item = document.createElement('div');
        item.className = 'pipeline-node-item';
        item.dataset.nodeId = node.id;

        if (this.stateManager.selectedNodeId === node.id && this.stateManager.getSelectedSliceIndex() === null) {
            item.classList.add('selected');
        }

        // Visibility Toggle (Eye)
        let isVisible = node.parameters.visible !== false && !node.parameters.hidden;
        const eyeBtn = document.createElement('button');
        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        eyeBtn.title = isVisible ? 'Hide in viewports' : 'Show in viewports';
        eyeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isVisible = !isVisible;
            this.stateManager.updateNodeParametersInPlace(node.id, { visible: isVisible, hidden: !isVisible });
            eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
            eyeBtn.title = isVisible ? 'Hide in viewports' : 'Show in viewports';
        });

        // Type color badge
        const badge = document.createElement('span');
        badge.className = 'pipeline-type-badge';
        badge.style.backgroundColor = cat.color;

        // Label
        const label = document.createElement('span');
        label.className = 'pipeline-node-label';
        label.textContent = node.parameters.name || node.id;
        label.title = `${node.type} (ID: ${node.id}) — Double-click or press F2 to rename`;

        // Double click anywhere on node item or label to rename in-place
        const triggerRename = (e: MouseEvent) => {
            e.stopPropagation();
            this.startInPlaceRename(node, label);
        };
        item.addEventListener('dblclick', triggerRename);
        label.addEventListener('dblclick', triggerRename);

        // Type descriptor chip
        const typeChip = document.createElement('span');
        typeChip.className = 'pipeline-type-chip';
        typeChip.textContent = this.getNodeTypeSummary(node);

        item.appendChild(eyeBtn);
        item.appendChild(badge);
        item.appendChild(label);
        item.appendChild(typeChip);

        // Click to select node
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            this.stateManager.setSelectedSliceIndex(null);
            this.selectedGaugeIndex = null;
            this.activeModelId = model.id;
            this.stateManager.selectNode(model.id, node.id);
            this.saveSettings();
            this.updateSelectionHighlight();
        });

        // Mouse enter / leave for 3D viewport hover highlighting
        item.addEventListener('mouseenter', () => {
            this.stateManager.setHoveredNode(node.id);
        });
        item.addEventListener('mouseleave', () => {
            this.stateManager.setHoveredNode(null);
        });

        // Context menu
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showNodeContextMenu(e, node, model);
        });

        nodeContainer.appendChild(item);

        // Slices Sub-items under the sliced Domain
        if (this.isSliceDomainNode(node, model)) {
            const slices: any[] = node.parameters.slices || [];
            const childList = document.createElement('div');
            childList.className = 'pipeline-child-list';

            slices.forEach((sl: any, idx: number) => {
                const childItem = this.createSliceItem(node, sl, idx, model);
                childList.appendChild(childItem);
            });

            // Quick Add Slice Button row
            const addSliceRow = document.createElement('div');
            addSliceRow.className = 'pipeline-add-child-row';
            const addSliceBtn = document.createElement('button');
            addSliceBtn.className = 'pipeline-add-child-btn';
            addSliceBtn.innerHTML = '<span>➕</span> <span>Add Slice Plane</span>';
            addSliceBtn.title = `Add a new orthogonal slice plane to ${node.parameters.name || node.id}`;
            addSliceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addNewSliceToDomain(node, model);
            });
            addSliceRow.appendChild(addSliceBtn);
            childList.appendChild(addSliceRow);

            nodeContainer.appendChild(childList);
        }

        return nodeContainer;
    }

    private isSliceDomainNode(node: Node, model: Model): boolean {
        if (node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'DomainMesh2D') {
            return true;
        }
        if (['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'MPMDomain3D', 'MPMDomain2D', 'FEMDomain3D'].includes(node.type)) {
            const hasMesh = model.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh' || n.type === 'DomainMesh2D');
            if (!hasMesh) return true;
        }
        if (node.type === 'Telemetry3DViewport') {
            const hasAnyDomain = model.nodes.some(n => [
                'DomainMesh3D', 'DomainMesh', 'DomainMesh2D',
                'CFDSolver3D', 'CFDSolver2D', 'CFDSolver',
                'MPMDomain3D', 'MPMDomain2D',
                'FEMDomain3D'
            ].includes(n.type));
            if (!hasAnyDomain) return true;
        }
        return false;
    }

    private createSliceItem(domainNode: Node, slice: any, idx: number, model: Model): HTMLElement {
        const item = document.createElement('div');
        item.className = 'pipeline-node-item pipeline-child-item';
        item.dataset.nodeId = domainNode.id;
        item.dataset.sliceIndex = String(idx);

        const currentSelectedSlice = this.stateManager.getSelectedSliceIndex();
        if (this.stateManager.selectedNodeId === domainNode.id && currentSelectedSlice === idx) {
            item.classList.add('selected');
        }

        // Branch connector symbol
        const branch = document.createElement('span');
        branch.className = 'pipeline-branch-symbol';
        branch.textContent = '└─';

        // Visibility Toggle (Eye)
        let isVisible = slice.enabled !== false;
        const eyeBtn = document.createElement('button');
        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        eyeBtn.title = isVisible ? 'Hide slice plane' : 'Show slice plane';
        eyeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isVisible = !isVisible;
            slice.enabled = isVisible;
            const currentSlices = [...(domainNode.parameters.slices || [])];
            currentSlices[idx] = { ...slice, enabled: isVisible };
            this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
            eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
            eyeBtn.title = isVisible ? 'Hide slice plane' : 'Show slice plane';
            (window as any).transportController?.onSliceConfigChange?.(currentSlices);
        });

        // Slice Icon
        const icon = document.createElement('span');
        icon.className = 'pipeline-slice-icon';
        icon.textContent = '🥞';

        // Slice Label
        const axisLabel = getSliceAxisLabel(slice.axis);
        const defaultName = `Slice #${idx} (${axisLabel})`;
        const label = document.createElement('span');
        label.className = 'pipeline-node-label';
        const customName = slice.name || defaultName;
        label.textContent = customName;
        label.title = `${customName} · Domain: ${domainNode.parameters.name || domainNode.id} · Field: ${slice.quantity || 'pressure'} · Colormap: ${slice.colormap || 'rainbow'} (Double-click or F2 to rename)`;

        // Double click to rename slice in-place
        const triggerSliceRename = (e: MouseEvent) => {
            e.stopPropagation();
            this.startInPlaceSliceRename(domainNode, idx, slice, label);
        };
        item.addEventListener('dblclick', triggerSliceRename);
        label.addEventListener('dblclick', triggerSliceRename);

        // Field and Colormap Tag
        const tag = document.createElement('span');
        tag.className = 'pipeline-slice-tag';
        tag.textContent = `${slice.quantity || 'pressure'}`;

        const cmapBadge = document.createElement('span');
        cmapBadge.className = `pipeline-cmap-badge cmap-${slice.colormap || 'rainbow'}`;
        cmapBadge.title = `Colormap: ${slice.colormap || 'rainbow'}`;

        // Quick Delete Button
        const delBtn = document.createElement('button');
        delBtn.className = 'pipeline-child-del-btn';
        delBtn.textContent = '✖';
        delBtn.title = 'Delete slice plane';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteSliceFromDomain(domainNode, idx, model);
        });

        item.appendChild(branch);
        item.appendChild(eyeBtn);
        item.appendChild(icon);
        item.appendChild(label);
        item.appendChild(tag);
        item.appendChild(cmapBadge);
        item.appendChild(delBtn);

        // Click to select slice
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeModelId = model.id;
            this.stateManager.selectNode(model.id, domainNode.id);
            this.stateManager.setSelectedSliceIndex(idx);
            this.selectedGaugeIndex = null;
            this.saveSettings();
            (window as any).transportController?.setActiveSliceIndex?.(idx);
            (window as any).transportController?.setSelectedObject?.({
                objectType: 'Slice',
                sliceIndex: idx,
                label: `Slice #${idx} (${getSliceAxisLabel(slice.axis)})`,
                nodeId: domainNode.id
            });
            this.updateSelectionHighlight();
        });

        // Mouse enter / leave for 3D viewport hover highlighting
        item.addEventListener('mouseenter', () => {
            this.stateManager.setHoveredNode(domainNode.id, idx);
        });
        item.addEventListener('mouseleave', () => {
            this.stateManager.setHoveredNode(null);
        });

        // Context menu
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showSliceContextMenu(e, domainNode, slice, idx, model);
        });

        return item;
    }

    private createGaugeItem(vgNode: Node, gauge: any, idx: number, model: Model, isExternal: boolean = false): HTMLElement {
        const item = document.createElement('div');
        item.className = 'pipeline-node-item pipeline-child-item';
        item.dataset.nodeId = vgNode.id;
        item.dataset.gaugeIndex = String(idx);

        const currentSelectedGauge = this.selectedGaugeIndex;
        if (this.stateManager.selectedNodeId === vgNode.id && currentSelectedGauge === idx) {
            item.classList.add('selected');
        }

        // Branch connector symbol
        const branch = document.createElement('span');
        branch.className = 'pipeline-branch-symbol';
        branch.textContent = '└─';

        // Visibility / Plotting Toggle (Eye)
        let isVisible = gauge.plot !== false && gauge.active !== false;
        const eyeBtn = document.createElement('button');
        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
        eyeBtn.title = isVisible ? 'Disable gauge plotting' : 'Enable gauge plotting';
        eyeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isVisible = !isVisible;
            gauge.plot = isVisible;
            if (!isExternal) {
                const currentGauges = [...(vgNode.parameters.gauges || [])];
                currentGauges[idx] = { ...gauge, plot: isVisible };
                this.stateManager.updateNodeParametersInPlace(vgNode.id, { gauges: currentGauges });
            }
            eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
            eyeBtn.title = isVisible ? 'Disable gauge plotting' : 'Enable gauge plotting';
        });

        // Gauge Icon
        const icon = document.createElement('span');
        icon.className = 'pipeline-slice-icon';
        icon.textContent = isExternal ? '📌' : '⏱️';

        // Gauge Label
        const defaultName = `Gauge ${gauge.id || '#' + (idx + 1)}`;
        const customName = gauge.name || defaultName;
        const label = document.createElement('span');
        label.className = 'pipeline-node-label';
        label.textContent = customName;
        const posStr = gauge.x !== undefined ? `(${gauge.x}, ${gauge.y}, ${gauge.z})` : (gauge.r !== undefined ? `(R:${gauge.r}, Z:${gauge.z})` : 'Pinned Probe');
        label.title = `${customName} · Position: ${posStr} — Click to inspect and plot`;

        // Double click to rename in-place if not external
        if (!isExternal) {
            const triggerGaugeRename = (e: MouseEvent) => {
                e.stopPropagation();
                this.startInPlaceGaugeRename(vgNode, idx, gauge, label);
            };
            item.addEventListener('dblclick', triggerGaugeRename);
            label.addEventListener('dblclick', triggerGaugeRename);
        }

        // Tag with coordinates
        const tag = document.createElement('span');
        tag.className = 'pipeline-slice-tag';
        tag.textContent = posStr;
        tag.title = isExternal ? posStr : `${posStr} — Double-click to edit coordinates`;
        if (!isExternal) {
            tag.style.cursor = 'pointer';
            tag.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.promptEditGaugeCoordinates(vgNode, idx, gauge, model);
            });
        }

        // Quick Delete / Unpin Button
        const delBtn = document.createElement('button');
        delBtn.className = 'pipeline-child-del-btn';
        if (isExternal) {
            delBtn.textContent = '✕';
            delBtn.title = 'Unpin probe';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pinnedIds: string[] = vgNode.parameters.pinned_probe_ids || [];
                const updated = pinnedIds.filter(id => id !== String(gauge.id));
                this.stateManager.updateNodeParametersInPlace(vgNode.id, { pinned_probe_ids: updated });
                this.render();
            });
        } else {
            delBtn.textContent = '✖';
            delBtn.title = 'Delete gauge probe';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteGaugeFromNode(vgNode, idx, model);
            });
        }

        item.appendChild(branch);
        item.appendChild(eyeBtn);
        item.appendChild(icon);
        item.appendChild(label);
        item.appendChild(tag);
        item.appendChild(delBtn);

        // Click to select gauge
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            this.activeModelId = model.id;
            this.stateManager.selectNode(model.id, vgNode.id);
            this.selectedGaugeIndex = idx;
            this.stateManager.setSelectedGaugeIndex(idx);
            this.stateManager.setSelectedSliceIndex(null);
            this.saveSettings();
            this.render({ scrollSelectedIntoView: false });
        });

        // Context menu
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showGaugeContextMenu(e, vgNode, gauge, idx, model);
        });

        return item;
    }

    private addNewSliceToDomain(domainNode: Node, model: Model, plane: 'xy' | 'xz' | 'yz' = 'xy'): void {
        const currentSlices = [...(domainNode.parameters.slices || [])];
        const newSlice = {
            axis: plane,
            offset: 0.0,
            enabled: true,
            colormap: 'rainbow',
            opacity: 1.0,
            quantity: 'pressure'
        };
        const updated = [...currentSlices, newSlice];
        this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: updated });
        (window as any).transportController?.onSliceConfigChange?.(updated);
        this.activeModelId = model.id;
        this.stateManager.selectNode(model.id, domainNode.id);
        this.stateManager.setSelectedSliceIndex(updated.length - 1);
        this.selectedGaugeIndex = null;
        this.render({ scrollSelectedIntoView: true });
    }

    private deleteSliceFromDomain(domainNode: Node, idx: number, model: Model): void {
        const currentSlices = [...(domainNode.parameters.slices || [])];
        if (idx >= 0 && idx < currentSlices.length) {
            currentSlices.splice(idx, 1);
            this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
            (window as any).transportController?.onSliceConfigChange?.(currentSlices);
            this.stateManager.setSelectedSliceIndex(null);
            this.render();
        }
    }

    private addNewGaugeToNode(vgNode: Node, model: Model): void {
        const currentGauges = [...(vgNode.parameters.gauges || [])];
        const is3D = model.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D');
        const nextIdx = currentGauges.length + 1;
        const newGauge = is3D
            ? { id: `G${nextIdx}`, name: `Gauge ${nextIdx}`, x: 0.5, y: 0.5, z: 0.5, active: true, plot: true }
            : { id: `G${nextIdx}`, name: `Gauge ${nextIdx}`, r: 0.1, z: 0.0, active: true, plot: true };
        const updated = [...currentGauges, newGauge];
        this.stateManager.updateNodeParametersInPlace(vgNode.id, { gauges: updated });
        this.activeModelId = model.id;
        this.stateManager.selectNode(model.id, vgNode.id);
        this.selectedGaugeIndex = updated.length - 1;
        this.stateManager.setSelectedSliceIndex(null);
        this.render({ scrollSelectedIntoView: true });
    }

    private deleteGaugeFromNode(vgNode: Node, idx: number, model: Model): void {
        const currentGauges = [...(vgNode.parameters.gauges || [])];
        if (idx >= 0 && idx < currentGauges.length) {
            currentGauges.splice(idx, 1);
            this.stateManager.updateNodeParametersInPlace(vgNode.id, { gauges: currentGauges });
            this.selectedGaugeIndex = null;
            this.render();
        }
    }

    private showSliceContextMenu(e: MouseEvent, domainNode: Node, slice: any, idx: number, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `Slice #${idx} (${getSliceAxisLabel(slice.axis)}) · ${domainNode.parameters.name || domainNode.id}`;
        menu.appendChild(title);

        // Rename Slice Plane
        const renameItem = document.createElement('div');
        renameItem.className = 'context-menu-item';
        renameItem.textContent = '✏ Rename Slice Plane (F2)';
        renameItem.addEventListener('click', () => {
            menu.remove();
            const labelEl = this.rootElement.querySelector(`[data-node-id="${domainNode.id}"][data-slice-index="${idx}"] .pipeline-node-label`) as HTMLElement;
            if (labelEl) {
                this.startInPlaceSliceRename(domainNode, idx, slice, labelEl);
            }
        });
        menu.appendChild(renameItem);

        // Toggle Visibility
        const visItem = document.createElement('div');
        visItem.className = 'context-menu-item';
        visItem.textContent = slice.enabled !== false ? '👁 Hide Slice Plane' : '👁 Show Slice Plane';
        visItem.addEventListener('click', () => {
            menu.remove();
            slice.enabled = !(slice.enabled !== false);
            const currentSlices = [...(domainNode.parameters.slices || [])];
            currentSlices[idx] = { ...slice, enabled: slice.enabled };
            this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
            (window as any).transportController?.onSliceConfigChange?.(currentSlices);
            this.render();
        });
        menu.appendChild(visItem);

        // Duplicate
        const dupItem = document.createElement('div');
        dupItem.className = 'context-menu-item';
        dupItem.textContent = '📑 Duplicate Slice Plane';
        dupItem.addEventListener('click', () => {
            menu.remove();
            const currentSlices = [...(domainNode.parameters.slices || [])];
            const clone = JSON.parse(JSON.stringify(slice));
            if (clone.name) clone.name += ' (Copy)';
            currentSlices.push(clone);
            this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
            (window as any).transportController?.onSliceConfigChange?.(currentSlices);
            this.stateManager.setSelectedSliceIndex(currentSlices.length - 1);
            this.render();
        });
        menu.appendChild(dupItem);

        // Focus in Slices Matrix Workstation Bar
        const focusItem = document.createElement('div');
        focusItem.className = 'context-menu-item';
        focusItem.textContent = '🥞 Open in Slices Matrix';
        focusItem.addEventListener('click', () => {
            menu.remove();
            (window as any).transportController?.switchTab?.('slices_matrix');
            (window as any).transportController?.setActiveSliceIndex?.(idx);
        });
        menu.appendChild(focusItem);

        // Delete
        const delItem = document.createElement('div');
        delItem.className = 'context-menu-item danger';
        delItem.textContent = '🗑 Delete Slice Plane';
        delItem.addEventListener('click', () => {
            menu.remove();
            this.deleteSliceFromDomain(domainNode, idx, model);
        });
        menu.appendChild(delItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private showGaugeContextMenu(e: MouseEvent, vgNode: Node, gauge: any, idx: number, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const defaultName = `Gauge ${gauge.id || '#' + (idx + 1)}`;
        const customName = gauge.name || defaultName;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `${customName} · ${vgNode.parameters.name || vgNode.id}`;
        menu.appendChild(title);

        // Rename
        const renameItem = document.createElement('div');
        renameItem.className = 'context-menu-item';
        renameItem.textContent = '✏ Rename Gauge Probe (F2)';
        renameItem.addEventListener('click', () => {
            menu.remove();
            const labelEl = this.rootElement.querySelector(`[data-node-id="${vgNode.id}"][data-gauge-index="${idx}"] .pipeline-node-label`) as HTMLElement;
            if (labelEl) {
                this.startInPlaceGaugeRename(vgNode, idx, gauge, labelEl);
            }
        });
        menu.appendChild(renameItem);

        // Toggle Plotting
        const visItem = document.createElement('div');
        visItem.className = 'context-menu-item';
        visItem.textContent = gauge.plot !== false ? '👁 Disable Plotting' : '👁 Enable Plotting';
        visItem.addEventListener('click', () => {
            menu.remove();
            const isPlot = !(gauge.plot !== false);
            gauge.plot = isPlot;
            const currentGauges = [...(vgNode.parameters.gauges || [])];
            currentGauges[idx] = { ...gauge, plot: isPlot };
            this.stateManager.updateNodeParametersInPlace(vgNode.id, { gauges: currentGauges });
            this.render();
        });
        menu.appendChild(visItem);

        // Duplicate
        const dupItem = document.createElement('div');
        dupItem.className = 'context-menu-item';
        dupItem.textContent = '📑 Duplicate Gauge Probe';
        dupItem.addEventListener('click', () => {
            menu.remove();
            const currentGauges = [...(vgNode.parameters.gauges || [])];
            const clone = JSON.parse(JSON.stringify(gauge));
            clone.id = (gauge.id || `G${idx + 1}`) + '_copy';
            clone.name = (gauge.name || gauge.id || `G${idx + 1}`) + ' (Copy)';
            currentGauges.push(clone);
            this.stateManager.updateNodeParametersInPlace(vgNode.id, { gauges: currentGauges });
            this.selectedGaugeIndex = currentGauges.length - 1;
            this.render();
        });
        menu.appendChild(dupItem);

        // Edit Coordinates / Location
        if (vgNode.parameters.source_mode !== 'external_file') {
            const editPosItem = document.createElement('div');
            editPosItem.className = 'context-menu-item';
            editPosItem.textContent = '📍 Edit Location / Coordinates...';
            editPosItem.addEventListener('click', () => {
                menu.remove();
                this.promptEditGaugeCoordinates(vgNode, idx, gauge, model);
            });
            menu.appendChild(editPosItem);
        }

        // Delete
        const delItem = document.createElement('div');
        delItem.className = 'context-menu-item danger';
        delItem.textContent = '🗑 Delete Gauge Probe';
        delItem.addEventListener('click', () => {
            menu.remove();
            this.deleteGaugeFromNode(vgNode, idx, model);
        });
        menu.appendChild(delItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private promptEditGaugeCoordinates(vgNode: Node, idx: number, gauge: any, model: Model): void {
        const is3D = gauge.is_3d ?? (gauge.x !== undefined || gauge.y !== undefined || vgNode.parameters.domain_type === '3D');
        const defaultPrompt = is3D ? `${gauge.x ?? 0}, ${gauge.y ?? 0}, ${gauge.z ?? 0}` : `${gauge.r ?? 0}, ${gauge.z ?? 0}`;
        const input = window.prompt(is3D ? 'Enter probe coordinates (x, y, z in meters):' : 'Enter probe coordinates (radius r, height z in meters):', defaultPrompt);
        if (!input) return;

        const parts = input.split(',').map(s => parseFloat(s.trim()));
        if (is3D && parts.length >= 3 && !parts.slice(0, 3).some(isNaN)) {
            const currentGauges = [...(vgNode.parameters.gauges || [])];
            currentGauges[idx] = { ...gauge, x: parts[0], y: parts[1], z: parts[2] };
            this.stateManager.updateNodeParameters(vgNode.id, { gauges: currentGauges });
            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
            this.render();
        } else if (!is3D && parts.length >= 2 && !parts.slice(0, 2).some(isNaN)) {
            const currentGauges = [...(vgNode.parameters.gauges || [])];
            currentGauges[idx] = { ...gauge, r: parts[0], z: parts[1] };
            this.stateManager.updateNodeParameters(vgNode.id, { gauges: currentGauges });
            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
            this.render();
        } else {
            alert('Invalid coordinate format. Please provide numbers separated by commas.');
        }
    }

    private createActiveGaugeInspectionCard(vgNode: Node, idx: number, model: Model): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pipeline-gauge-inspector-card';
        card.style.background = '#18181b';
        card.style.border = '1px solid #3f3f46';
        card.style.borderRadius = '6px';
        card.style.margin = '4px 8px 8px 24px';
        card.style.padding = '8px 10px';
        card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '6px';

        const gauges: any[] = vgNode.parameters.gauges || [];
        const gauge = gauges[idx] || { id: `P${idx + 1}` };
        const name = gauge.name || gauge.id || `Probe #${idx + 1}`;
        const posStr = gauge.x !== undefined ? `(${gauge.x}, ${gauge.y}, ${gauge.z})` : (gauge.r !== undefined ? `(R:${gauge.r}, Z:${gauge.z})` : 'External Coords');

        // Header with close button
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';

        const title = document.createElement('span');
        title.style.fontWeight = 'bold';
        title.style.fontSize = '11px';
        title.style.color = '#38bdf8';
        title.textContent = `🎯 ${name}`;

        const closeBtn = document.createElement('button');
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#71717a';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '11px';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close Inspection Panel';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            this.selectedGaugeIndex = null;
            this.render();
        };

        header.appendChild(title);
        header.appendChild(closeBtn);
        card.appendChild(header);

        // Coordinates Subtitle
        const posSubtitle = document.createElement('div');
        posSubtitle.style.fontSize = '10px';
        posSubtitle.style.color = '#a1a1aa';
        posSubtitle.textContent = `Pos: ${posStr}`;
        card.appendChild(posSubtitle);

        // Telemetry metrics
        const history = this.stateManager.getTelemetry(vgNode.id);
        const histItem = history?.[idx] || history?.gauges_history?.[idx];
        let pPeak = 0;
        let impPeak = 0;
        let pVals: number[] = [];

        if (histItem && histItem.channel_values) {
            const pArray = histItem.channel_values[0] || [];
            const impArray = histItem.channel_values[8] || [];
            pVals = pArray;
            pPeak = pArray.length > 0 ? Math.max(...pArray) : 0;
            impPeak = impArray.length > 0 ? impArray[impArray.length - 1] : 0;
        }

        const statsRow = document.createElement('div');
        statsRow.style.display = 'flex';
        statsRow.style.gap = '8px';
        statsRow.style.fontSize = '10px';

        const peakBadge = document.createElement('span');
        peakBadge.style.background = '#27272a';
        peakBadge.style.padding = '2px 5px';
        peakBadge.style.borderRadius = '3px';
        peakBadge.style.color = '#f43f5e';
        peakBadge.textContent = `P_max: ${(pPeak / 1e3).toFixed(1)} kPa`;

        const impBadge = document.createElement('span');
        impBadge.style.background = '#27272a';
        impBadge.style.padding = '2px 5px';
        impBadge.style.borderRadius = '3px';
        impBadge.style.color = '#38bdf8';
        impBadge.textContent = `Impulse: ${impPeak.toFixed(1)} Pa·s`;

        statsRow.appendChild(peakBadge);
        statsRow.appendChild(impBadge);
        card.appendChild(statsRow);

        // Mini Canvas Sparkline
        const canvas = document.createElement('canvas');
        canvas.width = 220;
        canvas.height = 45;
        canvas.style.width = '100%';
        canvas.style.height = '45px';
        canvas.style.background = '#09090b';
        canvas.style.borderRadius = '3px';
        canvas.style.border = '1px solid #27272a';

        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = '#09090b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (pVals.length > 1) {
                const min = Math.min(...pVals);
                const max = Math.max(...pVals, min + 1);
                ctx.beginPath();
                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 1.5;
                for (let i = 0; i < pVals.length; i++) {
                    const x = (i / (pVals.length - 1)) * canvas.width;
                    const y = canvas.height - ((pVals[i] - min) / (max - min)) * (canvas.height - 6) - 3;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            } else {
                ctx.fillStyle = '#52525b';
                ctx.font = '9px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('Awaiting Telemetry...', canvas.width / 2, canvas.height / 2 + 3);
            }
        }
        card.appendChild(canvas);

        // Action Toolbar
        const actionsRow = document.createElement('div');
        actionsRow.style.display = 'flex';
        actionsRow.style.gap = '6px';
        actionsRow.style.marginTop = '2px';

        // Pin/Unpin Button
        const pinnedIds: string[] = vgNode.parameters.pinned_probe_ids || [];
        const isPinned = pinnedIds.includes(String(gauge.id || idx));
        const pinBtn = document.createElement('button');
        pinBtn.style.flex = '1';
        pinBtn.style.padding = '3px 6px';
        pinBtn.style.fontSize = '9px';
        pinBtn.style.borderRadius = '3px';
        pinBtn.style.border = '1px solid #3f3f46';
        pinBtn.style.cursor = 'pointer';
        pinBtn.style.background = isPinned ? '#1e3a5f' : '#27272a';
        pinBtn.style.color = isPinned ? '#38bdf8' : '#e4e4e7';
        pinBtn.textContent = isPinned ? '📌 Pinned' : '📌 Pin';
        pinBtn.title = isPinned ? 'Unpin from live stream' : 'Pin to live WebSocket telemetry & 60 FPS charts';
        pinBtn.onclick = (e) => {
            e.stopPropagation();
            const idStr = String(gauge.id || idx);
            let updatedPinned = [...pinnedIds];
            if (isPinned) {
                updatedPinned = updatedPinned.filter(id => id !== idStr);
            } else {
                if (updatedPinned.length < 16) {
                    updatedPinned.push(idStr);
                }
            }
            this.stateManager.updateNodeParametersInPlace(vgNode.id, { pinned_probe_ids: updatedPinned });
            this.render();
        };

        // Export CSV Button
        const exportBtn = document.createElement('button');
        exportBtn.style.flex = '1';
        exportBtn.style.padding = '3px 6px';
        exportBtn.style.fontSize = '9px';
        exportBtn.style.borderRadius = '3px';
        exportBtn.style.border = '1px solid #3f3f46';
        exportBtn.style.background = '#27272a';
        exportBtn.style.color = '#e4e4e7';
        exportBtn.style.cursor = 'pointer';
        exportBtn.textContent = '💾 CSV';
        exportBtn.title = 'Export this probe history to CSV';
        exportBtn.onclick = (e) => {
            e.stopPropagation();
            this.exportSingleProbeCSV(vgNode, idx);
        };

        actionsRow.appendChild(pinBtn);
        actionsRow.appendChild(exportBtn);
        card.appendChild(actionsRow);

        return card;
    }

    private openMassiveGaugeExplorer(vgNode: Node, model: Model): void {
        const existing = document.querySelector('.pipeline-gauge-explorer-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'pipeline-gauge-explorer-modal';
        modal.style.position = 'fixed';
        modal.style.top = '10%';
        modal.style.left = '50%';
        modal.style.transform = 'translateX(-50%)';
        modal.style.width = '600px';
        modal.style.maxHeight = '75vh';
        modal.style.background = '#18181b';
        modal.style.border = '1px solid #3f3f46';
        modal.style.borderRadius = '8px';
        modal.style.boxShadow = '0 12px 36px rgba(0,0,0,0.7)';
        modal.style.zIndex = '9999';
        modal.style.display = 'flex';
        modal.style.flexDirection = 'column';
        modal.style.overflow = 'hidden';

        // Header
        const header = document.createElement('div');
        header.style.padding = '12px 16px';
        header.style.background = '#27272a';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.borderBottom = '1px solid #3f3f46';

        const title = document.createElement('div');
        title.style.fontWeight = 'bold';
        title.style.fontSize = '13px';
        title.style.color = '#38bdf8';
        title.textContent = `🔍 Virtual Gauge Explorer — ${vgNode.parameters.name || vgNode.id}`;

        const closeBtn = document.createElement('button');
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#a1a1aa';
        closeBtn.style.fontSize = '16px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.textContent = '✕';
        closeBtn.onclick = () => modal.remove();

        header.appendChild(title);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Filter Controls Bar
        const filterBar = document.createElement('div');
        filterBar.style.padding = '10px 16px';
        filterBar.style.background = '#1f1f23';
        filterBar.style.borderBottom = '1px solid #27272a';
        filterBar.style.display = 'flex';
        filterBar.style.gap = '8px';
        filterBar.style.alignItems = 'center';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search by ID, name, or index (e.g. #1042)...';
        searchInput.style.flex = '1';
        searchInput.style.padding = '6px 10px';
        searchInput.style.background = '#09090b';
        searchInput.style.border = '1px solid #3f3f46';
        searchInput.style.borderRadius = '4px';
        searchInput.style.color = '#fff';
        searchInput.style.fontSize = '11px';
        filterBar.appendChild(searchInput);

        modal.appendChild(filterBar);

        // Table Container
        const tableContainer = document.createElement('div');
        tableContainer.style.flex = '1';
        tableContainer.style.overflowY = 'auto';
        tableContainer.style.padding = '0 16px';
        modal.appendChild(tableContainer);

        // Footer Pagination
        const footer = document.createElement('div');
        footer.style.padding = '8px 16px';
        footer.style.background = '#27272a';
        footer.style.borderTop = '1px solid #3f3f46';
        footer.style.display = 'flex';
        footer.style.justifyContent = 'space-between';
        footer.style.alignItems = 'center';
        footer.style.fontSize = '11px';
        footer.style.color = '#a1a1aa';

        const pageInfo = document.createElement('span');
        const paginationBtns = document.createElement('div');
        paginationBtns.style.display = 'flex';
        paginationBtns.style.gap = '6px';

        const prevBtn = document.createElement('button');
        prevBtn.textContent = '◀ Prev';
        prevBtn.style.padding = '4px 8px';
        prevBtn.style.background = '#3f3f46';
        prevBtn.style.border = 'none';
        prevBtn.style.borderRadius = '3px';
        prevBtn.style.color = '#fff';
        prevBtn.style.cursor = 'pointer';

        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next ▶';
        nextBtn.style.padding = '4px 8px';
        nextBtn.style.background = '#3f3f46';
        nextBtn.style.border = 'none';
        nextBtn.style.borderRadius = '3px';
        nextBtn.style.color = '#fff';
        nextBtn.style.cursor = 'pointer';

        paginationBtns.appendChild(prevBtn);
        paginationBtns.appendChild(nextBtn);
        footer.appendChild(pageInfo);
        footer.appendChild(paginationBtns);
        modal.appendChild(footer);

        let currentPage = 1;
        const pageSize = 50;

        const isExternal = vgNode.parameters.source_mode === 'external_file';
        const rawGauges: any[] = vgNode.parameters.gauges || [];
        const externalCount = vgNode.parameters.external_probe_count || 0;

        const renderTable = () => {
            tableContainer.innerHTML = '';
            const query = searchInput.value.toLowerCase().trim();

            let displayGauges: any[] = [];
            if (!isExternal) {
                displayGauges = rawGauges.filter((g, idx) => {
                    const idStr = String(g.id || `P${idx + 1}`).toLowerCase();
                    const nameStr = String(g.name || '').toLowerCase();
                    const idxStr = `#${idx + 1}`;
                    return !query || idStr.includes(query) || nameStr.includes(query) || idxStr.includes(query);
                });
            } else {
                const count = externalCount > 0 ? externalCount : 1000;
                for (let i = 0; i < count; i++) {
                    const idStr = `P${i + 1}`;
                    const idxStr = `#${i + 1}`;
                    if (!query || idStr.toLowerCase().includes(query) || idxStr.includes(query)) {
                        displayGauges.push({ id: idStr, idx: i, isExt: true });
                    }
                    if (displayGauges.length >= 5000) break;
                }
            }

            const totalPages = Math.max(1, Math.ceil(displayGauges.length / pageSize));
            if (currentPage > totalPages) currentPage = totalPages;
            pageInfo.textContent = `Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, displayGauges.length)} of ${displayGauges.length.toLocaleString()} matching probes`;

            prevBtn.disabled = currentPage <= 1;
            nextBtn.disabled = currentPage >= totalPages;
            prevBtn.style.opacity = currentPage <= 1 ? '0.5' : '1.0';
            nextBtn.style.opacity = currentPage >= totalPages ? '0.5' : '1.0';

            const table = document.createElement('table');
            table.style.width = '100%';
            table.style.borderCollapse = 'collapse';
            table.style.fontSize = '11px';

            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr style="border-bottom: 1px solid #3f3f46; color: #71717a; text-align: left;">
                    <th style="padding: 8px 4px;">ID / Index</th>
                    <th style="padding: 8px 4px;">Position</th>
                    <th style="padding: 8px 4px; text-align: right;">Actions</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            const pageItems = displayGauges.slice((currentPage - 1) * pageSize, currentPage * pageSize);

            const pinnedIds: string[] = vgNode.parameters.pinned_probe_ids || [];

            pageItems.forEach((item: any) => {
                const originalIdx = item.isExt ? item.idx : rawGauges.indexOf(item);
                const posStr = item.x !== undefined ? `(${item.x}, ${item.y}, ${item.z})` : (item.r !== undefined ? `(R:${item.r}, Z:${item.z})` : 'External Buffer');
                const isPinned = pinnedIds.includes(String(item.id || originalIdx));

                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid #27272a';
                tr.style.cursor = 'pointer';
                tr.onmouseenter = () => tr.style.background = 'rgba(56, 189, 248, 0.06)';
                tr.onmouseleave = () => tr.style.background = 'transparent';

                const tdName = document.createElement('td');
                tdName.style.padding = '6px 4px';
                tdName.textContent = item.name || item.id || `Probe #${originalIdx + 1}`;

                const tdPos = document.createElement('td');
                tdPos.style.padding = '6px 4px';
                tdPos.style.color = '#a1a1aa';
                tdPos.textContent = posStr;

                const tdActions = document.createElement('td');
                tdActions.style.padding = '6px 4px';
                tdActions.style.textAlign = 'right';

                const inspectBtn = document.createElement('button');
                inspectBtn.textContent = 'Inspect';
                inspectBtn.style.padding = '2px 6px';
                inspectBtn.style.fontSize = '9px';
                inspectBtn.style.borderRadius = '3px';
                inspectBtn.style.border = '1px solid #0284c7';
                inspectBtn.style.background = '#0369a1';
                inspectBtn.style.color = '#fff';
                inspectBtn.style.cursor = 'pointer';
                inspectBtn.style.marginRight = '4px';
                inspectBtn.onclick = (e) => {
                    e.stopPropagation();
                    modal.remove();
                    this.activeModelId = model.id;
                    this.stateManager.selectNode(model.id, vgNode.id);
                    this.selectedGaugeIndex = originalIdx;
                    this.stateManager.setSelectedGaugeIndex(originalIdx);
                    this.render({ scrollSelectedIntoView: true });
                };

                const pinBtn = document.createElement('button');
                pinBtn.textContent = isPinned ? 'Pinned' : 'Pin';
                pinBtn.style.padding = '2px 6px';
                pinBtn.style.fontSize = '9px';
                pinBtn.style.borderRadius = '3px';
                pinBtn.style.border = '1px solid #3f3f46';
                pinBtn.style.background = isPinned ? '#1e3a5f' : '#27272a';
                pinBtn.style.color = isPinned ? '#38bdf8' : '#ccc';
                pinBtn.style.cursor = 'pointer';
                pinBtn.onclick = (e) => {
                    e.stopPropagation();
                    const idStr = String(item.id || originalIdx);
                    let updatedPinned = [...pinnedIds];
                    if (isPinned) {
                        updatedPinned = updatedPinned.filter(id => id !== idStr);
                    } else {
                        if (updatedPinned.length < 16) updatedPinned.push(idStr);
                    }
                    this.stateManager.updateNodeParametersInPlace(vgNode.id, { pinned_probe_ids: updatedPinned });
                    renderTable();
                    this.render();
                };

                tdActions.appendChild(inspectBtn);
                tdActions.appendChild(pinBtn);

                tr.appendChild(tdName);
                tr.appendChild(tdPos);
                tr.appendChild(tdActions);

                tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            tableContainer.appendChild(table);
        };

        searchInput.oninput = () => {
            currentPage = 1;
            renderTable();
        };

        prevBtn.onclick = () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        };

        nextBtn.onclick = () => {
            currentPage++;
            renderTable();
        };

        renderTable();
        document.body.appendChild(modal);
    }

    private exportSingleProbeCSV(node: Node, gaugeIdx: number): void {
        const history = this.stateManager.getTelemetry(node.id);
        const gauges: any[] = node.parameters.gauges || [];
        const gauge = gauges[gaugeIdx] || { id: `P${gaugeIdx + 1}` };
        const times: number[] = history?.times || [];
        const histItem = history?.[gaugeIdx] || history?.gauges_history?.[gaugeIdx];
        
        let csvContent = `time_s,pressure_Pa,overpressure_Pa,impulse_Pas\n`;
        if (histItem && histItem.channel_values) {
            const pVals = histItem.channel_values[0] || [];
            const opVals = histItem.channel_values[7] || [];
            const impVals = histItem.channel_values[8] || [];
            const len = Math.max(times.length, pVals.length);
            for (let i = 0; i < len; ++i) {
                const t = times[i] !== undefined ? times[i] : i;
                const p = pVals[i] !== undefined ? pVals[i] : '';
                const op = opVals[i] !== undefined ? opVals[i] : '';
                const imp = impVals[i] !== undefined ? impVals[i] : '';
                csvContent += `${t},${p},${op},${imp}\n`;
            }
        }
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `probe_${gauge.id || gaugeIdx + 1}_history.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    public startInPlaceRename(node: Node, labelElement: HTMLElement): void {
        const currentName = node.parameters.name || node.id;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = node.parameters.name || '';
        input.placeholder = node.id;
        input.className = 'pipeline-rename-input';
        
        let isCommitted = false;

        const commitRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            const newName = input.value.trim();
            if (newName !== (node.parameters.name || '')) {
                this.stateManager.updateNodeParameters(node.id, { name: newName || undefined });
            } else {
                labelElement.textContent = node.parameters.name || node.id;
            }
        };

        const cancelRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            labelElement.textContent = node.parameters.name || node.id;
        };

        input.addEventListener('blur', commitRename);
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitRename();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancelRename();
            }
        });
        input.addEventListener('keyup', (ev) => ev.stopPropagation());
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('dblclick', (ev) => ev.stopPropagation());

        labelElement.innerHTML = '';
        labelElement.appendChild(input);
        input.focus();
        input.select();
    }

    public startInPlaceSliceRename(domainNode: Node, sliceIndex: number, slice: any, labelElement: HTMLElement): void {
        const axisLabel = getSliceAxisLabel(slice.axis);
        const defaultName = `Slice #${sliceIndex} (${axisLabel})`;
        const currentName = slice.name || defaultName;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = slice.name || '';
        input.placeholder = defaultName;
        input.className = 'pipeline-rename-input';
        
        let isCommitted = false;

        const commitRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            const newName = input.value.trim();
            const currentSlices = [...(domainNode.parameters.slices || [])];
            if (sliceIndex >= 0 && sliceIndex < currentSlices.length) {
                const targetSlice = { ...currentSlices[sliceIndex] };
                if (newName) {
                    targetSlice.name = newName;
                } else {
                    delete targetSlice.name;
                }
                currentSlices[sliceIndex] = targetSlice;
                this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
                (window as any).transportController?.onSliceConfigChange?.(currentSlices);
                this.render();
            } else {
                labelElement.textContent = slice.name || defaultName;
            }
        };

        const cancelRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            labelElement.textContent = slice.name || defaultName;
        };

        input.addEventListener('blur', commitRename);
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitRename();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancelRename();
            }
        });
        input.addEventListener('keyup', (ev) => ev.stopPropagation());
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('dblclick', (ev) => ev.stopPropagation());

        labelElement.innerHTML = '';
        labelElement.appendChild(input);
        input.focus();
        input.select();
    }

    public startInPlaceGaugeRename(gaugeNode: Node, gaugeIndex: number, gauge: any, labelElement: HTMLElement): void {
        const defaultName = `Gauge ${gauge.id || '#' + (gaugeIndex + 1)}`;
        const currentName = gauge.name || defaultName;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = gauge.name || gauge.id || '';
        input.placeholder = defaultName;
        input.className = 'pipeline-rename-input';
        
        let isCommitted = false;

        const commitRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            const newName = input.value.trim();
            const currentGauges = [...(gaugeNode.parameters.gauges || [])];
            if (gaugeIndex >= 0 && gaugeIndex < currentGauges.length) {
                const targetGauge = { ...currentGauges[gaugeIndex] };
                if (newName) {
                    targetGauge.name = newName;
                    targetGauge.id = newName;
                } else {
                    delete targetGauge.name;
                }
                currentGauges[gaugeIndex] = targetGauge;
                this.stateManager.updateNodeParametersInPlace(gaugeNode.id, { gauges: currentGauges });
                this.render();
            } else {
                labelElement.textContent = gauge.name || gauge.id || defaultName;
            }
        };

        const cancelRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            labelElement.textContent = gauge.name || gauge.id || defaultName;
        };

        input.addEventListener('blur', commitRename);
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitRename();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancelRename();
            }
        });
        input.addEventListener('keyup', (ev) => ev.stopPropagation());
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('dblclick', (ev) => ev.stopPropagation());

        labelElement.innerHTML = '';
        labelElement.appendChild(input);
        input.focus();
        input.select();
    }

    public startModelRename(model: Model, targetElement: HTMLElement): void {
        const isSelect = targetElement instanceof HTMLSelectElement || targetElement.tagName === 'SELECT';
        if (isSelect && targetElement.style.display === 'none') {
            const existingInput = targetElement.parentElement?.querySelector('.pipeline-model-rename-input') as HTMLInputElement;
            if (existingInput) {
                existingInput.focus();
                existingInput.select();
                return;
            }
        }

        const currentName = model.name || model.id;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = model.name || '';
        input.placeholder = model.id;
        input.className = 'pipeline-rename-input pipeline-model-rename-input';
        
        let isCommitted = false;

        const cleanup = () => {
            if (isSelect) {
                input.remove();
                targetElement.style.display = '';
            }
        };

        const commitRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            cleanup();
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                this.stateManager.renameModel(model.id, newName);
            }
            this.render();
        };

        const cancelRename = () => {
            if (isCommitted) return;
            isCommitted = true;
            cleanup();
            this.render();
        };

        input.addEventListener('blur', commitRename);
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitRename();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancelRename();
            }
        });
        input.addEventListener('keyup', (ev) => ev.stopPropagation());
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('dblclick', (ev) => ev.stopPropagation());
        input.addEventListener('mousedown', (ev) => ev.stopPropagation());

        if (isSelect) {
            targetElement.style.display = 'none';
            if (targetElement.parentElement) {
                targetElement.parentElement.insertBefore(input, targetElement);
            }
            input.style.width = '140px';
            input.style.maxWidth = '170px';
            input.style.boxSizing = 'border-box';
        } else {
            targetElement.innerHTML = '';
            targetElement.appendChild(input);
        }

        input.focus();
        input.select();
    }

    private getNodeTypeSummary(node: Node): string {
        switch (node.type) {
            case 'CFDSolver3D':
                return `${node.parameters.device || 'GPU'} ${node.parameters.temporal_order ? node.parameters.temporal_order + '-Ord' : 'ADER-2'}`;
            case 'FEMDomain3D':
                return `${node.parameters.device || 'GPU'} FEM`;
            case 'MPMDomain3D':
                return `${node.parameters.device || 'GPU'} MPM`;
            case 'Material':
            case 'MPMMaterialSteel' as any:
            case 'MPMMaterial' as any:
            case 'MaterialSteel' as any: {
                const matType = node.parameters.material_type;
                if (matType === 'Air') return node.parameters.preset || 'Air (Ambient STP)';
                if (matType === 'JWL Charge') return `JWL (${node.parameters.composition || 'TNT'})`;
                if (matType === 'Ideal Gas Charge') return `Ideal Gas (${node.parameters.composition || 'TNT'})`;
                return node.parameters.preset || node.parameters.material_model || 'Material';
            }
            case 'Charge3D':
                return `${node.parameters.charge_mass || '0.85'} kg`;
            case 'DomainMesh3D':
                return `${node.parameters.nx || 100}x${node.parameters.ny || 100}x${node.parameters.nz || 100}`;
            case 'STLGeometry':
                return node.parameters.file_path ? (String(node.parameters.file_path).split('/').pop() || 'STL') : 'STL CAD';
            case 'PrimitiveGeometry3D':
                return node.parameters.shape_type || 'CSG Primitive';
            case 'FSICoupler2D':
                return '2D CFD-MPM';
            case 'FSICoupler3D':
                return '3D CFD-MPM';
            case 'FEMFSICoupler3D':
                return '3D CFD-FEM';
            case 'MPMObject2D':
                return node.parameters.shape_type || 'MPM 2D';
            case 'MPMObject3D':
                return node.parameters.shape_type || 'MPM 3D';
            case 'FEMObject3D':
                return node.parameters.mesh_source || 'FEM 3D';
            case 'LSDynaImporter3D':
                return node.parameters.file_path ? (String(node.parameters.file_path).split('/').pop() || 'LS-DYNA') : 'LS-DYNA';
            case 'VirtualGauges': {
                const isExternal = node.parameters.source_mode === 'external_file';
                const count = isExternal ? (node.parameters.external_probe_count || 0) : (node.parameters.gauges?.length || 0);
                return `${count} probe${count === 1 ? '' : 's'}`;
            }
            default:
                return node.type;
        }
    }

    private handleSelectionChange(nodeId: string | null, sliceIdx: number | null, gaugeIdx: number | null): void {
        if (!nodeId) {
            this.updateSelectionHighlight();
            return;
        }

        const models = this.stateManager.getWorkspaceModels();
        const owningModel = models.find(m => m.nodes.some(n => n.id === nodeId));
        const node = owningModel?.nodes.find(n => n.id === nodeId);

        let needsRerender = false;

        if (owningModel) {
            // Auto-expand pipeline group if collapsed
            const groups = this.buildPipelineGroups(models);
            const group = groups.find(g => g.models.some(m => m.id === owningModel.id));
            if (group && this.collapsedPipelineGroups.has(group.id)) {
                this.collapsedPipelineGroups.delete(group.id);
                needsRerender = true;
            }

            // Auto-expand model if collapsed
            if (this.collapsedModels.has(owningModel.id)) {
                this.collapsedModels.delete(owningModel.id);
                needsRerender = true;
            }

            // Auto-expand category if collapsed
            if (node) {
                const cat = CATEGORIES.find(c => c.types.includes(node.type));
                if (cat && this.collapsedCategories.has(cat.id)) {
                    this.collapsedCategories.delete(cat.id);
                    needsRerender = true;
                } else if (!cat && this.collapsedCategories.has('other')) {
                    this.collapsedCategories.delete('other');
                    needsRerender = true;
                }
            }
        }

        if (needsRerender) {
            this.saveSettings();
            this.render({ scrollSelectedIntoView: true });
        } else {
            this.updateSelectionHighlight(true);
        }
    }

    private updateSelectionHighlight(scrollIntoViewIfOutOfSight: boolean = false): void {
        const selectedId = this.stateManager.selectedNodeId;
        const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
        const selectedGaugeIdx = this.selectedGaugeIndex;

        let activeSelectedEl: HTMLElement | null = null;

        const allItems = this.rootElement.querySelectorAll('.pipeline-node-item');
        allItems.forEach(el => {
            const hEl = el as HTMLElement;
            const nodeId = hEl.dataset.nodeId;
            const sliceIdx = hEl.dataset.sliceIndex;
            const gaugeIdx = hEl.dataset.gaugeIndex;

            let isMatch = false;
            if (sliceIdx !== undefined) {
                if (nodeId === selectedId && selectedSliceIdx !== null && String(selectedSliceIdx) === sliceIdx) {
                    isMatch = true;
                }
            } else if (gaugeIdx !== undefined) {
                if (nodeId === selectedId && selectedGaugeIdx !== null && String(selectedGaugeIdx) === gaugeIdx) {
                    isMatch = true;
                }
            } else {
                if (nodeId === selectedId && selectedSliceIdx === null) {
                    isMatch = true;
                }
            }

            if (isMatch) {
                hEl.classList.add('selected');
                activeSelectedEl = hEl;
            } else {
                hEl.classList.remove('selected');
            }
        });

        if (scrollIntoViewIfOutOfSight && activeSelectedEl) {
            this.ensureElementInView(activeSelectedEl);
        }
    }

    private ensureElementInView(el: HTMLElement, smooth: boolean = true): void {
        const treeContainer = this.rootElement.querySelector('.pipeline-tree-container') as HTMLElement;
        if (!treeContainer || !el) return;

        const containerRect = treeContainer.getBoundingClientRect();
        const itemRect = el.getBoundingClientRect();

        const isAbove = itemRect.top < containerRect.top;
        const isBelow = itemRect.bottom > containerRect.bottom;

        if (isAbove || isBelow) {
            el.scrollIntoView({
                block: 'nearest',
                behavior: smooth ? 'smooth' : 'auto'
            });
        }
    }

    private deleteNode(model: Model, nodeId: string): void {
        const state = this.stateManager.getCurrentState();
        if (state) {
            state.nodes = state.nodes.filter(n => n.id !== nodeId);
            state.connections = state.connections.filter(c => c.fromNode !== nodeId && c.toNode !== nodeId);
            this.stateManager.selectNode(model.id, null);
            this.stateManager.pushState(state);
            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        }
    }

    private showAddEntityMenu(e: MouseEvent, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = 'Add Entity to Active Model';
        menu.appendChild(title);

        // Dedicated Slices & Cross-Sections in Add Menu
        const sliceCat = document.createElement('div');
        sliceCat.className = 'context-menu-cat';
        sliceCat.textContent = '🥞 Slices & Cross-Sections';
        menu.appendChild(sliceCat);

        [
            { label: '+ Add X-Normal Slice Plane', plane: 'yz' as const },
            { label: '+ Add Y-Normal Slice Plane', plane: 'xz' as const },
            { label: '+ Add Z-Normal Slice Plane', plane: 'xy' as const }
        ].forEach(spec => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.textContent = spec.label;
            item.addEventListener('click', () => {
                menu.remove();
                let targetDomain = model.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh' || n.type === 'DomainMesh2D') ||
                                   model.nodes.find(n => ['CFDSolver3D', 'MPMDomain3D', 'FEMDomain3D', 'Telemetry3DViewport'].includes(n.type));
                if (!targetDomain) {
                    this.addNodeToModel(model, 'DomainMesh3D');
                    const updatedState = this.stateManager.getCurrentState();
                    targetDomain = updatedState?.nodes.find(n => n.type === 'DomainMesh3D');
                }
                if (targetDomain) {
                    this.addNewSliceToDomain(targetDomain, model, spec.plane);
                }
            });
            menu.appendChild(item);
        });

        CATEGORIES.forEach(cat => {
            const catHeader = document.createElement('div');
            catHeader.className = 'context-menu-cat';
            catHeader.textContent = `${cat.icon} ${cat.label}`;
            menu.appendChild(catHeader);

            cat.types.forEach(type => {
                const item = document.createElement('div');
                item.className = 'context-menu-item';
                item.textContent = this.getNodeTypeFriendlyName(type);
                item.addEventListener('click', () => {
                    this.addNodeToModel(model, type);
                    menu.remove();
                });
                menu.appendChild(item);
            });
        });

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private getNodeTypeFriendlyName(type: string): string {
        switch (type) {
            case 'DomainMesh': return 'Domain Mesh (1D)';
            case 'DomainMesh2D': return 'Domain Mesh 2D';
            case 'DomainMesh3D': return 'Domain Mesh 3D';
            case 'RefinementMesh3D': return 'Refinement Mesh 3D';
            case 'Material': return 'Material & EOS';
            case 'Charge1D': return 'Charge 1D';
            case 'Charge2D': return 'Charge 2D';
            case 'Charge3D': return 'Charge 3D';
            case 'DetonatorLocation': return 'Detonator Location (1D/2D)';
            case 'DetonatorLocation3D': return 'Detonator Location 3D';
            case 'CFDSolver': return 'CFD Solver (1D)';
            case 'CFDSolver2D': return 'CFD Solver 2D';
            case 'CFDSolver3D': return 'CFD Solver 3D';
            case 'MPMDomain2D': return 'MPM Domain 2D';
            case 'MPMDomain3D': return 'MPM Domain 3D';
            case 'FEMDomain3D': return 'FEM Domain 3D (Hex8 Explicit)';
            case 'STLGeometry': return 'STL Geometry 3D (CAD Surface)';
            case 'PrimitiveGeometry3D': return 'Primitive Geometry 3D (CSG)';
            case 'MPMObject2D': return 'MPM Object 2D (Primitive)';
            case 'MPMObject3D': return 'MPM Object 3D (Box/Sphere/STL)';
            case 'FEMObject3D': return 'FEM Object 3D (Box Mesh)';
            case 'LSDynaImporter3D': return 'LS-DYNA Importer (.k / .key)';
            case 'FSICoupler2D': return 'FSI Coupler 2D (CFD-MPM)';
            case 'FSICoupler3D': return 'FSI Coupler 3D (CFD-MPM)';
            case 'FEMFSICoupler3D': return 'FEM-CFD FSI Coupler 3D';
            case 'RemapNode': return 'Remapper (1D Baseline)';
            case 'Remap1DTo2DNode': return 'Remapper (1D ➔ 2D)';
            case 'Remap1DTo3DNode': return 'Remapper (1D ➔ 3D)';
            case 'Remap2DTo3DNode': return 'Remapper (2D ➔ 3D)';
            case 'ThePainter': return 'Initializer (The Painter)';
            case 'Telemetry3DViewport': return 'Telemetry - 3D Viewport';
            case 'TelemetryContour': return 'Telemetry - Contour (2D)';
            case 'TelemetryGraph': return 'Telemetry - Graph';
            case 'TelemetryText': return 'Telemetry - Text';
            case 'VirtualGauges': return 'Virtual Gauges';
            case 'VTKOutput': return 'VTK Output Controls';
            case 'HardwareConfig': return 'Hardware Configuration';
            default: return type;
        }
    }

    private showPipelineGroupContextMenu(e: MouseEvent, group: PipelineHierarchyGroup): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `${group.name} (Pipeline)`;
        menu.appendChild(title);

        // Run Pipeline
        const runItem = document.createElement('div');
        runItem.className = 'context-menu-item';
        runItem.textContent = '⚡ Run Full Pipeline';
        runItem.addEventListener('click', () => {
            menu.remove();
            if ((window as any).executeWorkspacePipeline) {
                (window as any).executeWorkspacePipeline();
            } else if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(group.models[0].id, 'EXEC_ALL');
            }
        });
        menu.appendChild(runItem);

        // Expand All
        const expandItem = document.createElement('div');
        expandItem.className = 'context-menu-item';
        expandItem.textContent = '▼ Expand Pipeline & Models';
        expandItem.addEventListener('click', () => {
            menu.remove();
            this.collapsedPipelineGroups.delete(group.id);
            group.models.forEach(m => this.collapsedModels.delete(m.id));
            CATEGORIES.forEach(c => this.collapsedCategories.delete(c.id));
            this.saveSettings();
            this.render();
        });
        menu.appendChild(expandItem);

        // Collapse All
        const collapseItem = document.createElement('div');
        collapseItem.className = 'context-menu-item';
        collapseItem.textContent = '▶ Collapse Pipeline';
        collapseItem.addEventListener('click', () => {
            menu.remove();
            this.collapsedPipelineGroups.add(group.id);
            this.saveSettings();
            this.render();
        });
        menu.appendChild(collapseItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private showModelContextMenu(e: MouseEvent, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `${model.name || model.id} (Model)`;
        menu.appendChild(title);

        // Rename Model
        const renameItem = document.createElement('div');
        renameItem.className = 'context-menu-item';
        renameItem.textContent = '✏ Rename Model (F2)';
        renameItem.addEventListener('click', () => {
            menu.remove();
            const modelHeaderEl = this.rootElement.querySelector(`[data-model-id="${model.id}"] .pipeline-model-name`) as HTMLElement;
            if (modelHeaderEl) {
                this.startModelRename(model, modelHeaderEl);
            }
        });
        menu.appendChild(renameItem);

        // Set Active Model
        const activeItem = document.createElement('div');
        activeItem.className = 'context-menu-item';
        activeItem.textContent = '🎯 Focus / Set Active';
        activeItem.addEventListener('click', () => {
            menu.remove();
            this.activeModelId = model.id;
            this.stateManager.setActiveModel(model.id);
            this.saveSettings();
            this.render();
        });
        menu.appendChild(activeItem);

        // Expand All
        const expandAllItem = document.createElement('div');
        expandAllItem.className = 'context-menu-item';
        expandAllItem.textContent = '▼ Expand All';
        expandAllItem.addEventListener('click', () => {
            menu.remove();
            this.expandAll();
        });
        menu.appendChild(expandAllItem);

        // Collapse All
        const collapseAllItem = document.createElement('div');
        collapseAllItem.className = 'context-menu-item';
        collapseAllItem.textContent = '▶ Collapse All';
        collapseAllItem.addEventListener('click', () => {
            menu.remove();
            this.collapseAll();
        });
        menu.appendChild(collapseAllItem);

        // Delete Model (if not last model in workspace)
        const allModels = this.stateManager.getWorkspaceModels();
        if (allModels.length > 1) {
            const delItem = document.createElement('div');
            delItem.className = 'context-menu-item danger';
            delItem.textContent = '🗑 Delete Model';
            delItem.addEventListener('click', () => {
                menu.remove();
                if (confirm(`Are you sure you want to delete model "${model.name || model.id}"?`)) {
                    this.stateManager.removeModelFromWorkspace(model.id);
                }
            });
            menu.appendChild(delItem);
        }

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private showCategoryContextMenu(e: MouseEvent, cat: EntityCategory, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `${cat.icon} ${cat.label}`;
        menu.appendChild(title);

        const isCollapsed = this.collapsedCategories.has(cat.id);
        const toggleItem = document.createElement('div');
        toggleItem.className = 'context-menu-item';
        toggleItem.textContent = isCollapsed ? '▼ Expand Category' : '▶ Collapse Category';
        toggleItem.addEventListener('click', () => {
            menu.remove();
            if (isCollapsed) {
                this.collapsedCategories.delete(cat.id);
            } else {
                this.collapsedCategories.add(cat.id);
            }
            this.saveSettings();
            this.render();
        });
        menu.appendChild(toggleItem);

        const expandAllItem = document.createElement('div');
        expandAllItem.className = 'context-menu-item';
        expandAllItem.textContent = '▼ Expand All';
        expandAllItem.addEventListener('click', () => {
            menu.remove();
            this.expandAll();
        });
        menu.appendChild(expandAllItem);

        const collapseAllItem = document.createElement('div');
        collapseAllItem.className = 'context-menu-item';
        collapseAllItem.textContent = '▶ Collapse All';
        collapseAllItem.addEventListener('click', () => {
            menu.remove();
            this.collapseAll();
        });
        menu.appendChild(collapseAllItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private showBackgroundContextMenu(e: MouseEvent, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = 'Pipeline Actions';
        menu.appendChild(title);

        // Expand All
        const expandItem = document.createElement('div');
        expandItem.className = 'context-menu-item';
        expandItem.textContent = '▼ Expand All';
        expandItem.addEventListener('click', () => {
            menu.remove();
            this.expandAll();
        });
        menu.appendChild(expandItem);

        // Collapse All
        const collapseItem = document.createElement('div');
        collapseItem.className = 'context-menu-item';
        collapseItem.textContent = '▶ Collapse All';
        collapseItem.addEventListener('click', () => {
            menu.remove();
            this.collapseAll();
        });
        menu.appendChild(collapseItem);

        // Add Entity
        const addItem = document.createElement('div');
        addItem.className = 'context-menu-item';
        addItem.textContent = '+ Add Filter / Entity...';
        addItem.addEventListener('click', (ev) => {
            menu.remove();
            this.showAddEntityMenu(ev, model);
        });
        menu.appendChild(addItem);

        // Run Pipeline
        const runItem = document.createElement('div');
        runItem.className = 'context-menu-item';
        runItem.textContent = '⚡ Run Workspace Pipeline';
        runItem.addEventListener('click', () => {
            menu.remove();
            if ((window as any).executeWorkspacePipeline) {
                (window as any).executeWorkspacePipeline();
            } else if ((window as any).executeModelCommand) {
                (window as any).executeModelCommand(model.id, 'EXEC_ALL');
            }
        });
        menu.appendChild(runItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private showNodeContextMenu(e: MouseEvent, node: Node, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `${node.type} (${node.id})`;
        menu.appendChild(title);

        // Rename
        const renameItem = document.createElement('div');
        renameItem.className = 'context-menu-item';
        renameItem.textContent = '✏ Rename Entity (F2)';
        renameItem.addEventListener('click', () => {
            menu.remove();
            const labelEl = this.rootElement.querySelector(`[data-node-id="${node.id}"] .pipeline-node-label`) as HTMLElement;
            if (labelEl) {
                this.startInPlaceRename(node, labelEl);
            }
        });
        menu.appendChild(renameItem);

        if (node.type === 'VirtualGauges') {
            const gaugeMgrItem = document.createElement('div');
            gaugeMgrItem.className = 'context-menu-item';
            gaugeMgrItem.textContent = '⏱️ Open Gauge Manager...';
            gaugeMgrItem.addEventListener('click', () => {
                menu.remove();
                new GaugeManagerModal(this.stateManager, node, model, null, () => {
                    this.render();
                });
            });
            menu.appendChild(gaugeMgrItem);
        }

        // Duplicate
        const dupItem = document.createElement('div');
        dupItem.className = 'context-menu-item';
        dupItem.textContent = '📑 Duplicate Entity';
        dupItem.addEventListener('click', () => {
            menu.remove();
            this.duplicateNode(model, node);
        });
        menu.appendChild(dupItem);

        // Delete
        const delItem = document.createElement('div');
        delItem.className = 'context-menu-item danger';
        delItem.textContent = '🗑 Delete Entity';
        delItem.addEventListener('click', () => {
            menu.remove();
            this.deleteNode(model, node.id);
        });
        menu.appendChild(delItem);

        document.body.appendChild(menu);

        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as HTMLElement)) {
                menu.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private addNodeToModel(model: Model, type: NodeType): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const id = this.stateManager.generateUniqueNodeId(type);
        const inputs = this.stateManager.getDefaultInputs(type);
        const outputs = this.stateManager.getDefaultOutputs(type);
        const defaultParams = this.stateManager.getDefaultParameters(type) || {};

        const newNode: Node = {
            id,
            type,
            x: 100,
            y: 100,
            displayMode: 'expanded',
            inputs,
            outputs,
            parameters: { ...defaultParams }
        };

        state.nodes.push(newNode);
        this.stateManager.pushState(state);
        this.stateManager.selectNode(model.id, id);
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
    }

    private duplicateNode(model: Model, node: Node): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const newId = this.stateManager.generateUniqueNodeId(node.type);
        const clonedParams = JSON.parse(JSON.stringify(node.parameters));
        if (clonedParams.name) clonedParams.name += ' (Copy)';

        const newNode: Node = {
            id: newId,
            type: node.type,
            x: (node.x || 100) + 40,
            y: (node.y || 100) + 40,
            displayMode: node.displayMode || 'expanded',
            inputs: JSON.parse(JSON.stringify(node.inputs || [])),
            outputs: JSON.parse(JSON.stringify(node.outputs || [])),
            parameters: clonedParams
        };

        state.nodes.push(newNode);
        this.stateManager.pushState(state);
        this.stateManager.selectNode(model.id, newId);
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
    }

    public destroy(): void {
        if (this.renderRafId !== null) {
            cancelAnimationFrame(this.renderRafId);
            this.renderRafId = null;
        }
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offSelectionChange(this.selectionListener);
        this.stateManager.offSliceSelectionChange(this.sliceSelectionListener);
        this.stateManager.offGaugeSelectionChange(this.gaugeSelectionListener);
        this.stateManager.offModelStatusChange(this.modelStatusListener);
        this.container.innerHTML = '';
    }
}
