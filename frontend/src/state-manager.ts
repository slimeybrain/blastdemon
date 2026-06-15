import { SimulationState, SimulationStatus, LayoutNode, PanelNode, SplitNode, LayoutDirection, PanelType } from './types.js';

export class StateManager {
    private history: SimulationState[] = [];
    private currentIndex: number = -1;
    private listeners: ((state: SimulationState) => void)[] = [];
    private simulationStatus: SimulationStatus = 'UNINITIALIZED';
    private statusListeners: ((status: SimulationStatus) => void)[] = [];
    private pendingSteps: number = 0;
    private telemetryStore: Map<string, any> = new Map();
    private telemetryListeners: ((nodeId: string, data: any) => void)[] = [];
    public selectedNodeId: string | null = null;
    private selectionListeners: ((nodeId: string | null) => void)[] = [];

    public workspaces: SimulationState[] = [];
    public activeWorkspaceIndex: number = 0;

    constructor(initialState?: SimulationState) {
        if (initialState) {
            this.workspaces = [initialState];
            this.pushState(initialState, false); // Don't save on initial push to avoid overwrite during load
        }
    }

    switchWorkspace(index: number) {
        if (index >= 0 && index < this.workspaces.length) {
            this.activeWorkspaceIndex = index;
            this.history = [JSON.parse(JSON.stringify(this.workspaces[index]))];
            this.currentIndex = 0;
            this.notifyListeners();
        }
    }

    createWorkspace() {
        this.workspaces.push(JSON.parse(JSON.stringify(this.workspaces[this.activeWorkspaceIndex])));
        this.switchWorkspace(this.workspaces.length - 1);
        this.saveWorkspace();
    }

    /**
     * Pushes a new state to the history, discarding any redo history.
     * Performs a deep copy to ensure immutability.
     */
    pushState(newState: SimulationState, autoSave: boolean = true): void {
        const stateCopy = JSON.parse(JSON.stringify(newState)) as SimulationState;
        stateCopy.layout = ensureMenuBar(stateCopy.layout);

        // Remove redo history if we are in the middle of history
        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(stateCopy);
        this.currentIndex++;

        if (this.workspaces.length > 0) {
            this.workspaces[this.activeWorkspaceIndex] = JSON.parse(JSON.stringify(stateCopy));
        }

        this.notifyListeners();
        if (autoSave) this.saveWorkspace();
    }

    /**
     * Moves back in history.
     */
    undo(): SimulationState | null {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            const state = this.getCurrentState();
            this.notifyListeners();
            this.saveWorkspace();
            return state;
        }
        return null;
    }

    /**
     * Moves forward in history.
     */
    redo(): SimulationState | null {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            const state = this.getCurrentState();
            this.notifyListeners();
            this.saveWorkspace();
            return state;
        }
        return null;
    }

    /**
     * Updates the current state. If pushToHistory is true, it acts like pushState.
     * If false, it updates the current history entry in place and notifies listeners.
     */
    updateState(state: SimulationState, pushToHistory: boolean = true): void {
        if (pushToHistory) {
            this.pushState(state);
        } else {
            if (this.currentIndex === -1) {
                this.history.push(state);
                this.currentIndex = 0;
            } else {
                this.history[this.currentIndex] = state;
            }
            this.notifyListeners();
            this.saveWorkspace();
        }
    }

    /**
     * Gets the current active state.
     */
    getCurrentState(): SimulationState | null {
        if (this.currentIndex >= 0 && this.currentIndex < this.history.length) {
            return JSON.parse(JSON.stringify(this.history[this.currentIndex]));
        }
        return null;
    }

    getHistoryLength(): number {
        return this.history.length;
    }

    getCurrentIndex(): number {
        return this.currentIndex;
    }

    /**
     * Updates parameters for a specific node and pushes a new state.
     */
    updateNodeParameters(nodeId: string, parameters: Record<string, any>): void {
        const state = this.getCurrentState();
        if (!state) return;

        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
            node.parameters = { ...node.parameters, ...parameters };
            this.setStatus('UNINITIALIZED');
            this.pushState(state);
        }
    }

    updateNodeParametersInPlace(nodeId: string, parameters: Record<string, any>): void {
        const state = this.getCurrentState();
        if (!state) return;

        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
            node.parameters = { ...node.parameters, ...parameters };
            this.updateState(state, false);
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
                // Clear explicit dimensions to allow node to resize to its natural content size
                delete node.width;
                delete node.height;
            }

            this.pushState(state);
        }
    }

    /**
     * Registers a listener to be called when the state changes.
     */
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
            // It's a raw log message for the solver
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

        // Filter repetitive data for TelemetryText
        if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'resource_pulse')) {
            // Only allow progress/resource data for specific consumers, usually TelemetryText doesn't want them repeated if it already shows status
            // Actually, let's just make it not store progress/resource pulses in the TelemetryText log history.
        }

        const targetNode = state.nodes.find(n => n.id === nodeId);
        let telemetryToStore = data;
        if (targetNode?.type === 'TelemetryText' && !(data instanceof ArrayBuffer)) {
            // Avoid logging progress/resource pulse in text logs
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

        // Propagate to connected nodes
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
                    // Filter repetitive progress/resource messages in connected LOG nodes
                    if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'resource_pulse')) {
                        return;
                    }

                    let log = this.telemetryStore.get(connectedNode.id);
                    if (!Array.isArray(log)) log = [];

                    const formattedMsg = this.formatTelemetry(data);
                    // Avoid duplicate consecutive messages (e.g. "Paused... waiting")
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

        if (panelId === 'panel-menu-bar') return; // Cannot close menu bar!

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
        if (this.workspaces.length > 0) {
            localStorage.setItem('blast_workspace', JSON.stringify({
                workspaces: this.workspaces,
                activeIndex: this.activeWorkspaceIndex
            }));
        }
    }

    loadWorkspace(initialFallback?: SimulationState): SimulationState | null {
        try {
            const saved = localStorage.getItem('blast_workspace');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.workspaces) {
                    this.workspaces = parsed.workspaces;
                    this.activeWorkspaceIndex = parsed.activeIndex || 0;
                    const state = this.workspaces[this.activeWorkspaceIndex];
                    state.layout = ensureMenuBar(state.layout);
                    this.history = [JSON.parse(JSON.stringify(state))];
                    this.currentIndex = 0;
                    this.notifyListeners();
                    console.log('[System] Workspace hydrated successfully.');
                    return state;
                } else {
                    const state = parsed as SimulationState;
                    state.layout = ensureMenuBar(state.layout);
                    this.workspaces = [state];
                    this.activeWorkspaceIndex = 0;
                    this.history = [state];
                    this.currentIndex = 0;
                    this.notifyListeners();
                    console.log('[System] Legacy Workspace hydrated successfully.');
                    return state;
                }
            }
        } catch (e) {
            console.error('[System] Workspace hydration failed:', e);
        }

        if (initialFallback) {
            this.workspaces = [initialFallback];
            this.activeWorkspaceIndex = 0;
            this.history = [initialFallback];
            this.currentIndex = 0;
            this.notifyListeners();
            return initialFallback;
        }
        return null;
    }

    clearWorkspace(): void {
        localStorage.removeItem('blast_workspace');
        console.log('[System] Local workspace cleared.');
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
