import { SimulationState, SimulationStatus } from './types.js';

export class StateManager {
    private history: SimulationState[] = [];
    private currentIndex: number = -1;
    private listeners: ((state: SimulationState) => void)[] = [];
    private simulationStatus: SimulationStatus = 'UNINITIALIZED';
    private statusListeners: ((status: SimulationStatus) => void)[] = [];
    private pendingSteps: number = 0;

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
        this.setStatus('UNINITIALIZED');
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
            // For dragging, we update the reference directly to avoid cloning overhead
            if (this.currentIndex === -1) {
                this.history.push(state);
                this.currentIndex = 0;
            } else {
                this.history[this.currentIndex] = state;
            }
            this.setStatus('UNINITIALIZED');
            this.notifyListeners();
        }
    }

    /**
     * Gets the current active state.
     */
    getCurrentState(): SimulationState | null {
        if (this.currentIndex >= 0 && this.currentIndex < this.history.length) {
            // Return a copy to prevent accidental mutations of the history entry
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
            this.pushState(state);
        }
    }

    /**
     * Registers a listener to be called when the state changes.
     */
    onStateChange(listener: (state: SimulationState) => void): void {
        this.listeners.push(listener);
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

    pushTelemetry(data: any): void {
        const state = this.getCurrentState();
        if (!state) return;

        const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
        if (!solverNode) return;

        solverNode.latestTelemetry = data;

        // Propagate to connected nodes
        const telemetryEdges = state.edges.filter(e => e.fromNode === solverNode.id && e.fromPort === 'telemetry');
        telemetryEdges.forEach(edge => {
            const targetNode = state.nodes.find(n => n.id === edge.toNode);
            if (targetNode) {
                if (targetNode.type === 'TelemetryGraph') {
                    targetNode.latestTelemetry = data;
                } else if (targetNode.type === 'TelemetryText') {
                    if (!targetNode.latestLog) targetNode.latestLog = [];
                    const logMsg = typeof data === 'string' ? data : JSON.stringify(data);
                    targetNode.latestLog.push(logMsg);
                    if (targetNode.latestLog.length > 50) targetNode.latestLog.shift();
                }
            }
        });

        this.updateState(state, false);
    }

    private notifyListeners(): void {
        const currentState = this.getCurrentState();
        if (currentState) {
            this.listeners.forEach(listener => listener(currentState));
        }
    }
}
