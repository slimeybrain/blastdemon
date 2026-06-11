import { StateManager } from './state-manager.js';
import { SimulationState } from './types.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver } from './serialization.js';
import { LayoutManager } from './layout-manager.js';

console.log("BlastDaemon Workspace Initializing (Recursive Layout)...");

const initialState: SimulationState = {
    nodes: [
        {
            id: 'node-mesh', type: 'DomainMesh', x: 50, y: 50,
            inputs: [], outputs: [{ id: 'out', label: 'Mesh' }],
            parameters: { domain_radius: 1.0, cell_size: 0.001, left_bc: 'Reflecting', right_bc: 'Terminate' }
        },
        {
            id: 'node-air', type: 'MaterialAir', x: 50, y: 200,
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: { atm_pressure: 101325, atm_temperature: 298.15 }
        },
        {
            id: 'node-explosive', type: 'MaterialExplosive', x: 50, y: 350,
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: { charge_mass: 1.0, composition: 'TNT', rho: 1630, detonation_energy: 4520000 }
        },
        {
            id: 'node-painter', type: 'ThePainter', x: 300, y: 200,
            inputs: [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Explosive' }],
            outputs: [{ id: 'out', label: 'State' }],
            parameters: {}
        },
        {
            id: 'node-solver', type: 'CFDSolver', x: 550, y: 200,
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
                type: 'panel',
                id: 'panel-outliner',
                panelType: 'OUTLINER',
                targetNodeId: null
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
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    if (target.id === 'auto-arrange-btn') {
        // This is tricky because we might have multiple graphs.
        // For now, let's find the first graph renderer and call it.
        (layoutManager as any).components.forEach((comp: any) => {
            if (comp.type === 'NODE_GRAPH') comp.instance.autoArrange();
        });
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
        stateManager.addPendingSteps(steps);

        // Immediate Execution: Always send command if not already running (Resumes automatically)
        if (stateManager.getStatus() !== 'RUNNING') {
            networkManager.send({ command: "STEP", steps: stateManager.getPendingSteps(), cfl: getCflFromSolver() });
            stateManager.clearPendingSteps();
            stateManager.setStatus('RUNNING');
        }
    }

    if (target.id === 'exec-end-btn') {
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
            if (progressBar) progressBar.style.width = `${dataJson.percent}%`;
            stateManager.pushTelemetry(dataJson);
            return;
        }

        if (dataJson.type === 'TELEMETRY') {
            stateManager.pushTelemetry(dataJson);
            if (progressBar) progressBar.style.width = '0%';
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
