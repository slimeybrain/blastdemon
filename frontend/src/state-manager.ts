import { SimulationState, SimulationStatus, LayoutNode, PanelNode, SplitNode, LayoutDirection, PanelType, Model, Workspace, AppState, Node, Connection, NodeType, Port } from './types.js';

export class StateManager {
    private appState: AppState;
    private history: AppState[] = [];
    private currentIndex: number = -1;
    private listeners: ((state: SimulationState) => void)[] = [];
    private simulationStatus: SimulationStatus = 'UNINITIALIZED';
    private statusListeners: ((status: SimulationStatus) => void)[] = [];
    private pendingSteps: number = 0;
    public telemetryStore: Map<string, any> = new Map();
    private telemetryListeners: ((nodeId: string, data: any) => void)[] = [];
    public selectedNodeId: string | null = null;
    private selectionListeners: ((nodeId: string | null) => void)[] = [];

    // Removed runTarget fields
    private modelStatuses: Map<string, SimulationStatus> = new Map();
    private modelProgresses: Map<string, number> = new Map();
    private modelSimTimes: Map<string, number> = new Map();
    private modelStatusListeners: ((modelId: string, status: SimulationStatus) => void)[] = [];
    private clipboardModel: Model | null = null;

    constructor(initialState?: SimulationState) {
        const defaultModelId = 'model-default';
        const defaultModel: Model = {
            id: defaultModelId,
            name: 'Default Model',
            filename: null,
            nodes: initialState ? JSON.parse(JSON.stringify(initialState.nodes)) : [],
            connections: initialState ? JSON.parse(JSON.stringify(initialState.connections)) : []
        };
        const defaultWorkspaceId = 'ws-default';
        const defaultWorkspace: Workspace = {
            id: defaultWorkspaceId,
            name: 'Workspace 1',
            modelIds: [defaultModelId],
            activeModelId: defaultModelId,
            layout: initialState ? JSON.parse(JSON.stringify(initialState.layout)) : {
                type: 'panel',
                id: 'panel-graph',
                panelType: 'NODE_GRAPH',
                targetNodeId: null
            },
            connections: []
        };

        this.appState = {
            models: { [defaultModelId]: defaultModel },
            workspaces: [defaultWorkspace],
            activeWorkspaceId: defaultWorkspaceId,
            workspaceCounter: 1
        };

        this.pushAppState(this.appState, false);
    }

    // Shims for legacy/external code
    get workspaces(): SimulationState[] {
        return this.appState.workspaces.map(ws => this.synthesizeWorkspaceState(ws));
    }

    get activeWorkspaceIndex(): number {
        return this.appState.workspaces.findIndex(ws => ws.id === this.appState.activeWorkspaceId);
    }

    // Removed runTarget methods

    getModelStatus(modelId: string): SimulationStatus {
        return this.modelStatuses.get(modelId) || 'UNINITIALIZED';
    }

    setModelStatus(modelId: string, status: SimulationStatus): void {
        const oldStatus = this.modelStatuses.get(modelId);
        if (oldStatus !== status) {
            this.modelStatuses.set(modelId, status);
            this.modelStatusListeners.forEach(l => l(modelId, status));
            
            const activeWs = this.getActiveWorkspace();
            if (activeWs && activeWs.activeModelId === modelId) {
                this.setStatus(status);
            }
        }
    }

    onModelStatusChange(listener: (modelId: string, status: SimulationStatus) => void): void {
        this.modelStatusListeners.push(listener);
    }

    offModelStatusChange(listener: (modelId: string, status: SimulationStatus) => void): void {
        this.modelStatusListeners = this.modelStatusListeners.filter(l => l !== listener);
    }

    getModelProgress(modelId: string): number {
        return this.modelProgresses.get(modelId) || 0;
    }

    setModelProgress(modelId: string, percent: number): void {
        this.modelProgresses.set(modelId, percent);
    }

    getModelSimTime(modelId: string): number {
        return this.modelSimTimes.get(modelId) || 0.0;
    }

    setModelSimTime(modelId: string, simTime: number): void {
        this.modelSimTimes.set(modelId, simTime);
    }

    // Workspace management
    getActiveWorkspace(): Workspace {
        return this.appState.workspaces.find(ws => ws.id === this.appState.activeWorkspaceId) || this.appState.workspaces[0];
    }

