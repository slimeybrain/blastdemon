import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { NetworkManager } from './network.js';
import { serializeSimulationState } from './serialization.js';
import { TelemetryRenderer } from './telemetry-renderer.js';
import { LayoutManager } from './layout-manager.js';

console.log("BlastDaemon Workspace Initializing...");

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

// Initialize Layout Manager
const layoutManager = new LayoutManager('app-container');
layoutManager.init();

// Expose for debugging/testing
(window as any).layoutManager = layoutManager;

const canvas = document.getElementById('simulation-canvas') as HTMLCanvasElement;
const canvasContainer = document.getElementById('canvas-container') as HTMLElement;

let renderer: CanvasRenderer | null = null;
if (canvas && canvasContainer) {
    renderer = new CanvasRenderer(canvas, stateManager);
    console.log("CanvasRenderer initialized.");
} else {
    console.error("Could not find simulation-canvas or container.");
}

const telemetryCanvas = document.getElementById('telemetry-canvas') as HTMLCanvasElement;
const telemetryContainer = document.getElementById('telemetry-container') as HTMLElement;
let telemetryRenderer: TelemetryRenderer | null = null;
if (telemetryCanvas && telemetryContainer) {
    telemetryRenderer = new TelemetryRenderer(telemetryCanvas);
    console.log("TelemetryRenderer initialized.");
}

// Outliner Population
const outliner = document.getElementById('outliner');
if (outliner) {
    const updateOutliner = (state: SimulationState) => {
        outliner.innerHTML = '';
        state.nodes.forEach(node => {
            const li = document.createElement('li');
            li.textContent = `${node.type} (${node.id})`;
            outliner.appendChild(li);
        });
    };
    stateManager.onStateChange(updateOutliner);
    updateOutliner(initialState);
}

// Resize Observer
const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
        if (entry.target === canvasContainer && canvas && renderer) {
            canvas.width = entry.contentRect.width;
            canvas.height = entry.contentRect.height;
            renderer.render();
        } else if (entry.target === telemetryContainer && telemetryCanvas && telemetryRenderer) {
            telemetryCanvas.width = entry.contentRect.width;
            telemetryCanvas.height = entry.contentRect.height;
            // Telemetry might need a re-draw if it has data
        }
    }
});

if (canvasContainer) resizeObserver.observe(canvasContainer);
if (telemetryContainer) resizeObserver.observe(telemetryContainer);

// Initialize Networking
const networkManager = new NetworkManager('ws://localhost:8080');

if (telemetryRenderer) {
    networkManager.onMessage((data) => {
        telemetryRenderer!.handleMessage(data);
    });
}

networkManager.connect().then(() => {
    console.log("Network connected, sending initial state...");
    const state = stateManager.getCurrentState();
    if (state) {
        const payload = serializeSimulationState(state);
        networkManager.send(payload);
        console.log("Initial state sent to BlastDaemon.");
    }
}).catch(err => {
    console.error("Failed to connect to BlastDaemon:", err);
});

console.log("Workspace ready.");
