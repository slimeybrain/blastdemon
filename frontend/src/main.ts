import { StateManager } from './state-manager';
import { SimulationState } from './types';

console.log("BlastDaemon SSOT Initializing...");

const initialState: SimulationState = {
    nodes: [
        { id: '1', type: 'Domain1D', x: 0, y: 0, parameters: { size: 100 } }
    ],
    edges: []
};

const stateManager = new StateManager(initialState);
console.log("Initial state pushed.");

const secondState: SimulationState = {
    nodes: [
        { id: '1', type: 'Domain1D', x: 0, y: 0, parameters: { size: 100 } },
        { id: '2', type: 'InitialCondition', x: 10, y: 10, parameters: { value: 0.5 } }
    ],
    edges: [
        { fromNode: '1', fromPort: 'out', toNode: '2', toPort: 'in' }
    ]
};

stateManager.pushState(secondState);
console.log("Second state pushed.");

console.log("Current state nodes count:", stateManager.getCurrentState()?.nodes.length); // Should be 2

stateManager.undo();
console.log("Undo performed.");
console.log("Current state nodes count after undo:", stateManager.getCurrentState()?.nodes.length); // Should be 1

stateManager.redo();
console.log("Redo performed.");
console.log("Current state nodes count after redo:", stateManager.getCurrentState()?.nodes.length); // Should be 2

console.log("SSOT Verification complete.");