    getWorkspaceModels(wsId?: string): Model[] {
        const targetId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetId);
        if (!ws) return [];
        return ws.modelIds.map(id => this.appState.models[id]).filter(m => !!m);
    }

    getAllModels(): Model[] {
        return Object.values(this.appState.models);
    }

    getAllWorkspaces(): Workspace[] {
        return this.appState.workspaces;
    }

    switchWorkspace(idOrIndex: string | number) {
        let targetWorkspace: Workspace | undefined;
        if (typeof idOrIndex === 'number') {
            targetWorkspace = this.appState.workspaces[idOrIndex];
        } else {
            targetWorkspace = this.appState.workspaces.find(ws => ws.id === idOrIndex);
        }

        if (targetWorkspace) {
            this.appState.activeWorkspaceId = targetWorkspace.id;

            this.pushAppState(this.appState);
        }
    }

    createWorkspace() {
        this.appState.workspaceCounter++;
        const newId = `ws-${Math.random().toString(36).substr(2, 9)}`;
        const activeWs = this.getActiveWorkspace();
        
        const defaultLayout: LayoutNode = {
            type: 'split',
            id: `split-root-${newId}`,
            direction: 'horizontal',
            ratio: 0.2,
            firstChild: {
                type: 'split',
                id: `split-left-${newId}`,
                direction: 'vertical',
                ratio: 0.5,
                firstChild: {
                    type: 'split',
                    id: `split-menu-outliner-${newId}`,
                    direction: 'vertical',
                    ratio: 0.1,
                    firstChild: {
                        type: 'panel',
                        id: `panel-menu-bar-${newId}`,
                        panelType: 'MENU_BAR',
                        targetNodeId: null
                    },
                    secondChild: {
                        type: 'panel',
                        id: `panel-outliner-${newId}`,
                        panelType: 'OUTLINER',
                        targetNodeId: null
                    }
                },
                secondChild: {
                    type: 'panel',
                    id: `panel-execution-${newId}`,
                    panelType: 'EXECUTION_MANAGER',
                    targetNodeId: null
                }
            },
            secondChild: {
                type: 'split',
                id: `split-main-${newId}`,
                direction: 'horizontal',
                ratio: 0.75,
                firstChild: {
                    type: 'panel',
                    id: `panel-graph-${newId}`,
                    panelType: 'NODE_GRAPH',
                    targetNodeId: null
                },
                secondChild: {
                    type: 'panel',
                    id: `panel-properties-${newId}`,
                    panelType: 'PROPERTIES',
                    targetNodeId: null
                }
            }
        };

        const newWorkspace: Workspace = {
            id: newId,
            name: `Workspace ${this.appState.workspaceCounter}`,
            modelIds: [],
            activeModelId: null,
            layout: defaultLayout,
            connections: []
        };

        this.appState.workspaces.push(newWorkspace);
        this.appState.activeWorkspaceId = newId;
        this.pushAppState(this.appState);
    }

    deleteWorkspace(wsId: string): void {
        if (this.appState.workspaces.length <= 1) return;
        const index = this.appState.workspaces.findIndex(ws => ws.id === wsId);
        if (index !== -1) {
            this.appState.workspaces = this.appState.workspaces.filter(ws => ws.id !== wsId);
            if (this.appState.activeWorkspaceId === wsId) {
                const nextActiveIdx = Math.max(0, index - 1);
                this.appState.activeWorkspaceId = this.appState.workspaces[nextActiveIdx].id;
            }
            this.pushAppState(this.appState);
        }
    }


    renameWorkspace(id: string, name: string): void {
        const ws = this.appState.workspaces.find(w => w.id === id);
        if (ws) {
            ws.name = name;
            this.pushAppState(this.appState);
        }
    }

    getModelColors(modelId: string): { base: string, faint: string } {
        const allModels = this.getAllModels();
        const idx = allModels.findIndex(m => m.id === modelId);
        
        const palette = [
            { h: 217, s: 90, l: 60 }, // Blue
            { h: 0, s: 85, l: 60 },   // Red
            { h: 142, s: 70, l: 50 }, // Emerald
            { h: 38, s: 90, l: 50 },  // Amber
            { h: 262, s: 80, l: 60 }, // Purple
            { h: 327, s: 75, l: 55 }, // Pink
            { h: 187, s: 90, l: 45 }, // Cyan
            { h: 25, s: 95, l: 55 },  // Orange
            { h: 171, s: 75, l: 45 }, // Teal
            { h: 84, s: 80, l: 48 },  // Lime
            { h: 200, s: 85, l: 65 }, // Light Blue
            { h: 345, s: 80, l: 55 }, // Crimson
            { h: 105, s: 65, l: 45 }, // Forest Green
            { h: 45, s: 95, l: 55 },  // Yellow-Orange
            { h: 280, s: 70, l: 65 }, // Violet
            { h: 310, s: 70, l: 50 }, // Magenta
            { h: 160, s: 85, l: 40 }, // Mint
            { h: 15, s: 85, l: 50 },  // Rust
            { h: 230, s: 75, l: 65 }, // Indigo
            { h: 65, s: 80, l: 45 }   // Olive
        ];
        
        const color = idx !== -1 ? palette[idx % palette.length] : { h: 0, s: 0, l: 50 };
        return {
            base: `hsl(${color.h}, ${color.s}%, ${color.l}%)`,
            faint: `hsla(${color.h}, ${color.s}%, ${color.l}%, 0.04)`
        };
    }

    // Model management
    createModel(name?: string): Model {
        const modelId = `model-${Math.random().toString(36).substr(2, 9)}`;
        const newModel: Model = {
            id: modelId,
            name: name || `Model ${Object.keys(this.appState.models).length + 1}`,
            filename: null,
            nodes: [],
            connections: []
        };
        this.appState.models[modelId] = newModel;
        
        const activeWs = this.getActiveWorkspace();
        activeWs.modelIds.push(modelId);
        activeWs.activeModelId = modelId;

        this.pushAppState(this.appState);
        return newModel;
    }

    setModelFilename(modelId: string, filename: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            model.filename = filename;
            this.pushAppState(this.appState);
        }
    }

    addModelToWorkspace(model: Model, wsId?: string): void {
        const targetWsId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetWsId);
        if (ws) {
            if (!this.appState.models[model.id]) {
                this.appState.models[model.id] = model;
            }
            if (!ws.modelIds.includes(model.id)) {
                ws.modelIds.push(model.id);
            }
            if (!ws.activeModelId) {
                ws.activeModelId = model.id;
            }
            this.pushAppState(this.appState);
        }
    }

    removeModelFromWorkspace(modelId: string, wsId?: string): void {
        const targetWsId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetWsId);
        if (ws) {
            ws.modelIds = ws.modelIds.filter(id => id !== modelId);
            if (ws.activeModelId === modelId) {
                ws.activeModelId = ws.modelIds.length > 0 ? ws.modelIds[0] : null;
            }
            // Clean up workspace level connections that referenced this model's nodes
            const model = this.appState.models[modelId];
            if (model) {
                const nodeIds = new Set(model.nodes.map(n => n.id));
                ws.connections = ws.connections.filter(c => !nodeIds.has(c.fromNode) && !nodeIds.has(c.toNode));
            }
            this.pushAppState(this.appState);
        }
    }

    setActiveModel(modelId: string): void {
        const ws = this.getActiveWorkspace();
        if (ws && ws.modelIds.includes(modelId)) {
            ws.activeModelId = modelId;
            this.pushAppState(this.appState);
        }
    }

    renameModel(modelId: string, name: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            model.name = name;
            this.pushAppState(this.appState);
        }
    }

    moveModelInWorkspace(modelId: string, direction: 'top' | 'up' | 'down' | 'bottom'): void {
        const ws = this.getActiveWorkspace();
        if (!ws) return;

        const idx = ws.modelIds.indexOf(modelId);
        if (idx === -1) return;

        const newModelIds = [...ws.modelIds];
        if (direction === 'top') {
            if (idx === 0) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.unshift(item);
        } else if (direction === 'up') {
            if (idx === 0) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.splice(idx - 1, 0, item);
        } else if (direction === 'down') {
            if (idx === newModelIds.length - 1) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.splice(idx + 1, 0, item);
        } else if (direction === 'bottom') {
            if (idx === newModelIds.length - 1) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.push(item);
        }

        ws.modelIds = newModelIds;
        this.pushAppState(this.appState);
    }

    reorderModelsInWorkspace(reorderedIds: string[]): void {
        const ws = this.getActiveWorkspace();
        if (!ws) return;

        const currentSet = new Set(ws.modelIds);
        const filtered = reorderedIds.filter(id => currentSet.has(id));
        ws.modelIds.forEach(id => {
            if (!filtered.includes(id)) filtered.push(id);
        });

        ws.modelIds = filtered;
        this.pushAppState(this.appState);
    }

    copyModelToClipboard(modelId: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            this.clipboardModel = JSON.parse(JSON.stringify(model));
        }
    }

    private getUniqueNodeIdFromBase(baseId: string, tempExistingIds: Set<string>): string {
        const prefix = baseId.replace(/-\d+$/, '');
        let newId = baseId;
        if (tempExistingIds.has(newId)) {
            let index = 1;
            newId = `${prefix}-${index}`;
            while (tempExistingIds.has(newId)) {
                index++;
                newId = `${prefix}-${index}`;
            }
        }
        tempExistingIds.add(newId);
        return newId;
    }

    getClipboardModel(): Model | null {
        return this.clipboardModel;
    }

    private getUniqueNodeId(type: NodeType, tempExistingIds: Set<string>): string {
        const prefixMap: Record<NodeType, string> = {
            'DomainMesh': 'node-mesh',
            'Material': 'node-material',
            'Charge1D': 'node-charge1d',
            'Charge2D': 'node-charge2d',
            'ThePainter': 'node-painter',
            'CFDSolver': 'node-solver',
            'TelemetryText': 'node-log',
            'TelemetryGraph': 'node-chart',
            'DomainMesh2D': 'node-mesh2d',
            'DetonatorLocation': 'node-detonator',
            'DetonatorLocation3D': 'node-detonator',
            'RemapNode': 'node-remap',
            'Remap1DTo2DNode': 'node-remap',
            'Remap1DTo3DNode': 'node-remap',
            'Remap2DTo3DNode': 'node-remap',
            'HardwareConfig': 'node-hardware',
            'CFDSolver2D': 'node-solver2d',
            'TelemetryContour': 'node-contour',
            'VTKOutput': 'node-vtk',
            'VirtualGauges': 'node-gauges',
            'DomainMesh3D': 'node-mesh3d',
            'Charge3D': 'node-charge3d',
            'CFDSolver3D': 'node-solver3d',
            'Telemetry3DViewport': 'node-viewport3d',
            'STLGeometry': 'node-stl',
            'PrimitiveGeometry3D': 'node-stl',
            'MPMDomain2D': 'node-mpm-domain',
            'MPMDomain3D': 'node-mpm-domain3d',
            'MPMObject2D': 'node-mpm-obj',
            'MPMObject3D': 'node-mpm-obj3d',
            'MPMMaterialSteel': 'node-mpm-steel',
            'FSICoupler2D': 'node-fsi-coupler',
            'FSICoupler3D': 'node-fsi-coupler3d',
            'RefinementMesh3D': 'node-refinement3d'
        };
        const prefix = prefixMap[type] || `node-${type.toLowerCase()}`;

        let index = 1;
        if (tempExistingIds.has(prefix)) {
            index = 2;
        }
        while (tempExistingIds.has(`${prefix}-${index}`)) {
            index++;
        }
        const newId = index === 1 && !tempExistingIds.has(prefix) ? prefix : `${prefix}-${index}`;
        tempExistingIds.add(newId);
        return newId;
    }

    pasteModelFromClipboard(offsetX: number = 100, offsetY: number = 100): Model | null {
        if (!this.clipboardModel) return null;

        const newModelId = `model-${Math.random().toString(36).substr(2, 9)}`;

        // Unique name
        let newModelName = `${this.clipboardModel.name} (Copy)`;
        let nameConflict = Object.values(this.appState.models).some(m => m.name === newModelName);
        let counter = 1;
        while (nameConflict) {
            newModelName = `${this.clipboardModel.name} (Copy) ${counter}`;
            nameConflict = Object.values(this.appState.models).some(m => m.name === newModelName);
            counter++;
        }

        const tempExistingIds = new Set<string>();
        Object.values(this.appState.models).forEach(model => {
            model.nodes.forEach(n => tempExistingIds.add(n.id));
        });

        const idMapping: Record<string, string> = {};
        const duplicatedNodes: Node[] = this.clipboardModel.nodes.map(node => {
            const newNodeId = this.getUniqueNodeIdFromBase(node.id, tempExistingIds);
            idMapping[node.id] = newNodeId;
            return {
                ...JSON.parse(JSON.stringify(node)),
                id: newNodeId,
                x: node.x + offsetX,
                y: node.y + offsetY
            };
        });

        const duplicatedConnections: Connection[] = this.clipboardModel.connections.map(conn => {
            return {
                fromNode: idMapping[conn.fromNode] || conn.fromNode,
                fromPort: conn.fromPort,
                toNode: idMapping[conn.toNode] || conn.toNode,
                toPort: conn.toPort
            };
        });

        const newModel: Model = {
            id: newModelId,
            name: newModelName,
            filename: this.clipboardModel.filename ? `${this.clipboardModel.filename.replace(/\.[^/.]+$/, "")}_copy.json` : null,
            nodes: duplicatedNodes,
            connections: duplicatedConnections
        };

        this.appState.models[newModelId] = newModel;

        const activeWs = this.getActiveWorkspace();
        activeWs.modelIds.push(newModelId);
        activeWs.activeModelId = newModelId;

        // Initialize statuses
        this.modelStatuses.set(newModelId, 'UNINITIALIZED');
        this.modelProgresses.set(newModelId, 0);
        this.modelSimTimes.set(newModelId, 0.0);

        this.pushAppState(this.appState);

        return newModel;
    }

    // Core state sync and history
    getCurrentState(): SimulationState | null {
        const ws = this.getActiveWorkspace();
        if (!ws) return null;
        return this.synthesizeWorkspaceState(ws);
    }

    getSimulationState(targetModelId: string | 'all'): SimulationState | null {
        if (targetModelId === 'all') {
            return this.getCurrentState();
        }
        const model = this.appState.models[targetModelId];
        const ws = this.getActiveWorkspace();
        if (!ws) return null;
        return {
            nodes: model ? JSON.parse(JSON.stringify(model.nodes)) : [],
            connections: model ? JSON.parse(JSON.stringify(model.connections)) : [],
            layout: JSON.parse(JSON.stringify(ws.layout))
        };
    }


    private synthesizeWorkspaceState(ws: Workspace): SimulationState {
        const nodes: Node[] = [];
        const connections: Connection[] = [];

        ws.modelIds.forEach(mId => {
            const model = this.appState.models[mId];
            if (model) {
                nodes.push(...JSON.parse(JSON.stringify(model.nodes)));
                connections.push(...JSON.parse(JSON.stringify(model.connections)));
            }
        });

        connections.push(...JSON.parse(JSON.stringify(ws.connections)));

        return {
            nodes,
            connections,
            layout: JSON.parse(JSON.stringify(ws.layout))
        };
    }



    pushAppState(newAppState: AppState, autoSave: boolean = true): void {
        const stateCopy = JSON.parse(JSON.stringify(newAppState)) as AppState;
        
        // Heal duplicate node IDs to prevent models merging
        this.healDuplicateNodeIds(stateCopy);

        // Ensure menu bar exists on all layouts
        stateCopy.workspaces.forEach(ws => {
            ws.layout = ensureMenuBar(ws.layout);
            ws.modelIds = Array.from(new Set(ws.modelIds));
        });

        // Constrain all slices to their domain boundaries
        Object.values(stateCopy.models).forEach(model => {
            constrainAllSlices(model);
        });



        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(stateCopy);
        this.currentIndex++;
        this.appState = stateCopy;

        this.notifyListeners();
        if (autoSave) this.saveWorkspace();
    }

    pushState(newState: SimulationState, autoSave: boolean = true): void {
        this.healNodes(newState.nodes, newState);
        // Construct new AppState from the SimulationState
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        const ws = appStateCopy.workspaces.find(w => w.id === appStateCopy.activeWorkspaceId);
        if (!ws) return;

        ws.layout = JSON.parse(JSON.stringify(newState.layout));

        // Sync nodes and connections back to models and workspace
        const modelsInWs = ws.modelIds.map(id => appStateCopy.models[id]).filter(m => !!m);

        // Track node membership
        const nodeToModelMap: Record<string, string> = {};
        modelsInWs.forEach(model => {
            model.nodes.forEach(n => {
                nodeToModelMap[n.id] = model.id;
            });
        });

        // Determine which models need to be rebuilt.
        // We always rebuild the active model, plus any model that has nodes in newState.nodes.
        const modelsToRebuild = new Set<string>();
        if (ws.activeModelId) {
            modelsToRebuild.add(ws.activeModelId);
        }
        newState.nodes.forEach(node => {
            const mId = nodeToModelMap[node.id];
            if (mId) {
                modelsToRebuild.add(mId);
            }
        });

        // Clear existing nodes and connections ONLY for models being rebuilt
        modelsInWs.forEach(model => {
            if (modelsToRebuild.has(model.id)) {
                model.nodes = [];
                model.connections = [];
            }
        });

        // Clear only cross-model connections involving rebuilt models
        ws.connections = ws.connections.filter(conn => {
            const fromModelId = nodeToModelMap[conn.fromNode];
            const toModelId = nodeToModelMap[conn.toNode];
            const involvesRebuilt = (fromModelId && modelsToRebuild.has(fromModelId)) ||
                                    (toModelId && modelsToRebuild.has(toModelId));
            return !involvesRebuilt;
        });

        // Distribute nodes
        newState.nodes.forEach(node => {
            let modelId = nodeToModelMap[node.id];
            if (!modelId || !appStateCopy.models[modelId]) {
                // New node goes to active model
                modelId = ws.activeModelId || Object.keys(appStateCopy.models)[0];
            }
            if (modelId && appStateCopy.models[modelId]) {
                appStateCopy.models[modelId].nodes.push(node);
            }
        });

        // Distribute connections
        newState.connections.forEach(conn => {
            const fromModelId = appStateCopy.models[ws.modelIds.find(id => appStateCopy.models[id].nodes.some(n => n.id === conn.fromNode)) || '']?.id;
            const toModelId = appStateCopy.models[ws.modelIds.find(id => appStateCopy.models[id].nodes.some(n => n.id === conn.toNode)) || '']?.id;

            if (fromModelId && toModelId && fromModelId === toModelId) {
                if (modelsToRebuild.has(fromModelId)) {
                    // Internal connection for a rebuilt model: add it
                    appStateCopy.models[fromModelId].connections.push(conn);
                }
            } else {
                // Cross-model connection: add it if it involves a rebuilt model
                const involvesRebuilt = (fromModelId && modelsToRebuild.has(fromModelId)) || 
                                        (toModelId && modelsToRebuild.has(toModelId));
                if (involvesRebuilt) {
                    const exists = ws.connections.some(c => 
                        c.fromNode === conn.fromNode && c.fromPort === conn.fromPort &&
                        c.toNode === conn.toNode && c.toPort === conn.toPort
                    );
                    if (!exists) {
                        ws.connections.push(conn);
                    }
                }
            }
        });

        this.pushAppState(appStateCopy, autoSave);
    }

    updateState(state: SimulationState, pushToHistory: boolean = true): void {
        if (pushToHistory) {
            this.pushState(state);
        } else {
            this.pushState(state, false);
        }
    }

    undo(): SimulationState | null {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this.appState = JSON.parse(JSON.stringify(this.history[this.currentIndex]));
            this.notifyListeners();
            this.saveWorkspace();
            return this.getCurrentState();
        }
        return null;
    }

    redo(): SimulationState | null {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            this.appState = JSON.parse(JSON.stringify(this.history[this.currentIndex]));
            this.notifyListeners();
            this.saveWorkspace();
            return this.getCurrentState();
        }
        return null;
    }

    updateNodeParameters(nodeId: string, parameters: Record<string, any>): void {
        console.log("[DEBUG] updateNodeParameters called for node:", nodeId, "params:", parameters);
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        let found = false;
        
        for (const model of Object.values(appStateCopy.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                const merged = { ...node.parameters, ...parameters };
                const updatedKey = Object.keys(parameters).find(k => k === 'charge_mass') || Object.keys(parameters)[0];
                syncExplosiveParameters(node, merged, model, updatedKey);
                syncQuantityRanges(node, parameters, merged);
                node.parameters = merged;
                console.log("[DEBUG] Node parameters updated in memory. New parameters:", node.parameters);
                
                if (node.type === 'Material') {
                    const dependentConns = model.connections.filter(c => c.fromNode === node.id && c.toPort === 'material');
                    dependentConns.forEach(c => {
                        const depNode = model.nodes.find(n => n.id === c.toNode);
                        if (depNode && (depNode.type === 'Charge1D' || depNode.type === 'Charge2D' || depNode.type === 'Charge3D')) {
                            syncExplosiveParameters(depNode, depNode.parameters, model, 'rho');
                        }
                    });
                }
                
                found = true;
                break;
            }
        }

        if (found) {
            this.setStatus('UNINITIALIZED');
            this.pushAppState(appStateCopy);
        } else {
            console.error("[DEBUG] Node NOT found for parameter update:", nodeId);
        }
    }

    updateNodeParametersInPlace(nodeId: string, parameters: Record<string, any>): void {
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        let found = false;
        let changed = false;
        
        for (const model of Object.values(appStateCopy.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                const merged = { ...node.parameters, ...parameters };
                const updatedKey = Object.keys(parameters).find(k => k === 'charge_mass') || Object.keys(parameters)[0];
                syncExplosiveParameters(node, merged, model, updatedKey);
                syncQuantityRanges(node, parameters, merged);
                
                for (const [key, value] of Object.entries(merged)) {
                    if (node.parameters[key] !== value) {
                        node.parameters[key] = value;
                        changed = true;
                    }
                }

                if (constrainAllSlices(model)) {
                    changed = true;
                }
                
                if (node.type === 'Material') {
                    const dependentConns = model.connections.filter(c => c.fromNode === node.id && c.toPort === 'material');
                    dependentConns.forEach(c => {
                        const depNode = model.nodes.find(n => n.id === c.toNode);
                        if (depNode && (depNode.type === 'Charge1D' || depNode.type === 'Charge2D' || depNode.type === 'Charge3D')) {
                            const oldRadius = depNode.parameters['charge_radius'];
                            syncExplosiveParameters(depNode, depNode.parameters, model, 'rho');
                            if (depNode.parameters['charge_radius'] !== oldRadius) {
                                changed = true;
                            }
                        }
                    });
                }
                
                found = true;
                break;
            }
        }

        if (found && changed) {
            this.appState = appStateCopy;
            this.saveWorkspace();
            this.notifyListeners();
        }
    }

    toggleNodeDisplayMode(nodeId: string): void {
        const state = this.getCurrentState();
        if (!state) return;

        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
            const modes: ('compact' | 'normal' | 'expanded')[] = ['normal', 'expanded', 'compact'];
            const currentMode = (node.displayMode === 'full-panel' ? 'expanded' : node.displayMode) || 'expanded';
            const nextIndex = (modes.indexOf(currentMode) + 1) % modes.length;
            const nextMode = modes[nextIndex];
            node.displayMode = nextMode;

            if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
                if (nextMode === 'compact') {
                    node.width = 180;
                    node.height = 40;
                } else if (nextMode === 'normal') {
                    node.width = node.type === 'TelemetryContour' ? 420 : 250;
                    if (node.type === 'TelemetryContour') {
                        node.height = 300;
                    } else {
                        node.height = node.type === 'TelemetryGraph' ? 150 : 130;
                    }
                } else if (nextMode === 'expanded') {
                    node.width = node.type === 'TelemetryContour' ? 420 : 350;
                    if (node.type === 'TelemetryContour') {
                        node.height = 300;
                    } else {
                        node.height = 220;
                    }
                }
            } else {
                delete node.width;
                delete node.height;
            }

            this.pushState(state);
        }
    }

    onStateChange(listener: (state: SimulationState) => void): void {
        this.listeners.push(listener);
    }

    offStateChange(listener: (state: SimulationState) => void): void {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    getStatus(): SimulationStatus {
        return this.simulationStatus;
    }

    setStatus(status: SimulationStatus): void {
        if (this.simulationStatus !== status) {
            const oldStatus = this.simulationStatus;
            this.simulationStatus = status;
            this.notifyStatusListeners();

            if (status === 'PAUSED' && oldStatus === 'RUNNING') {
                this.pushTelemetry('Simulation Interrupted/Paused');
            } else if (status === 'TERMINATED') {
                this.pushTelemetry('Simulation Terminated');
            }
        }
    }

    onStatusChange(listener: (status: SimulationStatus) => void): void {
        this.statusListeners.push(listener);
    }

    offStatusChange(listener: (status: SimulationStatus) => void): void {
        this.statusListeners = this.statusListeners.filter(l => l !== listener);
    }

    onTelemetryUpdate(listener: (nodeId: string, data: any) => void): void {
        this.telemetryListeners.push(listener);
    }

    offTelemetryUpdate(listener: (nodeId: string, data: any) => void): void {
        this.telemetryListeners = this.telemetryListeners.filter(l => l !== listener);
    }

    onSelectionChange(listener: (nodeId: string | null) => void): void {
        this.selectionListeners.push(listener);
    }

    offSelectionChange(listener: (nodeId: string | null) => void): void {
        this.selectionListeners = this.selectionListeners.filter(l => l !== listener);
    }

    setSelectedNode(nodeId: string | null): void {
        if (this.selectedNodeId !== nodeId) {
            this.selectedNodeId = nodeId;
            this.selectionListeners.forEach(l => l(nodeId));
        }
    }

    getSelectedNodeId(): string | null {
        return this.selectedNodeId;
    }

    getTelemetry(nodeId: string): any {
        return this.telemetryStore.get(nodeId);
    }

    addPendingSteps(steps: number): void {
        this.pendingSteps += steps;
    }

    getPendingSteps(): number {
        return this.pendingSteps;
    }

    clearPendingSteps(): void {
        this.pendingSteps = 0;
    }

    private notifyStatusListeners(): void {
        this.statusListeners.forEach(listener => listener(this.simulationStatus));
    }

    private notifyTelemetryUpdate(nodeId: string, data: any): void {
        this.telemetryListeners.forEach(listener => listener(nodeId, data));
    }

    private formatTelemetry(data: any): string {
        const timestamp = new Date().toLocaleTimeString();

        if (data instanceof ArrayBuffer) {
            return `[${timestamp}] [BINARY] ArrayBuffer(${data.byteLength})`;
        }

        if (typeof data === 'string') {
            if (data.startsWith('{')) {
                try {
                    const parsed = JSON.parse(data);
                    return this.formatTelemetry(parsed);
                } catch (e) {
                    return `[${timestamp}] [TEXT] ${data}`;
                }
            }
            return `[${timestamp}] [TEXT] ${data}`;
        }

        if (typeof data === 'object' && data !== null) {
            if (data.type === 'progress' || data.type === 'progress_2d' || data.command === 'PROGRESS') {
                const percent = data.percent !== undefined ? data.percent : (data.value || 0);
                const wcStr = data.wallclock !== undefined ? `, Wallclock: ${Number(data.wallclock).toFixed(4)}s` : '';
                return `[${timestamp}] [PROGRESS] ${percent}% complete${wcStr}`;
            }
            if (data.type === 'TELEMETRY_MPM_2D') {
                const wcStr = data.wallclock !== undefined ? `, Wallclock: ${Number(data.wallclock).toFixed(4)}s` : '';
                const dtStr = data.dt !== undefined ? `, dt: ${Number(data.dt).toExponential(6)}s` : '';
                return `[${timestamp}] [MPM] Time: ${data.time?.toExponential(6) || '0'}${dtStr}${wcStr}, Terminated: ${data.is_terminated || false}`;
            }
            if (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D') {
                const tag = data.type === 'TELEMETRY_2D' ? 'CFD' : (data.type === 'TELEMETRY_3D' ? '3D' : 'SOLVER');
                const engineType = data.is_ideal_gas ? ' (IG)' : ' (MM)';
                const wcStr = data.wallclock !== undefined ? `, Wallclock: ${Number(data.wallclock).toFixed(4)}s` : '';
                const dtStr = data.dt !== undefined ? `, dt: ${Number(data.dt).toExponential(6)}s` : '';
                return `[${timestamp}] [${tag}${engineType}] Time: ${data.time?.toExponential(6) || '0'}${dtStr}${wcStr}, Terminated: ${data.is_terminated || false}`;
            }
            if (data.type === 'resource_pulse') {
                return `[${timestamp}] [RESOURCES] CPU: ${data.metrics?.cpu?.toFixed(1)}%, RAM: ${data.metrics?.ram?.toFixed(1)}%`;
            }
            return `[${timestamp}] [JSON] ${JSON.stringify(data, null, 2)}`;
        }

        return `[${timestamp}] [DATA] ${String(data)}`;
    }

    pushTelemetry(nodeIdOrData: any, optionalData?: any, modelId?: string): void {
        let nodeId: string | null = null;
        let data: any = null;

        const state = this.getCurrentState();
        if (!state) return;

        const model = modelId ? this.appState.models[modelId] : null;
        const nodes = model ? model.nodes : state.nodes;
        const connections = model ? model.connections : state.connections;

        if (typeof nodeIdOrData === 'string' && optionalData !== undefined) {
            nodeId = nodeIdOrData;
            data = optionalData;
        } else if (typeof nodeIdOrData === 'string') {
            const solverNode = nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        } else {
            const solverNode = nodes.find(n => n.id === 'node-solver') || nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        }

        if (!nodeId) return;

        const targetNode = nodes.find(n => n.id === nodeId);
        let telemetryToStore = data;
        if ((targetNode?.type === 'TelemetryText' || targetNode?.type === 'CFDSolver' || targetNode?.type === 'CFDSolver2D' || targetNode?.type === 'CFDSolver3D' || targetNode?.type === 'MPMDomain2D' || targetNode?.type === 'MPMDomain3D' || targetNode?.type === 'FSICoupler2D' || targetNode?.type === 'FSICoupler3D') && !(data instanceof ArrayBuffer)) {
            if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'progress_2d' || data.type === 'resource_pulse')) {
                 // Skip
            } else {
                let log = this.telemetryStore.get(nodeId);
                if (!Array.isArray(log)) log = [];
                log.push(this.formatTelemetry(data));
                if (log.length > 100) log.shift();
                telemetryToStore = log;
            }
        }

        this.telemetryStore.set(nodeId, telemetryToStore);
        this.notifyTelemetryUpdate(nodeId, telemetryToStore);

        const solverNodeTypes = ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MPMDomain2D', 'MPMDomain3D', 'FSICoupler2D', 'FSICoupler3D'];
        const isSolverOrCoupler = targetNode && solverNodeTypes.includes(targetNode.type);

        const telemetryConnections = connections.filter(e => {
            if (e.fromNode === nodeId) return true;
            if (isSolverOrCoupler) {
                const fromN = nodes.find(n => n.id === e.fromNode);
                return fromN && solverNodeTypes.includes(fromN.type);
            }
            return false;
        });
        const updatedNodeIds = new Set<string>();

        telemetryConnections.forEach(connection => {
            const connectedNode = nodes.find(n => n.id === connection.toNode);
            if (connectedNode) {
                updatedNodeIds.add(connectedNode.id);
                if (connectedNode.type === 'TelemetryGraph') {
                    if (data instanceof ArrayBuffer || (data && (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_MPM_2D'))) {
                         this.telemetryStore.set(connectedNode.id, data);
                         this.notifyTelemetryUpdate(connectedNode.id, data);
                    }
                } else if (connectedNode.type === 'VirtualGauges') {
                    if (data && !(data instanceof ArrayBuffer) && data.gauges_history) {
                         this.telemetryStore.set(connectedNode.id, data.gauges_history);
                         this.notifyTelemetryUpdate(connectedNode.id, data.gauges_history);
                    }
                } else if (connectedNode.type === 'TelemetryContour' || connectedNode.type === 'Telemetry3DViewport') {
                    if (data instanceof ArrayBuffer || (data && (data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_MPM_2D'))) {
                         this.telemetryStore.set(connectedNode.id, data);
                         if (data && data.type === 'TELEMETRY_3D') {
                             this.telemetryStore.set(connectedNode.id + "-config-3d", data);
                         }
                         this.notifyTelemetryUpdate(connectedNode.id, data);
                    }
                } else if (connectedNode.type === 'TelemetryText') {
                    if (data instanceof ArrayBuffer) return;
                    if (data && typeof data === 'object' && data.type === 'resource_pulse') {
                        return;
                    }

                    let log = this.telemetryStore.get(connectedNode.id);
                    if (!Array.isArray(log)) log = [];

                    const formattedMsg = this.formatTelemetry(data);
                    if (log.length > 0 && log[log.length - 1] === formattedMsg) return;

                    log.push(formattedMsg);

                    if (log.length > 100) log.shift();
                    this.telemetryStore.set(connectedNode.id, log);
                    this.notifyTelemetryUpdate(connectedNode.id, log);
                }
            }
        });

        // Also check for virtual gauge nodes connected to the solver in the reverse direction (VirtualGauges3D -> CFDSolver3D)
        const reverseGaugeConnections = connections.filter(e => e.toNode === nodeId);
        reverseGaugeConnections.forEach(connection => {
            const connectedNode = nodes.find(n => n.id === connection.fromNode);
            if (connectedNode && !updatedNodeIds.has(connectedNode.id)) {
                if (connectedNode.type === 'VirtualGauges') {
                    if (data && !(data instanceof ArrayBuffer) && data.gauges_history) {
                         this.telemetryStore.set(connectedNode.id, data.gauges_history);
                         this.notifyTelemetryUpdate(connectedNode.id, data.gauges_history);
                    }
                }
            }
        });
    }

    private notifyListeners(): void {
        const currentState = this.getCurrentState();
        if (currentState) {
            this.listeners.forEach(listener => listener(currentState));
        }
    }

    // --- Layout Mutators ---
    splitPanel(panelId: string, direction: LayoutDirection): void {
        const state = this.getCurrentState();
        if (!state) return;

        const findAndSplit = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                const newPanelId = `panel-${Math.random().toString(36).substr(2, 9)}`;
                return {
                    type: 'split',
                    id: `split-${Math.random().toString(36).substr(2, 9)}`,
                    direction,
                    ratio: 0.5,
                    firstChild: JSON.parse(JSON.stringify(node)),
                    secondChild: {
                        type: 'panel',
                        id: newPanelId,
                        panelType: node.panelType,
                        targetNodeId: node.targetNodeId
                    }
                };
            }
            if (node.type === 'split') {
                node.firstChild = findAndSplit(node.firstChild);
                node.secondChild = findAndSplit(node.secondChild);
            }
            return node;
        };

        state.layout = findAndSplit(state.layout);
        this.pushState(state);
    }

    closePanel(panelId: string): void {
        const state = this.getCurrentState();
        if (!state) return;

        if (panelId === 'panel-menu-bar') return;
        if (state.layout.type === 'panel') return;

        const findAndClose = (node: LayoutNode): LayoutNode => {
            if (node.type === 'split') {
                if (node.firstChild.type === 'panel' && node.firstChild.id === panelId) {
                    return node.secondChild;
                }
                if (node.secondChild.type === 'panel' && node.secondChild.id === panelId) {
                    return node.firstChild;
                }
                node.firstChild = findAndClose(node.firstChild);
                node.secondChild = findAndClose(node.secondChild);
            }
            return node;
        };

        state.layout = findAndClose(state.layout);
        this.pushState(state);
    }

    setPanelRatio(splitId: string, newRatio: number): void {
        const state = this.getCurrentState();
        if (!state) return;

        const updateRatio = (node: LayoutNode): LayoutNode => {
            if (node.type === 'split') {
                if (node.id === splitId) {
                    node.ratio = Math.max(0.05, Math.min(0.95, newRatio));
                } else {
                    node.firstChild = updateRatio(node.firstChild);
                    node.secondChild = updateRatio(node.secondChild);
                }
            }
            return node;
        };

        state.layout = updateRatio(state.layout);
        this.updateState(state, false);
    }

    commitPanelRatio(): void {
        const state = this.getCurrentState();
        if (state) this.pushState(state);
    }

    setPanelType(panelId: string, newType: PanelType, targetId: string | null = null): void {
        const state = this.getCurrentState();
        if (!state) return;

        const updateType = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                node.panelType = newType;
                node.targetNodeId = targetId;
            } else if (node.type === 'split') {
                node.firstChild = updateType(node.firstChild);
                node.secondChild = updateType(node.secondChild);
            }
            return node;
        };

        state.layout = updateType(state.layout);
        this.pushState(state);
    }

    updatePanelOptions(panelId: string, options: Record<string, any>): void {
        const state = this.getCurrentState();
        if (!state) return;

        const updateOpts = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                node.options = { ...node.options, ...options };
            } else if (node.type === 'split') {
                node.firstChild = updateOpts(node.firstChild);
                node.secondChild = updateOpts(node.secondChild);
            }
            return node;
        };

        state.layout = updateOpts(state.layout);
        this.pushState(state);
    }

    // --- Persistence ---
    saveWorkspace(): void {
        localStorage.setItem('blast_app_state', JSON.stringify(this.appState));
    }

    loadWorkspace(initialFallback?: SimulationState): SimulationState | null {
        try {
            const saved = localStorage.getItem('blast_app_state');
            if (saved) {
                this.appState = JSON.parse(saved);
                this.healDuplicateNodeIds();
                let anyChanged = false;
                Object.values(this.appState.models).forEach(model => {
                    this.healNodes(model.nodes);
                    if (constrainAllSlices(model)) {
                        anyChanged = true;
                    }
                });
                if (anyChanged) {
                    this.saveWorkspace();
                }
                this.history = [JSON.parse(JSON.stringify(this.appState))];
                this.currentIndex = 0;
                this.notifyListeners();
                console.log('[System] AppState hydrated successfully.');
                return this.getCurrentState();
            }
            
            // Legacy fallback
            const legacy = localStorage.getItem('blast_workspace');
            if (legacy) {
                const parsed = JSON.parse(legacy);
                if (parsed.workspaces && parsed.workspaces.length > 0) {
                    const ws1 = parsed.workspaces[0];
                    const defaultModelId = 'model-default';
                    this.appState = {
                        models: {
                            [defaultModelId]: {
                                id: defaultModelId,
                                name: 'Default Model',
                                filename: null,
                                nodes: ws1.nodes || [],
                                connections: ws1.connections || []
                            }
                        },
                        workspaces: parsed.workspaces.map((ws: any, idx: number) => ({
                            id: `ws-${idx}`,
                            name: ws.name || `Workspace ${idx + 1}`,
                            modelIds: [defaultModelId],
                            activeModelId: defaultModelId,
                            layout: ws.layout,
                            connections: []
                        })),
                        activeWorkspaceId: `ws-${parsed.activeIndex || 0}`,
                        workspaceCounter: parsed.workspaces.length
                    };
                    // Self-healing for legacy loaded nodes
                    Object.values(this.appState.models).forEach(model => {
                        this.healNodes(model.nodes);
                    });
                    this.history = [JSON.parse(JSON.stringify(this.appState))];
                    this.currentIndex = 0;

                    this.notifyListeners();
                    console.log('[System] Legacy workspace converted.');
                    return this.getCurrentState();
                }
            }
        } catch (e) {
            console.error('[System] AppState hydration failed:', e);
        }

        if (initialFallback) {
            const defaultModelId = 'model-default';
            const defaultModel: Model = {
                id: defaultModelId,
                name: 'Default Model',
                filename: null,
                nodes: JSON.parse(JSON.stringify(initialFallback.nodes)),
                connections: JSON.parse(JSON.stringify(initialFallback.connections))
            };
            const defaultWorkspaceId = 'ws-default';
            const defaultWorkspace: Workspace = {
                id: defaultWorkspaceId,
                name: 'Workspace 1',
                modelIds: [defaultModelId],
                activeModelId: defaultModelId,
                layout: JSON.parse(JSON.stringify(initialFallback.layout)),
                connections: []
            };

            this.appState = {
                models: { [defaultModelId]: defaultModel },
                workspaces: [defaultWorkspace],
                activeWorkspaceId: defaultWorkspaceId,
                workspaceCounter: 1
            };
            this.history = [JSON.parse(JSON.stringify(this.appState))];
            this.currentIndex = 0;
            this.notifyListeners();
            return this.getCurrentState();
        }
        return null;
    }

    duplicateWorkspaceLayout(): void {
        const activeWs = this.getActiveWorkspace();
        this.appState.workspaceCounter++;
        const newId = `ws-${Math.random().toString(36).substr(2, 9)}`;
        const duplicatedWs: Workspace = {
            id: newId,
            name: `${activeWs.name} (Copy)`,
            modelIds: [...activeWs.modelIds],
            activeModelId: activeWs.activeModelId,
            layout: JSON.parse(JSON.stringify(activeWs.layout)),
            connections: JSON.parse(JSON.stringify(activeWs.connections))
        };
        this.appState.workspaces.push(duplicatedWs);
        this.appState.activeWorkspaceId = newId;
        this.pushAppState(this.appState);
    }

    getAppState(): AppState {
        return this.appState;
    }

    loadAppState(newAppState: AppState): void {
        this.appState = newAppState;
        this.healDuplicateNodeIds();
        Object.values(this.appState.models).forEach(model => {
            this.healNodes(model.nodes);
        });
        this.pushAppState(this.appState);
    }

    clearWorkspace(): void {
        localStorage.removeItem('blast_app_state');
        localStorage.removeItem('blast_workspace');
        console.log('[System] Local workspace and AppState cleared.');
    }

    generateUniqueNodeId(type: NodeType): string {
        const existingIds = new Set<string>();
        Object.values(this.appState.models).forEach(model => {
            model.nodes.forEach(n => existingIds.add(n.id));
        });
        return this.getUniqueNodeId(type, existingIds);
    }

    private nodeExistsInAnyModel(nodeId: string, targetAppState: AppState = this.appState): boolean {
        return Object.values(targetAppState.models).some(m => m.nodes.some(n => n.id === nodeId));
    }

    public healDuplicateNodeIds(targetAppState: AppState = this.appState): void {
        const seenIds = new Set<string>();
        Object.values(targetAppState.models).forEach(model => {
            const modelIdMap = new Map<string, string>(); // oldId -> newId for this specific model

            model.nodes.forEach(node => {
                if (seenIds.has(node.id)) {
                    const prefix = node.id.replace(/-\d+$/, '');
                    let index = 1;
                    let newId = `${prefix}-${index}`;
                    while (seenIds.has(newId) || this.nodeExistsInAnyModel(newId, targetAppState)) {
                        index++;
                        newId = `${prefix}-${index}`;
                    }
                    console.warn(`[HEAL] Renaming duplicate node ID ${node.id} to ${newId} in model "${model.name}"`);
                    modelIdMap.set(node.id, newId);
                    
                    if (this.selectedNodeId === node.id) {
                        this.selectedNodeId = newId;
                    }
                    
                    node.id = newId;
                }
                seenIds.add(node.id);
            });

            if (modelIdMap.size > 0) {
                // Update internal connections of this model
                model.connections.forEach(conn => {
                    if (modelIdMap.has(conn.fromNode)) {
                        conn.fromNode = modelIdMap.get(conn.fromNode)!;
                    }
                    if (modelIdMap.has(conn.toNode)) {
                        conn.toNode = modelIdMap.get(conn.toNode)!;
                    }
                });

                // Update cross-model workspace connections referencing these renamed nodes
                targetAppState.workspaces.forEach(ws => {
                    ws.connections.forEach(conn => {
                        if (modelIdMap.has(conn.fromNode)) {
                            conn.fromNode = modelIdMap.get(conn.fromNode)!;
                        }
                        if (modelIdMap.has(conn.toNode)) {
                            conn.toNode = modelIdMap.get(conn.toNode)!;
                        }
                    });

                    // Walk the layout tree and update targetNodeId references
                    const updatePanelTargetId = (layoutNode: LayoutNode) => {
                        if (!layoutNode) return;
                        if (layoutNode.type === 'panel') {
                            if (layoutNode.targetNodeId && modelIdMap.has(layoutNode.targetNodeId)) {
                                console.log(`[HEAL] Updating layout panel ${layoutNode.id} targetNodeId from ${layoutNode.targetNodeId} to ${modelIdMap.get(layoutNode.targetNodeId)}`);
                                layoutNode.targetNodeId = modelIdMap.get(layoutNode.targetNodeId)!;
                            }
                        } else if (layoutNode.type === 'split') {
                            updatePanelTargetId(layoutNode.firstChild);
                            updatePanelTargetId(layoutNode.secondChild);
                        }
                    };
                    updatePanelTargetId(ws.layout);
                });
            }
        });
    }

    private healNodes(nodes: Node[], stateObj?: { nodes: Node[], connections: Connection[] }): void {
        nodes.forEach(node => {
            if ((node.type as any) === 'VirtualGauges3D') {
                node.type = 'VirtualGauges';
            }
            node.inputs = this.getDefaultInputs(node.type);
            node.outputs = this.getDefaultOutputs(node.type);
        });

        // Auto-heal: re-route CFDSolver3D.mesh connections that point to a RefinementMesh3D
        // (old scene format). Trace back to the DomainMesh3D and re-wire directly.
        const model = stateObj || Object.values(this.appState.models).find(m => m.nodes === nodes);
        if (model) {
            const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver3D');
            for (const solver of solverNodes) {
                const meshConnIdx = model.connections.findIndex(
                    c => c.toNode === solver.id && c.toPort === 'mesh'
                );
                if (meshConnIdx === -1) continue;
                const meshConn = model.connections[meshConnIdx];
                const srcNode = model.nodes.find(n => n.id === meshConn.fromNode);
                if (!srcNode || srcNode.type !== 'RefinementMesh3D') continue;

                // Trace the parent_mesh chain to find the DomainMesh3D root
                let curr: Node | undefined = srcNode;
                let depth = 0;
                while (curr && curr.type === 'RefinementMesh3D' && depth < 20) {
                    const parentConn = model.connections.find(c => c.toNode === curr!.id && c.toPort === 'parent_mesh');
                    if (!parentConn) break;
                    curr = model.nodes.find(n => n.id === parentConn.fromNode);
                    depth++;
                }
                if (curr && curr.type === 'DomainMesh3D') {
                    console.warn(`[HEAL] Re-routing CFDSolver3D.mesh from RefinementMesh3D "${meshConn.fromNode}" to DomainMesh3D "${curr.id}"`);
                    model.connections[meshConnIdx] = {
                        fromNode: curr.id,
                        fromPort: 'mesh',
                        toNode: solver.id,
                        toPort: 'mesh'
                    };
                }
            }
        }

        const defaults: Record<string, Record<string, any>> = {
            'DomainMesh': {
                dimension: '1D',
                domain_radius: 1.0,
                cell_size: 0.001,
                left_bc: 'Transmitting',
                right_bc: 'Transmitting',
                y_min_bc: 'Reflecting',
                y_max_bc: 'Reflecting',
                z_min_bc: 'Reflecting',
                z_max_bc: 'Reflecting'
            },
            'Material': {
                material_type: 'Air',
                // Air params
                atm_pressure: 101325.0,
                atm_temperature: 288.0,
                gamma: 1.4,
                // JWL params
                composition: 'TNT',
                rho: 1630,
                detonation_energy: 4290000,
                det_vel: 6930,
                jwl_A: 373.77e9,
                jwl_B: 3.747e9,
                jwl_R1: 4.15,
                jwl_R2: 0.90,
                jwl_omega: 0.35,
                // Ideal Gas Charge params
                ideal_gamma: 1.4,
                ideal_rho_0: 1630,
                ideal_e_0: 4290000
            },
            'Charge1D': {
                charge_mass: 0.853479,
                charge_radius: 0.05
            },
            'Charge2D': {
                charge_shape: 'Sphere',
                charge_mass: 0.853479,
                charge_radius: 0.05,
                charge_height: 0.1,
                charge_r: 0.0,
                charge_z: 0.1
            },
            'VirtualGauges': {
                gauges: [],
                telemetry_channel: 0,
                enable_gauges: 'Enabled',
                export_ascii: false,
                export_binary: false,
                export_hdf5: false,
                ascii_delimiter: 'Comma',
                ascii_precision: 6,
                include_header: true,
                output_dir: '',
                custom_filename: 'gauges',
                qty_pressure: true,
                qty_density: true,
                qty_velocity: true,
                qty_energy: true,
                qty_reacted: true,
                qty_unreacted: true,
                qty_air: true,
                qty_overpressure: true,
                qty_impulse: true
            },
            'CFDSolver': {
                init_mode: 'Multi-Material JWL',
                cfl: 0.4,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                precision: 'single'
            },
            'TelemetryGraph': {
                telemetry_channel: 0,
                x_axis_mode: 'radius',
                plot_stride: 1,
                min_y: 0,
                max_y: 1,
                show_grid: true,
                colormap: 'plasma'
            },
            'DomainMesh2D': {
                cell_size: 0.005,
                max_r: 1.0,
                max_z: 1.0,
                bc_r_min: 'Reflecting',
                bc_r_max: 'Terminate',
                bc_z_min: 'Reflecting',
                bc_z_max: 'Terminate',
                coordinate_system: 'Axisymmetric'
            },
            'DetonatorLocation': {
                detonator_r: 0.0,
                detonator_z: 0.1,
                detonator_radius: 0.001
            },
            'DetonatorLocation3D': {
                detonator_x: 0.5,
                detonator_y: 0.5,
                detonator_z: 0.5
            },
            'STLGeometry': {
                stl_file: '',
                geometry_hash: '',
                voxelization_method: 'watertight_floodfill'
            },
            'PrimitiveGeometry3D': {
                primitives: [],
                voxelization_method: 'watertight_floodfill'
            },
            'RemapNode': {
                explosive_x: 0.0,
                explosive_y: 0.0,
                explosive_z: 0.1,
                explosive_r: 0.0,
                remap_radius: 0.5,
                trigger_type: 'end',
                trigger_val: 0.0
            },
            'Remap1DTo2DNode': {
                explosive_r: 0.0,
                explosive_z: 0.1,
                remap_radius: 0.5,
                trigger_type: 'end',
                trigger_val: 0.0
            },
            'Remap1DTo3DNode': {
                explosive_x: 0.5,
                explosive_y: 0.5,
                explosive_z: 0.5,
                remap_radius: 0.0,
                trigger_type: 'end',
                trigger_val: 0.0
            },
            'Remap2DTo3DNode': {
                explosive_x: 0.5,
                explosive_y: 0.5,
                explosive_z: 0.5,
                remap_radius: 0.0,
                trigger_type: 'end',
                trigger_val: 0.0
            },
            'HardwareConfig': {
                device: 'cpu',
                precision: 'single'
            },
            'CFDSolver2D': {
                init_mode: 'From1D',
                cfl: 0.35,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                mesh_type: 'regular',
                amr_max_levels: 3,
                amr_threshold: 0.05,
                amr_coarsen_ratio: 0.2
            },
            'TelemetryContour': {
                telemetry_channel: 0,
                auto_scale: true,
                log_scale: false,
                colormap: 'plasma',
                min_y: 0,
                max_y: 1,
                downsample_stride: 1,
                refresh_rate: 0.0,
                interpolate: true
            },
            'VTKOutput': {
                vtk_dir: './vtk_output',
                export_slices: true,
                export_volumes: false,
                custom_filename: 'vtk_output',
                step_interval: 10,
                time_interval: 0.0,
                vtk_format: 'Binary',
                qty_pressure: true,
                qty_density: true,
                qty_velocity: true,
                qty_energy: true,
                qty_reacted: true,
                qty_unreacted: true,
                qty_air: true,
                qty_overpressure: true,
                qty_impulse: true
            },
            'DomainMesh3D': {
                xmin: 0.0, xmax: 1.0,
                ymin: 0.0, ymax: 1.0,
                zmin: 0.0, zmax: 1.0,
                cell_size: 0.01,
                bc_x_min: 'Reflecting', bc_x_max: 'Transmitting',
                bc_y_min: 'Reflecting', bc_y_max: 'Transmitting',
                bc_z_min: 'Reflecting', bc_z_max: 'Transmitting'
            },

            'Charge3D': {
                charge_shape: 'Sphere',
                charge_mass: 6.8277,
                charge_x: 0.5, charge_y: 0.5, charge_z: 0.5,
                charge_radius: 0.1,
                charge_height: 0.2,
                charge_lx: 0.2, charge_ly: 0.2, charge_lz: 0.2
            },
            'CFDSolver3D': {
                cfl: 0.4,
                device: 'cpu',
                init_mode: 'From1D',
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                precision: 'single',
                telemetry_mode: 'Enabled',
                telemetry_interval_ms: 100,
                enable_gauges: 'Enabled',
                enable_vtk: 'Disabled'
            },
            'Telemetry3DViewport': {
                colormap: 'plasma',
                quantity_colormaps: {
                    pressure: 'plasma',
                    density: 'viridis',
                    velocity: 'rainbow',
                    energy: 'inferno',
                    species1: 'magma',
                    species2: 'coolwarm',
                    species3: 'plasma',
                    solid: 'grayscale',
                    overpressure: 'inferno',
                    impulse: 'thermal'
                },
                quantity_ranges: {
                    pressure: [101325.0, 1013250.0],
                    density: [1.2, 100.0],
                    velocity: [0.0, 1000.0],
                    energy: [200000.0, 10000000.0],
                    species1: [0.0, 1.0],
                    species2: [0.0, 1.0],
                    species3: [0.0, 1.0],
                    solid: [0.0, 1.0],
                    overpressure: [0.0, 101325.0 * 99.0],
                    impulse: [0.0, 10000.0]
                },
                refresh_rate: 2.0,
                slices: [{ axis: 'xy', offset: 0.5, quantities: ['pressure'], stride: 1, opacity: 1.0, colormap: 'plasma', auto_scale: true, log_scale: false, interpolate: true, min_val: 101325.0, max_val: 101325.0 * 10.0, enabled: true }],
                log_scale: false,
                auto_scale: true,
                min_val: 101325.0,
                max_val: 101325.0 * 100.0,
                show_color_bar: true,
                color_bar_position: 'left-center',
                colorbar_source: 'slice',
                show_grid: true,
                grid_meshlines: true,
                show_grid_box: true,
                grid_opacity: 1.0,
                cell_edges: false,
                interpolate: false,
                // Lighting — explicit defaults so overlay sliders initialise correctly
                lightingEnabled: true,
                aoEnabled: true,
                ambientLevel: 0.3,
                specularIntensity: 0.4,
                // MPM Particles Defaults
                showMPMParticles: true,
                mpmParticleSize: 4.0,
                mpmParticleQuantity: 'vonMises',
                mpmParticleColormap: 'plasma',
                mpmParticleAutoScale: true,
                mpmParticleLogScale: false,
                mpmParticleOpacity: 1.0,
                mpmParticleMinVal: 0.0,
                mpmParticleMaxVal: 500000000.0,
                // VTK / File outputs
                vtk_dir: '',
                export_slices: true,
                export_volumes: false,
                custom_filename: 'vtk_output',
                step_interval: 10,
                time_interval: 0.0,
                vtk_format: 'Binary',
                qty_pressure: true,
                qty_density: true,
                qty_velocity: true,
                qty_energy: true,
                qty_reacted: true,
                qty_unreacted: true,
                qty_air: true,
                qty_overpressure: true,
                qty_impulse: true,
                show_stl: true,
                stl_colormap: 'plasma',
                stl_wireframe: false,
                stl_solids: true,
                stl_opacity: 0.5,
                stl_show_results: false,
                stl_quantity: 'pressure',
                stl_sampling_mode: 'nearest',
                stl_auto_scale: true,
                stl_log_scale: false,
                stl_min_val: 101325.0,
                stl_max_val: 1013250.0,
                show_gauges: true,
                gauge_size: 1.0,
                gauge_opacity: 1.0,
                gauge_quantity: 'pressure',
                gauge_solid: true,
                show_obstacles: false,
                obstacles_colormap: 'plasma',
                obstacles_gridlines: true,
                obstacles_solid: true,
                obstacles_lighting: true,
                obstacles_opacity: 1.0,
                obstacles_quantity: 'pressure',
                obstacles_auto_scale: true,
                obstacles_log_scale: false,
                obstacles_interpolate: true,
                obstacles_min_val: 101325.0,
                obstacles_max_val: 101325.0 * 10.0
            },
            'MPMDomain2D': {
                precision: 'single',
                transfer_scheme: 'GIMP',
                velocity_scheme: 'APIC',
                space_time_scheme: 'RK2',
                flip_blend: 0.95,
                ppc: 4,
                cfl: 0.3
            },
            'MPMDomain3D': {
                device: 'cpu',
                precision: 'single',
                transfer_scheme: 'GIMP',
                velocity_scheme: 'APIC',
                space_time_scheme: 'RK2',
                flip_blend: 0.95,
                ppc: 8,
                cfl: 0.3
            },
            'MPMObject2D': {
                shape_type: 'Rectangle',
                pos_x: 0.5,
                pos_y: 0.5,
                size_x: 0.2,
                size_y: 0.2,
                radius: 0.1,
                vel_x: 0.0,
                vel_y: 0.0,
                angular_vel: 0.0
            },
            'MPMObject3D': {
                shape_type: 'Box',
                pos_x: 0.5, pos_y: 0.5, pos_z: 0.5,
                size_x: 0.2, size_y: 0.2, size_z: 0.2,
                radius: 0.1,
                vel_x: 0.0, vel_y: 0.0, vel_z: 0.0,
                angular_vel_x: 0.0, angular_vel_y: 0.0, angular_vel_z: 0.0
            },
            'MPMMaterialSteel': {
                material_model: 'Steel (Hypoelastic)',
                density: 7850.0,
                youngs_modulus: 210.0e9,
                poissons_ratio: 0.3,
                yield_stress: 400.0e6,
                hardening_modulus: 1.0e9,
                failure_strain: 0.25,
                tensile_failure_stress: 600.0e6,
                jc_A: 792.0e6,
                jc_B: 510.0e6,
                jc_n: 0.26,
                jc_C: 0.014,
                jc_m: 1.03,
                T_melt: 1793.0,
                T_room: 293.0,
                Cp: 477.0,
                mg_gamma0: 1.81,
                mg_c0: 4570.0,
                mg_s: 1.49
            },

            'FSICoupler2D': {},
            'FSICoupler3D': {}
        };

        nodes.forEach(node => {
            if (!node.parameters) {
                node.parameters = {};
            }
            if (node.type === 'PrimitiveGeometry3D') {
                const prims = node.parameters.primitives || [];
                prims.forEach((prim: any, idx: number) => {
                    if (prim.name === undefined) {
                        prim.name = `${prim.type.charAt(0).toUpperCase() + prim.type.slice(1)} ${idx + 1}`;
                    }
                    if (prim.subtractive === undefined) {
                        prim.subtractive = false;
                    }
                    if (prim.voxelization_method === undefined) {
                        prim.voxelization_method = 'use_node_default';
                    }
                });
            }
            if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                delete node.parameters['time_step'];
            }
            if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
                delete node.parameters['output_mode'];
                delete node.parameters['output_interval'];
            }
            if (node.type === 'CFDSolver3D') {
                delete node.parameters['stl_file'];
                delete node.parameters['geometry_hash'];
                delete node.parameters['mesh_type'];
                delete node.parameters['amr_max_levels'];
                delete node.parameters['amr_threshold'];
                delete node.parameters['amr_coarsen_ratio'];
                delete node.parameters['amr_tile_size'];
            }
            if (node.type === 'DomainMesh') {
                if (node.parameters['x_min_bc'] !== undefined) {
                    node.parameters['left_bc'] = node.parameters['x_min_bc'];
                    delete node.parameters['x_min_bc'];
                }
                if (node.parameters['x_max_bc'] !== undefined) {
                    node.parameters['right_bc'] = node.parameters['x_max_bc'];
                    delete node.parameters['x_max_bc'];
                }
            }
            if (node.type === 'DomainMesh3D') {
                if (node.parameters['xmin'] === undefined && node.parameters['origin_x'] !== undefined) {
                    const ox = Number(node.parameters['origin_x'] ?? 0.0);
                    const dx = Number(node.parameters['dim_x'] ?? 1.0);
                    node.parameters['xmin'] = ox;
                    node.parameters['xmax'] = ox + dx;
                }
                if (node.parameters['ymin'] === undefined && node.parameters['origin_y'] !== undefined) {
                    const oy = Number(node.parameters['origin_y'] ?? 0.0);
                    const dy = Number(node.parameters['dim_y'] ?? 1.0);
                    node.parameters['ymin'] = oy;
                    node.parameters['ymax'] = oy + dy;
                }
                if (node.parameters['zmin'] === undefined && node.parameters['origin_z'] !== undefined) {
                    const oz = Number(node.parameters['origin_z'] ?? 0.0);
                    const dz = Number(node.parameters['dim_z'] ?? 1.0);
                    node.parameters['zmin'] = oz;
                    node.parameters['zmax'] = oz + dz;
                }
                delete node.parameters['dim_x'];
                delete node.parameters['dim_y'];
                delete node.parameters['dim_z'];
                delete node.parameters['origin_x'];
                delete node.parameters['origin_y'];
                delete node.parameters['origin_z'];
            }
            if (!node.displayMode) {
                node.displayMode = 'expanded';
            }
            // Self-healing: if charge_radius/lx/ly/lz exists but charge_mass is missing, calculate charge_mass first so it doesn't get overwritten by defaults
            if ((node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') && node.parameters['charge_mass'] === undefined) {
                let rho = 1630.0;
                let model: { nodes: Node[], connections: Connection[] } | null = stateObj || null;
                if (!model) {
                    model = Object.values(this.appState.models).find(m => m.nodes.some(n => n.id === node.id)) || null;
                }
                if (model) {
                    const conn = model.connections.find(c => c.toNode === node.id && c.toPort === 'material');
                    const matNode = conn ? model.nodes.find(n => n.id === conn.fromNode) : null;
                    if (matNode && matNode.type === 'Material') {
                        const matType = matNode.parameters?.material_type || 'Air';
                        if (matType === 'Ideal Gas Charge') {
                            rho = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        } else {
                            rho = Number(matNode.parameters?.rho ?? 1630.0);
                        }
                    }
                }
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (shape === 'Sphere') {
                    const radius = Number(node.parameters['charge_radius'] !== undefined ? node.parameters['charge_radius'] : 0.1);
                    node.parameters['charge_mass'] = (4.0 / 3.0) * Math.PI * Math.pow(radius, 3.0) * rho;
                } else if (shape === 'Cylinder') {
                    const radius = Number(node.parameters['charge_radius'] !== undefined ? node.parameters['charge_radius'] : 0.1);
                    const height = Number(node.parameters['charge_height'] !== undefined ? node.parameters['charge_height'] : 0.2);
                    node.parameters['charge_mass'] = Math.PI * radius * radius * height * rho;
                } else if (shape === 'Block') {
                    const lx = Number(node.parameters['charge_lx'] !== undefined ? node.parameters['charge_lx'] : 0.2);
                    const ly = Number(node.parameters['charge_ly'] !== undefined ? node.parameters['charge_ly'] : 0.2);
                    const lz = Number(node.parameters['charge_lz'] !== undefined ? node.parameters['charge_lz'] : 0.2);
                    node.parameters['charge_mass'] = lx * ly * lz * rho;
                }
            }
            const nodeDefaults = defaults[node.type];
            if (nodeDefaults) {
                for (const [key, val] of Object.entries(nodeDefaults)) {
                    if (node.parameters[key] === undefined) {
                        node.parameters[key] = val;
                    }
                }
            }
            // Sync logic
            let model: { nodes: Node[], connections: Connection[] } | null = stateObj || null;
            if (!model) {
                model = Object.values(this.appState.models).find(m => m.nodes.some(n => n.id === node.id)) || null;
            }
            syncExplosiveParameters(node, node.parameters, model);
        });
    }

    importWorkspace(workspace: Workspace, models: Model[]): void {
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        
        models.forEach(model => {
            appStateCopy.models[model.id] = model;
        });

        const existingWsIdx = appStateCopy.workspaces.findIndex(w => w.id === workspace.id);
        if (existingWsIdx !== -1) {
            appStateCopy.workspaces[existingWsIdx] = workspace;
        } else {
            appStateCopy.workspaces.push(workspace);
        }

        appStateCopy.activeWorkspaceId = workspace.id;

        this.loadAppState(appStateCopy);
    }

    getDefaultInputs(type: NodeType): Port[] {
        switch (type) {
            case 'ThePainter': return [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Charge' }];
            case 'CFDSolver': return [{ id: 'in', label: 'Initial State' }];
            case 'TelemetryText': return [
                { id: 'in', label: 'Stream 1' },
                { id: 'in_2', label: 'Stream 2' }
            ];
            case 'TelemetryGraph': return [{ id: 'in', label: 'Data Stream' }];
            case 'CFDSolver2D': return [
                { id: 'mesh', label: 'Mesh' },
                { id: 'detonator', label: 'Detonator' },
                { id: 'explosive', label: 'Charge' },
                { id: 'hardware', label: 'Hardware' },
                { id: 'air', label: 'Air' },
                { id: 'remap', label: 'Remap' }
            ];
            case 'Charge1D':
            case 'Charge2D': return [{ id: 'material', label: 'Material' }];
            case 'RemapNode':
            case 'Remap1DTo2DNode':
            case 'Remap1DTo3DNode': return [{ id: 'in', label: '1D Solver' }];
            case 'Remap2DTo3DNode': return [{ id: 'in', label: '2D Solver' }];
            case 'TelemetryContour': return [
                { id: 'in', label: 'CFD Stream' },
                { id: 'mpm_in', label: 'MPM Stream' }
            ];
            case 'VTKOutput': return [{ id: 'in', label: 'Solver' }];
            case 'VirtualGauges': return [{ id: 'in', label: 'Solver Output' }];
            case 'CFDSolver3D': return [
                { id: 'mesh', label: 'Mesh' },
                { id: 'air', label: 'Air' },
                { id: 'charge', label: 'Charge' },
                { id: 'detonator', label: 'Detonator' },
                { id: 'stl', label: 'STL Geometry' },
                { id: 'gauges', label: 'Gauges' },
                { id: 'remap', label: 'Remap' }
            ];
            case 'RefinementMesh3D': return [{ id: 'parent_mesh', label: 'Parent Mesh' }];
            case 'Charge3D': return [{ id: 'material', label: 'Material' }];
            case 'Telemetry3DViewport': return [{ id: 'in', label: 'Data Stream' }];
            case 'MPMDomain2D': return [{ id: 'mesh', label: 'Grid' }, { id: 'objects', label: 'MPM Objects' }];
            case 'MPMDomain3D': return [{ id: 'mesh', label: 'Grid' }, { id: 'objects', label: 'MPM Objects' }];
            case 'MPMObject2D':
            case 'MPMObject3D': return [{ id: 'material', label: 'Material' }];
            case 'FSICoupler2D': return [{ id: 'cfd', label: 'CFD Solver' }, { id: 'mpm', label: 'MPM Solver' }];
            case 'FSICoupler3D': return [{ id: 'cfd', label: 'CFD Solver 3D' }, { id: 'mpm', label: 'MPM Solver 3D' }];
            default: return [];
        }
    }

    getDefaultOutputs(type: NodeType): Port[] {
        switch (type) {
            case 'DomainMesh': return [{ id: 'out', label: 'Mesh' }];
            case 'Material': return [{ id: 'out', label: 'Material' }];
            case 'Charge1D':
            case 'Charge2D': return [{ id: 'out', label: 'Charge' }];
            case 'ThePainter': return [{ id: 'out', label: 'State' }];
            case 'CFDSolver': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'DomainMesh2D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'DetonatorLocation':
            case 'DetonatorLocation3D': return [{ id: 'detonator', label: 'Detonator Spec' }];
            case 'RemapNode':
            case 'Remap1DTo2DNode':
            case 'Remap1DTo3DNode':
            case 'Remap2DTo3DNode': return [{ id: 'remap', label: 'Remap Spec' }];
            case 'HardwareConfig': return [{ id: 'hardware', label: 'Hardware Spec' }];
            case 'CFDSolver2D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'DomainMesh3D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'RefinementMesh3D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'Charge3D': return [{ id: 'out', label: 'Charge Spec' }];
            case 'CFDSolver3D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'VirtualGauges': return [{ id: 'out', label: 'Gauges Spec' }];
            case 'MPMDomain2D':
            case 'MPMDomain3D': return [{ id: 'telemetry', label: 'Telemetry' }, { id: 'mpm_out', label: 'MPM State' }];
            case 'MPMObject2D':
            case 'MPMObject3D': return [{ id: 'out', label: 'Object Spec' }];
            case 'MPMMaterialSteel': return [{ id: 'out', label: 'Material Spec' }];
            case 'FSICoupler2D':
            case 'FSICoupler3D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'STLGeometry':
            case 'PrimitiveGeometry3D': return [{ id: 'stl', label: 'STL Geometry' }];
            default: return [];
        }
    }
}


