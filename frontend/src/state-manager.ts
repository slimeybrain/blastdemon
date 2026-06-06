import { SimulationState } from './types.js';

export class StateManager {
    private history: SimulationState[] = [];
    private currentIndex: number = -1;

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
    }

    /**
     * Moves back in history.
     */
    undo(): SimulationState | null {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            return this.getCurrentState();
        }
        return null;
    }

    /**
     * Moves forward in history.
     */
    redo(): SimulationState | null {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            return this.getCurrentState();
        }
        return null;
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
}
