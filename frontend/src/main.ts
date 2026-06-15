import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver, serializeToBinary, deserializeFromBinary } from './serialization.js';
import { LayoutManager } from './layout-manager.js';

console.log("BlastDaemon Workspace Initializing (Recursive Layout)...");

const initialState: SimulationState = {
    nodes: [
        {
            id: 'node-mesh', type: 'DomainMesh', x: 50, y: 50, displayMode: 'normal',
            inputs: [], outputs: [{ id: 'out', label: 'Mesh' }],
            parameters: {
                dimension: '1D',
                domain_radius: 1.0,
                cell_size: 0.001,
                x_min_bc: 'Reflecting',
                x_max_bc: 'Terminate',
                y_min_bc: 'Reflecting',
                y_max_bc: 'Reflecting',
                z_min_bc: 'Reflecting',
                z_max_bc: 'Reflecting'
            }
        },
        {
            id: 'node-air', type: 'MaterialAir', x: 50, y: 200, displayMode: 'normal',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: { atm_pressure: 101325, atm_temperature: 298.15 }
        },
        {
            id: 'node-explosive', type: 'MaterialExplosive', x: 50, y: 350, displayMode: 'normal',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: { charge_mass: 1.0, composition: 'TNT', rho: 1630, detonation_energy: 4520000 }
        },
        {
            id: 'node-painter', type: 'ThePainter', x: 300, y: 200, displayMode: 'normal',
            inputs: [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Explosive' }],
            outputs: [{ id: 'out', label: 'State' }],
            parameters: {}
        },
        {
            id: 'node-solver', type: 'CFDSolver', x: 550, y: 200, displayMode: 'normal',
            inputs: [{ id: 'in', label: 'Initial State' }],
            outputs: [{ id: 'telemetry', label: 'Telemetry' }],
            parameters: { cfl: 0.4, flux_scheme: 'AUSM+', spatial_order: 2, temporal_order: 2, output_mode: 'By Time', output_interval: 0.0001 }
        }
    ],
    connections: [
        { fromNode: 'node-mesh', fromPort: 'out', toNode: 'node-painter', toPort: 'mesh' },
        { fromNode: 'node-air', fromPort: 'out', toNode: 'node-painter', toPort: 'air' },
        { fromNode: 'node-explosive', fromPort: 'out', toNode: 'node-painter', toPort: 'explosive' },
        { fromNode: 'node-painter', fromPort: 'out', toNode: 'node-solver', toPort: 'in' }
    ],
    layout: {
        type: 'split',
        id: 'split-root',
        direction: 'horizontal',
        ratio: 0.2,
        firstChild: {
            type: 'split',
            id: 'split-left',
            direction: 'vertical',
            ratio: 0.5,
            firstChild: {
                type: 'split',
                id: 'split-menu-outliner',
                direction: 'vertical',
                ratio: 0.1,
                firstChild: {
                    type: 'panel',
                    id: 'panel-menu-bar',
                    panelType: 'MENU_BAR',
                    targetNodeId: null
                },
                secondChild: {
                    type: 'panel',
                    id: 'panel-outliner',
                    panelType: 'OUTLINER',
                    targetNodeId: null
                }
            },
            secondChild: {
                type: 'panel',
                id: 'panel-execution',
                panelType: 'EXECUTION_MANAGER',
                targetNodeId: null
            }
        },
        secondChild: {
            type: 'split',
            id: 'split-main',
            direction: 'horizontal',
            ratio: 0.75,
            firstChild: {
                type: 'panel',
                id: 'panel-graph',
                panelType: 'NODE_GRAPH',
                targetNodeId: null
            },
            secondChild: {
                type: 'panel',
                id: 'panel-properties',
                panelType: 'PROPERTIES',
                targetNodeId: null
            }
        }
    }
};

const stateManager = new StateManager(initialState);

// Hydrate from localStorage if available
const savedState = stateManager.loadWorkspace();
const activeState = savedState || initialState;

const layoutManager = new LayoutManager('app-container', stateManager);

function getCflFromSolver(): number {
    const state = stateManager.getCurrentState();
    const solver = state?.nodes?.find(n => n.type === 'CFDSolver');
    return solver?.parameters?.cfl || 0.4;
}

(window as any).stateManager = stateManager;
(window as any).layoutManager = layoutManager;

const networkManager = new NetworkManager('ws://localhost:8080');

networkManager.onOpen(() => {
    const state = stateManager.getCurrentState();
    if (state) networkManager.send(serializeSimulationState(state));
});

// Event Delegation for Simulation Controls (since they are injected dynamically)
document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    if (target.id === 'menu-new-model') {
        if (confirm("Reset current model and start clean?")) {
            stateManager.pushState(initialState);
            layoutManager.render(initialState);
        }
    }

    if (target.id === 'menu-load-json') {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [{
                        description: 'BlastDemon Model (JSON)',
                        accept: { 'application/json': ['.json'] }
                    }]
                });
                const file = await handle.getFile();
                const text = await file.text();
                const state = JSON.parse(text) as SimulationState;
                stateManager.pushState(state);
                layoutManager.render(state);
                console.log("Model loaded successfully from JSON via FileSystem API.");
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    console.error("FileSystem API load failed, using fallback:", err);
                    document.getElementById('load-json-file')?.click();
                }
            }
        } else {
            document.getElementById('load-json-file')?.click();
        }
    }

    if (target.id === 'menu-save-json') {
        const state = stateManager.getCurrentState();
        if (state) {
            const jsonString = JSON.stringify(state, null, 2);
            if ('showSaveFilePicker' in window) {
                try {
                    const handle = await (window as any).showSaveFilePicker({
                        suggestedName: 'model.json',
                        types: [{
                            description: 'BlastDemon Model (JSON)',
                            accept: { 'application/json': ['.json'] }
                        }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(jsonString);
                    await writable.close();
                    console.log("Model saved to JSON via FileSystem API.");
                } catch (err) {
                    if ((err as Error).name !== 'AbortError') {
                        console.error("FileSystem API save failed, using fallback:", err);
                        fallbackSaveJson(jsonString);
                    }
                }
            } else {
                fallbackSaveJson(jsonString);
            }
        }
    }

    if (target.id === 'menu-load-binary') {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [{
                        description: 'BlastDemon Binary Model',
                        accept: { 'application/octet-stream': ['.bin', '.model'] }
                    }]
                });
                const file = await handle.getFile();
                const buffer = await file.arrayBuffer();
                const state = deserializeFromBinary(buffer);
                stateManager.pushState(state);
                layoutManager.render(state);
                console.log("Model loaded successfully from Binary via FileSystem API.");
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    console.error("FileSystem API binary load failed, using fallback:", err);
                    document.getElementById('load-binary-file')?.click();
                }
            }
        } else {
            document.getElementById('load-binary-file')?.click();
        }
    }

    if (target.id === 'menu-save-binary') {
        const state = stateManager.getCurrentState();
        if (state) {
            const buffer = serializeToBinary(state);
            if ('showSaveFilePicker' in window) {
                try {
                    const handle = await (window as any).showSaveFilePicker({
                        suggestedName: 'model.bin',
                        types: [{
                            description: 'BlastDemon Binary Model',
                            accept: { 'application/octet-stream': ['.bin', '.model'] }
                        }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(buffer);
                    await writable.close();
                    console.log("Model saved to Binary via FileSystem API.");
                } catch (err) {
                    if ((err as Error).name !== 'AbortError') {
                        console.error("FileSystem API binary save failed, using fallback:", err);
                        fallbackSaveBinary(buffer);
                    }
                }
            } else {
                fallbackSaveBinary(buffer);
            }
        }
    }

    if (target.classList.contains('auto-arrange-btn')) {
        const panelId = target.dataset.panelId;
        if (panelId) {
            const comp = layoutManager.components.get(panelId);
            if (comp && comp.type === 'NODE_GRAPH') {
                comp.instance.autoArrange();
            }
        }
    }

    if (target.id === 'init-btn') {
        const state = stateManager.getCurrentState();
        if (state) {
            stateManager.clearPendingSteps();
            const payload = serializeForSolver(state, "INIT");
            console.log("Sending INIT payload:", payload);
            networkManager.send(payload);
            stateManager.setStatus('INITIALIZED');
        }
    }

    const stepMatch = target.id.match(/exec-(\d+)-btn/);
    if (stepMatch) {
        const steps = parseInt(stepMatch[1]);
        if (stateManager.getStatus() === 'UNINITIALIZED' || stateManager.getStatus() === 'TERMINATED') {
            stateManager.pushTelemetry("[WARNING] Cannot execute simulation steps: System is uninitialized. Please click 'Initialize' first.");
            return;
        }
        stateManager.addPendingSteps(steps);

        // Immediate Execution: Always send command if not already running (Resumes automatically)
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps(), cfl: getCflFromSolver() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    }

    if (target.id === 'exec-end-btn') {
        if (stateManager.getStatus() === 'UNINITIALIZED' || stateManager.getStatus() === 'TERMINATED') {
            stateManager.pushTelemetry("[WARNING] Cannot execute simulation: System is uninitialized. Please click 'Initialize' first.");
            return;
        }
        stateManager.clearPendingSteps();
        networkManager.send({ command: "EXEC_ALL", cfl: getCflFromSolver() });
        stateManager.setStatus('RUNNING');
    }

    if (target.id === 'interrupt-btn') {
        stateManager.clearPendingSteps();
        networkManager.send({ command: "PAUSE" });
        stateManager.setStatus('PAUSED');
    }

    if (target.id === 'terminate-btn') {
        stateManager.clearPendingSteps();
        networkManager.send({ command: "TERMINATE" });
        stateManager.setStatus('TERMINATED');
    }

    if (target.id === 'save-workspace-btn') {
        stateManager.saveWorkspace();
    }

    if (target.id === 'clear-save-btn') {
        stateManager.clearWorkspace();
    }
});

networkManager.onMessage((data) => {
    if (data instanceof ArrayBuffer) {
        stateManager.pushTelemetry(data);
        return;
    }

    if (typeof data !== 'string') return;

    // Handle Resource Pulse and other non-JSON or custom JSON
    try {
        const dataJson = JSON.parse(data);
        const progressBar = document.getElementById('progress-bar');

        if (dataJson.type === 'resource_pulse') {
            layoutManager.broadcastResourceData(dataJson);
            return;
        }

        if (dataJson.type === 'progress') {
            const progressLabel = document.getElementById('progress-label');
            if (progressBar) progressBar.style.width = `${dataJson.percent}%`;
            if (progressLabel) {
                if (dataJson.mode === 'STEP') {
                    progressLabel.textContent = `Steps: ${dataJson.completed} / ${dataJson.total} (${dataJson.percent}%) | Time: ${dataJson.sim_time.toExponential(6)}s`;
                } else if (dataJson.mode === 'EXEC_ALL') {
                    progressLabel.textContent = `Progress: ${dataJson.percent}% | Time: ${dataJson.sim_time.toExponential(6)}s`;
                } else {
                    progressLabel.textContent = `Progress: ${dataJson.percent}%`;
                }
            }
            stateManager.pushTelemetry(dataJson);
            return;
        }

        if (dataJson.type === 'TELEMETRY') {
            stateManager.pushTelemetry(dataJson);
            if (progressBar) progressBar.style.width = '0%';
            const progressLabel = document.getElementById('progress-label');
            if (progressLabel && dataJson.time > 0) {
                progressLabel.textContent = `Time: ${dataJson.time.toExponential(6)}s ${dataJson.is_terminated ? '(Terminated)' : ''}`;
            }
            if (dataJson.time === 0) stateManager.setStatus('INITIALIZED');

            if (stateManager.getStatus() === 'RUNNING' && dataJson.is_terminated !== true) {
                const pending = stateManager.getPendingSteps();
                if (pending > 0) {
                    networkManager.send({ command: "STEP", steps: pending, cfl: getCflFromSolver() });
                    stateManager.clearPendingSteps();
                } else {
                    stateManager.setStatus('PAUSED');
                }
            }

            if (dataJson.is_terminated === true && dataJson.time > 0) {
                stateManager.clearPendingSteps();
                if (stateManager.getStatus() !== 'TERMINATED') {
                    stateManager.setStatus('TERMINATED');
                }
            }
            return;
        }
    } catch (e) {
        // If not JSON, it's likely a kernel log string
        if (data.startsWith('[') && data.includes(']')) {
            stateManager.pushTelemetry(data);
        }
    }
});

layoutManager.render(activeState);
console.log("Workspace ready.");

document.getElementById('load-json-file')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const state = JSON.parse(event.target?.result as string) as SimulationState;
            stateManager.pushState(state);
            layoutManager.render(state);
            console.log("Model loaded successfully from JSON.");
        } catch (err) {
            alert("Failed to parse JSON file: " + err);
        }
    };
    reader.readAsText(file);
    input.value = ''; // Reset file input
});

document.getElementById('load-binary-file')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const buffer = event.target?.result as ArrayBuffer;
            const state = deserializeFromBinary(buffer);
            stateManager.pushState(state);
            layoutManager.render(state);
            console.log("Model loaded successfully from Binary.");
        } catch (err) {
            alert("Failed to parse Binary file: " + err);
        }
    };
    reader.readAsArrayBuffer(file);
    input.value = ''; // Reset file input
});

function fallbackSaveJson(jsonString: string) {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(jsonString);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "model.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

function fallbackSaveBinary(buffer: ArrayBuffer) {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", url);
    downloadAnchor.setAttribute("download", "model.bin");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);
}