function hasPanelType(node: LayoutNode, type: PanelType): boolean {
    if (node.type === 'panel') {
        return node.panelType === type;
    }
    return hasPanelType(node.firstChild, type) || hasPanelType(node.secondChild, type);
}

function ensureMenuBar(node: LayoutNode): LayoutNode {
    if (hasPanelType(node, 'MENU_BAR')) {
        return node;
    }
    
    const traverseAndInsert = (n: LayoutNode): LayoutNode => {
        if (n.type === 'panel') {
            if (n.panelType === 'OUTLINER') {
                return {
                    type: 'split',
                    id: 'split-menu-outliner',
                    direction: 'vertical',
                    ratio: 0.1,
                    firstChild: {
                        type: 'panel',
                        id: 'panel-menu-bar',
                        panelType: 'MENU_BAR',
                        targetNodeId: null
                    },
                    secondChild: n
                };
            }
            return n;
        } else {
            n.firstChild = traverseAndInsert(n.firstChild);
            n.secondChild = traverseAndInsert(n.secondChild);
            return n;
        }
    };
    
    const result = traverseAndInsert(node);
    if (!hasPanelType(result, 'MENU_BAR')) {
        return {
            type: 'split',
            id: 'split-menu-root',
            direction: 'vertical',
            ratio: 0.05,
            firstChild: {
                type: 'panel',
                id: 'panel-menu-bar',
                panelType: 'MENU_BAR',
                targetNodeId: null
            },
            secondChild: result
        };
    }
    return result;
}

