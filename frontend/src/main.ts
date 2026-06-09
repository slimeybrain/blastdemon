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

// Execution Transport Bar Logic
let playInterval: number | null = null;

const statusBadge = document.getElementById('status-badge');
const initBtn = document.getElementById('init-btn') as HTMLButtonElement;
const exec1Btn = document.getElementById('exec-1-btn') as HTMLButtonElement;
const exec10Btn = document.getElementById('exec-10-btn') as HTMLButtonElement;
const exec100Btn = document.getElementById('exec-100-btn') as HTMLButtonElement;
const exec1000Btn = document.getElementById('exec-1000-btn') as HTMLButtonElement;
const execEndBtn = document.getElementById('exec-end-btn') as HTMLButtonElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const terminateBtn = document.getElementById('terminate-btn') as HTMLButtonElement;

function updateTransportUI(status: string) {
    if (statusBadge) {
        statusBadge.textContent = status;
        statusBadge.className = `status-badge badge-${status.toLowerCase()}`;
    }

    const isLive = (status === 'INITIALIZED' || status === 'PAUSED');
    const isRunning = (status === 'RUNNING');
    const canExec = (status === 'INITIALIZED' || status === 'RUNNING' || status === 'PAUSED');

    if (exec1Btn) exec1Btn.disabled = !canExec;
    if (exec10Btn) exec10Btn.disabled = !canExec;
    if (exec100Btn) exec100Btn.disabled = !canExec;
    if (exec1000Btn) exec1000Btn.disabled = !canExec;
    if (execEndBtn) execEndBtn.disabled = !canExec;
    if (playBtn) playBtn.disabled = !isLive;
    if (pauseBtn) pauseBtn.disabled = !isRunning;
}

stateManager.onStatusChange((status) => {
    updateTransportUI(status);
});

// Initial UI sync
updateTransportUI(stateManager.getStatus());

if (initBtn) {
    initBtn.addEventListener('click', () => {
        networkManager.log('[System] Initializing simulation engine...', 'system');
        const state = stateManager.getCurrentState();
        if (state) {
            const payload = serializeForSolver(state, "INIT");
            networkManager.send(payload);
            stateManager.setStatus('INITIALIZED');
        }
    });
}

if (exec1Btn) {
    exec1Btn.addEventListener('click', () => {
        stateManager.addPendingSteps(1);
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    });
}

if (exec10Btn) {
    exec10Btn.addEventListener('click', () => {
        stateManager.addPendingSteps(10);
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    });
}

if (exec100Btn) {
    exec100Btn.addEventListener('click', () => {
        stateManager.addPendingSteps(100);
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    });
}

if (exec1000Btn) {
    exec1000Btn.addEventListener('click', () => {
        stateManager.addPendingSteps(1000);
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    });
}

if (execEndBtn) {
    execEndBtn.addEventListener('click', () => {
        networkManager.log('[System] Executing until termination boundary...', 'system');
        stateManager.clearPendingSteps();
        networkManager.send({ command: "EXEC_END" });
        stateManager.setStatus('RUNNING');
    });
}

if (playBtn) {
    playBtn.addEventListener('click', () => {
        if (playInterval) return;
        networkManager.log('[System] Playback started', 'success');
        stateManager.setStatus('RUNNING');
        // Now that backend is async, we can just send a large number of steps or
        // keep the interval but it might be better to just let the backend run.
        // For 'Play', we'll send a large step count.
        networkManager.send({ command: "STEP", steps: 10000 });
    });
}

if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
        if (playInterval) {
            clearInterval(playInterval);
            playInterval = null;
        }
        stateManager.clearPendingSteps();
        networkManager.send({ command: "PAUSE" });
        stateManager.setStatus('PAUSED');
        networkManager.log('[System] Playback paused', 'system');
    });
}

if (terminateBtn) {
    terminateBtn.addEventListener('click', () => {
        if (playInterval) {
            clearInterval(playInterval);
            playInterval = null;
        }
        stateManager.clearPendingSteps();
        networkManager.log('[System] Terminating solver...', 'error');
        networkManager.send({ command: "TERMINATE" });
        stateManager.setStatus('TERMINATED');
    });
}

// Global WebSocket listener for telemetry and progress
const progressBar = document.getElementById('progress-bar') as HTMLElement;

networkManager.onMessage((dataString) => {
    try {
        const data = JSON.parse(dataString);

        if (data.type === 'progress') {
            if (progressBar) {
                progressBar.style.width = `${data.percent}%`;
            }
        }

        if (data.type === 'TELEMETRY') {
            // Reset progress bar on full telemetry frame
            if (progressBar) {
                progressBar.style.width = '0%';
            }

            // Set status back to INITIALIZED or PAUSED if it was RUNNING and not terminated
            if (stateManager.getStatus() === 'RUNNING' && data.is_terminated !== true) {
                const pending = stateManager.getPendingSteps();
                if (pending > 0) {
                    networkManager.send({ command: "STEP", steps: pending });
                    stateManager.clearPendingSteps();
                } else {
                    stateManager.setStatus('PAUSED');
                }
            }

            if (data.is_terminated === true) {
                stateManager.clearPendingSteps();
                if (playInterval) {
                    clearInterval(playInterval);
                    playInterval = null;
                }
                if (stateManager.getStatus() !== 'TERMINATED') {
                    stateManager.setStatus('TERMINATED');
                    networkManager.log('[System] Simulation reached termination boundary.', 'error');
                }
            }
        }
    } catch (e) {}
});

console.log("Workspace ready.");
