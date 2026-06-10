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

    constructor(initialState?: SimulationState) {
        if (initialState) {
            this.pushState(initialState);
        }
    }

    /**
     * Pushes a new state to the history, discarding any redo history.
     * Performs a deep copy to ensure immutability.
     */
    pushState(newState: SimulationState): void {
        const stateCopy = JSON.parse(JSON.stringify(newState)) as SimulationState;

        // Remove redo history if we are in the middle of history
        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(stateCopy);
        this.currentIndex++;
        // We don't necessarily want to reset status on EVERY state change (like layout changes)
        // But the previous implementation did it. I'll keep it for now but might need to rethink.
        // Actually, if I change layout, simulation shouldn't stop.
        // Let's only set to UNINITIALIZED if nodes or connections changed.
        // For now, I'll stick to previous behavior to be safe, or refine it.
        this.notifyListeners();
    }

    /**
     * Moves back in history.
     */
    undo(): SimulationState | null {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            const state = this.getCurrentState();
            this.notifyListeners();
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
            this.simulationStatus = status;
            this.notifyStatusListeners();
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

    pushTelemetry(nodeIdOrData: any, optionalData?: any): void {
        let nodeId: string | null = null;
        let data: any = null;

        if (typeof nodeIdOrData === 'string') {
            nodeId = nodeIdOrData;
            data = optionalData;
        } else {
            const state = this.getCurrentState();
            if (!state) return;
            const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        }

        if (!nodeId) return;

        if (!(data instanceof ArrayBuffer)) {
            this.telemetryStore.set(nodeId, data);
        }
        this.notifyTelemetryUpdate(nodeId, data);

        const state = this.getCurrentState();
        if (!state) return;

        // Propagate to connected nodes
        const telemetryConnections = state.connections.filter(e => e.fromNode === nodeId);
        telemetryConnections.forEach(connection => {
            const targetNode = state.nodes.find(n => n.id === connection.toNode);
            if (targetNode) {
                if (targetNode.type === 'TelemetryGraph') {
                    // Graphs accept both binary (new) and legacy JSON (compatibility)
                    this.telemetryStore.set(targetNode.id, data);
                    this.notifyTelemetryUpdate(targetNode.id, data);
                } else if (targetNode.type === 'TelemetryText') {
                    let log = this.telemetryStore.get(targetNode.id);
                    if (!Array.isArray(log)) log = [];
                    const logMsg = typeof data === 'string' ? data : JSON.stringify(data);
                    log.push(logMsg);
                    if (log.length > 50) log.shift();
                    this.telemetryStore.set(targetNode.id, log);
                    this.notifyTelemetryUpdate(targetNode.id, log);
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

        // Special case: don't close the last panel
        if (state.layout.type === 'panel') return;

        const findAndClose = (node: LayoutNode, parent: SplitNode | null): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                // This shouldn't be called directly on the panel if we handle it in the parent split
                return node;
            }
            if (node.type === 'split') {
                if (node.firstChild.type === 'panel' && node.firstChild.id === panelId) {
                    return node.secondChild;
                }
                if (node.secondChild.type === 'panel' && node.secondChild.id === panelId) {
                    return node.firstChild;
                }
                node.firstChild = findAndClose(node.firstChild, node);
                node.secondChild = findAndClose(node.secondChild, node);
            }
            return node;
        };

        state.layout = findAndClose(state.layout, null);
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
        // Using updateState(state, false) for smooth resizing if needed,
        // but setPanelRatio usually happens on mousemove.
        // Actually, let's use updateState with false to avoid spamming history.
        this.updateState(state, false);
    }

    // Finalize ratio change into history
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
}
