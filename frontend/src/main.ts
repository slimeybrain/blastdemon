import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { NetworkManager } from './network.js';
import { serializeSimulationState } from './serialization.js';

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

// Initialize Networking
const networkManager = new NetworkManager('ws://localhost:8080');
networkManager.connect().then(() => {
    console.log("Network connected, sending initial state...");
    const state = stateManager.getCurrentState();
    if (state) {
        const payload = serializeSimulationState(state);
        console.log("Payload to send:", payload);
        networkManager.send(payload);
        console.log("Initial state sent to BlastDaemon.");
    }
}).catch(err => {
    console.error("Failed to connect to BlastDaemon:", err);
});

console.log("SSOT Verification complete.");
