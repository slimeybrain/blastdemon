import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { GraphRenderer } from './graph-renderer.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver } from './serialization.js';
import { LayoutManager } from './layout-manager.js';
import { PropertyEditor } from './property-editor.js';

// Extend HTMLCanvasElement for TypeScript if it's missing transferControlToOffscreen
interface TransferableCanvas extends HTMLCanvasElement {
    transferControlToOffscreen(): any;
}

console.log("BlastDaemon Workspace Initializing...");

const initialState: SimulationState = {
    nodes: [
        {
            id: 'node-mesh',
            type: 'DomainMesh',
            x: 50,
            y: 50,
            inputs: [],
            outputs: [{ id: 'out', label: 'Mesh' }],
            parameters: {
                domain_radius: 1.0,
                cell_size: 0.001,
                left_bc: 'Reflecting',
                right_bc: 'Terminate'
            }
        },
        {
            id: 'node-air',
            type: 'MaterialAir',
            x: 50,
            y: 200,
            inputs: [],
            outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                atm_pressure: 101325,
                atm_temperature: 298.15
            }
        },
        {
            id: 'node-explosive',
            type: 'MaterialExplosive',
            x: 50,
            y: 350,
            inputs: [],
            outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                charge_mass: 1.0,
                composition: 'TNT',
                rho: 1630,
                detonation_energy: 4520000,
                jwl_A: 3.7377e11,
                jwl_B: 3.7471e9,
                jwl_R1: 4.15,
                jwl_R2: 0.9,
                jwl_omega: 0.35
            }
        },
        {
            id: 'node-painter',
            type: 'ThePainter',
            x: 300,
            y: 200,
            inputs: [
                { id: 'mesh', label: 'Mesh' },
                { id: 'air', label: 'Air' },
                { id: 'explosive', label: 'Explosive' }
            ],
            outputs: [{ id: 'out', label: 'State' }],
            parameters: {}
        },
        {
            id: 'node-solver',
            type: 'CFDSolver',
            x: 550,
            y: 200,
            inputs: [{ id: 'in', label: 'Initial State' }],
            outputs: [],
            parameters: {
                cfl: 0.4,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                output_mode: 'By Time',
                output_interval: 0.0001
            }
        }
    ],
    edges: [
        { fromNode: 'node-mesh', fromPort: 'out', toNode: 'node-painter', toPort: 'mesh' },
        { fromNode: 'node-air', fromPort: 'out', toNode: 'node-painter', toPort: 'air' },
        { fromNode: 'node-explosive', fromPort: 'out', toNode: 'node-painter', toPort: 'explosive' },
        { fromNode: 'node-painter', fromPort: 'out', toNode: 'node-solver', toPort: 'in' }
    ]
};

const stateManager = new StateManager(initialState);

// Initialize Property Editor
const propertyEditor = new PropertyEditor('property-editor-container', stateManager);

// Initialize Layout Manager
const layoutManager = new LayoutManager('app-container');
layoutManager.init();

// Expose for debugging/testing
(window as any).layoutManager = layoutManager;

const viewport = document.getElementById('graph-viewport') as HTMLElement;
const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
const edgeSvg = document.getElementById('edge-svg') as unknown as SVGSVGElement;

let renderer: GraphRenderer | null = null;
if (viewport && canvasContainer && edgeSvg) {
    renderer = new GraphRenderer(viewport, canvasContainer, edgeSvg, stateManager);
    renderer.onNodeSelected = (nodeId) => {
        propertyEditor.setSelectedNode(nodeId);
    };
    console.log("GraphRenderer initialized.");
} else {
    console.error("Could not find graph viewport components.");
}

// Telemetry Worker Initialization
const telemetryCanvas = document.getElementById('telemetry-canvas') as TransferableCanvas;
const telemetryContainer = document.getElementById('telemetry-container') as HTMLElement;

let chartWorker: Worker | null = null;

if (telemetryCanvas && telemetryContainer) {
    // Transfer control to OffscreenCanvas
    const offscreen = telemetryCanvas.transferControlToOffscreen();

    // Create worker using standard ES6 module
    chartWorker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });

    chartWorker.postMessage({
        type: 'init',
        canvas: offscreen
    }, [offscreen] as any);

    console.log("Telemetry ChartWorker initialized.");
}

// Initialize Networking
const networkManager = new NetworkManager('ws://localhost:8080');
if (chartWorker) {
    networkManager.setWorker(chartWorker);
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


networkManager.onOpen(() => {
    console.log("Network connected, sending initial state...");
    const state = stateManager.getCurrentState();
    if (state) {
        const payload = serializeSimulationState(state);
        networkManager.send(payload);
        console.log("Initial state sent to BlastDaemon.");
    }
});

// Auto-Arrange Button
const autoArrangeBtn = document.getElementById('auto-arrange-btn');
if (autoArrangeBtn && renderer) {
    autoArrangeBtn.addEventListener('click', () => {
        renderer?.autoArrange();
    });
}

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
