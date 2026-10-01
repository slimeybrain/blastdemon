/**
 * BlastDaemon PipelineBrowser
 * ParaView-style hierarchical pipeline tree managing multi-physics models,
 * parent-child entity nesting, visibility toggles, filter pipelines, and execution.
 */

import { StateManager, prepareModelSavePayload, getSliceAxisLabel, isExplosiveMaterialNode, isSeabedMaterialNode, isWaterMaterialNode, isSolidMaterialNode, resolveFEMCounts } from './state-manager.js';
import { Model, Node, NodeType, SimulationStatus } from './types.js';
import { PlatformBridge } from './PlatformBridge.js';
import { CustomDialog } from './custom-dialog.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { GaugeManagerModal } from './gauge-manager-modal.js';
import { PipelineConnectionModal } from './pipeline-connection-modal.js';
import { FEMSetupModal } from './fem-setup-modal.js';
import { isAirMaterialNode, isJWLMaterialNode, isIdealGasMaterialNode } from './serialization.js';

interface EntityCategory {
    id: string;
    label: string;
    icon: string;
    color: string;
    types: NodeType[];
}

export function isNodeTypeInCategory(catId: string, types: NodeType[], type: string): boolean {
    if (types.includes(type as NodeType)) return true;
    if (catId === 'charges' && (type === 'TriggerLocation' || type === 'TriggerLocation3D')) return true;
    if (catId === 'remap' && type === 'RemapNode') return true;
    if (catId === 'geometry' && type === 'Obstacle') return true;
    if (catId === 'materials' && (type === 'MPMMaterialSteel' || type === 'MPMMaterial' || type === 'MaterialSteel')) return true;
    return false;
}

const CATEGORIES: EntityCategory[] = [
    {
        id: 'domain_mesh',
        label: 'Domain & Grid Meshes',
        icon: '📐',
        color: '#4fc3f7',
        types: ['DomainMesh', 'DomainMesh2D', 'DomainMesh3D']
    },
    {
        id: 'materials',
        label: 'Materials & Equations of State',
        icon: '🧪',
        color: '#81c784',
        types: ['Material']
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
        types: ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MPMDomain2D', 'MPMDomain3D', 'FEMDomain3D', 'MarineHarbourDomain']
    },
    {
        id: 'geometry',
        label: 'Geometry & Obstacles',
        icon: '🧊',
        color: '#80deea',
        types: ['STLGeometry', 'PrimitiveGeometry3D', 'Obstacle3D']
    },
    {
        id: 'structures',
        label: 'Structural Bodies & Parts',
        icon: '🏗️',
        color: '#ffd54f',
        types: ['MPMObject2D', 'MPMObject3D', 'FEMObject3D', 'LSDynaImporter3D', 'FEMBeam3D', 'FEMRebar3D']
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
        types: ['Remap1DTo2DNode', 'Remap1DTo3DNode', 'Remap2DTo3DNode', 'ThePainter']
    },
    {
        id: 'sinks',
        label: 'Telemetry, Viewports & Sinks',
        icon: '📊',
        color: '#4db6ac',
        types: ['Telemetry3DViewport', 'TelemetryContour', 'TelemetryGraph', 'TelemetryText', 'VirtualGauges', 'VirtualGauges3D', 'VTKOutput', 'HardwareConfig']
    }
];

export const ALL_CATEGORIZED_TYPES = new Set<string>([
    ...CATEGORIES.flatMap(c => c.types),
    'TriggerLocation', 'TriggerLocation3D', 'RemapNode', 'Obstacle', 'MPMMaterialSteel', 'MPMMaterial', 'MaterialSteel'
]);

const EYE_OPEN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