const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0],
    solid: [0.0, 1.0],
    overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0]
};

function syncQuantityRanges(node: Node, parameters: Record<string, any>, merged: Record<string, any>) {
    if (node.type !== 'Telemetry3DViewport') return;

    if (!merged.quantity_ranges) {
        merged.quantity_ranges = {
            pressure: [101325.0, 101325.0 * 100.0],
            density: [1.2, 100.0],
            velocity: [0.0, 1000.0],
            energy: [200000.0, 10000000.0],
            species1: [0.0, 1.0],
            species2: [0.0, 1.0],
            species3: [0.0, 1.0],
            solid: [0.0, 1.0],
            overpressure: [0.0, 101325.0 * 99.0],
            impulse: [0.0, 10000.0]
        };
    }

    const slices = merged.slices || [];
    const focusedIdx = merged.focusedSliceIndex !== undefined ? merged.focusedSliceIndex : 0;
    const slice = slices[focusedIdx] || slices[0] || { quantities: ['pressure'] };
    const qty = slice.quantities?.[0] || 'pressure';

    if (parameters.min_val !== undefined || parameters.max_val !== undefined) {
        const currentMin = parameters.min_val !== undefined ? parameters.min_val : merged.min_val;
        const currentMax = parameters.max_val !== undefined ? parameters.max_val : merged.max_val;
        merged.quantity_ranges[qty] = [currentMin, currentMax];
    } else {
        const range = merged.quantity_ranges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
        merged.min_val = range[0];
        merged.max_val = range[1];
    }
}

