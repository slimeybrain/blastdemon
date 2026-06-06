import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { CanvasRenderer } from './canvas-renderer.js';

console.log("BlastDaemon SSOT Initializing...");

const initialState: SimulationState = {
    nodes: [
        { id: '1', type: 'Domain1D', x: 50, y: 50, parameters: { size: 100 } },
        { id: '2', type: 'InitialCondition', x: 300, y: 50, parameters: { value: 0.5 } }
    ],
    edges: [
        { fromNode: '1', fromPort: 'out', toNode: '2', toPort: 'in' }
    ]
};

const stateManager = new StateManager(initialState);
const canvas = document.getElementById('simulation-canvas') as HTMLCanvasElement;

if (canvas) {
    const renderer = new CanvasRenderer(canvas, stateManager);
    renderer.render();
    console.log("CanvasRenderer initialized and initial state rendered.");
} else {
    console.error("Could not find simulation-canvas element.");
}

console.log("SSOT Verification complete.");