const PIPELINE_VIEW_MODE_KEY = 'blast_pipeline_view_mode';
const PIPELINE_WIRING_MODE_KEY = 'blast_pipeline_wiring_mode';
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
    private wiringViewMode: 'ALL' | 'FOCUS' = 'ALL';
    private activeModelId: string | null = null;
    public selectedGaugeIndex: number | null = null;
    public selectedChildId: string | null = null;
    private stateListener: () => void;
    private selectionListener: (nodeId: string | null) => void;
    private sliceSelectionListener: (sliceIdx: number | null) => void;
    private gaugeSelectionListener: (gaugeIdx: number | null) => void;
    private modelStatusListener: (modelId: string, status: SimulationStatus) => void;
    private inPlaceListener: (nodeId: string, params: Record<string, any>) => void;

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
                this.selectedChildId = null;
            }
            this.handleSelectionChange(nodeId, null, null);
        };
        this.sliceSelectionListener = (sliceIdx: number | null) => {
            if (sliceIdx !== null) {
                this.selectedGaugeIndex = null;
                this.selectedChildId = null;
            }
            const nodeId = this.stateManager.selectedNodeId;
            this.handleSelectionChange(nodeId, sliceIdx, null);
        };
        this.gaugeSelectionListener = (gaugeIdx: number | null) => {
            if (gaugeIdx !== null) {
                this.stateManager.setSelectedSliceIndex(null);
                this.selectedChildId = null;
            }
            this.selectedGaugeIndex = gaugeIdx;
            const nodeId = this.stateManager.selectedNodeId;
            this.handleSelectionChange(nodeId, null, gaugeIdx);
        };
        this.modelStatusListener = () => this.renderHeader();
        this.inPlaceListener = (nodeId: string, params: Record<string, any>) => {
            if (params.visible !== undefined || params.hidden !== undefined) {
                const item = this.rootElement?.querySelector(`.pipeline-item[data-node-id="${nodeId}"]`);
                if (item) {
                    const eyeBtn = item.querySelector('.pipeline-eye-btn') as HTMLElement;
                    if (eyeBtn) {
                        const isVisible = params.visible !== false && !params.hidden;
                        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
                        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                        eyeBtn.title = isVisible ? 'Hide in viewports' : 'Show in viewports';
                    }
                }
            }
            if (params.show_water_sleeve !== undefined) {
                const sleeveEl = this.rootElement?.querySelector(`.pipeline-child-item[data-node-id="${nodeId}"][data-child-id="water_sleeve"]`);
                if (sleeveEl) {
                    const eyeBtn = sleeveEl.querySelector('.pipeline-eye-btn') as HTMLElement;
                    if (eyeBtn) {
                        const isVisible = params.show_water_sleeve !== false;
                        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
                        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                        eyeBtn.title = isVisible ? 'Hide Water Discretization' : 'Show Water Discretization';
                    }
                }
            }
            if (params.show_soil_mpm !== undefined) {
                const soilEl = this.rootElement?.querySelector(`.pipeline-child-item[data-node-id="${nodeId}"][data-child-id="seabed_soil"]`);
                if (soilEl) {
                    const eyeBtn = soilEl.querySelector('.pipeline-eye-btn') as HTMLElement;
                    if (eyeBtn) {
                        const isVisible = params.show_soil_mpm !== false;
                        eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
                        eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                        eyeBtn.title = isVisible ? 'Hide Soil Scour Zone' : 'Show Soil Scour Zone';
                    }
                }
            }
        };

        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.onSelectionChange(this.selectionListener);
        this.stateManager.onSliceSelectionChange(this.sliceSelectionListener);
        this.stateManager.onGaugeSelectionChange(this.gaugeSelectionListener);
        this.stateManager.onModelStatusChange(this.modelStatusListener);
        this.stateManager.onModelTelemetry((modelId, step, simTime) => {
            const models = this.stateManager.getWorkspaceModels();
            const activeModel = models.find(m => m.id === this.activeModelId) || models[0];
            if (activeModel && activeModel.id === modelId) {
                const readout = this.rootElement?.querySelector('.pipeline-time-readout');
                if (readout) {
                    const timeMs = (simTime * 1000).toFixed(3);
                    readout.textContent = `Step ${step} | ${timeMs} ms`;
                }
            }
        });

        this.buildBaseUI();
        this.render();
    }
    public setSelectedChildId(childId: string | null): void {
        this.selectedChildId = childId;
        this.updateSelectionHighlight();
    }

    private loadSettings(): void {
        try {
            const savedViewMode = localStorage.getItem(PIPELINE_VIEW_MODE_KEY);
            if (savedViewMode === 'ALL_MODELS' || savedViewMode === 'FOCUSED_ONLY') {
                this.viewMode = savedViewMode;
            }

            const savedWiringMode = localStorage.getItem(PIPELINE_WIRING_MODE_KEY);
            if (savedWiringMode === 'ALL' || savedWiringMode === 'FOCUS') {
                this.wiringViewMode = savedWiringMode;
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
            localStorage.setItem(PIPELINE_WIRING_MODE_KEY, this.wiringViewMode);
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
                const catNodes = model.nodes.filter(n => isNodeTypeInCategory(cat.id, cat.types, n.type));
                if (catNodes.length > 0) {
                    const catGroup = this.createCategoryGroup(cat, catNodes, model);
                    treeContainer.appendChild(catGroup);
                }
            }

            // Uncategorized fallback
            const uncategorizedNodes = model.nodes.filter(n => !ALL_CATEGORIZED_TYPES.has(n.type));
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
        if (status === 'INCOMPLETE') {
            const completeness = this.stateManager.isModelComplete(model.id);
            if (!completeness.complete && completeness.reason) {
                statusBadge.title = completeness.reason;
            }
        }

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
            nodes: [],
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
                    if (parsed.refresh_rate !== undefined) {
                        parsed.refresh_rate = Number(parsed.refresh_rate);
                        parsed.fps = parsed.fps !== undefined ? Number(parsed.fps) : StateManager.rateToFps(parsed.refresh_rate);
                    }
                    this.stateManager.addModelToWorkspace(parsed);
                    this.activeModelId = newId;
                    this.stateManager.setActiveModel(newId);
                    this.saveSettings();
                    this.render();
                } else if (parsed && parsed.models) {
                    Object.values(parsed.models).forEach((m: any) => {
                        if (m.filename === undefined) m.filename = null;
                        if (m.refresh_rate !== undefined) {
                            m.refresh_rate = Number(m.refresh_rate);
                            m.fps = m.fps !== undefined ? Number(m.fps) : StateManager.rateToFps(m.refresh_rate);
                        }
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
        if (model.nodes.some(n => n.type === 'MarineHarbourDomain' || n.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || n.parameters?.undex_coupling_method)) return { label: 'UNDEX 3D', color: '#0ea5e9' };
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

        // 1. Explicit user selection via source_model_id takes top priority
        if (remapNode.parameters?.source_model_id) {
            const sourceModel = allModels.find(m => m.id === remapNode.parameters.source_model_id);
            if (sourceModel && sourceModel.id !== model.id) {
                const remapType = remapNode.type === 'Remap2DTo3DNode' ? '2D ➔ 3D' : (remapNode.type === 'Remap1DTo3DNode' ? '1D ➔ 3D' : '1D ➔ 2D');
                return { sourceModel, remapType };
            }
        }

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
        else if (statuses.some(s => s === 'INCOMPLETE')) compositeStatus = 'INCOMPLETE';
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
        if (status === 'INCOMPLETE') {
            const completeness = this.stateManager.isModelComplete(model.id);
            if (!completeness.complete && completeness.reason) {
                statusBadge.title = completeness.reason;
            }
        }
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
                const catNodes = model.nodes.filter(n => isNodeTypeInCategory(cat.id, cat.types, n.type));
                if (catNodes.length > 0) {
                    const catGroup = this.createCategoryGroup(cat, catNodes, model);
                    body.appendChild(catGroup);
                }
            }

            const uncategorizedNodes = model.nodes.filter(n => !ALL_CATEGORIZED_TYPES.has(n.type));
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

            if (model.nodes.length === 0) {
                const emptyRow = document.createElement('div');
                emptyRow.className = 'pipeline-empty-state';
                emptyRow.style.padding = '14px 16px';
                emptyRow.style.color = '#64748b';
                emptyRow.style.fontSize = '11px';
                emptyRow.style.textAlign = 'center';
                emptyRow.innerHTML = `<div style="margin-bottom: 8px;">No items in this model</div>`;
                const addEmptyBtn = document.createElement('button');
                addEmptyBtn.className = 'pipeline-tool-btn add-btn';
                addEmptyBtn.textContent = '+ Add Item';
                addEmptyBtn.addEventListener('click', (e) => this.showAddEntityMenu(e, model));
                emptyRow.appendChild(addEmptyBtn);
                body.appendChild(emptyRow);
            }

            card.appendChild(body);
        }

        return card;
    }

    private createToolbar(model: Model, models?: Model[]): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'pipeline-toolbar';

        // Add Item Dropdown
        const addBtn = document.createElement('button');
        addBtn.className = 'pipeline-tool-btn add-btn';
        addBtn.textContent = '+ Add Item';
        addBtn.title = 'Add physical solver, mesh, material, charge, geometry, body, or sink item';
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

        // Manage Connections Modal
        const connBtn = document.createElement('button');
        connBtn.className = 'pipeline-tool-btn conn-btn';
        connBtn.textContent = '🔗 Connections';
        connBtn.title = 'Manage and wire entity connections in this model (Meshes, Solvers, Detonators, Materials, Objects)';
        connBtn.addEventListener('click', () => {
            new PipelineConnectionModal(this.stateManager, model, () => {
                this.render();
            });
        });

        toolbar.appendChild(addBtn);
        toolbar.appendChild(deleteBtn);
        toolbar.appendChild(connBtn);
        toolbar.appendChild(runAllBtn);

        // Wiring View Mode Toggle (All Wiring vs Focus Wiring)
        const wiringToggleBtn = document.createElement('button');
        wiringToggleBtn.className = `pipeline-tool-btn wiring-toggle-btn ${this.wiringViewMode === 'FOCUS' ? 'is-collapsed' : ''}`;
        wiringToggleBtn.title = this.wiringViewMode === 'ALL'
            ? 'Wiring view: All. Showing all connection badges. Click to switch to Focus mode (collapses wiring for unselected items).'
            : 'Wiring view: Focus. Showing connection badges for selected items only. Click to switch to All mode.';
        wiringToggleBtn.innerHTML = this.wiringViewMode === 'ALL'
            ? '<span class="pipeline-btn-icon">🔗</span> <span>All Wiring</span>'
            : '<span class="pipeline-btn-icon">🎯</span> <span>Focus Wiring</span>';
        wiringToggleBtn.addEventListener('click', () => {
            this.wiringViewMode = this.wiringViewMode === 'ALL' ? 'FOCUS' : 'ALL';
            this.saveSettings();
            this.render();
        });
        toolbar.appendChild(wiringToggleBtn);

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

        const catQuickAdd = document.createElement('button');
        catQuickAdd.className = 'pipeline-cat-quick-add';
        catQuickAdd.textContent = '+';
        catQuickAdd.title = `Add ${cat.label} item`;
        catQuickAdd.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddCategoryItemMenu(e, cat, model);
        });

        header.appendChild(caret);
        header.appendChild(catIcon);
        header.appendChild(catLabel);
        header.appendChild(catQuickAdd);
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

        const isNodeSelected = this.stateManager.selectedNodeId === node.id && this.stateManager.getSelectedSliceIndex() === null;
        if (isNodeSelected) {
            item.classList.add('selected');
            nodeContainer.classList.add('selected');
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
        label.textContent = this.getNodeDisplayName(node);
        label.title = `${node.type} (ID: ${node.id}) — Double-click or press F2 to rename`;

        // Double click anywhere on node item or label to rename in-place
        const triggerRename = (e: MouseEvent) => {
            e.stopPropagation();
            this.startInPlaceRename(node, label);
        };
        item.addEventListener('dblclick', triggerRename);
        label.addEventListener('dblclick', triggerRename);

        // Type descriptor chip (Compact Spec Pill, right-aligned)
        const typeChip = document.createElement('span');
        typeChip.className = 'pipeline-type-chip';
        typeChip.textContent = this.getNodeTypeSummary(node);
        typeChip.title = `${node.type}: ${this.getNodeTypeTooltip(node)}`;

        // Connection status chip & quick actions
        const connChip = this.createNodeConnectionChip(node, model);

        // FEM Model Setup & Preprocessor Quick Action Chip
        const isFemNode = node.type === 'FEMObject3D' || node.type === 'FEMDomain3D' || node.type === 'LSDynaImporter3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D' || node.type === 'FEMFSICoupler3D' || !!node.parameters?.fem_setup;
        let femSetupBtn: HTMLElement | null = null;
        if (isFemNode) {
            femSetupBtn = document.createElement('button');
            femSetupBtn.className = 'pipeline-conn-chip pipeline-fem-setup-btn';
            femSetupBtn.style.background = 'rgba(0, 229, 255, 0.15)';
            femSetupBtn.style.borderColor = 'rgba(0, 229, 255, 0.5)';
            femSetupBtn.style.color = '#00e5ff';
            femSetupBtn.style.cursor = 'pointer';
            femSetupBtn.style.fontWeight = '600';
            femSetupBtn.textContent = '⚡ Setup';
            femSetupBtn.title = 'Open FEM Model Setup & Preprocessor (Edit Parts, Elements, Formulations, Materials, BCs)';
            femSetupBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                new FEMSetupModal(this.stateManager, node, model, () => this.render());
            });
        }

        const hasWiring = !!connChip || !!femSetupBtn;

        item.appendChild(eyeBtn);
        item.appendChild(badge);
        item.appendChild(label);

        // In Focus mode: if not selected, add compact wiring indicator pill to line 1
        if (hasWiring && this.wiringViewMode === 'FOCUS') {
            const hasUnconnected = connChip ? (connChip.classList.contains('unconnected') || !!connChip.querySelector('.unconnected')) : false;
            const focusPill = document.createElement('span');
            focusPill.className = `pipeline-conn-focus-pill ${hasUnconnected ? 'warn' : ''}`;
            focusPill.textContent = hasUnconnected ? '⚠️ Unwired' : '🔗 Wired';
            focusPill.title = hasUnconnected ? 'Unassigned connections! Click node to inspect wiring.' : 'Connections active. Click node to inspect wiring.';
            item.appendChild(focusPill);
        }

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

        // Dedicated Wiring Row (Line 2)
        if (hasWiring) {
            const wiringRow = document.createElement('div');
            wiringRow.className = 'pipeline-wiring-row';
            wiringRow.dataset.nodeId = node.id;
            if (isNodeSelected) wiringRow.classList.add('selected');
            if (this.wiringViewMode === 'FOCUS' && !isNodeSelected) {
                wiringRow.classList.add('wiring-collapsed');
            }

            const branch = document.createElement('span');
            branch.className = 'pipeline-wiring-branch';
            branch.textContent = '↳';

            const chipsGroup = document.createElement('div');
            chipsGroup.className = 'pipeline-wiring-chips';

            if (connChip) {
                chipsGroup.appendChild(connChip);
            }
            if (femSetupBtn) {
                chipsGroup.appendChild(femSetupBtn);
            }

            wiringRow.appendChild(branch);
            wiringRow.appendChild(chipsGroup);

            // Clicking whitespace on wiring row selects node
            wiringRow.addEventListener('click', (e) => {
                if (e.target === wiringRow || e.target === branch || e.target === chipsGroup) {
                    item.click();
                }
            });

            // Hover highlighting
            wiringRow.addEventListener('mouseenter', () => {
                this.stateManager.setHoveredNode(node.id);
            });
            wiringRow.addEventListener('mouseleave', () => {
                this.stateManager.setHoveredNode(null);
            });

            // Context menu on wiring row whitespace
            wiringRow.addEventListener('contextmenu', (e) => {
                if (e.target === wiringRow || e.target === branch || e.target === chipsGroup) {
                    e.preventDefault();
                    this.showNodeContextMenu(e, node, model);
                }
            });

            nodeContainer.appendChild(wiringRow);
        }

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

        // FEM Structural Rebar Sub-items under LSDynaImporter3D or FEMDomain3D
        if (node.type === 'LSDynaImporter3D' || node.type === 'FEMDomain3D') {
            const femCounts = resolveFEMCounts(node, model as any);
            if (femCounts.numBeams && femCounts.numBeams > 0) {
                let childList = nodeContainer.querySelector('.pipeline-child-list') as HTMLElement;
                if (!childList) {
                    childList = document.createElement('div');
                    childList.className = 'pipeline-child-list';
                    nodeContainer.appendChild(childList);
                }

                const diamStr = ((femCounts.rebarDiameter ?? 0.00953) * 1000).toFixed(2);

                const rebarItem = document.createElement('div');
                rebarItem.className = 'pipeline-node-item pipeline-child-item';
                rebarItem.style.cursor = 'pointer';

                const branch = document.createElement('span');
                branch.className = 'pipeline-branch-symbol';
                branch.textContent = '└─';

                const icon = document.createElement('span');
                icon.className = 'pipeline-slice-icon';
                icon.textContent = '⛓️';

                const label = document.createElement('span');
                label.className = 'pipeline-node-label';
                label.textContent = `Rebar Cage (${femCounts.numBeams.toLocaleString()} beams · Ø${diamStr} mm)`;
                label.title = `Reinforcing Steel Beams: Ø${diamStr} mm (Kim et al. 2022 / HD10 specification). Click to configure in FEM Setup.`;

                const tag = document.createElement('span');
                tag.className = 'pipeline-slice-tag';
                tag.style.background = 'rgba(245, 158, 11, 0.2)';
                tag.style.color = '#fbbf24';
                tag.style.borderColor = 'rgba(245, 158, 11, 0.4)';
                tag.textContent = `Ø${diamStr}mm`;

                rebarItem.appendChild(branch);
                rebarItem.appendChild(icon);
                rebarItem.appendChild(label);
                rebarItem.appendChild(tag);

                rebarItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.stateManager.selectNode(model.id, node.id);
                    new FEMSetupModal(this.stateManager, node, model, () => this.render());
                });

                childList.appendChild(rebarItem);
            }
        }

        // Marine Blast Multi-Scale Zonal Hierarchy (Directive 18)
        if (node.type === 'MarineHarbourDomain' || (node.type === 'CFDSolver3D' && node.parameters?.init_mode === 'Hydrostatic_Stratified_3D')) {
            let childList = nodeContainer.querySelector('.pipeline-child-list') as HTMLElement;
            if (!childList) {
                childList = document.createElement('div');
                childList.className = 'pipeline-child-list';
                nodeContainer.appendChild(childList);
            }

            const waterZ = node.parameters?.water_surface_z ?? 10.0;
            const seabedZ = node.parameters?.seabed_surface_z ?? 2.0;
            const sleeveR = node.parameters?.nearfield_sleeve_radius ?? 2.5;
            const breach = node.parameters?.vertical_sleeve_breach === true;
            const k0 = node.parameters?.k0_earth_pressure ?? 0.50;
            const bedType = node.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';

            // 1. Atmospheric Air
            const airConn = model.connections?.find(c => (c.toNode === node.id && (c.toPort === 'air' || c.toPort === 'ambient_air')) || (c.fromNode === node.id && (c.fromPort === 'air' || c.fromPort === 'ambient_air')));
            const airMatNode = airConn ? model.nodes.find(n => n.id === (airConn.toNode === node.id ? airConn.fromNode : airConn.toNode)) : model.nodes.find(n => n.type === 'Material' && (n.parameters?.preset?.includes('Air') || n.parameters?.material_model === 'Ideal Gas'));

            const airItem = this.createMarineLayerItem({
                branch: '├──',
                icon: '🌫️',
                title: 'Atmospheric Air',
                methodTag: 'Eulerian CFD',
                subtitle: airMatNode ? `Eulerian CFD, Ideal Gas (${airMatNode.parameters?.name || airMatNode.id})` : 'Eulerian CFD, Ideal Gas, Transmitting Sky',
                tagText: `z > ${waterZ}m`,
                tagColor: '#38bdf8',
                onClick: (anchorEl) => {
                    const candidates: { id: string; label: string; sublabel?: string }[] = [];
                    if (airMatNode) {
                        candidates.push({
                            id: 'open_air_mat',
                            label: `🧪 Inspect Air Material (${airMatNode.parameters?.name || airMatNode.id})`,
                            sublabel: 'View and tune air density, pressure, temperature, gamma in Property Editor'
                        });
                    }
                    [5.0, 8.0, 10.0, 12.0, 15.0, 20.0, 50.0].forEach(z => {
                        candidates.push({
                            id: String(z),
                            label: `Set Water Surface Elevation: z = ${z} m`,
                            sublabel: z === waterZ ? 'Current Setting' : undefined
                        });
                    });
                    this.showQuickAssignPopup({
                        anchorEl,
                        title: 'Atmospheric Air Layer',
                        currentId: airMatNode ? '' : String(waterZ),
                        candidateNodes: candidates,
                        hideNoneOption: true,
                        model,
                        onSelect: (sel) => {
                            if (sel === 'open_air_mat' && airMatNode) {
                                this.stateManager.selectNode(model.id, airMatNode.id);
                            } else {
                                const val = parseFloat(sel);
                                if (!isNaN(val)) {
                                    this.stateManager.updateNodeParameters(node.id, { water_surface_z: val });
                                    this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                    this.render();
                                }
                            }
                        }
                    });
                }
            });
            childList.appendChild(airItem);

            // 2. Water Column
            const waterConn = model.connections?.find(c => (c.toNode === node.id && (c.toPort === 'water' || c.toPort === 'seawater')) || (c.fromNode === node.id && (c.fromPort === 'water' || c.fromPort === 'seawater')));
            const waterMatNode = waterConn ? model.nodes.find(n => n.id === (waterConn.toNode === node.id ? waterConn.fromNode : waterConn.toNode)) : model.nodes.find(n => n.type === 'Material' && (n.parameters?.material_model === 'Tait Water' || n.parameters?.preset?.includes('Water') || n.parameters?.preset?.includes('Seawater')));

            const waterItem = this.createMarineLayerItem({
                branch: '├──',
                icon: '💧',
                title: 'Water Column',
                methodTag: 'Tait Seawater',
                subtitle: waterMatNode ? `Eulerian CFD Far-Field, Tait Seawater (${waterMatNode.parameters?.name || waterMatNode.id})` : 'Eulerian CFD Far-Field, Tait Seawater',
                tagText: `${seabedZ}m < z ≤ ${waterZ}m`,
                tagColor: '#0ea5e9',
                onClick: (anchorEl) => {
                    const candidates: { id: string; label: string; sublabel?: string }[] = [];
                    if (waterMatNode) {
                        candidates.push({
                            id: 'open_water_mat',
                            label: `🧪 Inspect Seawater Material (${waterMatNode.parameters?.name || waterMatNode.id})`,
                            sublabel: 'View and tune Tait B, gamma, sound speed, cavitation cutoff in Property Editor'
                        });
                    }
                    [0.0, 1.0, 2.0, 3.0, 5.0, 8.0].forEach(z => {
                        candidates.push({
                            id: String(z),
                            label: `Set Seabed Mudline Elevation: z = ${z} m`,
                            sublabel: z === seabedZ ? 'Current Setting' : undefined
                        });
                    });
                    this.showQuickAssignPopup({
                        anchorEl,
                        title: 'Seawater Column',
                        currentId: waterMatNode ? '' : String(seabedZ),
                        candidateNodes: candidates,
                        hideNoneOption: true,
                        model,
                        onSelect: (sel) => {
                            if (sel === 'open_water_mat' && waterMatNode) {
                                this.stateManager.selectNode(model.id, waterMatNode.id);
                            } else {
                                const val = parseFloat(sel);
                                if (!isNaN(val)) {
                                    this.stateManager.updateNodeParameters(node.id, { seabed_surface_z: val });
                                    this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                    this.render();
                                }
                            }
                        }
                    });
                }
            });
            childList.appendChild(waterItem);

            // 3. Near-Field Water Sleeve / Water Discretization
            const waterMode = String(node.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve');
            const isPureFVWater = waterMode === 'Pure_FV' || waterMode === 'Pure FV';
            const isFullColWater = waterMode === 'Full_Column_MPM_Cylinder' || waterMode === 'Full Column MPM Cylinder';
            const ppc = node.parameters?.nearfield_ppc ?? 8;
            let sleeveMethodTag = `MPM ${ppc} PPC`;
            let sleeveSubtitle = `Lagrangian MPM (${ppc} PPC), R = ${sleeveR}m, Tait Water`;
            let sleeveTagText = `Sphere R=${sleeveR}m${breach ? ' (Sky)' : ''}`;
            let sleeveTagColor = '#a855f7';

            if (isPureFVWater) {
                sleeveMethodTag = 'Pure Eulerian FV';
                sleeveSubtitle = 'Pure Finite Volume (Unobstructed shockwave propagation, no particles)';
                sleeveTagText = 'Pure FV';
                sleeveTagColor = '#38bdf8';
            } else if (isFullColWater) {
                sleeveMethodTag = `MPM Column ${ppc} PPC`;
                sleeveSubtitle = `Vertical Column MPM Cylinder (${ppc} PPC), R = ${sleeveR}m (Mudline to Surface)`;
                sleeveTagText = `Cylinder R=${sleeveR}m`;
                sleeveTagColor = '#c084fc';
            }

            const isWaterSleeveVisible = node.parameters?.show_water_sleeve !== false;
            const sleeveItem = this.createMarineLayerItem({
                branch: '├──',
                icon: isPureFVWater ? '🌊' : '🌀',
                title: 'Water Discretization',
                methodTag: sleeveMethodTag,
                subtitle: sleeveSubtitle,
                tagText: sleeveTagText,
                tagColor: sleeveTagColor,
                nodeId: node.id,
                childId: 'water_sleeve',
                visible: isPureFVWater ? undefined : isWaterSleeveVisible,
                onToggleVisible: (vis) => {
                    this.stateManager.updateNodeParametersInPlace(node.id, { show_water_sleeve: vis });
                    (window as any).transportController?.onShadingChange?.('show_water_sleeve', vis);
                },
                onSelect: () => {
                    (window as any).transportController?.setSelectedObject?.({
                        objectType: 'MarineHarbourDomain',
                        childId: 'water_sleeve',
                        label: `Water Sleeve (${sleeveTagText})`,
                        nodeId: node.id
                    });
                },
                onClick: (anchorEl) => {
                    const candidates = [
                        { id: 'mode_Pure_FV', label: '🌊 Pure Eulerian FV (No Particles — Shockwave Penetrates Fluid)' },
                        { id: 'mode_Spherical_MPM_Sleeve', label: '🌀 Spherical MPM Sleeve (Near-Field Charge Cavitation Only)' },
                        { id: 'mode_Full_Column_MPM_Cylinder', label: '🏛️ Full-Column MPM Cylinder (Spanning Seabed to Water Surface)' },
                        { id: 'divider_1', label: '────────── Sizing & Resolution ──────────' },
                        { id: 'toggle_breach', label: breach ? '🔓 Breach: Venting to Sky (Click to Submerge)' : '🔒 Breach: Submerged Only (Click to Vent to Sky)' },
                        { id: 'r_1.5', label: 'Radius R = 1.5 m' },
                        { id: 'r_2.0', label: 'Radius R = 2.0 m' },
                        { id: 'r_2.5', label: 'Radius R = 2.5 m (Default)' },
                        { id: 'r_3.5', label: 'Radius R = 3.5 m' },
                        { id: 'r_5.0', label: 'Radius R = 5.0 m' },
                        { id: 'ppc_8', label: 'Particle Resolution: 8 PPC (Standard 2x2x2)' },
                        { id: 'ppc_27', label: 'Particle Resolution: 27 PPC (High 3x3x3)' },
                        { id: 'ppc_64', label: 'Particle Resolution: 64 PPC (Ultra 4x4x4)' }
                    ];
                    this.showQuickAssignPopup({
                        anchorEl,
                        title: 'Water Discretization Architecture & Sleeve Tuning',
                        currentId: `mode_${waterMode}`,
                        candidateNodes: candidates,
                        hideNoneOption: true,
                        model,
                        onSelect: (sel) => {
                            if (sel.startsWith('divider_')) return;
                            if (sel.startsWith('mode_')) {
                                let mode = sel.replace('mode_', '');
                                if (mode === 'Pure FV') mode = 'Pure_FV';
                                else if (mode === 'Spherical MPM Sleeve') mode = 'Spherical_MPM_Sleeve';
                                else if (mode === 'Full Column MPM Cylinder') mode = 'Full_Column_MPM_Cylinder';
                                this.stateManager.updateNodeParameters(node.id, { water_discretization_mode: mode });
                            } else if (sel === 'toggle_breach') {
                                this.stateManager.updateNodeParameters(node.id, { vertical_sleeve_breach: !breach });
                            } else if (sel.startsWith('r_')) {
                                const val = parseFloat(sel.replace('r_', ''));
                                if (!isNaN(val)) {
                                    this.stateManager.updateNodeParameters(node.id, { nearfield_sleeve_radius: val });
                                }
                            } else if (sel.startsWith('ppc_')) {
                                const val = parseInt(sel.replace('ppc_', ''), 10);
                                if (!isNaN(val)) {
                                    this.stateManager.updateNodeParameters(node.id, { nearfield_ppc: val });
                                }
                            }
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.render();
                        }
                    });
                }
            });
            childList.appendChild(sleeveItem);

            // Sub-item: Pressurized Casing & Cavity
            const chgConn = model.connections?.find(c => (c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')) || (c.fromNode === node.id && (c.fromPort === 'charge' || c.fromPort === 'explosive')));
            const chgNode = chgConn ? model.nodes.find(n => n.id === (chgConn.toNode === node.id ? chgConn.fromNode : chgConn.toNode)) : model.nodes.find(n => n.type === 'Charge3D');

            const casingItem = this.createMarineLayerItem({
                branch: '│   └──',
                icon: '⚙️',
                title: 'Pressurized Casing',
                methodTag: 'MPM Metal',
                subtitle: chgNode ? `Eulerian Gas + MPM Metal Casing (${chgNode.parameters?.name || chgNode.id}: ${chgNode.parameters?.charge_mass ?? '0.85'} kg)` : 'Eulerian Gas + MPM Metal Casing',
                tagText: 'Metal/JWL',
                tagColor: '#eab308',
                onClick: () => {
                    if (chgNode) {
                        this.stateManager.selectNode(model.id, chgNode.id);
                    } else {
                        new PipelineConnectionModal(this.stateManager, model, () => this.render());
                    }
                }
            });
            childList.appendChild(casingItem);

            // 4. Seabed Foundation
            const seabedConn = model.connections?.find(c => (c.toNode === node.id && (c.toPort === 'seabed' || c.toPort === 'elements')) || (c.fromNode === node.id && (c.fromPort === 'seabed' || c.fromPort === 'elements')));
            const seabedNode = seabedConn ? model.nodes.find(n => n.id === (seabedConn.toNode === node.id ? seabedConn.fromNode : seabedConn.toNode)) : model.nodes.find(n => n.type === 'FEMObject3D' || n.type === 'MPMObject3D');

            const isPureFVBed = bedType === 'Pure_FV';
            const isFullMPMBed = bedType === 'Full_Domain_MPM' || bedType === 'Pure_MPM';
            const isLocalCraterBed = bedType === 'Local_Crater_MPM';
            let bedTagText = bedType === 'Hybrid_MPM_Crater_FEM_FarField' ? 'Hex8 Far-Field' : bedType;
            let bedMethodTag = 'Geotech Soil';
            let bedSubtitle = `Geotechnical Saturated Soil (K₀ = ${k0.toFixed(2)})`;
            let bedTagColor = '#f97316';

            if (isPureFVBed) {
                bedTagText = 'Pure FV Mud';
                bedMethodTag = 'Pure Eulerian FV';
                bedSubtitle = 'Eulerian Multiphase Sediment (Allows shockwave penetration into mudline)';
                bedTagColor = '#06b6d4';
            } else if (isFullMPMBed) {
                bedTagText = 'Full MPM Bed';
                bedMethodTag = 'MPM Soil (Full)';
                bedSubtitle = 'Full-Domain Lagrangian MPM Soil Bed (Drucker-Prager)';
                bedTagColor = '#e11d48';
            } else if (isLocalCraterBed) {
                bedTagText = 'Local MPM Crater';
                bedMethodTag = 'MPM Soil (Crater)';
                bedSubtitle = 'Local Crater MPM Box (No Far-Field FEM Mesh)';
                bedTagColor = '#ea580c';
            }

            const seabedItem = this.createMarineLayerItem({
                branch: '└──',
                icon: '🏖️',
                title: 'Seabed Foundation',
                methodTag: bedMethodTag,
                subtitle: bedSubtitle,
                tagText: bedTagText,
                tagColor: bedTagColor,
                onClick: (anchorEl) => {
                    const candidates: { id: string; label: string; sublabel?: string }[] = [];
                    if (seabedNode) {
                        candidates.push({
                            id: 'open_seabed_node',
                            label: `🏗️ Inspect Seabed Solid Body (${seabedNode.parameters?.name || seabedNode.id})`,
                            sublabel: 'View dimensions, element subdivisions, and constitutive model in Property Editor'
                        });
                    }
                    candidates.push(
                        { id: 'Pure_FV', label: '🌊 Pure Eulerian FV Sediment (Allows Shockwave Penetration into Mud)' },
                        { id: 'Hybrid_MPM_Crater_FEM_FarField', label: 'Hybrid MPM Crater + Hex8 FEM Far-Field (Recommended)' },
                        { id: 'Full_Domain_MPM', label: 'Full Domain Lagrangian MPM Bed (Full Width/Depth)' },
                        { id: 'Local_Crater_MPM', label: 'Local Crater Lagrangian MPM Bed' },
                        { id: 'Pure_Hex8_FEM', label: 'Pure Hex8 FEM Mesh' }
                    );
                    this.showQuickAssignPopup({
                        anchorEl,
                        title: 'Seabed Discretization Architecture',
                        currentId: bedType,
                        candidateNodes: candidates,
                        hideNoneOption: true,
                        model,
                        onSelect: (sel) => {
                            if (sel === 'open_seabed_node' && seabedNode) {
                                this.stateManager.selectNode(model.id, seabedNode.id);
                            } else {
                                this.stateManager.updateNodeParameters(node.id, { seabed_mesh_type: sel });
                                this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                this.render();
                            }
                        }
                    });
                }
            });
            childList.appendChild(seabedItem);

            // Sub-item: Soil Scour / Crater Zone
            const isSoilMpm = !isPureFVBed;
            const isSoilMpmVisible = node.parameters?.show_soil_mpm !== false;
            const craterItem = this.createMarineLayerItem({
                branch: '    ├──',
                icon: isPureFVBed ? '🌊' : '💥',
                title: 'Soil Scour Zone',
                methodTag: isPureFVBed ? 'Pure Eulerian FV' : 'MPM Soil',
                subtitle: isPureFVBed ? 'Eulerian Multiphase Sediment (Flux across z = seabed_surface_z)' : 'Lagrangian MPM Soil, Drucker-Prager',
                tagText: isPureFVBed ? 'Eulerian Mud' : 'MPM Crater',
                tagColor: isPureFVBed ? '#06b6d4' : '#ef4444',
                nodeId: node.id,
                childId: 'seabed_soil',
                visible: isSoilMpm ? isSoilMpmVisible : undefined,
                onToggleVisible: (vis) => {
                    this.stateManager.updateNodeParametersInPlace(node.id, { show_soil_mpm: vis });
                    (window as any).transportController?.onShadingChange?.('show_soil_mpm', vis);
                },
                onSelect: () => {
                    (window as any).transportController?.setSelectedObject?.({
                        objectType: 'MarineHarbourDomain',
                        childId: 'seabed_soil',
                        label: `Soil Scour (${isPureFVBed ? 'Eulerian Mud' : 'MPM Crater'})`,
                        nodeId: node.id
                    });
                },
                onClick: (anchorEl) => {
                    const widthParam = Number(node.parameters?.crater_bed_width ?? 5.0);
                    const depthParam = Number(node.parameters?.crater_bed_depth ?? 3.0);
                    const candidates = [
                        { id: 'w_3.0', label: `Crater Bed Width: 3.0 m ${widthParam === 3.0 ? '✓' : ''}` },
                        { id: 'w_5.0', label: `Crater Bed Width: 5.0 m (Default) ${widthParam === 5.0 ? '✓' : ''}` },
                        { id: 'w_8.0', label: `Crater Bed Width: 8.0 m ${widthParam === 8.0 ? '✓' : ''}` },
                        { id: 'w_12.0', label: `Crater Bed Width: 12.0 m ${widthParam === 12.0 ? '✓' : ''}` },
                        { id: 'divider_c1', label: '────────── Crater Depth ──────────' },
                        { id: 'd_1.5', label: `Crater Bed Depth: 1.5 m ${depthParam === 1.5 ? '✓' : ''}` },
                        { id: 'd_3.0', label: `Crater Bed Depth: 3.0 m (Default) ${depthParam === 3.0 ? '✓' : ''}` },
                        { id: 'd_5.0', label: `Crater Bed Depth: 5.0 m ${depthParam === 5.0 ? '✓' : ''}` }
                    ];
                    this.showQuickAssignPopup({
                        anchorEl,
                        title: 'Soil Scour & Crater MPM Dimensions',
                        currentId: `w_${widthParam}`,
                        candidateNodes: candidates,
                        hideNoneOption: true,
                        model,
                        onSelect: (sel) => {
                            if (sel.startsWith('divider_')) return;
                            if (sel.startsWith('w_')) {
                                const val = parseFloat(sel.replace('w_', ''));
                                if (!isNaN(val)) this.stateManager.updateNodeParameters(node.id, { crater_bed_width: val });
                            } else if (sel.startsWith('d_')) {
                                const val = parseFloat(sel.replace('d_', ''));
                                if (!isNaN(val)) this.stateManager.updateNodeParameters(node.id, { crater_bed_depth: val });
                            }
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.render();
                        }
                    });
                }
            });
            childList.appendChild(craterItem);

            // Sub-item: Far-Field Foundation
            const farfieldItem = this.createMarineLayerItem({
                branch: '    └──',
                icon: isPureFVBed ? '🌊' : '🧱',
                title: 'Far-Field Foundation',
                methodTag: isPureFVBed ? 'Pure Eulerian FV' : 'Hex8 FEM',
                subtitle: isPureFVBed ? 'Eulerian Multiphase Sediment (Eulerian Hydrostatic Soil Column)' : 'Hex8 FEM Mesh, 1-Point Reduced Integration',
                tagText: isPureFVBed ? 'Eulerian Mud' : 'Hex8 FB-Hg',
                tagColor: isPureFVBed ? '#06b6d4' : '#10b981',
                onClick: () => {
                    if (seabedNode) {
                        this.stateManager.selectNode(model.id, seabedNode.id);
                    } else {
                        this.stateManager.selectNode(model.id, node.id);
                    }
                }
            });
            childList.appendChild(farfieldItem);
        }

        return nodeContainer;
    }

    private isSliceDomainNode(node: Node, model: Model): boolean {
        if (node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'DomainMesh2D') {
            return true;
        }
        if (['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'MPMDomain3D', 'MPMDomain2D', 'FEMDomain3D', 'MarineHarbourDomain'].includes(node.type)) {
            const hasMesh = model.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh' || n.type === 'DomainMesh2D');
            if (!hasMesh) return true;
        }
        if (node.type === 'Telemetry3DViewport') {
            const hasAnyDomain = model.nodes.some(n => [
                'DomainMesh3D', 'DomainMesh', 'DomainMesh2D',
                'CFDSolver3D', 'CFDSolver2D', 'CFDSolver',
                'MPMDomain3D', 'MPMDomain2D',
                'FEMDomain3D', 'MarineHarbourDomain'
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

    private createMarineLayerItem(options: {
        branch: string;
        icon: string;
        title: string;
        subtitle: string;
        methodTag?: string;
        tagText: string;
        tagColor: string;
        nodeId?: string;
        childId?: string;
        visible?: boolean;
        onToggleVisible?: (visible: boolean) => void;
        onSelect?: () => void;
        onClick?: (anchorEl: HTMLElement) => void;
    }): HTMLElement {
        const item = document.createElement('div');
        item.className = 'pipeline-node-item pipeline-child-item';
        item.style.cursor = 'pointer';

        if (options.nodeId) item.dataset.nodeId = options.nodeId;
        if (options.childId) item.dataset.childId = options.childId;

        const branch = document.createElement('span');
        branch.className = 'pipeline-branch-symbol';
        branch.textContent = options.branch;
        item.appendChild(branch);

        // Visibility Toggle (Eye)
        if (options.visible !== undefined) {
            let isVisible = options.visible;
            const eyeBtn = document.createElement('button');
            eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
            eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
            eyeBtn.title = isVisible ? `Hide ${options.title}` : `Show ${options.title}`;
            eyeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                isVisible = !isVisible;
                eyeBtn.innerHTML = isVisible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
                eyeBtn.className = `pipeline-eye-btn ${isVisible ? 'visible' : 'hidden'}`;
                eyeBtn.title = isVisible ? `Hide ${options.title}` : `Show ${options.title}`;
                options.onToggleVisible?.(isVisible);
            });
            item.appendChild(eyeBtn);
        }

        const icon = document.createElement('span');
        icon.className = 'pipeline-slice-icon';
        icon.textContent = options.icon;

        const label = document.createElement('span');
        label.className = 'pipeline-node-label';
        label.textContent = options.title;
        label.title = `${options.title} — ${options.subtitle}. Click to configure.`;

        // Method chip (Compact physics formulation)
        const methodChip = document.createElement('span');
        methodChip.className = 'pipeline-sub-chip';
        methodChip.textContent = options.methodTag || this.getCompactSubLabel(options.title, options.subtitle);
        methodChip.title = options.subtitle;

        // Elevation / Bounds tag
        const tag = document.createElement('span');
        tag.className = 'pipeline-slice-tag';
        tag.style.background = `${options.tagColor}22`;
        tag.style.color = options.tagColor;
        tag.style.borderColor = `${options.tagColor}66`;
        tag.textContent = options.tagText;
        if (options.onClick) {
            tag.style.cursor = 'pointer';
            tag.title = 'Click to configure discretization parameters';
            tag.addEventListener('click', (e) => {
                e.stopPropagation();
                options.onClick!(tag);
            });
        }

        item.appendChild(icon);
        item.appendChild(label);
        item.appendChild(methodChip);
        item.appendChild(tag);

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (options.nodeId) {
                const activeModelId = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === options.nodeId))?.id || this.activeModelId;
                if (activeModelId) {
                    this.stateManager.setActiveModel(activeModelId);
                    this.stateManager.selectNode(activeModelId, options.nodeId);
                }
                this.selectedChildId = options.childId || null;
                this.stateManager.setSelectedSliceIndex(null);
                this.selectedGaugeIndex = null;
                options.onSelect?.();
                this.updateSelectionHighlight();
            } else if (options.onClick) {
                options.onClick(item);
            }
        });

        return item;
    }

    private getCompactSubLabel(title: string, subtitle: string): string {
        if (title.includes('Air')) return 'Eulerian CFD';
        if (title.includes('Water Column')) return 'Tait Water';
        if (title.includes('Sleeve')) return 'MPM 8 PPC';
        if (title.includes('Casing')) return 'MPM Metal';
        if (title.includes('Seabed Foundation')) return 'Geotech Soil';
        if (title.includes('Crater') || title.includes('Scour')) return 'MPM Soil';
        if (title.includes('Far-Field')) return 'Hex8 FEM';
        if (subtitle.length > 14) return subtitle.slice(0, 13) + '…';
        return subtitle;
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
        const is3D = model.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D');
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

    private getNodeDisplayName(node: Node): string {
        if (node.parameters?.name && String(node.parameters.name).trim().length > 0) {
            return String(node.parameters.name);
        }
        switch (node.type) {
            case 'CFDSolver3D': return 'CFD Solver 3D';
            case 'CFDSolver2D': return 'CFD Solver 2D';
            case 'CFDSolver': return 'CFD Solver 1D';
            case 'FEMDomain3D': return 'FEM Solver';
            case 'MPMDomain3D': return 'MPM Solver 3D';
            case 'MPMDomain2D': return 'MPM Solver 2D';
            case 'FEMFSICoupler3D': return 'FEM-FSI Coupler';
            case 'FSICoupler3D': return 'FSI Coupler 3D';
            case 'FSICoupler2D': return 'FSI Coupler 2D';
            case 'DomainMesh3D': return 'Domain Mesh 3D';
            case 'DomainMesh2D': return 'Domain Mesh 2D';
            case 'DomainMesh': return 'Domain Mesh 1D';
            case 'MarineHarbourDomain': return 'Marine Harbour Domain';
            case 'Remap1DTo3DNode': return '1D→3D Remap';
            case 'Remap2DTo3DNode': return '2D→3D Remap';
            case 'Remap1DTo2DNode': return '1D→2D Remap';
            default: return node.type;
        }
    }

    private getNodeTypeSummary(node: Node): string {
        switch (node.type) {
            case 'MarineHarbourDomain':
                return 'Multi-Physics';
            case 'CFDSolver3D': {
                const dev = (node.parameters.device || 'CUDA').toUpperCase();
                const order = node.parameters.temporal_order ? `O${node.parameters.temporal_order}` : 'ADER-2';
                return `${dev} ${order}`;
            }
            case 'CFDSolver2D': {
                const dev = (node.parameters.device || 'CUDA').toUpperCase();
                return `${dev} 2D`;
            }
            case 'CFDSolver':
                return '1D CFD';
            case 'FEMDomain3D':
                return `${(node.parameters.device || 'CUDA').toUpperCase()} FEM`;
            case 'MPMDomain3D':
                return `${(node.parameters.device || 'CUDA').toUpperCase()} MPM`;
            case 'Material':
            case 'MPMMaterialSteel' as any:
            case 'MPMMaterial' as any:
            case 'MaterialSteel' as any:
                return this.getCompactMaterialSummary(node);
            case 'TriggerLocation3D':
            case 'DetonatorLocation3D': {
                const x = Number(node.parameters.detonator_x ?? node.parameters.trigger_x ?? 0.5);
                const y = Number(node.parameters.detonator_y ?? node.parameters.trigger_y ?? 0.5);
                const z = Number(node.parameters.detonator_z ?? node.parameters.trigger_z ?? 0.5);
                return `${x}, ${y}, ${z}`;
            }
            case 'TriggerLocation':
            case 'DetonatorLocation': {
                const r = Number(node.parameters.detonator_r ?? node.parameters.trigger_r ?? 0.0);
                const z = Number(node.parameters.detonator_z ?? node.parameters.trigger_z ?? 0.1);
                return `${r}, ${z}`;
            }
            case 'Charge3D':
                return `${node.parameters.charge_mass || '0.85'} kg`;
            case 'DomainMesh3D': {
                const nx = node.parameters.nx || 100;
                const ny = node.parameters.ny || 100;
                const nz = node.parameters.nz || 100;
                return (nx === ny && ny === nz) ? `${nx}³` : `${nx}×${ny}×${nz}`;
            }
            case 'STLGeometry':
                return node.parameters.file_path ? (String(node.parameters.file_path).split('/').pop() || 'STL') : 'STL CAD';
            case 'PrimitiveGeometry3D':
                return node.parameters.shape_type || 'CSG';
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
            case 'FEMObject3D': {
                const shape = node.parameters.shape_type || (node.parameters.mesh_source === 'Cylinder Generator' ? 'Cylinder' : (node.parameters.mesh_source === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box'));
                if (shape === 'Box') {
                    const nx = node.parameters.nx ?? 10;
                    const ny = node.parameters.ny ?? 10;
                    const nz = node.parameters.nz ?? 10;
                    return `Box ${nx}×${ny}×${nz}`;
                } else if (shape === 'Cylinder') {
                    const nr = node.parameters.nx ?? 2;
                    const nz = node.parameters.nz ?? 4;
                    return `Cyl ${nr}r×${nz}z`;
                } else {
                    return shape;
                }
            }
            case 'LSDynaImporter3D':
                return node.parameters.file_path ? (String(node.parameters.file_path).split('/').pop() || 'LS-DYNA') : 'LS-DYNA';
            case 'VirtualGauges':
            case 'VirtualGauges3D': {
                const isExternal = node.parameters.source_mode === 'external_file';
                const count = isExternal ? (node.parameters.external_probe_count || 0) : (node.parameters.gauges?.length || 0);
                return `${count} probe${count === 1 ? '' : 's'}`;
            }
            default:
                return node.type;
        }
    }

    private getCompactMaterialSummary(node: Node): string {
        const matType = node.parameters.material_type;
        if (matType === 'Air') return 'Air (STP)';
        if (matType === 'JWL Charge') return `JWL (${node.parameters.composition || 'TNT'})`;
        if (matType === 'Ideal Gas Charge') return `Ideal Gas (${node.parameters.composition || 'TNT'})`;

        const preset = node.parameters.preset;
        if (preset && preset !== 'Custom') {
            if (preset.includes('Water') || preset.includes('Tait')) return 'Tait Water';
            if (preset.includes('Air')) return 'Air (STP)';
            if (preset.includes('TNT') || preset.includes('JWL')) return 'JWL TNT';
            if (preset.includes('Steel')) return 'Steel';
            if (preset.includes('Concrete')) return 'Concrete';
            if (preset.includes('Soil') || preset.includes('Sand')) return 'Soil';
            if (preset.length > 14) return preset.slice(0, 13) + '…';
            return preset;
        }

        const matModel = node.parameters.material_model;
        if (matModel) {
            if (matModel.includes('Johnson-Cook') && matModel.includes('Mie-Grüneisen')) return 'JC + MG';
            if (matModel.includes('Johnson-Cook')) return 'Johnson-Cook';
            if (matModel.includes('Mie-Grüneisen')) return 'Mie-Grüneisen';
            if (matModel.includes('Drucker-Prager')) return 'Drucker-Prager';
            if (matModel.includes('Tait')) return 'Tait Water';
            if (matModel.includes('Ideal Gas')) return 'Ideal Gas';
            if (matModel.includes('Linear Elastic')) return 'Linear Elastic';
            if (matModel.length > 14) return matModel.slice(0, 13) + '…';
            return matModel;
        }
        return 'Material';
    }

    private getNodeTypeTooltip(node: Node): string {
        if (node.type === 'Material' || (node.type as string).startsWith('MPM') || (node.type as string).startsWith('FEM')) {
            const preset = node.parameters.preset;
            const model = node.parameters.material_model;
            if (preset && preset !== 'Custom') return `${preset} (${model || 'EOS'})`;
            if (model) return `${model} (Custom)`;
        }
        return this.getNodeTypeSummary(node);
    }

    private getCleanEntityName(name: string): string {
        if (!name) return '';
        let clean = name.replace(/^(Material_|Material\s+|Mesh_|Mesh\s+)/i, '').trim();
        clean = clean.replace(/Domain\s+Mesh\s+3D/i, 'Mesh 3D');
        clean = clean.replace(/Domain\s+Mesh\s+2D/i, 'Mesh 2D');
        clean = clean.replace(/Domain\s+Mesh\s+1D/i, 'Mesh 1D');
        clean = clean.replace(/DomainMesh3D/i, 'Mesh 3D');
        clean = clean.replace(/DomainMesh2D/i, 'Mesh 2D');
        clean = clean.replace(/DomainMesh/i, 'Mesh 1D');
        clean = clean.replace(/CFD\s+Solver\s+3D/i, 'CFD 3D');
        clean = clean.replace(/CFD\s+Solver\s+2D/i, 'CFD 2D');
        clean = clean.replace(/CFDSolver3D/i, 'CFD 3D');
        clean = clean.replace(/CFDSolver2D/i, 'CFD 2D');
        clean = clean.replace(/CFDSolver/i, 'CFD 1D');
        clean = clean.replace(/Marine\s+Harbour\s+Domain/i, 'Harbour 3D');
        clean = clean.replace(/MarineHarbourDomain/i, 'Harbour 3D');
        clean = clean.replace(/MPM\s+Domain\s+3D/i, 'MPM 3D');
        clean = clean.replace(/MPMDomain3D/i, 'MPM 3D');
        clean = clean.replace(/FEM\s+Domain\s+3D/i, 'FEM 3D');
        clean = clean.replace(/FEMDomain3D/i, 'FEM 3D');
        clean = clean.replace(/Air\s*\(Atmospheric\s+SEA\)/i, 'Air');
        clean = clean.replace(/Water\s*\(Tait\s+EOS\)/i, 'Water');
        clean = clean.replace(/Seawater\s*\(Tait\s+EOS\)/i, 'Seawater');
        clean = clean.replace(/TNT\s*\(High\s+Explosive\s+JWL\)/i, 'TNT');
        return clean;
    }

    private createNodeConnectionChip(node: Node, model: Model): HTMLElement | null {
        const state = this.stateManager.getCurrentState();
        if (!state) return null;

        // 1. Detonator nodes
        if (node.type === 'TriggerLocation3D' || node.type === 'TriggerLocation' || node.type === 'DetonatorLocation3D' || node.type === 'DetonatorLocation') {
            const conn = state.connections.find(c => c.fromNode === node.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'detonators'));
            const targetId = conn ? conn.toNode : (node.parameters?.target_domain || '');
            const target = model.nodes.find(n => n.id === targetId);
            const chip = document.createElement('span');
            chip.className = 'pipeline-conn-chip chip-charge';
            if (target) {
                chip.classList.add('connected');
                chip.textContent = `🎯 ${this.getCleanEntityName(target.parameters?.name || target.type)}`;
                chip.title = `Detonator is wired to ${target.parameters?.name || target.id}. Click to reassign or disconnect.`;
            } else {
                chip.classList.add('unconnected');
                chip.textContent = '⚠️ Assign Solver';
                chip.title = `Detonator is not connected to any solver domain! Click to assign.`;
            }
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const is3D = node.type === 'TriggerLocation3D' || node.type === 'DetonatorLocation3D';
                const candidates = model.nodes
                    .filter(n => is3D ? ['CFDSolver3D', 'MPMDomain3D', 'MarineHarbourDomain'].includes(n.type) : ['CFDSolver2D', 'MPMDomain2D', 'CFDSolver'].includes(n.type))
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                this.showQuickAssignPopup({
                    anchorEl: chip,
                    title: 'Target Solver Domain',
                    currentId: targetId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignDetonatorTarget(node, selectedId, model)
                });
            });
            return chip;
        }

        // 2. Domain meshes
        if (node.type === 'DomainMesh3D' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh') {
            const conn = state.connections.find(c => (c.fromNode === node.id && (c.toPort === 'mesh' || c.toPort === 'in')) || (c.toNode === node.id && c.fromPort === 'mesh'));
            const solverId = conn ? (conn.fromNode === node.id ? conn.toNode : conn.fromNode) : (node.parameters?.target_domain || '');
            const solver = model.nodes.find(n => n.id === solverId);
            const chip = document.createElement('span');
            chip.className = 'pipeline-conn-chip chip-mesh';
            if (solver) {
                chip.classList.add('connected');
                chip.textContent = `🔗 ${this.getCleanEntityName(solver.parameters?.name || solver.type)}`;
                chip.title = `Background mesh wired to ${solver.parameters?.name || solver.id}. Click to reassign or disconnect.`;
            } else {
                chip.classList.add('unconnected');
                chip.textContent = '⚠️ Assign Solver';
                chip.title = 'Mesh is not connected to any solver domain! Click to assign.';
            }
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const is3D = node.type === 'DomainMesh3D';
                const is2D = node.type === 'DomainMesh2D';
                const candidates = model.nodes
                    .filter(n => is3D ? ['CFDSolver3D', 'MPMDomain3D', 'MarineHarbourDomain'].includes(n.type) : (is2D ? ['CFDSolver2D', 'MPMDomain2D'].includes(n.type) : ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D'].includes(n.type)))
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                this.showQuickAssignPopup({
                    anchorEl: chip,
                    title: 'Target Solver Domain',
                    currentId: solverId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignSolverToMesh(node, selectedId, model)
                });
            });
            return chip;
        }

        // 3. Structural Objects (MPM / FEM)
        if (node.type === 'MPMObject3D' || node.type === 'FEMObject3D' || node.type === 'MPMObject2D' || node.type === 'LSDynaImporter3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D') {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            const domainConn = state.connections.find(c => c.fromNode === node.id && (c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects' || c.toPort === 'in'));
            const currentDomId = domainConn ? domainConn.toNode : (node.parameters?.target_domain || '');
            const domain = model.nodes.find(n => n.id === currentDomId);

            const domChip = document.createElement('span');
            domChip.className = 'pipeline-conn-chip';
            if (domain) {
                domChip.classList.add('connected');
                domChip.textContent = `🔗 ${this.getCleanEntityName(domain.parameters?.name || domain.type)}`;
                domChip.title = `Object wired to ${domain.parameters?.name || domain.id}. Click to reassign or disconnect.`;
            } else {
                domChip.classList.add('unconnected');
                domChip.textContent = '⚠️ Assign Domain';
                domChip.title = 'Object is not connected to a domain! Click to assign.';
            }
            domChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const is3D = node.type === 'MPMObject3D' || node.type === 'FEMObject3D' || node.type === 'LSDynaImporter3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D';
                const candidates = model.nodes
                    .filter(n => is3D ? (node.type === 'MPMObject3D' ? (n.type === 'MPMDomain3D' || n.type === 'MarineHarbourDomain') : (n.type === 'FEMDomain3D' || n.type === 'MarineHarbourDomain')) : n.type === 'MPMDomain2D')
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                this.showQuickAssignPopup({
                    anchorEl: domChip,
                    title: 'Target Solver Domain',
                    currentId: currentDomId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignObjectDomain(node, selectedId, model)
                });
            });
            group.appendChild(domChip);

            if (node.type !== 'LSDynaImporter3D') {
                const matConn = state.connections.find(c => (c.toNode === node.id || c.fromNode === node.id) && (c.toPort === 'material' || c.fromPort === 'material'));
                const currentMatId = matConn ? (matConn.toNode === node.id ? matConn.fromNode : matConn.toNode) : (node.parameters?.material || '');
                const mat = model.nodes.find(n => n.id === currentMatId);

                const matChip = document.createElement('span');
                matChip.className = 'pipeline-conn-chip';
                if (mat) {
                    matChip.classList.add('connected');
                    const preset = mat.parameters?.preset || mat.parameters?.material_model || 'Mat';
                    matChip.textContent = `🧪 ${this.getCleanEntityName(mat.parameters?.name || preset)}`;
                    matChip.title = `Material [${mat.parameters?.name || mat.id}] assigned. Click to reassign or disconnect.`;
                } else {
                    matChip.classList.add('unconnected');
                    matChip.textContent = '⚠️ Assign Material';
                    matChip.title = 'Object has no constitutive material wired! Click to assign material.';
                }
                matChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => n.type === 'Material' || (n.type as string).startsWith('MPMMaterial'))
                        .map(n => {
                            const preset = n.parameters?.preset || n.parameters?.material_model || 'Material';
                            return { id: n.id, label: n.parameters?.name || n.type, sublabel: preset };
                        });
                    this.showQuickAssignPopup({
                        anchorEl: matChip,
                        title: 'Constitutive Material',
                        currentId: currentMatId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignObjectMaterial(node, selectedId, model)
                    });
                });
                group.appendChild(matChip);
            }

            return group;
        }

        // 4. Material nodes
        if (node.type === 'Material' || (node.type as string).startsWith('MPMMaterial')) {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            const airConns = state.connections.filter(c => (c.fromNode === node.id || c.toNode === node.id) && (c.toPort === 'air' || c.fromPort === 'air' || c.toPort === 'ambient_air' || c.fromPort === 'ambient_air'));
            const waterConns = state.connections.filter(c => (c.fromNode === node.id || c.toNode === node.id) && (c.toPort === 'water' || c.fromPort === 'water' || c.toPort === 'seawater' || c.fromPort === 'seawater'));
            const seabedConns = state.connections.filter(c => (c.fromNode === node.id || c.toNode === node.id) && (c.toPort === 'seabed' || c.fromPort === 'seabed'));
            const matConns = state.connections.filter(c => (c.fromNode === node.id || c.toNode === node.id) && (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'mat' || c.fromPort === 'mat' || c.toPort === 'in' || c.fromPort === 'out'));
            const isAir = isAirMaterialNode(node) || isIdealGasMaterialNode(node);
            const isWater = isWaterMaterialNode(node);
            const isEnergetic = isExplosiveMaterialNode(node) || isJWLMaterialNode(node);
            const isSeabed = isSeabedMaterialNode(node) || node.parameters?.material_model === 'Drucker-Prager' || node.parameters?.material_model === 'Mohr-Coulomb';

            // Ambient Air Chip
            if (isAir || airConns.length > 0) {
                const currentSolverId = airConns.length > 0 ? (airConns[0].toNode === node.id ? airConns[0].fromNode : airConns[0].toNode) : (node.parameters?.ambient_air_target || '');
                const solverNode = model.nodes.find(n => n.id === currentSolverId);
                const airChip = document.createElement('span');
                airChip.className = 'pipeline-conn-chip chip-air';
                if (solverNode) {
                    airChip.classList.add('connected');
                    airChip.textContent = `💨 Air: ${this.getCleanEntityName(solverNode.parameters?.name || solverNode.type)}`;
                    airChip.title = `Material assigned as ambient air to ${solverNode.parameters?.name || solverNode.id}. Click to reassign or disconnect.`;
                } else {
                    airChip.classList.add('unconnected');
                    airChip.textContent = '💨 Assign Air to CFD';
                    airChip.title = 'Ambient Air Material is not assigned to any CFD domain! Click to assign.';
                }
                airChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type))
                        .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                    this.showQuickAssignPopup({
                        anchorEl: airChip,
                        title: 'Ambient Air CFD Domain',
                        currentId: currentSolverId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignAirTargetDomain(node, selectedId, model)
                    });
                });
                group.appendChild(airChip);
            }

            // Seawater Chip for Tait Water Material
            if (isWater || waterConns.length > 0) {
                const currentSolverId = waterConns.length > 0 ? (waterConns[0].toNode === node.id ? waterConns[0].fromNode : waterConns[0].toNode) : (node.parameters?.water_target || '');
                const solverNode = model.nodes.find(n => n.id === currentSolverId);
                const waterChip = document.createElement('span');
                waterChip.className = 'pipeline-conn-chip';
                waterChip.style.borderColor = '#0ea5e9';
                if (solverNode) {
                    waterChip.classList.add('connected');
                    waterChip.style.background = 'rgba(14, 165, 233, 0.2)';
                    waterChip.style.color = '#38bdf8';
                    waterChip.textContent = `💧 Seawater: ${this.getCleanEntityName(solverNode.parameters?.name || solverNode.type)}`;
                    waterChip.title = `Material assigned as seawater to ${solverNode.parameters?.name || solverNode.id}. Click to reassign or disconnect.`;
                } else {
                    waterChip.classList.add('unconnected');
                    waterChip.textContent = '💧 Assign Seawater to Harbour';
                    waterChip.title = 'Seawater Material is not assigned to any Marine Harbour domain! Click to assign.';
                }
                waterChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => ['MarineHarbourDomain', 'CFDSolver3D'].includes(n.type))
                        .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                    this.showQuickAssignPopup({
                        anchorEl: waterChip,
                        title: 'Target Harbour / UNDEX Domain',
                        currentId: currentSolverId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignWaterTargetDomain(node, selectedId, model)
                    });
                });
                group.appendChild(waterChip);
            }

            // Seabed Foundation Chip for Geotechnical / Seabed Material
            if (isSeabed || seabedConns.length > 0) {
                const currentSolverId = seabedConns.length > 0 ? (seabedConns[0].toNode === node.id ? seabedConns[0].fromNode : seabedConns[0].toNode) : (node.parameters?.seabed_target || '');
                const solverNode = model.nodes.find(n => n.id === currentSolverId);
                const seabedChip = document.createElement('span');
                seabedChip.className = 'pipeline-conn-chip';
                seabedChip.style.borderColor = '#f59e0b';
                if (solverNode) {
                    seabedChip.classList.add('connected');
                    seabedChip.style.background = 'rgba(245, 158, 11, 0.2)';
                    seabedChip.style.color = '#f59e0b';
                    seabedChip.textContent = `🪨 Seabed: ${this.getCleanEntityName(solverNode.parameters?.name || solverNode.type)}`;
                    seabedChip.title = `Material assigned as seabed foundation to ${solverNode.parameters?.name || solverNode.id}. Click to reassign or disconnect.`;
                } else {
                    seabedChip.classList.add('unconnected');
                    seabedChip.textContent = '🪨 Assign Seabed to Harbour';
                    seabedChip.title = 'Seabed Material is not assigned to any Marine Harbour domain! Click to assign.';
                }
                seabedChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => n.type === 'MarineHarbourDomain')
                        .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                    this.showQuickAssignPopup({
                        anchorEl: seabedChip,
                        title: 'Target Harbour Domain (seabed foundation)',
                        currentId: currentSolverId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignSeabedTargetDomain(node, selectedId, model)
                    });
                });
                group.appendChild(seabedChip);
            }

            // High-Explosive Target Charge Chip
            if (isEnergetic) {
                const chargeNodes = model.nodes.filter(n => ['Charge1D', 'Charge2D', 'Charge3D'].includes(n.type));
                const chgConn = matConns.find(c => chargeNodes.some(ch => ch.id === c.toNode || ch.id === c.fromNode));
                const currentChgId = chgConn ? (chgConn.toNode === node.id ? chgConn.fromNode : chgConn.toNode) : '';
                const chgNode = model.nodes.find(n => n.id === currentChgId);
                const chgChip = document.createElement('span');
                chgChip.className = 'pipeline-conn-chip chip-charge';
                if (chgNode) {
                    chgChip.classList.add('connected');
                    chgChip.textContent = `💥 Charge: ${this.getCleanEntityName(chgNode.parameters?.name || chgNode.type)}`;
                    chgChip.title = `Material assigned to charge [${chgNode.parameters?.name || chgNode.id}]. Click to reassign or disconnect.`;
                } else {
                    chgChip.classList.add('unconnected');
                    chgChip.textContent = '➕ Assign Charge';
                    chgChip.title = 'Energetic material not assigned to any Charge node! Click to assign.';
                }
                chgChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = chargeNodes.map(n => ({
                        id: n.id,
                        label: n.parameters?.name || n.type,
                        sublabel: `${n.parameters?.charge_mass ?? '0.85'} kg`
                    }));
                    this.showQuickAssignPopup({
                        anchorEl: chgChip,
                        title: 'Target Explosive Charge',
                        currentId: currentChgId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => {
                            if (selectedId) {
                                const targetCharge = model.nodes.find(n => n.id === selectedId);
                                if (targetCharge) this.assignChargeMaterial(targetCharge, node.id, model);
                            } else if (currentChgId) {
                                const prevCharge = model.nodes.find(n => n.id === currentChgId);
                                if (prevCharge) this.assignChargeMaterial(prevCharge, '', model);
                            }
                        }
                    });
                });
                group.appendChild(chgChip);
            }

            // Other object connections (FEM/MPM/Harbour/Rigid)
            const targetBodyTypes = ['FEMObject3D', 'MPMObject3D', 'RigidBody3D', 'MarineHarbourDomain', 'FEMDomain3D', 'MPMDomain3D', 'Obstacle3D', 'Obstacle'];
            const assignedBodies = model.nodes.filter(n => targetBodyTypes.includes(n.type) && (
                n.parameters?.material === node.id ||
                n.parameters?.seabed_foundation === node.id ||
                seabedConns.some(c => c.toNode === n.id || c.fromNode === n.id) ||
                matConns.some(c => (c.toNode === n.id && (c.toPort === 'material' || c.toPort === 'mat' || c.toPort === 'in' || c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'elements' || c.toPort === 'seabed')) || (c.fromNode === n.id && (c.fromPort === 'material' || c.fromPort === 'mat' || c.fromPort === 'out')))
            ));

            const candidateBodies = model.nodes
                .filter(n => targetBodyTypes.includes(n.type))
                .map(n => ({
                    id: n.id,
                    label: n.parameters?.name || n.type,
                    sublabel: n.type
                }));

            if (assignedBodies.length > 0) {
                const objChip = document.createElement('span');
                objChip.className = 'pipeline-conn-chip connected';
                objChip.textContent = assignedBodies.length === 1 
                    ? `🔗 ${this.getCleanEntityName(assignedBodies[0].parameters?.name || assignedBodies[0].type)}`
                    : `🔗 ${assignedBodies.length} bodies`;
                objChip.title = `Material assigned to ${assignedBodies.map(b => b.parameters?.name || b.type).join(', ')}. Click to reassign or disconnect.`;
                objChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showQuickAssignPopup({
                        anchorEl: objChip,
                        title: 'Assign Material to Body / Domain',
                        currentId: assignedBodies.length === 1 ? assignedBodies[0].id : '',
                        candidateNodes: candidateBodies,
                        model,
                        onSelect: (selectedId) => {
                            if (selectedId) {
                                const targetBody = model.nodes.find(n => n.id === selectedId);
                                if (targetBody) this.assignObjectMaterial(targetBody, node.id, model);
                            } else {
                                assignedBodies.forEach(b => this.assignObjectMaterial(b, '', model));
                            }
                        }
                    });
                });
                group.appendChild(objChip);
            } else if (!isAir && !isEnergetic && !isWater && !isSeabed && airConns.length === 0 && waterConns.length === 0 && seabedConns.length === 0) {
                const unassignedChip = document.createElement('span');
                unassignedChip.className = 'pipeline-conn-chip unconnected';
                unassignedChip.textContent = '⚠️ Unassigned';
                unassignedChip.title = 'Material is not assigned to any object or domain! Click to assign.';
                unassignedChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showQuickAssignPopup({
                        anchorEl: unassignedChip,
                        title: 'Assign Material to Body / Domain',
                        currentId: '',
                        candidateNodes: candidateBodies,
                        model,
                        onSelect: (selectedId) => {
                            if (selectedId) {
                                const targetBody = model.nodes.find(n => n.id === selectedId);
                                if (targetBody) this.assignObjectMaterial(targetBody, node.id, model);
                            }
                        }
                    });
                });
                group.appendChild(unassignedChip);
            }

            return group.children.length > 0 ? group : null;
        }

        // 5. Solvers (CFD / MPM / FEM)
        if (['CFDSolver', 'CFDSolver3D', 'MPMDomain3D', 'FEMDomain3D', 'CFDSolver2D', 'MPMDomain2D'].includes(node.type)) {
            const isCFD = ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D'].includes(node.type);
            const is3D = node.type === 'CFDSolver3D' || node.type === 'MPMDomain3D' || node.type === 'FEMDomain3D';
            const is2D = node.type === 'CFDSolver2D' || node.type === 'MPMDomain2D';

            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            // Check if remap is active or connected for CFD
            const remapConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'remap' || c.toPort === 'in')) || (c.fromNode === node.id && c.fromPort === 'remap'));
            const remapNodes = model.nodes.filter(n => is3D ? (n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode') : (n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode'));
            let currentRemapId = remapConn ? (remapConn.toNode === node.id ? remapConn.fromNode : remapConn.toNode) : (node.parameters?.remap || '');
            if (!currentRemapId && remapNodes.length === 1) {
                currentRemapId = remapNodes[0].id;
            }
            const remapNode = model.nodes.find(n => n.id === currentRemapId);
            const isRemapActive = isCFD && (is2D || is3D) && (!!remapNode || node.parameters?.init_mode === 'From1D' || node.parameters?.init_mode === 'From2D');

            // 1. Mesh Chip
            const meshConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'mesh' || c.toPort === 'in')) || (c.fromNode === node.id && c.fromPort === 'mesh'));
            let currentMeshId = meshConn ? (meshConn.toNode === node.id ? meshConn.fromNode : meshConn.toNode) : (node.parameters?.mesh || '');
            const meshNode = model.nodes.find(n => n.id === currentMeshId);
            const meshChip = document.createElement('span');
            meshChip.className = 'pipeline-conn-chip chip-mesh';
            if (meshNode) {
                meshChip.classList.add('connected');
                const cs = meshNode.parameters?.cell_size ?? meshNode.parameters?.dx;
                const csStr = cs !== undefined ? ` (${cs}m)` : '';
                meshChip.textContent = `📐 ${this.getCleanEntityName(meshNode.parameters?.name || meshNode.type)}${csStr}`;
                meshChip.title = `Background Mesh [${meshNode.parameters?.name || meshNode.id}] is wired. Click to reassign or disconnect.`;
            } else {
                meshChip.classList.add('unconnected');
                meshChip.textContent = '📐 +Mesh';
                meshChip.title = 'No background mesh connected! Click to assign mesh.';
            }
            meshChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = model.nodes
                    .filter(n => is3D ? n.type === 'DomainMesh3D' : (is2D ? n.type === 'DomainMesh2D' : ['DomainMesh', 'DomainMesh2D', 'DomainMesh3D'].includes(n.type)))
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                this.showQuickAssignPopup({
                    anchorEl: meshChip,
                    title: 'Background Mesh',
                    currentId: currentMeshId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignMeshToSolver(node, selectedId, model)
                });
            });
            group.appendChild(meshChip);

            // 2. Air Material Chip (for CFD solvers)
            if (isCFD) {
                const airConn = state.connections.find(c => (c.toNode === node.id && c.toPort === 'air') || (c.fromNode === node.id && c.fromPort === 'air'));
                let currentAirId = airConn ? (airConn.toNode === node.id ? airConn.fromNode : airConn.toNode) : (node.parameters?.ambient_air_material || '');
                const airNode = model.nodes.find(n => n.id === currentAirId);
                if (airNode) {
                    const airChip = document.createElement('span');
                    airChip.className = 'pipeline-conn-chip chip-air connected';
                    const airPreset = airNode.parameters?.preset || airNode.parameters?.material_model || 'Air';
                    airChip.textContent = `💨 ${this.getCleanEntityName(airNode.parameters?.name || airPreset)}`;
                    airChip.title = `Ambient Air Material [${airNode.parameters?.name || airNode.id}] is wired. Click to reassign or disconnect.`;
                    airChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const candidates = model.nodes
                            .filter(n => n.type === 'Material')
                            .map(n => {
                                const preset = n.parameters?.preset || n.parameters?.material_model || 'Material';
                                return { id: n.id, label: n.parameters?.name || n.type, sublabel: preset };
                            });
                        this.showQuickAssignPopup({
                            anchorEl: airChip,
                            title: 'Ambient Air Material',
                            currentId: currentAirId,
                            candidateNodes: candidates,
                            model,
                            onSelect: (selectedId) => this.assignAirToSolver(node, selectedId, model)
                        });
                    });
                    group.appendChild(airChip);
                } else if (!isRemapActive) {
                    const airChip = document.createElement('span');
                    airChip.className = 'pipeline-conn-chip chip-air unconnected';
                    airChip.textContent = '💨 +Air';
                    airChip.title = 'No ambient air material connected! Click to assign material.';
                    airChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const candidates = model.nodes
                            .filter(n => n.type === 'Material')
                            .map(n => {
                                const preset = n.parameters?.preset || n.parameters?.material_model || 'Material';
                                return { id: n.id, label: n.parameters?.name || n.type, sublabel: preset };
                            });
                        this.showQuickAssignPopup({
                            anchorEl: airChip,
                            title: 'Ambient Air Material',
                            currentId: currentAirId,
                            candidateNodes: candidates,
                            model,
                            onSelect: (selectedId) => this.assignAirToSolver(node, selectedId, model)
                        });
                    });
                    group.appendChild(airChip);
                }

                // 3. Charge Chip (for CFD solvers) - suppress unconnected chip if remap is active!
                const chgConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
                let currentChgId = chgConn ? chgConn.fromNode : (node.parameters?.explosive_charge || '');
                const chgNode = model.nodes.find(n => n.id === currentChgId);
                if (chgNode) {
                    const chgChip = document.createElement('span');
                    chgChip.className = 'pipeline-conn-chip chip-charge connected';
                    const chgMass = chgNode.parameters?.charge_mass ?? '0.85';
                    chgChip.textContent = `💥 ${this.getCleanEntityName(chgNode.parameters?.name || chgNode.type)} (${chgMass}kg)`;
                    chgChip.title = `Explosive Charge [${chgNode.parameters?.name || chgNode.id}] is wired. Click to reassign or disconnect.`;
                    chgChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const candidates = model.nodes
                            .filter(n => is3D ? n.type === 'Charge3D' : (is2D ? n.type === 'Charge2D' : n.type === 'Charge1D'))
                            .map(n => ({
                                id: n.id,
                                label: n.parameters?.name || n.type,
                                sublabel: `${n.parameters?.charge_mass ?? '0.85'} kg`
                            }));
                        this.showQuickAssignPopup({
                            anchorEl: chgChip,
                            title: 'High-Explosive Charge',
                            currentId: currentChgId,
                            candidateNodes: candidates,
                            model,
                            onSelect: (selectedId) => this.assignChargeToSolver(node, selectedId, model)
                        });
                    });
                    group.appendChild(chgChip);
                } else if (!isRemapActive) {
                    const chgChip = document.createElement('span');
                    chgChip.className = 'pipeline-conn-chip chip-charge unconnected';
                    chgChip.textContent = '➕ +Charge';
                    chgChip.title = 'No explosive charge connected. Click to assign charge.';
                    chgChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const candidates = model.nodes
                            .filter(n => is3D ? n.type === 'Charge3D' : (is2D ? n.type === 'Charge2D' : n.type === 'Charge1D'))
                            .map(n => ({
                                id: n.id,
                                label: n.parameters?.name || n.type,
                                sublabel: `${n.parameters?.charge_mass ?? '0.85'} kg`
                            }));
                        this.showQuickAssignPopup({
                            anchorEl: chgChip,
                            title: 'High-Explosive Charge',
                            currentId: currentChgId,
                            candidateNodes: candidates,
                            model,
                            onSelect: (selectedId) => this.assignChargeToSolver(node, selectedId, model)
                        });
                    });
                    group.appendChild(chgChip);
                }
            }

            // 4. Detonator Chip (if wired)
            const detConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'detonator' || c.toPort === 'trigger' || c.toPort === 'detonators'));
            if (detConn) {
                const detNode = model.nodes.find(n => n.id === detConn.fromNode);
                const detChip = document.createElement('span');
                detChip.className = 'pipeline-conn-chip connected';
                detChip.textContent = `🎯 ${this.getCleanEntityName(detNode?.parameters?.name || detNode?.type || 'Det')}`;
                detChip.title = `Detonator [${detNode?.parameters?.name || detNode?.id}] is connected. Click to open connections manager.`;
                detChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    new PipelineConnectionModal(this.stateManager, model, () => this.render());
                });
                group.appendChild(detChip);
            }

            // 5. Remapper Chip (for CFD 2D/3D solvers)
            if (isCFD && (is2D || is3D)) {
                const remapChip = document.createElement('span');
                remapChip.className = 'pipeline-conn-chip chip-remap';
                if (remapNode) {
                    remapChip.classList.add('connected');
                    remapChip.textContent = `🔄 ${this.getCleanEntityName(remapNode.parameters?.name || (is3D ? '1D→3D' : '1D→2D'))}`;
                    remapChip.title = `Remap node [${remapNode.parameters?.name || remapNode.id}] is assigned. Click to reassign or disconnect.`;
                } else if (remapNodes.length > 0) {
                    remapChip.classList.add('unconnected');
                    remapChip.textContent = '🔄 +Remap';
                    remapChip.title = 'Model contains a remap node but it is not wired to this CFD domain. Click to assign.';
                }
                if (remapNode || remapNodes.length > 0) {
                    remapChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const candidates = remapNodes.map(n => ({
                            id: n.id,
                            label: n.parameters?.name || n.type,
                            sublabel: n.type
                        }));
                        this.showQuickAssignPopup({
                            anchorEl: remapChip,
                            title: 'Remapper Node',
                            currentId: currentRemapId,
                            candidateNodes: candidates,
                            model,
                            onSelect: (selectedId) => this.assignRemapToSolver(node, selectedId, model)
                        });
                    });
                    group.appendChild(remapChip);
                }
            }

            return group;
        }

        // 6. Charges
        if (node.type === 'Charge3D' || node.type === 'Charge2D' || node.type === 'Charge1D') {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            // Target CFD Domain Chip
            const conn = state.connections.find(c => c.fromNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            const currentSolverId = conn ? conn.toNode : (node.parameters?.target_domain || '');
            const solver = model.nodes.find(n => n.id === currentSolverId);
            const solverChip = document.createElement('span');
            solverChip.className = 'pipeline-conn-chip chip-charge';
            if (solver) {
                solverChip.classList.add('connected');
                solverChip.textContent = `🎯 CFD: ${this.getCleanEntityName(solver.parameters?.name || solver.type)}`;
                solverChip.title = `Charge wired to ${solver.parameters?.name || solver.id}. Click to reassign or disconnect.`;
            } else {
                solverChip.classList.add('unconnected');
                solverChip.textContent = '⚠️ Assign CFD';
                solverChip.title = 'Charge is not connected to any CFD solver! Click to assign.';
            }
            solverChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = model.nodes
                    .filter(n => node.type === 'Charge3D' ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : (node.type === 'Charge2D' ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver'))
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                this.showQuickAssignPopup({
                    anchorEl: solverChip,
                    title: 'Target CFD Domain',
                    currentId: currentSolverId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignChargeTargetDomain(node, selectedId, model)
                });
            });
            group.appendChild(solverChip);

            // Assigned Explosive Material Chip
            const matConn = state.connections.find(c => (c.toNode === node.id || c.fromNode === node.id) && (c.toPort === 'material' || c.fromPort === 'material'));
            const currentMatId = matConn ? (matConn.toNode === node.id ? matConn.fromNode : matConn.toNode) : (node.parameters?.material || '');
            const matNode = model.nodes.find(n => n.id === currentMatId);
            const matChip = document.createElement('span');
            matChip.className = 'pipeline-conn-chip chip-air';
            if (matNode) {
                matChip.classList.add('connected');
                const preset = matNode.parameters?.preset || matNode.parameters?.material_model || 'Material';
                matChip.textContent = `💥 Mat: ${this.getCleanEntityName(matNode.parameters?.name || preset)}`;
                matChip.title = `Explosive Material [${matNode.parameters?.name || matNode.id}] assigned. Click to reassign or disconnect.`;
            } else {
                matChip.classList.add('unconnected');
                matChip.textContent = '⚠️ Assign Mat';
                matChip.title = 'Charge has no explosive material assigned! Click to assign material.';
            }
            matChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = model.nodes
                    .filter(n => (n.type === 'Material' || (n.type as string).startsWith('MPMMaterial')) && isExplosiveMaterialNode(n))
                    .map(n => {
                        const preset = n.parameters?.preset || n.parameters?.material_model || 'Material';
                        return { id: n.id, label: n.parameters?.name || n.type, sublabel: preset };
                    });
                this.showQuickAssignPopup({
                    anchorEl: matChip,
                    title: 'Assigned Explosive Material',
                    currentId: currentMatId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignChargeMaterial(node, selectedId, model)
                });
            });
            group.appendChild(matChip);

            return group;
        }

        // 7. FSI Couplers
        if (node.type === 'FEMFSICoupler3D' || node.type === 'FSICoupler3D' || node.type === 'FSICoupler2D') {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';
            const isFem = node.type === 'FEMFSICoupler3D';

            const cfdConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver'));
            const structConn = state.connections.find(c => c.toNode === node.id && (c.toPort === (isFem ? 'fem' : 'mpm') || c.toPort === (isFem ? 'fem_domain' : 'mpm_domain')));

            const cfdChip = document.createElement('span');
            cfdChip.className = 'pipeline-conn-chip';
            if (cfdConn) {
                cfdChip.classList.add('connected');
                cfdChip.textContent = '🔗 CFD Wired';
            } else {
                cfdChip.classList.add('unconnected');
                cfdChip.textContent = '⚠️ No CFD';
            }
            cfdChip.addEventListener('click', (e) => {
                e.stopPropagation();
                new PipelineConnectionModal(this.stateManager, model, () => this.render());
            });
            group.appendChild(cfdChip);

            const structChip = document.createElement('span');
            structChip.className = 'pipeline-conn-chip';
            if (structConn) {
                structChip.classList.add('connected');
                structChip.textContent = `🔗 ${isFem ? 'FEM' : 'MPM'} Wired`;
            } else {
                structChip.classList.add('unconnected');
                structChip.textContent = `⚠️ No ${isFem ? 'FEM' : 'MPM'}`;
            }
            structChip.addEventListener('click', (e) => {
                e.stopPropagation();
                new PipelineConnectionModal(this.stateManager, model, () => this.render());
            });
            group.appendChild(structChip);

            return group;
        }

        // 8. Remap Nodes (1D->3D, 2D->3D, 1D->2D)
        if (['Remap1DTo3DNode', 'Remap2DTo3DNode', 'RemapNode', 'Remap1DTo2DNode'].includes(node.type)) {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            const is3D = node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode';
            const is2Dto3D = node.type === 'Remap2DTo3DNode';
            const allModels = this.stateManager.getAllModels();
            const ws = this.stateManager.getActiveWorkspace();

            // 1. Upstream Source Model Chip
            let currentSourceModelId = node.parameters?.source_model_id || '';
            if (!currentSourceModelId && ws && ws.connections) {
                const wsConn = ws.connections.find(c => c.toNode === node.id);
                if (wsConn) {
                    const srcM = allModels.find(m => m.nodes.some(n => n.id === wsConn.fromNode));
                    if (srcM) currentSourceModelId = srcM.id;
                }
            }
            const sourceModel = allModels.find(m => m.id === currentSourceModelId);
            const srcChip = document.createElement('span');
            srcChip.className = 'pipeline-conn-chip chip-remap';
            const sourceDimLabel = is2Dto3D ? '2D' : '1D';

            if (sourceModel) {
                srcChip.classList.add('connected');
                srcChip.textContent = `📥 ${sourceDimLabel}: ${sourceModel.name || sourceModel.id}`;
                srcChip.title = `Upstream shock source: [${sourceModel.name || sourceModel.id}]. Click to select or disconnect source model.`;
            } else {
                srcChip.classList.add('unconnected');
                srcChip.textContent = `⚠️ +Source ${sourceDimLabel} Model`;
                srcChip.title = `No upstream ${sourceDimLabel} CFD model connected! Click to select source model.`;
            }

            srcChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const compatibleModels = allModels.filter(m => m.id !== model.id && m.nodes.some(n => is2Dto3D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver'));
                const candidates = [
                    { id: '', label: '🚫 [None (Disconnect)]', sublabel: 'Disconnect upstream source shock model' },
                    ...compatibleModels.map(m => {
                        const solver = m.nodes.find(n => is2Dto3D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver');
                        const solverLabel = solver?.parameters?.name || (is2Dto3D ? 'CFDSolver2D' : 'CFDSolver');
                        return {
                            id: m.id,
                            label: m.name || m.id,
                            sublabel: `${sourceDimLabel} CFD (${solverLabel})`
                        };
                    })
                ];
                this.showQuickAssignPopup({
                    anchorEl: srcChip,
                    title: `Upstream Source ${sourceDimLabel} Model`,
                    currentId: currentSourceModelId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignRemapSourceModel(node, selectedId, model)
                });
            });
            group.appendChild(srcChip);

            // 2. Downstream Target Solver Chip
            const conn = state.connections.find(c => (c.fromNode === node.id && (c.toPort === 'remap' || c.toPort === 'in')) || (c.toNode === node.id && c.toPort === 'remap'));
            let currentSolverId = conn ? (conn.toNode === node.id ? conn.fromNode : conn.toNode) : (node.parameters?.target_solver || '');
            const targetSolvers = model.nodes.filter(n => is3D ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : n.type === 'CFDSolver2D');
            if (!currentSolverId && targetSolvers.length === 1) {
                currentSolverId = targetSolvers[0].id;
            }
            const targetSolver = model.nodes.find(n => n.id === currentSolverId);
            const solverChip = document.createElement('span');
            solverChip.className = 'pipeline-conn-chip chip-charge';

            if (targetSolver) {
                solverChip.classList.add('connected');
                solverChip.textContent = `🎯 CFD: ${this.getCleanEntityName(targetSolver.parameters?.name || targetSolver.type)}`;
                solverChip.title = `Remapper wired to recipient solver [${targetSolver.parameters?.name || targetSolver.id}]. Click to reassign or disconnect.`;
            } else {
                solverChip.classList.add('unconnected');
                solverChip.textContent = '🎯 +Wire CFD Solver';
                solverChip.title = 'Remapper is not wired to any downstream CFD solver in this model! Click to wire.';
            }

            solverChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = targetSolvers.map(s => ({
                    id: s.id,
                    label: s.parameters?.name || s.type,
                    sublabel: is3D ? '3D CFD Grid' : '2D CFD Grid'
                }));
                this.showQuickAssignPopup({
                    anchorEl: solverChip,
                    title: 'Target Receiving CFD Solver',
                    currentId: currentSolverId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => {
                        const s = model.nodes.find(n => n.id === selectedId);
                        if (s) {
                            this.assignRemapToSolver(s, node.id, model);
                        } else {
                            this.assignRemapToSolver(targetSolver || targetSolvers[0], '', model);
                        }
                    }
                });
            });
            group.appendChild(solverChip);

            return group;
        }

        // 9. Marine Harbour & UNDEX Domain Chips (Directive 18)
        if (node.type === 'MarineHarbourDomain' || (node.type === 'CFDSolver3D' && node.parameters?.init_mode === 'Hydrostatic_Stratified_3D')) {
            const group = document.createElement('span');
            group.className = 'pipeline-conn-chip-group';

            // 0. Background Mesh Chip
            const meshConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'mesh' || c.toPort === 'in')) || (c.fromNode === node.id && c.fromPort === 'mesh'));
            let currentMeshId = meshConn ? (meshConn.toNode === node.id ? meshConn.fromNode : meshConn.toNode) : (node.parameters?.mesh || '');
            const meshNode = model.nodes.find(n => n.id === currentMeshId);
            const meshChip = document.createElement('span');
            meshChip.className = 'pipeline-conn-chip chip-mesh';
            if (meshNode) {
                meshChip.classList.add('connected');
                const cs = meshNode.parameters?.cell_size ?? 0.01;
                const nx = meshNode.parameters?.nx ?? 100;
                const ny = meshNode.parameters?.ny ?? 100;
                const nz = meshNode.parameters?.nz ?? 100;
                const dimStr = (nx === ny && ny === nz) ? `${nx}³` : `${nx}×${ny}×${nz}`;
                meshChip.textContent = `📐 Mesh ${dimStr} (${cs}m)`;
                meshChip.title = `Background Mesh [${meshNode.parameters?.name || meshNode.id}] is wired (dx = ${cs}m, ${nx}x${ny}x${nz}). Click to reassign or disconnect.`;
            } else {
                meshChip.classList.add('unconnected');
                meshChip.textContent = '📐 +Mesh';
                meshChip.title = 'Marine Harbour Domain requires a background mesh! Click to assign DomainMesh3D.';
            }
            meshChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates: { id: string; label: string; sublabel?: string }[] = model.nodes
                    .filter(n => n.type === 'DomainMesh3D')
                    .map(n => ({ id: n.id, label: n.parameters?.name || n.type, sublabel: n.type }));
                candidates.push({
                    id: '__create_new_mesh__',
                    label: '➕ Create New Background Grid (DomainMesh3D)',
                    sublabel: 'Adds a 3D Cartesian background grid and connects it to this domain'
                });
                this.showQuickAssignPopup({
                    anchorEl: meshChip,
                    title: 'Background Mesh',
                    currentId: currentMeshId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => {
                        if (selectedId === '__create_new_mesh__') {
                            const newMeshId = this.stateManager.generateUniqueNodeId('DomainMesh3D');
                            const newMeshNode: Node = {
                                id: newMeshId,
                                type: 'DomainMesh3D',
                                x: (node.x || 300) - 320,
                                y: node.y || 100,
                                displayMode: 'expanded',
                                inputs: this.stateManager.getDefaultInputs('DomainMesh3D'),
                                outputs: this.stateManager.getDefaultOutputs('DomainMesh3D'),
                                parameters: { ...this.stateManager.getDefaultParameters('DomainMesh3D'), name: 'Domain Mesh 3D' }
                            };
                            model.nodes.push(newMeshNode);
                            this.assignMeshToSolver(node, newMeshId, model);
                        } else {
                            this.assignMeshToSolver(node, selectedId, model);
                        }
                    }
                });
            });
            group.appendChild(meshChip);

            // 0b. Explosive Charge Chip
            const chgConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')) || (c.fromNode === node.id && (c.fromPort === 'charge' || c.fromPort === 'explosive')));
            let currentChgId = chgConn ? (chgConn.toNode === node.id ? chgConn.fromNode : chgConn.toNode) : (node.parameters?.explosive_charge || '');
            const chgNode = model.nodes.find(n => n.id === currentChgId);
            if (chgNode) {
                const chgChip = document.createElement('span');
                chgChip.className = 'pipeline-conn-chip chip-charge connected';
                const chgMass = chgNode.parameters?.charge_mass ?? '0.85';
                chgChip.textContent = `💥 ${this.getCleanEntityName(chgNode.parameters?.name || chgNode.type)} (${chgMass}kg)`;
                chgChip.title = `Explosive Charge [${chgNode.parameters?.name || chgNode.id}] is wired. Click to reassign or disconnect.`;
                chgChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => n.type === 'Charge3D')
                        .map(n => ({
                            id: n.id,
                            label: n.parameters?.name || n.type,
                            sublabel: `${n.parameters?.charge_mass ?? '0.85'} kg`
                        }));
                    this.showQuickAssignPopup({
                        anchorEl: chgChip,
                        title: 'High-Explosive Charge',
                        currentId: currentChgId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignChargeToSolver(node, selectedId, model)
                    });
                });
                group.appendChild(chgChip);
            } else {
                const chgChip = document.createElement('span');
                chgChip.className = 'pipeline-conn-chip chip-charge unconnected';
                chgChip.textContent = '➕ +Charge';
                chgChip.title = 'No explosive charge connected. Click to assign charge.';
                chgChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const candidates = model.nodes
                        .filter(n => n.type === 'Charge3D')
                        .map(n => ({
                            id: n.id,
                            label: n.parameters?.name || n.type,
                            sublabel: `${n.parameters?.charge_mass ?? '0.85'} kg`
                        }));
                    this.showQuickAssignPopup({
                        anchorEl: chgChip,
                        title: 'High-Explosive Charge',
                        currentId: currentChgId,
                        candidateNodes: candidates,
                        model,
                        onSelect: (selectedId) => this.assignChargeToSolver(node, selectedId, model)
                    });
                });
                group.appendChild(chgChip);
            }

            // 0c. Detonator Chip (if connected)
            const detConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'detonator' || c.toPort === 'trigger')) || (c.fromNode === node.id && (c.fromPort === 'detonator' || c.fromPort === 'trigger')));
            if (detConn) {
                const detNode = model.nodes.find(n => n.id === (detConn.toNode === node.id ? detConn.fromNode : detConn.toNode));
                const detChip = document.createElement('span');
                detChip.className = 'pipeline-conn-chip connected';
                detChip.textContent = `🎯 ${this.getCleanEntityName(detNode?.parameters?.name || detNode?.type || 'Det')}`;
                detChip.title = `Detonator [${detNode?.parameters?.name || detNode?.id}] is connected. Click to open connections manager.`;
                detChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    new PipelineConnectionModal(this.stateManager, model, () => this.render());
                });
                group.appendChild(detChip);
            }

            // 0d. Seawater Material Chip
            const waterConn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'water' || c.toPort === 'seawater')) || (c.fromNode === node.id && (c.fromPort === 'water' || c.fromPort === 'seawater')));
            let currentWaterId = waterConn ? (waterConn.toNode === node.id ? waterConn.fromNode : waterConn.toNode) : (node.parameters?.seawater_material || '');
            const waterMatNode = model.nodes.find(n => n.id === currentWaterId);
            const waterMatChip = document.createElement('span');
            waterMatChip.className = 'pipeline-conn-chip';
            waterMatChip.style.borderColor = '#0ea5e9';
            if (waterMatNode) {
                waterMatChip.classList.add('connected');
                waterMatChip.style.background = 'rgba(14, 165, 233, 0.2)';
                waterMatChip.style.color = '#38bdf8';
                waterMatChip.textContent = `💧 ${this.getCleanEntityName(waterMatNode.parameters?.name || waterMatNode.type)}`;
                waterMatChip.title = `Seawater Material [${waterMatNode.parameters?.name || waterMatNode.id}] is wired (Tait EOS). Click to reassign or disconnect.`;
            } else {
                waterMatChip.classList.add('unconnected');
                waterMatChip.textContent = '💧 +Seawater';
                waterMatChip.title = 'Marine Harbour Domain requires a seawater material! Click to assign.';
            }
            waterMatChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = model.nodes
                    .filter(n => n.type === 'Material')
                    .map(n => ({
                        id: n.id,
                        label: n.parameters?.name || n.type,
                        sublabel: n.parameters?.preset || n.parameters?.material_model || 'Material'
                    }));
                this.showQuickAssignPopup({
                    anchorEl: waterMatChip,
                    title: 'Seawater Material (Tait Water)',
                    currentId: currentWaterId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignWaterToSolver(node, selectedId, model)
                });
            });
            group.appendChild(waterMatChip);

            // 0e. Seabed Geotechnical Material Chip
            const seabedConn = state.connections.find(c => (c.toNode === node.id && c.toPort === 'seabed') || (c.fromNode === node.id && c.fromPort === 'seabed'));
            let currentSeabedId = seabedConn ? (seabedConn.toNode === node.id ? seabedConn.fromNode : seabedConn.toNode) : (node.parameters?.seabed_foundation || '');
            const seabedMatNode = model.nodes.find(n => n.id === currentSeabedId);
            const seabedMatChip = document.createElement('span');
            seabedMatChip.className = 'pipeline-conn-chip';
            seabedMatChip.style.borderColor = '#f59e0b';
            if (seabedMatNode) {
                seabedMatChip.classList.add('connected');
                seabedMatChip.style.background = 'rgba(217, 119, 6, 0.2)';
                seabedMatChip.style.color = '#fbbf24';
                seabedMatChip.textContent = `🪨 ${this.getCleanEntityName(seabedMatNode.parameters?.name || seabedMatNode.type)}`;
                seabedMatChip.title = `Seabed Geotechnical Material [${seabedMatNode.parameters?.name || seabedMatNode.id}] is wired. Click to reassign or disconnect.`;
            } else {
                seabedMatChip.classList.add('unconnected');
                seabedMatChip.textContent = '🪨 +Seabed';
                seabedMatChip.title = 'Click to assign geotechnical sediment material to harbour seabed.';
            }
            seabedMatChip.addEventListener('click', (e) => {
                e.stopPropagation();
                const candidates = model.nodes
                    .filter(n => n.type === 'Material')
                    .map(n => ({
                        id: n.id,
                        label: n.parameters?.name || n.type,
                        sublabel: n.parameters?.preset || n.parameters?.material_model || 'Material'
                    }));
                this.showQuickAssignPopup({
                    anchorEl: seabedMatChip,
                    title: 'Seabed Geotechnical Material',
                    currentId: currentSeabedId,
                    candidateNodes: candidates,
                    model,
                    onSelect: (selectedId) => this.assignSeabedToSolver(node, selectedId, model)
                });
            });
            group.appendChild(seabedMatChip);



            // Structures Chip: [🏛️ Struct: Quay Wall] or [🏛️ +Structure: Quay Wall]
            const femStructures = (model.nodes || []).filter(n => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'FEMBeam3D' || n.type === 'LSDynaImporter3D');
            const hasStruct = femStructures.length > 0;
            const structChip = document.createElement('span');
            structChip.className = `pipeline-conn-chip ${hasStruct ? 'connected' : 'warning'}`;
            structChip.style.background = hasStruct ? 'rgba(20, 184, 166, 0.2)' : 'rgba(20, 184, 166, 0.08)';
            structChip.style.borderColor = '#14b8a6';
            structChip.style.color = '#5eead4';
            if (hasStruct) {
                const wallObj = femStructures.find(n => n.type === 'FEMObject3D');
                const rawName = wallObj?.parameters?.name;
                const label = rawName ? this.getCleanEntityName(rawName) : `Quay Wall (${femStructures.length} parts)`;
                structChip.textContent = `🏛️ ${label}`;
                structChip.title = `Solid Structural Mesh (${femStructures.length} entities connected). Click to manage or add components.`;
            } else {
                structChip.textContent = `🏛️ +Structure: Quay Wall`;
                structChip.title = `No solid structural components in model. Click to instantiate a Concrete Quay Wall or import from another model.`;
            }
            structChip.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showHarbourStructurePopup(structChip, node, model);
            });
            group.appendChild(structChip);

            return group;
        }

        return null;
    }

    private showQuickAssignPopup(options: {
        anchorEl: HTMLElement;
        title: string;
        currentId: string;
        candidateNodes: Array<{ id: string; label: string; sublabel?: string }>;
        model: Model;
        hideNoneOption?: boolean;
        onSelect: (selectedId: string) => void;
    }): void {
        const existing = document.querySelector('.pipeline-quick-popup');
        if (existing) existing.remove();

        const popup = document.createElement('div');
        popup.className = 'pipeline-quick-popup';

        const rect = options.anchorEl.getBoundingClientRect();
        let top = rect.bottom + 4;
        let left = rect.left;
        if (left + 280 > window.innerWidth) {
            left = window.innerWidth - 290;
        }
        popup.style.top = `${top}px`;
        popup.style.left = `${Math.max(10, left)}px`;

        const header = document.createElement('div');
        header.className = 'pipeline-quick-popup-header';
        header.innerHTML = `<span>${options.title}</span>`;
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'pipeline-quick-popup-list';

        if (!options.hideNoneOption) {
            const noneItem = document.createElement('div');
            noneItem.className = 'pipeline-quick-popup-item' + (!options.currentId ? ' selected' : '');
            noneItem.innerHTML = `<span>(None / Disconnect)</span> ${!options.currentId ? '<span style="color:#38bdf8;">✓</span>' : ''}`;
            noneItem.onclick = (e) => {
                e.stopPropagation();
                popup.remove();
                options.onSelect('');
            };
            list.appendChild(noneItem);
        }

        let found = false;
        for (const cand of options.candidateNodes) {
            const item = document.createElement('div');
            const isSelected = cand.id === options.currentId;
            if (isSelected) found = true;
            item.className = 'pipeline-quick-popup-item' + (isSelected ? ' selected' : '');
            const subHtml = cand.sublabel ? `<span class="pipeline-quick-popup-item-sub">${cand.sublabel}</span>` : '';
            item.innerHTML = `<span>${cand.label}${subHtml}</span> ${isSelected ? '<span style="color:#38bdf8;">✓</span>' : ''}`;
            item.onclick = (e) => {
                e.stopPropagation();
                popup.remove();
                options.onSelect(cand.id);
            };
            list.appendChild(item);
        }

        if (!found && options.currentId) {
            const item = document.createElement('div');
            item.className = 'pipeline-quick-popup-item selected';
            item.innerHTML = `<span>Connected Entity [${options.currentId.substring(0, 8)}]</span> <span style="color:#38bdf8;">✓</span>`;
            item.onclick = (e) => {
                e.stopPropagation();
                popup.remove();
                options.onSelect(options.currentId);
            };
            list.appendChild(item);
        }
        popup.appendChild(list);

        const footer = document.createElement('div');
        footer.className = 'pipeline-quick-popup-footer';
        const modalBtn = document.createElement('button');
        modalBtn.className = 'pipeline-quick-popup-action';
        modalBtn.textContent = '🔗 Open Full Pipeline Connections Manager...';
        modalBtn.onclick = (e) => {
            e.stopPropagation();
            popup.remove();
            new PipelineConnectionModal(this.stateManager, options.model, () => this.render());
        };
        footer.appendChild(modalBtn);
        popup.appendChild(footer);

        document.body.appendChild(popup);

        const closeHandler = (e: MouseEvent) => {
            if (!popup.contains(e.target as any) && e.target !== options.anchorEl) {
                popup.remove();
                window.removeEventListener('click', closeHandler, true);
                window.removeEventListener('keydown', keyHandler);
            }
        };
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                popup.remove();
                window.removeEventListener('click', closeHandler, true);
                window.removeEventListener('keydown', keyHandler);
            }
        };
        setTimeout(() => {
            window.addEventListener('click', closeHandler, true);
            window.addEventListener('keydown', keyHandler);
        }, 10);
    }

    private assignAirToSolver(solver: Node, newAirId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.toNode === solver.id && c.toPort === 'air'));
        if (newAirId) {
            state.connections.push({
                fromNode: newAirId,
                fromPort: 'air',
                toNode: solver.id,
                toPort: 'air'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['ambient_air_material'] = newAirId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { ambient_air_material: newAirId });

        if (newAirId) {
            const mat = model.nodes.find(n => n.id === newAirId);
            if (mat) {
                if (!mat.parameters) mat.parameters = {};
                mat.parameters['ambient_air_target'] = solver.id;
                this.stateManager.updateNodeParametersInPlace(mat.id, { ambient_air_target: solver.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignChargeToSolver(solver: Node, newChargeId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.toNode === solver.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
        if (newChargeId) {
            state.connections.push({
                fromNode: newChargeId,
                fromPort: 'charge',
                toNode: solver.id,
                toPort: 'charge'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['explosive_charge'] = newChargeId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { explosive_charge: newChargeId });

        if (newChargeId) {
            const charge = model.nodes.find(n => n.id === newChargeId);
            if (charge) {
                if (!charge.parameters) charge.parameters = {};
                charge.parameters['target_domain'] = solver.id;
                this.stateManager.updateNodeParametersInPlace(charge.id, { target_domain: solver.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignRemapToSolver(solver: Node, newRemapId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.toNode === solver.id && (c.toPort === 'remap' || c.toPort === 'in')));
        if (newRemapId) {
            state.connections.push({
                fromNode: newRemapId,
                fromPort: 'remap',
                toNode: solver.id,
                toPort: 'remap'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['remap'] = newRemapId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { remap: newRemapId });

        if (newRemapId) {
            const remap = model.nodes.find(n => n.id === newRemapId);
            if (remap) {
                if (!remap.parameters) remap.parameters = {};
                remap.parameters['target_solver'] = solver.id;
                this.stateManager.updateNodeParametersInPlace(remap.id, { target_solver: solver.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignRemapSourceModel(remapNode: Node, newSourceModelId: string, model: Model): void {
        const ws = this.stateManager.getActiveWorkspace();
        const allModels = this.stateManager.getAllModels();
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        if (ws && ws.connections) {
            ws.connections = ws.connections.filter(c => c.toNode !== remapNode.id);
        }

        const isAuto = !newSourceModelId || newSourceModelId === '__auto__';
        const finalModelId = isAuto ? '' : newSourceModelId;

        if (!remapNode.parameters) remapNode.parameters = {};
        remapNode.parameters['source_model_id'] = finalModelId;
        this.stateManager.updateNodeParametersInPlace(remapNode.id, { source_model_id: finalModelId });

        if (finalModelId && ws) {
            const sourceModel = allModels.find(m => m.id === finalModelId);
            if (sourceModel) {
                const is2D = remapNode.type === 'Remap2DTo3DNode';
                const sourceSolver = sourceModel.nodes.find(n => is2D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver');
                if (sourceSolver) {
                    if (!ws.connections) ws.connections = [];
                    ws.connections.push({
                        fromNode: sourceSolver.id,
                        fromPort: 'telemetry',
                        toNode: remapNode.id,
                        toPort: 'in'
                    });
                }
            }
        }

        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignMeshToSolver(solver: Node, newMeshId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.toNode === solver.id && c.toPort === 'mesh'));
        if (newMeshId) {
            state.connections.push({
                fromNode: newMeshId,
                fromPort: 'mesh',
                toNode: solver.id,
                toPort: 'mesh'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['mesh'] = newMeshId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { mesh: newMeshId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignChargeMaterial(charge: Node, newMatId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.toNode === charge.id || c.fromNode === charge.id) && (c.toPort === 'material' || c.fromPort === 'material')));
        if (newMatId) {
            state.connections.push({
                fromNode: newMatId,
                fromPort: 'material',
                toNode: charge.id,
                toPort: 'material'
            });
        }
        if (!charge.parameters) charge.parameters = {};
        charge.parameters['material'] = newMatId;
        this.stateManager.updateNodeParametersInPlace(charge.id, { material: newMatId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignChargeTargetDomain(charge: Node, newSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.fromNode === charge.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
        if (newSolverId) {
            state.connections.push({
                fromNode: charge.id,
                fromPort: 'charge',
                toNode: newSolverId,
                toPort: 'charge'
            });
        }
        if (!charge.parameters) charge.parameters = {};
        charge.parameters['target_domain'] = newSolverId;
        this.stateManager.updateNodeParametersInPlace(charge.id, { target_domain: newSolverId });

        if (newSolverId) {
            const solver = model.nodes.find(n => n.id === newSolverId);
            if (solver) {
                if (!solver.parameters) solver.parameters = {};
                solver.parameters['explosive_charge'] = charge.id;
                this.stateManager.updateNodeParametersInPlace(solver.id, { explosive_charge: charge.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignAirTargetDomain(mat: Node, newSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'air' || c.fromPort === 'air')));
        if (newSolverId) {
            state.connections.push({
                fromNode: mat.id,
                fromPort: 'air',
                toNode: newSolverId,
                toPort: 'air'
            });
        }
        if (!mat.parameters) mat.parameters = {};
        mat.parameters['ambient_air_target'] = newSolverId;
        this.stateManager.updateNodeParametersInPlace(mat.id, { ambient_air_target: newSolverId });

        if (newSolverId) {
            const solver = model.nodes.find(n => n.id === newSolverId);
            if (solver) {
                if (!solver.parameters) solver.parameters = {};
                solver.parameters['ambient_air_material'] = mat.id;
                this.stateManager.updateNodeParametersInPlace(solver.id, { ambient_air_material: mat.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignSolverToMesh(mesh: Node, newSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.fromNode === mesh.id || c.toNode === mesh.id) && (c.toPort === 'mesh' || c.fromPort === 'mesh')));
        if (newSolverId) {
            state.connections.push({
                fromNode: mesh.id,
                fromPort: 'mesh',
                toNode: newSolverId,
                toPort: 'mesh'
            });
            const solver = model.nodes.find(n => n.id === newSolverId);
            if (solver) {
                if (!solver.parameters) solver.parameters = {};
                solver.parameters['mesh'] = mesh.id;
                this.stateManager.updateNodeParametersInPlace(solver.id, { mesh: mesh.id });
            }
        }
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignDetonatorTarget(det: Node, newSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        const isDet = det.type.startsWith('Detonator') || det.type.startsWith('Trigger');
        const port = isDet ? 'detonator' : 'charge';
        state.connections = state.connections.filter(c => !(c.fromNode === det.id && (c.toPort === 'detonator' || c.toPort === 'trigger' || c.toPort === 'detonators' || c.toPort === 'charge')));
        if (newSolverId) {
            state.connections.push({
                fromNode: det.id,
                fromPort: port,
                toNode: newSolverId,
                toPort: port
            });
        }
        if (!det.parameters) det.parameters = {};
        det.parameters['target_domain'] = newSolverId;
        this.stateManager.updateNodeParametersInPlace(det.id, { target_domain: newSolverId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignObjectDomain(body: Node, newDomainId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !(c.fromNode === body.id && (c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects' || c.toPort === 'in')));
        if (newDomainId) {
            const targetDom = model.nodes.find(n => n.id === newDomainId);
            const toPort = targetDom?.type === 'FEMDomain3D' ? 'mesh' : 'objects';
            state.connections.push({
                fromNode: body.id,
                fromPort: 'out',
                toNode: newDomainId,
                toPort: toPort
            });
        }
        if (!body.parameters) body.parameters = {};
        body.parameters['target_domain'] = newDomainId;
        this.stateManager.updateNodeParametersInPlace(body.id, { target_domain: newDomainId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignWaterToSolver(solver: Node, waterMatId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.toNode === solver.id || c.fromNode === solver.id) && (c.toPort === 'water' || c.fromPort === 'water' || c.toPort === 'seawater' || c.fromPort === 'seawater')));
        if (waterMatId) {
            state.connections.push({
                fromNode: waterMatId,
                fromPort: 'out',
                toNode: solver.id,
                toPort: 'water'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['seawater_material'] = waterMatId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { seawater_material: waterMatId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignSeabedToSolver(solver: Node, seabedMatId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.toNode === solver.id || c.fromNode === solver.id) && (c.toPort === 'seabed' || c.fromPort === 'seabed')));
        if (seabedMatId) {
            state.connections.push({
                fromNode: seabedMatId,
                fromPort: 'out',
                toNode: solver.id,
                toPort: 'seabed'
            });
        }
        if (!solver.parameters) solver.parameters = {};
        solver.parameters['seabed_foundation'] = seabedMatId;
        this.stateManager.updateNodeParametersInPlace(solver.id, { seabed_foundation: seabedMatId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignWaterTargetDomain(waterMat: Node, targetSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.fromNode === waterMat.id || c.toNode === waterMat.id) && (c.toPort === 'water' || c.fromPort === 'water' || c.toPort === 'seawater' || c.fromPort === 'seawater')));
        if (targetSolverId) {
            state.connections.push({
                fromNode: waterMat.id,
                fromPort: 'out',
                toNode: targetSolverId,
                toPort: 'water'
            });
            const solverNode = model.nodes.find(n => n.id === targetSolverId);
            if (solverNode) {
                if (!solverNode.parameters) solverNode.parameters = {};
                solverNode.parameters['seawater_material'] = waterMat.id;
                this.stateManager.updateNodeParametersInPlace(solverNode.id, { seawater_material: waterMat.id });
            }
        }
        if (!waterMat.parameters) waterMat.parameters = {};
        waterMat.parameters['water_target'] = targetSolverId;
        this.stateManager.updateNodeParametersInPlace(waterMat.id, { water_target: targetSolverId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignSeabedTargetDomain(seabedMat: Node, targetSolverId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        state.connections = state.connections.filter(c => !((c.fromNode === seabedMat.id || c.toNode === seabedMat.id) && (c.toPort === 'seabed' || c.fromPort === 'seabed')));
        if (targetSolverId) {
            state.connections.push({
                fromNode: seabedMat.id,
                fromPort: 'out',
                toNode: targetSolverId,
                toPort: 'seabed'
            });
            const solverNode = model.nodes.find(n => n.id === targetSolverId);
            if (solverNode) {
                if (!solverNode.parameters) solverNode.parameters = {};
                solverNode.parameters['seabed_foundation'] = seabedMat.id;
                this.stateManager.updateNodeParametersInPlace(solverNode.id, { seabed_foundation: seabedMat.id });
            }
        }
        if (!seabedMat.parameters) seabedMat.parameters = {};
        seabedMat.parameters['seabed_target'] = targetSolverId;
        this.stateManager.updateNodeParametersInPlace(seabedMat.id, { seabed_target: targetSolverId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
    }

    private assignObjectMaterial(body: Node, newMatId: string, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        if (body.type === 'MarineHarbourDomain') {
            const matNode = model.nodes.find(n => n.id === newMatId);
            const isWater = matNode && (matNode.parameters?.material_model === 'Tait Water' || matNode.parameters?.preset?.includes('Water') || matNode.parameters?.preset?.includes('Seawater'));
            const isAir = matNode && (matNode.parameters?.material_model === 'Ideal Gas' || matNode.parameters?.preset?.includes('Air'));
            if (isWater) {
                this.assignWaterToSolver(body, newMatId, model);
                return;
            } else if (isAir) {
                this.assignAirTargetDomain(matNode!, body.id, model);
                return;
            } else {
                this.assignSeabedToSolver(body, newMatId, model);
                return;
            }
        }

        state.connections = state.connections.filter(c => !((c.toNode === body.id || c.fromNode === body.id) && (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'mat' || c.fromPort === 'mat')));
        if (newMatId) {
            state.connections.push({
                fromNode: newMatId,
                fromPort: 'out',
                toNode: body.id,
                toPort: 'material'
            });
        }
        if (!body.parameters) body.parameters = {};
        body.parameters['material'] = newMatId;
        this.stateManager.updateNodeParametersInPlace(body.id, { material: newMatId });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.stateManager.pushState(state);
        this.render();
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
                const cat = CATEGORIES.find(c => isNodeTypeInCategory(c.id, c.types, node.type));
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
            const childId = hEl.dataset.childId;

            let isMatch = false;
            if (sliceIdx !== undefined) {
                if (nodeId === selectedId && selectedSliceIdx !== null && String(selectedSliceIdx) === sliceIdx) {
                    isMatch = true;
                }
            } else if (gaugeIdx !== undefined) {
                if (nodeId === selectedId && selectedGaugeIdx !== null && String(selectedGaugeIdx) === gaugeIdx) {
                    isMatch = true;
                }
            } else if (childId !== undefined) {
                if (nodeId === selectedId && this.selectedChildId !== null && this.selectedChildId === childId) {
                    isMatch = true;
                }
            } else {
                if (nodeId === selectedId && selectedSliceIdx === null && this.selectedChildId === null) {
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

        // Synchronize entry containers and wiring rows
        const allEntries = this.rootElement.querySelectorAll('.pipeline-node-entry');
        allEntries.forEach(el => {
            const hEl = el as HTMLElement;
            const nodeId = hEl.dataset.nodeId;
            const isMatch = nodeId === selectedId && selectedSliceIdx === null;
            if (isMatch) {
                hEl.classList.add('selected');
            } else {
                hEl.classList.remove('selected');
            }
        });

        const allWiringRows = this.rootElement.querySelectorAll('.pipeline-wiring-row');
        allWiringRows.forEach(el => {
            const hEl = el as HTMLElement;
            const nodeId = hEl.dataset.nodeId;
            const isMatch = nodeId === selectedId && selectedSliceIdx === null;
            if (isMatch) {
                hEl.classList.add('selected');
                if (this.wiringViewMode === 'FOCUS') {
                    hEl.classList.remove('wiring-collapsed');
                }
            } else {
                hEl.classList.remove('selected');
                if (this.wiringViewMode === 'FOCUS') {
                    hEl.classList.add('wiring-collapsed');
                }
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
        title.textContent = 'Add Item to Active Model';
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

        // Dedicated Sensor / Gauge Probe in Add Menu
        const sensorCat = document.createElement('div');
        sensorCat.className = 'context-menu-cat';
        sensorCat.textContent = '⏱️ Sensors & Virtual Probes';
        menu.appendChild(sensorCat);

        const gaugeItem = document.createElement('div');
        gaugeItem.className = 'context-menu-item';
        gaugeItem.textContent = '+ Add Virtual Gauge Probe';
        gaugeItem.addEventListener('click', () => {
            menu.remove();
            let vgNode = model.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
            if (!vgNode) {
                this.addNodeToModel(model, 'VirtualGauges');
                const updatedState = this.stateManager.getCurrentState();
                vgNode = updatedState?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
            }
            if (vgNode) {
                this.addNewGaugeToNode(vgNode, model);
            }
        });
        menu.appendChild(gaugeItem);

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

    private showAddCategoryItemMenu(e: MouseEvent, cat: EntityCategory, model: Model): void {
        const existingMenu = document.querySelector('.pipeline-context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'pipeline-context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;

        const title = document.createElement('div');
        title.className = 'context-menu-title';
        title.textContent = `Add ${cat.label} Item`;
        menu.appendChild(title);

        if (cat.id === 'domain_mesh') {
            // Slices for Domain Meshes
            [
                { label: '🥞 + Add X-Normal Slice Plane', plane: 'yz' as const },
                { label: '🥞 + Add Y-Normal Slice Plane', plane: 'xz' as const },
                { label: '🥞 + Add Z-Normal Slice Plane', plane: 'xy' as const }
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
        }

        if (cat.id === 'sinks') {
            // Quick Gauge Probe in Sinks
            const gaugeCatItem = document.createElement('div');
            gaugeCatItem.className = 'context-menu-item';
            gaugeCatItem.textContent = '⏱️ + Add Virtual Gauge Probe';
            gaugeCatItem.addEventListener('click', () => {
                menu.remove();
                let vgNode = model.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
                if (!vgNode) {
                    this.addNodeToModel(model, 'VirtualGauges');
                    const updatedState = this.stateManager.getCurrentState();
                    vgNode = updatedState?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
                }
                if (vgNode) {
                    this.addNewGaugeToNode(vgNode, model);
                }
            });
            menu.appendChild(gaugeCatItem);
        }

        cat.types.forEach(type => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.textContent = `➕ ${this.getNodeTypeFriendlyName(type)}`;
            item.addEventListener('click', () => {
                this.addNodeToModel(model, type);
                menu.remove();
            });
            menu.appendChild(item);
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
            case 'Material': return 'Material & EOS';
            case 'Charge1D': return 'Charge 1D';
            case 'Charge2D': return 'Charge 2D';
            case 'Charge3D': return 'Charge 3D';
            case 'TriggerLocation':
            case 'DetonatorLocation': return 'Detonator Location (1D/2D)';
            case 'TriggerLocation3D':
            case 'DetonatorLocation3D': return 'Detonator Location 3D';
            case 'CFDSolver': return 'CFD Solver (1D)';
            case 'CFDSolver2D': return 'CFD Solver 2D';
            case 'CFDSolver3D': return 'CFD Solver 3D';
            case 'MPMDomain2D': return 'MPM Domain 2D';
            case 'MPMDomain3D': return 'MPM Domain 3D';
            case 'FEMDomain3D': return '3D Explicit FEM Solver Domain';
            case 'STLGeometry': return 'STL Geometry 3D (CAD Surface)';
            case 'PrimitiveGeometry3D': return 'Primitive Geometry 3D (CSG)';
            case 'Obstacle3D': return '3D CSG Obstacle (Immersed Boundary)';
            case 'Obstacle': return '3D CSG Obstacle';
            case 'MPMObject2D': return 'MPM Object 2D (Primitive)';
            case 'MPMObject3D': return 'MPM Object 3D (Box/Sphere/STL)';
            case 'FEMObject3D': return '3D FEM Structural Body';
            case 'FEMBeam3D': return '3D FEM Beam Framework';
            case 'FEMRebar3D': return '3D FEM Rebar Reinforcement';
            case 'LSDynaImporter3D': return 'LS-DYNA Keyword Deck (*.k)';
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

        // Add Item to Category
        const addCatItem = document.createElement('div');
        addCatItem.className = 'context-menu-item';
        addCatItem.textContent = `➕ Add ${cat.label} Item...`;
        addCatItem.addEventListener('click', (ev) => {
            menu.remove();
            this.showAddCategoryItemMenu(ev, cat, model);
        });
        menu.appendChild(addCatItem);

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

        // Add Item
        const addItem = document.createElement('div');
        addItem.className = 'context-menu-item';
        addItem.textContent = '+ Add Item...';
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

        if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D') {
            const addGaugeItem = document.createElement('div');
            addGaugeItem.className = 'context-menu-item';
            addGaugeItem.textContent = '➕ Add Gauge Probe';
            addGaugeItem.addEventListener('click', () => {
                menu.remove();
                this.addNewGaugeToNode(node, model);
            });
            menu.appendChild(addGaugeItem);

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

        const isFemNode = node.type === 'FEMObject3D' || node.type === 'FEMDomain3D' || node.type === 'LSDynaImporter3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D' || node.type === 'FEMFSICoupler3D' || !!node.parameters?.fem_setup;
        if (isFemNode) {
            const femSetupItem = document.createElement('div');
            femSetupItem.className = 'context-menu-item';
            femSetupItem.innerHTML = '<span>⚡ Open FEM Model Setup & Preprocessor...</span>';
            femSetupItem.addEventListener('click', () => {
                menu.remove();
                new FEMSetupModal(this.stateManager, node, model, () => this.render());
            });
            menu.appendChild(femSetupItem);
        }

        // Context Connection Shortcuts
        const state = this.stateManager.getCurrentState();
        if (state) {
            // Detonator nodes
            if (node.type === 'TriggerLocation3D' || node.type === 'TriggerLocation' || node.type === 'DetonatorLocation3D' || node.type === 'DetonatorLocation') {
                const portName = 'detonator';
                const solverNodes = model.nodes.filter(n => ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MPMDomain2D', 'CFDSolver2D', 'MarineHarbourDomain'].includes(n.type));
                for (const solver of solverNodes) {
                    const solverName = solver.parameters?.name || solver.type;
                    const isConnected = state.connections.some(c => c.fromNode === node.id && c.toNode === solver.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'detonators'));
                    const connItem = document.createElement('div');
                    connItem.className = 'context-menu-item';
                    if (!isConnected) {
                        connItem.style.color = '#38bdf8';
                        connItem.textContent = `💥 Connect to ${solverName}`;
                        connItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: portName,
                                toNode: solver.id,
                                toPort: portName
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        connItem.style.color = '#f87171';
                        connItem.textContent = `❌ Disconnect from ${solverName}`;
                        connItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toNode === solver.id));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(connItem);
                }
            } else if (['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MPMDomain2D', 'CFDSolver2D', 'CFDSolver', 'MarineHarbourDomain'].includes(node.type)) {
                // Background mesh options
                const meshNodes = model.nodes.filter(n => ['DomainMesh3D', 'DomainMesh2D', 'DomainMesh'].includes(n.type));
                for (const mesh of meshNodes) {
                    const meshName = mesh.parameters?.name || mesh.type;
                    const isConnected = state.connections.some(c => (c.fromNode === mesh.id && c.toNode === node.id && c.toPort === 'mesh') || (c.toNode === mesh.id && c.fromNode === node.id && c.fromPort === 'mesh'));
                    const meshItem = document.createElement('div');
                    meshItem.className = 'context-menu-item';
                    if (!isConnected) {
                        meshItem.style.color = '#38bdf8';
                        meshItem.textContent = `📐 Connect Mesh [${meshName}]`;
                        meshItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'mesh'));
                            state.connections.push({
                                fromNode: mesh.id,
                                fromPort: 'mesh',
                                toNode: node.id,
                                toPort: 'mesh'
                            });
                            if (!node.parameters) node.parameters = {};
                            node.parameters['mesh'] = mesh.id;
                            this.stateManager.updateNodeParametersInPlace(node.id, { mesh: mesh.id });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        meshItem.style.color = '#f87171';
                        meshItem.textContent = `❌ Disconnect Mesh [${meshName}]`;
                        meshItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'mesh'));
                            if (!node.parameters) node.parameters = {};
                            node.parameters['mesh'] = '';
                            this.stateManager.updateNodeParametersInPlace(node.id, { mesh: '' });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(meshItem);
                }

                // Ambient Air options (for CFD solvers)
                if (['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(node.type)) {
                    const matNodes = model.nodes.filter(n => n.type === 'Material');
                    for (const mat of matNodes) {
                        const matName = mat.parameters?.name || mat.parameters?.preset || mat.parameters?.material_model || mat.type;
                        const isAirConn = state.connections.some(c => (c.fromNode === mat.id && c.toNode === node.id && c.toPort === 'air') || (c.toNode === mat.id && c.fromNode === node.id && c.fromPort === 'air'));
                        const airItem = document.createElement('div');
                        airItem.className = 'context-menu-item';
                        if (!isAirConn) {
                            airItem.style.color = '#38bdf8';
                            airItem.textContent = `💨 Assign Ambient Air [${matName}]`;
                            airItem.addEventListener('click', () => {
                                menu.remove();
                                state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'air'));
                                state.connections.push({
                                    fromNode: mat.id,
                                    fromPort: 'air',
                                    toNode: node.id,
                                    toPort: 'air'
                                });
                                if (!node.parameters) node.parameters = {};
                                node.parameters['ambient_air_material'] = mat.id;
                                this.stateManager.updateNodeParametersInPlace(node.id, { ambient_air_material: mat.id });
                                if (!mat.parameters) mat.parameters = {};
                                mat.parameters['ambient_air_target'] = node.id;
                                this.stateManager.updateNodeParametersInPlace(mat.id, { ambient_air_target: node.id });
                                this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                this.stateManager.pushState(state);
                                this.render();
                            });
                        } else {
                            airItem.style.color = '#f87171';
                            airItem.textContent = `❌ Disconnect Ambient Air [${matName}]`;
                            airItem.addEventListener('click', () => {
                                menu.remove();
                                state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'air'));
                                if (!node.parameters) node.parameters = {};
                                node.parameters['ambient_air_material'] = '';
                                this.stateManager.updateNodeParametersInPlace(node.id, { ambient_air_material: '' });
                                if (!mat.parameters) mat.parameters = {};
                                mat.parameters['ambient_air_target'] = '';
                                this.stateManager.updateNodeParametersInPlace(mat.id, { ambient_air_target: '' });
                                this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                this.stateManager.pushState(state);
                                this.render();
                            });
                        }
                        menu.appendChild(airItem);
                    }

                    // Charge connection options
                    const chargeNodes = model.nodes.filter(n => {
                        if (node.type === 'CFDSolver') return n.type === 'Charge1D';
                        if (node.type === 'CFDSolver2D') return n.type === 'Charge2D';
                        if (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain') return n.type === 'Charge3D';
                        return ['Charge1D', 'Charge2D', 'Charge3D'].includes(n.type);
                    });
                    for (const chg of chargeNodes) {
                        const chgName = chg.parameters?.name || chg.type;
                        const isChgConn = state.connections.some(c => c.fromNode === chg.id && c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
                        const chgItem = document.createElement('div');
                        chgItem.className = 'context-menu-item';
                        if (!isChgConn) {
                            chgItem.style.color = '#fb923c';
                            chgItem.textContent = `💥 Connect Charge [${chgName}]`;
                            chgItem.addEventListener('click', () => {
                                menu.remove();
                                state.connections = state.connections.filter(c => !(c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                                state.connections.push({
                                    fromNode: chg.id,
                                    fromPort: 'charge',
                                    toNode: node.id,
                                    toPort: 'charge'
                                });
                                if (!node.parameters) node.parameters = {};
                                node.parameters['explosive_charge'] = chg.id;
                                this.stateManager.updateNodeParametersInPlace(node.id, { explosive_charge: chg.id });
                                if (!chg.parameters) chg.parameters = {};
                                chg.parameters['target_domain'] = node.id;
                                this.stateManager.updateNodeParametersInPlace(chg.id, { target_domain: node.id });
                                this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                this.stateManager.pushState(state);
                                this.render();
                            });
                        } else {
                            chgItem.style.color = '#f87171';
                            chgItem.textContent = `❌ Disconnect Charge [${chgName}]`;
                            chgItem.addEventListener('click', () => {
                                menu.remove();
                                state.connections = state.connections.filter(c => !(c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                                if (!node.parameters) node.parameters = {};
                                node.parameters['explosive_charge'] = '';
                                this.stateManager.updateNodeParametersInPlace(node.id, { explosive_charge: '' });
                                if (!chg.parameters) chg.parameters = {};
                                chg.parameters['target_domain'] = '';
                                this.stateManager.updateNodeParametersInPlace(chg.id, { target_domain: '' });
                                this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                                this.stateManager.pushState(state);
                                this.render();
                            });
                        }
                        menu.appendChild(chgItem);
                    }
                }

                // Detonator options for this solver
                const detonators = model.nodes.filter(n => n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation' || n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation');
                for (const det of detonators) {
                    const portName = 'detonator';
                    const detName = det.parameters?.name || det.type;
                    const isConnected = state.connections.some(c => c.fromNode === det.id && c.toNode === node.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'detonators'));
                    const detItem = document.createElement('div');
                    detItem.className = 'context-menu-item';
                    if (!isConnected) {
                        detItem.style.color = '#fb923c';
                        detItem.textContent = `💥 Connect Detonator [${detName}]`;
                        detItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections.push({
                                fromNode: det.id,
                                fromPort: portName,
                                toNode: node.id,
                                toPort: portName
                            });
                            if (!det.parameters) det.parameters = {};
                            det.parameters['target_domain'] = node.id;
                            this.stateManager.updateNodeParametersInPlace(det.id, { target_domain: node.id });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        detItem.style.color = '#f87171';
                        detItem.textContent = `❌ Disconnect Detonator [${detName}]`;
                        detItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === det.id && c.toNode === node.id));
                            if (!det.parameters) det.parameters = {};
                            det.parameters['target_domain'] = '';
                            this.stateManager.updateNodeParametersInPlace(det.id, { target_domain: '' });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(detItem);
                }
            } else if (node.type === 'DomainMesh3D' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh') {
                const solverNodes = model.nodes.filter(n => ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MPMDomain2D', 'CFDSolver2D', 'CFDSolver', 'MarineHarbourDomain'].includes(n.type));
                for (const solver of solverNodes) {
                    const solverName = solver.parameters?.name || solver.type;
                    const isConnected = state.connections.some(c => (c.fromNode === node.id && c.toNode === solver.id && c.toPort === 'mesh') || (c.toNode === node.id && c.fromNode === solver.id && c.fromPort === 'mesh'));
                    const connItem = document.createElement('div');
                    connItem.className = 'context-menu-item';
                    if (!isConnected) {
                        connItem.style.color = '#38bdf8';
                        connItem.textContent = `🔗 Connect to ${solverName}`;
                        connItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === solver.id && c.toPort === 'mesh'));
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'mesh',
                                toNode: solver.id,
                                toPort: 'mesh'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        connItem.style.color = '#f87171';
                        connItem.textContent = `❌ Disconnect from ${solverName}`;
                        connItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toNode === solver.id && c.toPort === 'mesh'));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(connItem);
                }
            } else if (node.type === 'Charge3D' || node.type === 'Charge2D' || node.type === 'Charge1D') {
                // Target CFD solver
                const compatibleSolvers = model.nodes.filter(n => {
                    if (node.type === 'Charge1D') return n.type === 'CFDSolver';
                    if (node.type === 'Charge2D') return n.type === 'CFDSolver2D';
                    if (node.type === 'Charge3D') return n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain';
                    return false;
                });
                for (const solver of compatibleSolvers) {
                    const solverName = solver.parameters?.name || solver.type;
                    const isConnected = state.connections.some(c => c.fromNode === node.id && c.toNode === solver.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
                    const solverItem = document.createElement('div');
                    solverItem.className = 'context-menu-item';
                    if (!isConnected) {
                        solverItem.style.color = '#f59e0b';
                        solverItem.textContent = `💥 Connect to ${solverName}`;
                        solverItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'charge',
                                toNode: solver.id,
                                toPort: 'charge'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        solverItem.style.color = '#f87171';
                        solverItem.textContent = `❌ Disconnect from ${solverName}`;
                        solverItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toNode === solver.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(solverItem);
                }

                // Explosive Material assignments
                const matNodes = model.nodes.filter(n => n.type === 'Material' || (n.type as string).startsWith('MPMMaterial'));
                for (const mat of matNodes) {
                    const matName = mat.parameters?.name || mat.parameters?.preset || mat.parameters?.material_model || mat.type;
                    const isConnected = state.connections.some(c => (c.fromNode === mat.id && c.toNode === node.id && c.toPort === 'material') || (c.toNode === mat.id && c.fromNode === node.id && c.fromPort === 'material'));
                    const matItem = document.createElement('div');
                    matItem.className = 'context-menu-item';
                    if (!isConnected) {
                        matItem.style.color = '#4ade80';
                        matItem.textContent = `🧪 Assign Material [${matName}]`;
                        matItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !((c.toNode === node.id || c.fromNode === node.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                            state.connections.push({
                                fromNode: mat.id,
                                fromPort: 'material',
                                toNode: node.id,
                                toPort: 'material'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        matItem.style.color = '#f87171';
                        matItem.textContent = `❌ Disconnect Material [${matName}]`;
                        matItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !((c.toNode === node.id || c.fromNode === node.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(matItem);
                }
            } else if (node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode' || node.type === 'RemapNode' || node.type === 'Remap1DTo2DNode') {
                const is3D = node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode';
                const compatibleSolvers = model.nodes.filter(n => is3D ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : n.type === 'CFDSolver2D');
                for (const solver of compatibleSolvers) {
                    const solverName = solver.parameters?.name || solver.type;
                    const isConnected = state.connections.some(c => c.fromNode === node.id && c.toNode === solver.id && (c.toPort === 'remap' || c.toPort === 'in'));
                    const solverItem = document.createElement('div');
                    solverItem.className = 'context-menu-item';
                    if (!isConnected) {
                        solverItem.style.color = '#38bdf8';
                        solverItem.textContent = `🔄 Wire to ${solverName}`;
                        solverItem.addEventListener('click', () => {
                            menu.remove();
                            this.assignRemapToSolver(solver, node.id, model);
                        });
                    } else {
                        solverItem.style.color = '#f87171';
                        solverItem.textContent = `❌ Disconnect from ${solverName}`;
                        solverItem.addEventListener('click', () => {
                            menu.remove();
                            this.assignRemapToSolver(solver, '', model);
                        });
                    }
                    menu.appendChild(solverItem);
                }

                // Upstream source simulation model context actions
                const allModels = this.stateManager.getAllModels();
                const is2Dto3D = node.type === 'Remap2DTo3DNode';
                const upstreamModels = allModels.filter(m => m.id !== model.id && m.nodes.some(n => is2Dto3D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver'));
                for (const uModel of upstreamModels) {
                    const uName = uModel.name || uModel.id;
                    const isCurrent = node.parameters?.source_model_id === uModel.id;
                    const uItem = document.createElement('div');
                    uItem.className = 'context-menu-item';
                    if (!isCurrent) {
                        uItem.style.color = '#38bdf8';
                        uItem.textContent = `📥 Set Source: ${uName}`;
                        uItem.addEventListener('click', () => {
                            menu.remove();
                            this.assignRemapSourceModel(node, uModel.id, model);
                        });
                    } else {
                        uItem.style.color = '#f87171';
                        uItem.textContent = `❌ Disconnect Source: ${uName}`;
                        uItem.addEventListener('click', () => {
                            menu.remove();
                            this.assignRemapSourceModel(node, '', model);
                        });
                    }
                    menu.appendChild(uItem);
                }
            } else if (node.type === 'MPMObject3D' || node.type === 'FEMObject3D' || node.type === 'MPMObject2D' || node.type === 'LSDynaImporter3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D') {
                const domainNodes = model.nodes.filter(n => ['MPMDomain3D', 'FEMDomain3D', 'MPMDomain2D', 'MarineHarbourDomain'].includes(n.type));
                for (const domain of domainNodes) {
                    const domainName = domain.parameters?.name || domain.type;
                    const isConnected = state.connections.some(c => c.fromNode === node.id && c.toNode === domain.id && (c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects'));
                    if (!isConnected) {
                        const connItem = document.createElement('div');
                        connItem.className = 'context-menu-item';
                        connItem.style.color = '#c084fc';
                        connItem.textContent = `🔗 Connect to ${domainName}`;
                        connItem.addEventListener('click', () => {
                            menu.remove();
                            const targetPort = domain.type === 'FEMDomain3D' ? 'mesh' : (domain.type === 'MarineHarbourDomain' ? 'elements' : 'objects');
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'out',
                                toNode: domain.id,
                                toPort: targetPort
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                        menu.appendChild(connItem);
                    }
                }

                // Material assignments
                const matNodes = model.nodes.filter(n => n.type === 'Material' || (n.type as string).startsWith('MPMMaterial'));
                for (const mat of matNodes) {
                    const matName = mat.parameters?.name || mat.parameters?.preset || mat.parameters?.material_model || mat.type;
                    const isConnected = state.connections.some(c => c.fromNode === mat.id && c.toNode === node.id && c.toPort === 'material');
                    if (!isConnected) {
                        const matItem = document.createElement('div');
                        matItem.className = 'context-menu-item';
                        matItem.style.color = '#4ade80';
                        matItem.textContent = `🧪 Assign Material [${matName}]`;
                        matItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'material'));
                            state.connections.push({
                                fromNode: mat.id,
                                fromPort: 'material',
                                toNode: node.id,
                                toPort: 'material'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                        menu.appendChild(matItem);
                    }
                }
            } else if (node.type === 'Material' || (node.type as string).startsWith('MPMMaterial')) {
                // 1. Ambient Air assignment options (for CFD solvers)
                const cfdSolvers = model.nodes.filter(n => ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type));
                for (const solver of cfdSolvers) {
                    const solverName = solver.parameters?.name || solver.type;
                    const isAirConn = state.connections.some(c => (c.fromNode === node.id && c.toNode === solver.id && c.toPort === 'air') || (c.toNode === node.id && c.fromNode === solver.id && c.fromPort === 'air'));
                    const airItem = document.createElement('div');
                    airItem.className = 'context-menu-item';
                    if (!isAirConn) {
                        airItem.style.color = '#38bdf8';
                        airItem.textContent = `💨 Assign as Ambient Air to ${solverName}`;
                        airItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === solver.id && c.toPort === 'air'));
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'air',
                                toNode: solver.id,
                                toPort: 'air'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        airItem.style.color = '#f87171';
                        airItem.textContent = `❌ Disconnect Ambient Air from ${solverName}`;
                        airItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toNode === solver.id && c.toPort === 'air'));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(airItem);
                }

                // 2. High-Explosive Charge assignment options
                const chargeNodes = model.nodes.filter(n => ['Charge1D', 'Charge2D', 'Charge3D'].includes(n.type));
                for (const chg of chargeNodes) {
                    const chgName = chg.parameters?.name || chg.type;
                    const isMatConn = state.connections.some(c => (c.fromNode === node.id && c.toNode === chg.id && c.toPort === 'material') || (c.toNode === node.id && c.fromNode === chg.id && c.fromPort === 'material'));
                    const chgItem = document.createElement('div');
                    chgItem.className = 'context-menu-item';
                    if (!isMatConn) {
                        chgItem.style.color = '#fb923c';
                        chgItem.textContent = `💥 Assign to Charge [${chgName}]`;
                        chgItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !((c.toNode === chg.id || c.fromNode === chg.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'material',
                                toNode: chg.id,
                                toPort: 'material'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        chgItem.style.color = '#f87171';
                        chgItem.textContent = `❌ Disconnect from Charge [${chgName}]`;
                        chgItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !((c.toNode === chg.id || c.fromNode === chg.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(chgItem);
                }

                // 3. Object assignments
                const objectNodes = model.nodes.filter(n => ['MPMObject3D', 'FEMObject3D', 'MPMObject2D', 'LSDynaImporter3D', 'FEMBeam3D', 'FEMRebar3D'].includes(n.type));
                for (const obj of objectNodes) {
                    const objName = obj.parameters?.name || obj.type;
                    const isConnected = state.connections.some(c => c.fromNode === node.id && c.toNode === obj.id && c.toPort === 'material');
                    if (!isConnected) {
                        const matItem = document.createElement('div');
                        matItem.className = 'context-menu-item';
                        matItem.style.color = '#4ade80';
                        matItem.textContent = `🧪 Assign to [${objName}]`;
                        matItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.toNode === obj.id && c.toPort === 'material'));
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'material',
                                toNode: obj.id,
                                toPort: 'material'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                        menu.appendChild(matItem);
                    }
                }
            } else if (node.type === 'STLGeometry' || node.type === 'PrimitiveGeometry3D' || node.type === 'Obstacle3D' || node.type === 'Obstacle') {
                const cfdSolver = model.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
                if (cfdSolver) {
                    const isConn = state.connections.some(c => c.fromNode === node.id && c.toNode === cfdSolver.id && c.toPort === 'stl');
                    const geomItem = document.createElement('div');
                    geomItem.className = 'context-menu-item';
                    if (!isConn) {
                        geomItem.style.color = '#38bdf8';
                        geomItem.textContent = `🔗 Connect to ${cfdSolver.parameters?.name || 'CFD Solver 3D'} (stl)`;
                        geomItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections.push({
                                fromNode: node.id,
                                fromPort: 'stl',
                                toNode: cfdSolver.id,
                                toPort: 'stl'
                            });
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    } else {
                        geomItem.style.color = '#f87171';
                        geomItem.textContent = `❌ Disconnect from ${cfdSolver.parameters?.name || 'CFD Solver 3D'}`;
                        geomItem.addEventListener('click', () => {
                            menu.remove();
                            state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toNode === cfdSolver.id && c.toPort === 'stl'));
                            this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
                            this.stateManager.pushState(state);
                            this.render();
                        });
                    }
                    menu.appendChild(geomItem);
                }
            }

            if (node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'DomainMesh2D') {
                const sliceItem = document.createElement('div');
                sliceItem.className = 'context-menu-item';
                sliceItem.textContent = '🥞 + Add Slice Plane (Z-Normal)';
                sliceItem.addEventListener('click', () => {
                    menu.remove();
                    this.addNewSliceToDomain(node, model, 'xy');
                });
                menu.appendChild(sliceItem);
            }

            // Always provide "Manage Model Connections..."
            const manageItem = document.createElement('div');
            manageItem.className = 'context-menu-item';
            manageItem.style.color = '#38bdf8';
            manageItem.style.fontWeight = '500';
            manageItem.textContent = '🔗 Manage Model Connections...';
            manageItem.addEventListener('click', () => {
                menu.remove();
                new PipelineConnectionModal(this.stateManager, model, () => {
                    this.render();
                });
            });
            menu.appendChild(manageItem);
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

        // Copy to another Model
        const otherModels = this.stateManager.getAllModels().filter(m => m.id !== model.id);
        if (otherModels.length > 0) {
            const copyItem = document.createElement('div');
            copyItem.className = 'context-menu-item';
            copyItem.textContent = '📋 Copy to Model...';
            copyItem.addEventListener('click', (ev) => {
                menu.remove();
                this.showCopyToModelPopup(ev.clientX, ev.clientY, node, model, otherModels);
            });
            menu.appendChild(copyItem);
        }

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

        // Calculate layout position to prevent stacking on (100, 100)
        const modelNodes = model.nodes || [];
        let newX = 100;
        let newY = 100;
        if (modelNodes.length > 0) {
            const maxX = Math.max(...modelNodes.map(n => n.x || 100));
            const lastNode = modelNodes.find(n => (n.x || 100) === maxX) || modelNodes[modelNodes.length - 1];
            newX = (lastNode.x || 100) + 320;
            newY = lastNode.y || 100;
        }

        const newNode: Node = {
            id,
            type,
            x: newX,
            y: newY,
            displayMode: 'expanded',
            inputs,
            outputs,
            parameters: { ...defaultParams }
        };

        state.nodes.push(newNode);
        model.nodes.push(newNode);

        // Auto-connect complementary nodes within the same model
        if (type === 'MPMDomain3D' || type === 'MarineHarbourDomain') {
            const meshNode = model.nodes.find(n => n.id !== id && n.type === 'DomainMesh3D');
            const hasMeshConn = state.connections.some(c => c.toNode === id && c.toPort === 'mesh');
            if (meshNode && !hasMeshConn) {
                state.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: id,
                    toPort: 'mesh'
                });
                model.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: id,
                    toPort: 'mesh'
                });
            }
            if (type === 'MPMDomain3D') {
                const objNode = model.nodes.find(n => n.id !== id && n.type === 'MPMObject3D');
                const hasObjConn = state.connections.some(c => c.toNode === id && (c.toPort === 'objects' || c.toPort === 'mpm_objects'));
                if (objNode && !hasObjConn) {
                    state.connections.push({
                        fromNode: objNode.id,
                        fromPort: 'out',
                        toNode: id,
                        toPort: 'objects'
                    });
                    model.connections.push({
                        fromNode: objNode.id,
                        fromPort: 'out',
                        toNode: id,
                        toPort: 'objects'
                    });
                }
            }
        } else if (type === 'DomainMesh3D') {
            const solverNode = model.nodes.find(n => n.id !== id && ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MarineHarbourDomain'].includes(n.type));
            const hasMeshConn = solverNode && state.connections.some(c => c.toNode === solverNode.id && c.toPort === 'mesh');
            if (solverNode && !hasMeshConn) {
                state.connections.push({
                    fromNode: id,
                    fromPort: 'mesh',
                    toNode: solverNode.id,
                    toPort: 'mesh'
                });
                model.connections.push({
                    fromNode: id,
                    fromPort: 'mesh',
                    toNode: solverNode.id,
                    toPort: 'mesh'
                });
            }
        } else if (type === 'Charge3D') {
            const solverNode = model.nodes.find(n => n.id !== id && ['CFDSolver3D', 'MarineHarbourDomain'].includes(n.type));
            const hasChgConn = solverNode && state.connections.some(c => c.toNode === solverNode.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            if (solverNode && !hasChgConn) {
                state.connections.push({
                    fromNode: id,
                    fromPort: 'charge',
                    toNode: solverNode.id,
                    toPort: 'charge'
                });
                model.connections.push({
                    fromNode: id,
                    fromPort: 'charge',
                    toNode: solverNode.id,
                    toPort: 'charge'
                });
                newNode.parameters['target_domain'] = solverNode.id;
            }
        } else if (type === 'MPMObject3D') {
            const mpmDomain = model.nodes.find(n => n.id !== id && n.type === 'MPMDomain3D');
            if (mpmDomain) {
                state.connections.push({
                    fromNode: id,
                    fromPort: 'out',
                    toNode: mpmDomain.id,
                    toPort: 'objects'
                });
                model.connections.push({
                    fromNode: id,
                    fromPort: 'out',
                    toNode: mpmDomain.id,
                    toPort: 'objects'
                });
            }
            const matNode = model.nodes.find(n => n.id !== id && n.type === 'Material');
            if (matNode) {
                state.connections.push({
                    fromNode: matNode.id,
                    fromPort: 'out',
                    toNode: id,
                    toPort: 'material'
                });
                model.connections.push({
                    fromNode: matNode.id,
                    fromPort: 'out',
                    toNode: id,
                    toPort: 'material'
                });
                newNode.parameters['material'] = matNode.id;
            }
        }

        this.stateManager.healModelGraph(model);
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
        model.nodes.push(newNode);
        this.stateManager.pushState(state);
        this.stateManager.selectNode(model.id, newId);
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
    }

    private showCopyToModelPopup(
        clientX: number,
        clientY: number,
        node: Node,
        sourceModel: Model,
        otherModels: Model[]
    ): void {
        const existing = document.querySelector('.pipeline-quick-popup');
        if (existing) existing.remove();

        const popup = document.createElement('div');
        popup.className = 'pipeline-quick-popup';
        popup.style.top = `${clientY + 4}px`;
        popup.style.left = `${Math.min(window.innerWidth - 300, Math.max(10, clientX))}px`;

        const header = document.createElement('div');
        header.className = 'pipeline-quick-popup-header';
        header.innerHTML = `<span>📋 Copy Entity to Model</span>`;
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'pipeline-quick-popup-list';

        otherModels.forEach(m => {
            const item = document.createElement('div');
            item.className = 'pipeline-quick-popup-item';
            const nodeCount = (m.nodes || []).length;
            item.innerHTML = `
                <div class="pipeline-quick-popup-item-label">${m.name || m.id}</div>
                <div class="pipeline-quick-popup-item-sublabel">${nodeCount} entities</div>
            `;
            item.addEventListener('click', () => {
                popup.remove();
                this.copyNodeToModel(node, sourceModel, m);
            });
            list.appendChild(item);
        });

        popup.appendChild(list);
        document.body.appendChild(popup);

        const closeHandler = (ev: MouseEvent) => {
            if (!popup.contains(ev.target as HTMLElement)) {
                popup.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private copyNodeToModel(node: Node, sourceModel: Model, targetModel: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const newId = this.stateManager.generateUniqueNodeId(node.type);
        const clonedParams = JSON.parse(JSON.stringify(node.parameters || {}));
        if (clonedParams.name) {
            clonedParams.name += ` (from ${sourceModel.name || sourceModel.id})`;
        }

        // Calculate layout position in target model
        const targetNodes = targetModel.nodes || [];
        let newX = 100;
        let newY = 100;
        if (targetNodes.length > 0) {
            const maxX = Math.max(...targetNodes.map(n => n.x || 100));
            const lastNode = targetNodes.find(n => (n.x || 100) === maxX) || targetNodes[targetNodes.length - 1];
            newX = (lastNode.x || 100) + 320;
            newY = lastNode.y || 100;
        }

        // If the copied node references a material in sourceModel, also copy or link the material
        if (node.parameters?.material) {
            const srcMat = sourceModel.nodes.find(n => n.id === node.parameters.material);
            if (srcMat) {
                const tgtMat = targetModel.nodes.find(n => n.type === 'Material' && (n.parameters?.name === srcMat.parameters?.name || n.id === srcMat.id));
                if (!tgtMat) {
                    const newMatId = this.stateManager.generateUniqueNodeId('Material');
                    const clonedMat: Node = {
                        id: newMatId,
                        type: 'Material',
                        x: newX,
                        y: newY + 200,
                        displayMode: 'expanded',
                        inputs: JSON.parse(JSON.stringify(srcMat.inputs || [])),
                        outputs: JSON.parse(JSON.stringify(srcMat.outputs || [])),
                        parameters: JSON.parse(JSON.stringify(srcMat.parameters || {}))
                    };
                    state.nodes.push(clonedMat);
                    targetModel.nodes.push(clonedMat);
                    clonedParams.material = newMatId;
                } else {
                    clonedParams.material = tgtMat.id;
                }
            }
        }

        const newNode: Node = {
            id: newId,
            type: node.type,
            x: newX,
            y: newY,
            displayMode: node.displayMode || 'expanded',
            inputs: JSON.parse(JSON.stringify(node.inputs || [])),
            outputs: JSON.parse(JSON.stringify(node.outputs || [])),
            parameters: clonedParams
        };

        state.nodes.push(newNode);
        targetModel.nodes.push(newNode);

        // If copying an FEMObject3D into targetModel and targetModel has no FEMDomain3D, instantiate one
        if (node.type === 'FEMObject3D') {
            let femDomain = targetModel.nodes.find(n => n.type === 'FEMDomain3D');
            if (!femDomain) {
                const domId = this.stateManager.generateUniqueNodeId('FEMDomain3D');
                femDomain = {
                    id: domId,
                    type: 'FEMDomain3D',
                    x: newX - 320,
                    y: newY,
                    displayMode: 'expanded',
                    inputs: this.stateManager.getDefaultInputs('FEMDomain3D'),
                    outputs: this.stateManager.getDefaultOutputs('FEMDomain3D'),
                    parameters: {
                        ...this.stateManager.getDefaultParameters('FEMDomain3D'),
                        name: 'Structural FEM Domain',
                        device: 'gpu'
                    }
                };
                state.nodes.push(femDomain);
                targetModel.nodes.push(femDomain);
            }
            // Wire FEMObject3D to FEMDomain3D
            state.connections.push({ fromNode: newId, fromPort: 'out', toNode: femDomain.id, toPort: 'mesh' });
            targetModel.connections.push({ fromNode: newId, fromPort: 'out', toNode: femDomain.id, toPort: 'mesh' });
            // Wire material to FEMObject3D if available
            if (clonedParams.material) {
                state.connections.push({ fromNode: clonedParams.material, fromPort: 'out', toNode: newId, toPort: 'material' });
                targetModel.connections.push({ fromNode: clonedParams.material, fromPort: 'out', toNode: newId, toPort: 'material' });
            }
        } else if (node.type === 'FEMDomain3D') {
            // Also copy any connected FEMObject3D nodes from sourceModel
            const objConns = sourceModel.connections.filter(c => c.toNode === node.id && (c.toPort === 'mesh' || c.toPort === 'parts'));
            objConns.forEach(c => {
                const srcObj = sourceModel.nodes.find(n => n.id === c.fromNode);
                if (srcObj && (srcObj.type === 'FEMObject3D' || srcObj.type === 'LSDynaImporter3D')) {
                    this.copyNodeToModel(srcObj, sourceModel, targetModel);
                }
            });
        }

        this.stateManager.healModelGraph(targetModel);
        this.stateManager.pushState(state);
        this.stateManager.selectNode(targetModel.id, newId);
        this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
        this.render();
    }

    private showHarbourStructurePopup(anchorEl: HTMLElement, node: Node, model: Model): void {
        const existing = document.querySelector('.pipeline-quick-popup');
        if (existing) existing.remove();

        const popup = document.createElement('div');
        popup.className = 'pipeline-quick-popup';

        const rect = anchorEl.getBoundingClientRect();
        let top = rect.bottom + 4;
        let left = rect.left;
        if (left + 330 > window.innerWidth) {
            left = window.innerWidth - 340;
        }
        popup.style.top = `${top}px`;
        popup.style.left = `${Math.max(10, left)}px`;

        const header = document.createElement('div');
        header.className = 'pipeline-quick-popup-header';
        header.innerHTML = `<span>🏛️ Harbour Structural Components</span>`;
        popup.appendChild(header);

        const list = document.createElement('div');
        list.className = 'pipeline-quick-popup-list';

        // 1. Existing structural objects in this model
        const existingFEM = (model.nodes || []).filter(n => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'FEMBeam3D' || n.type === 'LSDynaImporter3D');
        if (existingFEM.length > 0) {
            const secHdr = document.createElement('div');
            secHdr.className = 'pipeline-quick-popup-section';
            secHdr.textContent = 'Connected Solid Components:';
            secHdr.style.cssText = 'padding: 4px 8px; font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase;';
            list.appendChild(secHdr);

            existingFEM.forEach(fn => {
                const item = document.createElement('div');
                item.className = 'pipeline-quick-popup-item';
                const label = fn.parameters?.name || fn.id;
                const sublabel = `${fn.type} · ${fn.parameters?.shape_type || 'Solid'}`;
                item.innerHTML = `
                    <div class="pipeline-quick-popup-item-label">🏛️ ${label}</div>
                    <div class="pipeline-quick-popup-item-sublabel">${sublabel}</div>
                `;
                item.addEventListener('click', () => {
                    popup.remove();
                    this.stateManager.selectNode(model.id, fn.id);
                    this.render();
                });
                list.appendChild(item);
            });
        }

        // 2. Action: 1-Click Instantiate Concrete Quay Wall
        const addWallItem = document.createElement('div');
        addWallItem.className = 'pipeline-quick-popup-item';
        addWallItem.style.borderTop = existingFEM.length > 0 ? '1px solid rgba(255,255,255,0.08)' : 'none';
        addWallItem.innerHTML = `
            <div class="pipeline-quick-popup-item-label" style="color: #5eead4; font-weight: 600;">+ Instantiate Concrete Quay Wall (Hex8)</div>
            <div class="pipeline-quick-popup-item-sublabel">Autocreates 30m×6m×14m B35 reinforced concrete block with clamped base</div>
        `;
        addWallItem.addEventListener('click', () => {
            popup.remove();
            this.instantiateConcreteQuayWall(node, model);
        });
        list.appendChild(addWallItem);

        // 3. Action: Copy Structure from another open model
        const otherModels = this.stateManager.getAllModels().filter(m => m.id !== model.id);
        const modelsWithFEM = otherModels.filter(m => (m.nodes || []).some(n => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D'));
        if (modelsWithFEM.length > 0) {
            const copyHdr = document.createElement('div');
            copyHdr.className = 'pipeline-quick-popup-section';
            copyHdr.textContent = 'Copy from Open Models:';
            copyHdr.style.cssText = 'padding: 4px 8px; font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; margin-top: 4px;';
            list.appendChild(copyHdr);

            modelsWithFEM.forEach(m => {
                const femNodes = (m.nodes || []).filter(n => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D');
                femNodes.forEach(fn => {
                    const item = document.createElement('div');
                    item.className = 'pipeline-quick-popup-item';
                    const nodeName = fn.parameters?.name || fn.id;
                    item.innerHTML = `
                        <div class="pipeline-quick-popup-item-label">📋 Copy "${nodeName}" from ${m.name || m.id}</div>
                        <div class="pipeline-quick-popup-item-sublabel">${fn.type} · Ready to import</div>
                    `;
                    item.addEventListener('click', () => {
                        popup.remove();
                        this.copyNodeToModel(fn, m, model);
                    });
                    list.appendChild(item);
                });
            });
        }

        popup.appendChild(list);
        document.body.appendChild(popup);

        const closeHandler = (ev: MouseEvent) => {
            if (!popup.contains(ev.target as HTMLElement)) {
                popup.remove();
                window.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('click', closeHandler), 10);
    }

    private instantiateConcreteQuayWall(harbourNode: Node, model: Model): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        // 1. Ensure FEMDomain3D exists
        let femDomain = model.nodes.find(n => n.type === 'FEMDomain3D');
        if (!femDomain) {
            const femDomainId = this.stateManager.generateUniqueNodeId('FEMDomain3D');
            femDomain = {
                id: femDomainId,
                type: 'FEMDomain3D',
                x: (harbourNode.x || 100) + 320,
                y: (harbourNode.y || 100) - 150,
                displayMode: 'expanded',
                inputs: this.stateManager.getDefaultInputs('FEMDomain3D'),
                outputs: this.stateManager.getDefaultOutputs('FEMDomain3D'),
                parameters: {
                    ...this.stateManager.getDefaultParameters('FEMDomain3D'),
                    name: 'Structural FEM Domain',
                    device: 'gpu',
                    integration_scheme: 'OnePointFB',
                    convert_failed_elements_to_mpm: false
                }
            };
            state.nodes.push(femDomain);
            model.nodes.push(femDomain);
        }

        // 2. Ensure Reinforced Concrete Material exists
        let concreteMat = model.nodes.find(n => n.type === 'Material' && (n.parameters?.name?.includes('Concrete') || n.parameters?.preset?.includes('Concrete')));
        if (!concreteMat) {
            const concreteMatId = this.stateManager.generateUniqueNodeId('Material');
            concreteMat = {
                id: concreteMatId,
                type: 'Material',
                x: (harbourNode.x || 100) + 320,
                y: (harbourNode.y || 100) + 180,
                displayMode: 'expanded',
                inputs: this.stateManager.getDefaultInputs('Material'),
                outputs: this.stateManager.getDefaultOutputs('Material'),
                parameters: {
                    ...this.stateManager.getDefaultParameters('Material'),
                    name: 'Reinforced Concrete (B35)',
                    material_model: 'Hypoelastic',
                    density: 2400.0,
                    youngs_modulus: 30.0e9,
                    poissons_ratio: 0.20,
                    yield_stress: 35.0e6,
                    fc: 35.0e6,
                    ft: 3.2e6
                }
            };
            state.nodes.push(concreteMat);
            model.nodes.push(concreteMat);
        }

        // 3. Create Concrete Quay Wall FEMObject3D
        const quayWallId = this.stateManager.generateUniqueNodeId('FEMObject3D');
        const quayWallNode: Node = {
            id: quayWallId,
            type: 'FEMObject3D',
            x: (harbourNode.x || 100) + 640,
            y: (harbourNode.y || 100),
            displayMode: 'expanded',
            inputs: this.stateManager.getDefaultInputs('FEMObject3D'),
            outputs: this.stateManager.getDefaultOutputs('FEMObject3D'),
            parameters: {
                ...this.stateManager.getDefaultParameters('FEMObject3D'),
                name: 'Concrete Quay Wall',
                shape_type: 'Box',
                mesh_source: 'Box Generator',
                origin_mode: 'Center',
                boundary_condition: 'Clamped',
                pos_x: 20.0,
                pos_y: 0.0,
                pos_z: 7.0,
                size_x: 6.0,
                size_y: 30.0,
                size_z: 14.0,
                nx: 12,
                ny: 30,
                nz: 28,
                material: concreteMat.id
            }
        };
        state.nodes.push(quayWallNode);
        model.nodes.push(quayWallNode);

        // 4. Wire connections
        state.connections.push({ fromNode: concreteMat.id, fromPort: 'out', toNode: quayWallId, toPort: 'material' });
        model.connections.push({ fromNode: concreteMat.id, fromPort: 'out', toNode: quayWallId, toPort: 'material' });

        state.connections.push({ fromNode: quayWallId, fromPort: 'out', toNode: femDomain.id, toPort: 'mesh' });
        model.connections.push({ fromNode: quayWallId, fromPort: 'out', toNode: femDomain.id, toPort: 'mesh' });

        // 5. Update graph and trigger re-render
        this.stateManager.healModelGraph(model);
        this.stateManager.pushState(state);
        this.stateManager.selectNode(model.id, quayWallId);
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
        this.render();
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