function constrainAllSlices(model: any): boolean {
    const meshNode = model.nodes.find((n: any) => n.type === 'DomainMesh3D');
    if (!meshNode) return false;

    const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
    const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
    const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
    const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
    const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
    const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

    let totalChanged = false;
    model.nodes.forEach((node: any) => {
        if (node.type === 'Telemetry3DViewport') {
            if (!node.parameters.quantity_ranges) {
                node.parameters.quantity_ranges = {
                    pressure: [101325.0, 101325.0 * 100.0],
                    density: [1.2, 100.0],
                    velocity: [0.0, 1000.0],
                    energy: [200000.0, 10000000.0],
                    species1: [0.0, 1.0],
                    species2: [0.0, 1.0],
                    species3: [0.0, 1.0],
                    solid: [0.0, 1.0]
                };
                totalChanged = true;
            }

            if (node.parameters.slices) {
                let changed = false;
                const slices = node.parameters.slices.map((slice: any) => {
                let minVal = 0.0;
                let maxVal = 1.0;
                if (slice.axis === 'xy') {
                    minVal = zmin;
                    maxVal = zmax;
                } else if (slice.axis === 'xz') {
                    minVal = ymin;
                    maxVal = ymax;
                } else if (slice.axis === 'yz') {
                    minVal = xmin;
                    maxVal = xmax;
                }

                const offset = slice.offset !== undefined ? Number(slice.offset) : (minVal + maxVal) / 2;
                const clamped = Math.max(minVal, Math.min(maxVal, offset));
                if (Math.abs(clamped - offset) > 1e-6) {
                    changed = true;
                    return { ...slice, offset: clamped };
                }
                return slice;
            });

            if (changed) {
                node.parameters.slices = slices;
                totalChanged = true;
            }
        }
    }
});
    return totalChanged;
}

