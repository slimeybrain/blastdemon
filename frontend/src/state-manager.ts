import { SimulationState, SimulationStatus, LayoutNode, PanelNode, SplitNode, LayoutDirection, PanelType, Model, Workspace, AppState, Node, Connection } from './types.js';

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

    // Run target selection (either a model ID or 'all' for merged)
    private runTargetId: string | 'all' = 'all';
    private runTargetListeners: ((targetId: string | 'all') => void)[] = [];

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

    // Run target management
    getRunTarget(): string | 'all' {
        return this.runTargetId;
    }

    setRunTarget(targetId: string | 'all'): void {
        this.runTargetId = targetId;
        this.runTargetListeners.forEach(l => l(targetId));
    }

    onRunTargetChange(listener: (targetId: string | 'all') => void): void {
        this.runTargetListeners.push(listener);
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
            // Reset run target if model not present
            if (this.runTargetId !== 'all' && !targetWorkspace.modelIds.includes(this.runTargetId)) {
                this.runTargetId = 'all';
            }
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
        
        // Ensure menu bar exists on all layouts
        stateCopy.workspaces.forEach(ws => {
            ws.layout = ensureMenuBar(ws.layout);
            ws.modelIds = Array.from(new Set(ws.modelIds));
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

        // Clear existing nodes in the workspace models so we can rebuild
        modelsInWs.forEach(model => {
            model.nodes = [];
            model.connections = [];
        });
        ws.connections = [];

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
                // Internal connection
                appStateCopy.models[fromModelId].connections.push(conn);
            } else {
                // Cross-model connection
                ws.connections.push(conn);
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
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        let found = false;
        
        for (const model of Object.values(appStateCopy.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                node.parameters = { ...node.parameters, ...parameters };
                found = true;
                break;
            }
        }

        if (found) {
            this.setStatus('UNINITIALIZED');
            this.pushAppState(appStateCopy);
        }
    }

    updateNodeParametersInPlace(nodeId: string, parameters: Record<string, any>): void {
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        let found = false;
        
        for (const model of Object.values(appStateCopy.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                node.parameters = { ...node.parameters, ...parameters };
                found = true;
                break;
            }
        }

        if (found) {
            this.appState = appStateCopy;
            this.notifyListeners();
        }
    }

    toggleNodeDisplayMode(nodeId: string): void {
        const state = this.getCurrentState();
        if (!state) return;

        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
            const modes: ('compact' | 'normal' | 'expanded')[] = ['normal', 'expanded', 'compact'];
            const currentMode = (node.displayMode === 'full-panel' ? 'expanded' : node.displayMode) || 'normal';
            const nextIndex = (modes.indexOf(currentMode) + 1) % modes.length;
            const nextMode = modes[nextIndex];
            node.displayMode = nextMode;

            if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph') {
                if (nextMode === 'compact') {
                    node.width = 180;
                    node.height = 40;
                } else if (nextMode === 'normal') {
                    node.width = 250;
                    node.height = node.type === 'TelemetryGraph' ? 150 : 130;
                } else if (nextMode === 'expanded') {
                    node.width = 350;
                    node.height = 220;
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
            if (data.type === 'progress' || data.command === 'PROGRESS') {
                const percent = data.percent !== undefined ? data.percent : (data.value || 0);
                return `[${timestamp}] [PROGRESS] ${percent}% complete`;
            }
            if (data.type === 'TELEMETRY') {
                return `[${timestamp}] [SOLVER] Time: ${data.time?.toExponential(6) || '0'}, Terminated: ${data.is_terminated || false}`;
            }
            if (data.type === 'resource_pulse') {
                return `[${timestamp}] [RESOURCES] CPU: ${data.metrics?.cpu?.toFixed(1)}%, RAM: ${data.metrics?.ram?.toFixed(1)}%`;
            }
            return `[${timestamp}] [JSON] ${JSON.stringify(data, null, 2)}`;
        }

        return `[${timestamp}] [DATA] ${String(data)}`;
    }

    pushTelemetry(nodeIdOrData: any, optionalData?: any): void {
        let nodeId: string | null = null;
        let data: any = null;

        const state = this.getCurrentState();
        if (!state) return;

        if (typeof nodeIdOrData === 'string' && optionalData !== undefined) {
            nodeId = nodeIdOrData;
            data = optionalData;
        } else if (typeof nodeIdOrData === 'string') {
            const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        } else {
            const solverNode = state.nodes.find(n => n.id === 'node-solver') || state.nodes.find(n => n.type === 'CFDSolver');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        }

        if (!nodeId) return;

        const targetNode = state.nodes.find(n => n.id === nodeId);
        let telemetryToStore = data;
        if (targetNode?.type === 'TelemetryText' && !(data instanceof ArrayBuffer)) {
            if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'resource_pulse')) {
                 // Skip
            } else {
                let log = this.telemetryStore.get(nodeId);
                if (!Array.isArray(log)) log = [];
                log.push(this.formatTelemetry(data));
                if (log.length > 100) log.shift();
                telemetryToStore = log;
            }
        }

        if (!(data instanceof ArrayBuffer)) {
            this.telemetryStore.set(nodeId, telemetryToStore);
        }
        this.notifyTelemetryUpdate(nodeId, telemetryToStore);

        const telemetryConnections = state.connections.filter(e => e.fromNode === nodeId);
        telemetryConnections.forEach(connection => {
            const connectedNode = state.nodes.find(n => n.id === connection.toNode);
            if (connectedNode) {
                if (connectedNode.type === 'TelemetryGraph') {
                    if (data instanceof ArrayBuffer || (data && data.type === 'TELEMETRY')) {
                         this.telemetryStore.set(connectedNode.id, data);
                         this.notifyTelemetryUpdate(connectedNode.id, data);
                    }
                } else if (connectedNode.type === 'TelemetryText') {
                    if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'resource_pulse')) {
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
        this.pushAppState(newAppState);
    }

    clearWorkspace(): void {
        localStorage.removeItem('blast_app_state');
        localStorage.removeItem('blast_workspace');
        console.log('[System] Local workspace and AppState cleared.');
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
