import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver } from './serialization.js';
import { LayoutManager } from './layout-manager.js';

// Extend HTMLCanvasElement for TypeScript if it's missing transferControlToOffscreen
interface TransferableCanvas extends HTMLCanvasElement {
    transferControlToOffscreen(): any;
}

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

// Telemetry Worker Initialization
const telemetryCanvas = document.getElementById('telemetry-canvas') as TransferableCanvas;
const telemetryContainer = document.getElementById('telemetry-container') as HTMLElement;

let chartWorker: Worker | null = null;

if (telemetryCanvas && telemetryContainer) {
    // Transfer control to OffscreenCanvas
    const offscreen = telemetryCanvas.transferControlToOffscreen();

    // Create worker using standard ES6 module
    chartWorker = new Worker(new URL('./ChartWorker.js', import.meta.url), { type: 'module' });

    chartWorker.postMessage({
        type: 'init',
        canvas: offscreen
    }, [offscreen] as any);

    console.log("Telemetry ChartWorker initialized.");
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
        } else if (entry.target === telemetryContainer && telemetryCanvas && chartWorker) {
            // Send resize message to worker
            chartWorker.postMessage({
                type: 'resize',
                width: entry.contentRect.width,
                height: entry.contentRect.height
            });
        }
    }
});

if (canvasContainer) resizeObserver.observe(canvasContainer);
if (telemetryContainer) resizeObserver.observe(telemetryContainer);

// Initialize Networking
const networkManager = new NetworkManager('ws://localhost:8080');

networkManager.onMessage((data) => {
    if (chartWorker) {
        chartWorker.postMessage({
            type: 'data',
            telemetry: data
        });
    }
});

networkManager.onOpen(() => {
    console.log("Network connected, sending initial state...");
    const state = stateManager.getCurrentState();
    if (state) {
        const payload = serializeSimulationState(state);
        networkManager.send(payload);
        console.log("Initial state sent to BlastDaemon.");
    }
});

// Run Simulation Button
const runBtn = document.getElementById('run-simulation-btn');
if (runBtn) {
    runBtn.addEventListener('click', () => {
        networkManager.log('[System] Sending simulation config to Broker...', 'system');
        const state = stateManager.getCurrentState();
        if (state) {
            const payload = serializeForSolver(state);
            networkManager.send(payload);
        }
    });
}

console.log("Workspace ready.");