function syncExplosiveParameters(node: Node, parameters: Record<string, any>, state: { nodes: Node[], connections: Connection[] } | null, updatedKey?: string): void {
    if (node.type !== 'Charge1D' && node.type !== 'Charge2D' && node.type !== 'Charge3D') {
        return;
    }

    const shape = parameters['charge_shape'] || 'Sphere';
    
    let rho = 1630.0;
    if (state) {
        const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'material');
        const matNode = conn ? state.nodes.find(n => n.id === conn.fromNode) : null;
        if (matNode && matNode.type === 'Material') {
            const matType = matNode.parameters?.material_type || 'Air';
            if (matType === 'Ideal Gas Charge') {
                rho = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
            } else {
                rho = Number(matNode.parameters?.rho ?? 1630.0);
            }
        }
    }

    const height = Number(parameters['charge_height'] !== undefined ? parameters['charge_height'] : 0.2);
    const radius = Number(parameters['charge_radius'] !== undefined ? parameters['charge_radius'] : 0.1);
    const mass = Number(parameters['charge_mass'] !== undefined ? parameters['charge_mass'] : 0.0);
    const lx = Number(parameters['charge_lx'] !== undefined ? parameters['charge_lx'] : 0.2);
    const ly = Number(parameters['charge_ly'] !== undefined ? parameters['charge_ly'] : 0.2);
    const lz = Number(parameters['charge_lz'] !== undefined ? parameters['charge_lz'] : 0.2);

    if (updatedKey === 'charge_radius' || updatedKey === 'charge_height' || updatedKey === 'charge_lx' || updatedKey === 'charge_ly' || updatedKey === 'charge_lz') {
        if (shape === 'Cylinder') {
            parameters['charge_mass'] = Math.PI * radius * radius * height * rho;
        } else if (shape === 'Block') {
            parameters['charge_mass'] = lx * ly * lz * rho;
        } else {
            parameters['charge_mass'] = (4.0 / 3.0) * Math.PI * Math.pow(radius, 3.0) * rho;
        }
    } else {
        if (mass > 0 && rho > 0) {
            if (shape === 'Cylinder') {
                if (height > 0) {
                    parameters['charge_radius'] = Math.sqrt(mass / (Math.PI * rho * height));
                }
            } else if (shape === 'Block') {
                const currentVolume = lx * ly * lz;
                if (currentVolume > 0) {
                    const targetVolume = mass / rho;
                    const scaleFactor = Math.pow(targetVolume / currentVolume, 1.0 / 3.0);
                    parameters['charge_lx'] = lx * scaleFactor;
                    parameters['charge_ly'] = ly * scaleFactor;
                    parameters['charge_lz'] = lz * scaleFactor;
                } else {
                    const size = Math.pow(mass / rho, 1.0 / 3.0);
                    parameters['charge_lx'] = size;
                    parameters['charge_ly'] = size;
                    parameters['charge_lz'] = size;
                }
            } else {
                parameters['charge_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0 / 3.0);
            }
        }
    }
}

function getConnectedRefinementNodes(rootNodeId: string, state: SimulationState): Node[] {
    const connected: Node[] = [];
    const visited = new Set<string>();

    const traverse = (parentId: string) => {
        if (visited.has(parentId)) return;
        visited.add(parentId);

        const conns = state.connections.filter(c => c.fromNode === parentId);
        for (const conn of conns) {
            const childNode = state.nodes.find(n => n.id === conn.toNode);
            if (childNode && childNode.type === 'RefinementMesh3D' && !visited.has(childNode.id)) {
                connected.push(childNode);
                traverse(childNode.id);
            }
        }
    };

    traverse(rootNodeId);
    return connected;
}

export function calculateRefinementMeshInfo(node: Node, state: SimulationState) {
    const rawSx = Number(node.parameters['submesh_size_x'] ?? 0.5);
    const rawSy = Number(node.parameters['submesh_size_y'] ?? 0.5);
    const rawSz = Number(node.parameters['submesh_size_z'] ?? 0.5);
    const rawX = Number(node.parameters['submesh_x'] ?? 0.25);
    const rawY = Number(node.parameters['submesh_y'] ?? 0.25);
    const rawZ = Number(node.parameters['submesh_z'] ?? 0.25);
    const lvl = Number(node.parameters['refinement_level'] ?? 1);

    let rootMeshNode: Node | null = null;
    let currNode: Node | undefined = node;
    let depth = 0;
    while (currNode && depth < 20) {
        const parentConn = state.connections.find(c => c.toNode === currNode!.id && c.toPort === 'parent_mesh');
        if (!parentConn) break;
        currNode = state.nodes.find(n => n.id === parentConn.fromNode);
        if (currNode && currNode.type === 'DomainMesh3D') {
            rootMeshNode = currNode;
            break;
        }
    }

    if (!rootMeshNode) {
        rootMeshNode = state.nodes.find(n => n.type === 'DomainMesh3D') || null;
    }

    const parentCellSize = Number(rootMeshNode?.parameters['cell_size'] ?? 0.01);
    
    let parentNx = 100, parentNy = 100, parentNz = 100;
    let rootXMin = 0.0, rootYMin = 0.0, rootZMin = 0.0;
    if (rootMeshNode) {
        rootXMin = Number(rootMeshNode.parameters['xmin'] ?? rootMeshNode.parameters['origin_x'] ?? 0.0);
        const xmax = Number(rootMeshNode.parameters['xmax'] ?? (rootXMin + (rootMeshNode.parameters['dim_x'] ?? 1.0)));
        rootYMin = Number(rootMeshNode.parameters['ymin'] ?? rootMeshNode.parameters['origin_y'] ?? 0.0);
        const ymax = Number(rootMeshNode.parameters['ymax'] ?? (rootYMin + (rootMeshNode.parameters['dim_y'] ?? 1.0)));
        rootZMin = Number(rootMeshNode.parameters['zmin'] ?? rootMeshNode.parameters['origin_z'] ?? 0.0);
        const zmax = Number(rootMeshNode.parameters['zmax'] ?? (rootZMin + (rootMeshNode.parameters['dim_z'] ?? 1.0)));
        const dim_x = xmax - rootXMin;
        const dim_y = ymax - rootYMin;
        const dim_z = zmax - rootZMin;
        parentNx = Math.max(1, Math.round(dim_x / parentCellSize));
        parentNy = Math.max(1, Math.round(dim_y / parentCellSize));
        parentNz = Math.max(1, Math.round(dim_z / parentCellSize));
    }
    const parentTotalCells = parentNx * parentNy * parentNz;

    const ix0 = Math.round((rawX - rootXMin) / parentCellSize);
    const ix1 = Math.round((rawX + rawSx - rootXMin) / parentCellSize);
    const sx = Math.max(parentCellSize, (Math.max(ix0 + 1, ix1) - ix0) * parentCellSize);

    const jy0 = Math.round((rawY - rootYMin) / parentCellSize);
    const jy1 = Math.round((rawY + rawSy - rootYMin) / parentCellSize);
    const sy = Math.max(parentCellSize, (Math.max(jy0 + 1, jy1) - jy0) * parentCellSize);

    const kz0 = Math.round((rawZ - rootZMin) / parentCellSize);
    const kz1 = Math.round((rawZ + rawSz - rootZMin) / parentCellSize);
    const sz = Math.max(parentCellSize, (Math.max(kz0 + 1, kz1) - kz0) * parentCellSize);

    const refinedCellSize = parentCellSize / Math.pow(2, lvl);
    const subNx = Math.max(1, Math.round(sx / refinedCellSize));
    const subNy = Math.max(1, Math.round(sy / refinedCellSize));
    const subNz = Math.max(1, Math.round(sz / refinedCellSize));
    const subTotalCells = subNx * subNy * subNz;

    // Sum all subgrids attached in this simulation model / domain tree
    let allSubgridCells = 0;
    if (rootMeshNode) {
        const refNodes = getConnectedRefinementNodes(rootMeshNode.id, state);
        for (const refNode of refNodes) {
            const rsx_raw = Number(refNode.parameters['submesh_size_x'] ?? 0.5);
            const rsy_raw = Number(refNode.parameters['submesh_size_y'] ?? 0.5);
            const rsz_raw = Number(refNode.parameters['submesh_size_z'] ?? 0.5);
            const rx_raw = Number(refNode.parameters['submesh_x'] ?? 0.25);
            const ry_raw = Number(refNode.parameters['submesh_y'] ?? 0.25);
            const rz_raw = Number(refNode.parameters['submesh_z'] ?? 0.25);
            const rlvl = Number(refNode.parameters['refinement_level'] ?? 1);

            const rix0 = Math.round((rx_raw - rootXMin) / parentCellSize);
            const rix1 = Math.round((rx_raw + rsx_raw - rootXMin) / parentCellSize);
            const rsx = Math.max(parentCellSize, (Math.max(rix0 + 1, rix1) - rix0) * parentCellSize);

            const rjy0 = Math.round((ry_raw - rootYMin) / parentCellSize);
            const rjy1 = Math.round((ry_raw + rsy_raw - rootYMin) / parentCellSize);
            const rsy = Math.max(parentCellSize, (Math.max(rjy0 + 1, rjy1) - rjy0) * parentCellSize);

            const rkz0 = Math.round((rz_raw - rootZMin) / parentCellSize);
            const rkz1 = Math.round((rz_raw + rsz_raw - rootZMin) / parentCellSize);
            const rsz = Math.max(parentCellSize, (Math.max(rkz0 + 1, rkz1) - rkz0) * parentCellSize);

            const rCellSize = parentCellSize / Math.pow(2, rlvl);
            const rNx = Math.max(1, Math.round(rsx / rCellSize));
            const rNy = Math.max(1, Math.round(rsy / rCellSize));
            const rNz = Math.max(1, Math.round(rsz / rCellSize));
            allSubgridCells += (rNx * rNy * rNz);
        }
    } else {
        allSubgridCells = subTotalCells;
    }

    const newTotalCells = parentTotalCells + allSubgridCells;

    return {
        subNx, subNy, subNz,
        subTotalCells,
        parentTotalCells,
        allSubgridCells,
        newTotalCells,
        hasParent: !!rootMeshNode
    };
}

export function getMeshDisplayHTML(node: Node, state?: SimulationState): string {
    const cellSize = Number(node.parameters['cell_size'] ?? 0.001);
    if (node.type === 'DomainMesh') {
        const radius = Number(node.parameters['domain_radius'] ?? 1.0);
        const n_cells = Math.round(radius / cellSize);
        return `<div>Calculated Grid: ${n_cells.toLocaleString()} cells</div>`;
    } else if (node.type === 'DomainMesh2D') {
        const max_r = Number(node.parameters['max_r'] ?? 1.0);
        const max_z = Number(node.parameters['max_z'] ?? 1.0);
        const nr = Math.round(max_r / cellSize);
        const nz = Math.round(max_z / cellSize);
        return `<div>Calculated Grid: ${nr} x ${nz} cells (Total: ${(nr * nz).toLocaleString()})</div>`;
    } else if (node.type === 'DomainMesh3D') {
        const xmin = Number(node.parameters['xmin'] ?? node.parameters['origin_x'] ?? 0.0);
        const xmax = Number(node.parameters['xmax'] ?? (xmin + (node.parameters['dim_x'] ?? 1.0)));
        const ymin = Number(node.parameters['ymin'] ?? node.parameters['origin_y'] ?? 0.0);
        const ymax = Number(node.parameters['ymax'] ?? (ymin + (node.parameters['dim_y'] ?? 1.0)));
        const zmin = Number(node.parameters['zmin'] ?? node.parameters['origin_z'] ?? 0.0);
        const zmax = Number(node.parameters['zmax'] ?? (zmin + (node.parameters['dim_z'] ?? 1.0)));

        const dim_x = xmax - xmin;
        const dim_y = ymax - ymin;
        const dim_z = zmax - zmin;
        const nx = Math.round(dim_x / cellSize);
        const ny = Math.round(dim_y / cellSize);
        const nz = Math.round(dim_z / cellSize);
        const currentCells = nx * ny * nz;

        let totalSubgridCells = 0;
        if (state) {
            const refNodes = getConnectedRefinementNodes(node.id, state);
            for (const refNode of refNodes) {
                const stats = calculateRefinementMeshInfo(refNode, state);
                totalSubgridCells += stats.subTotalCells;
            }
        }

        if (totalSubgridCells > 0) {
            return `<div>Calculated Grid: ${nx} x ${ny} x ${nz} (${currentCells.toLocaleString()} cells)</div><div>Total Grid (w/ Subgrids): ${(currentCells + totalSubgridCells).toLocaleString()} cells</div>`;
        } else {
            return `<div>Calculated Grid: ${nx} x ${ny} x ${nz} cells (Total: ${currentCells.toLocaleString()})</div>`;
        }
    } else if (node.type === 'RefinementMesh3D') {
        if (state) {
            const stats = calculateRefinementMeshInfo(node, state);
            return `<div>Refined Region: ${stats.subNx} x ${stats.subNy} x ${stats.subNz} (${stats.subTotalCells.toLocaleString()} cells)</div><div>Total Grid (w/ Parent): ${stats.newTotalCells.toLocaleString()} cells</div>`;
        } else {
            const sx = Number(node.parameters['submesh_size_x'] ?? 0.5);
            const sy = Number(node.parameters['submesh_size_y'] ?? 0.5);
            const sz = Number(node.parameters['submesh_size_z'] ?? 0.5);
            return `<div>SubMesh (${sx}m x ${sy}m x ${sz}m)</div>`;
        }
    }
    return '';
}


