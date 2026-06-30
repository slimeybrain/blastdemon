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
            parameters: { gamma: 1.4, atm_pressure: 101325, atm_temperature: 298.15 }
        },
        {
            id: 'node-explosive', type: 'MaterialExplosive', x: 50, y: 350, displayMode: 'normal',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                composition: 'TNT',
                charge_mass: 1.0,
                rho: 1630,
                detonation_energy: 4290000,
                det_vel: 6930,
                jwl_A: 373.77e9,
                jwl_B: 3.747e9,
                jwl_R1: 4.15,
                jwl_R2: 0.90,
                jwl_omega: 0.35
            }
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
            parameters: { init_mode: 'Multi-Material JWL', cfl: 0.4, flux_scheme: 'AUSM+', spatial_order: 2, temporal_order: 2, output_mode: 'By Time', output_interval: 0.0001 }
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
    const solver = state?.nodes?.find(n => n.type === 'CFDSolver2D') || state?.nodes?.find(n => n.type === 'CFDSolver');
    return solver?.parameters?.cfl || 0.4;
}

(window as any).stateManager = stateManager;
(window as any).layoutManager = layoutManager;

const networkManager = new NetworkManager('ws://localhost:8080');

networkManager.onOpen(() => {
    const state = stateManager.getCurrentState();
    if (state) networkManager.send(serializeSimulationState(state));
});

// Event Delegation for Simulation Controls and Menus (since they are injected dynamically)
document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    // --- File Menu Actions (Model-level) ---
    if (target.id === 'menu-new-model') {
        const name = prompt("Enter name for the new model:", `Model ${stateManager.getAllModels().length + 1}`);
        if (name !== null) {
            stateManager.createModel(name.trim() || undefined);
        }
    }

    if (target.id === 'menu-load-json') {
        const fileInput = document.getElementById('load-json-file');
        if (fileInput) fileInput.click();
    }

    if (target.id === 'menu-save-json') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            const model = stateManager.getWorkspaceModels().find(m => m.id === activeWs.activeModelId);
            if (model) {
                const jsonString = JSON.stringify({
                    name: model.name,
                    nodes: model.nodes,
                    connections: model.connections
                }, null, 2);
                fallbackSaveJson(jsonString, `${model.name.toLowerCase().replace(/\s+/g, '_')}.json`);
            }
        } else {
            alert("No active model to save.");
        }
    }

    if (target.id === 'menu-load-binary') {
        const fileInput = document.getElementById('load-binary-file');
        if (fileInput) fileInput.click();
    }

    if (target.id === 'menu-save-binary') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            const model = stateManager.getWorkspaceModels().find(m => m.id === activeWs.activeModelId);
            if (model) {
                // Synthesize SimulationState wrapper just to use the binary serializer
                const dummyState: SimulationState = {
                    nodes: model.nodes,
                    connections: model.connections,
                    layout: activeWs.layout
                };
                const buffer = serializeToBinary(dummyState);
                fallbackSaveBinary(buffer, `${model.name.toLowerCase().replace(/\s+/g, '_')}.bin`);
            }
        } else {
            alert("No active model to save.");
        }
    }

    // --- Workspace Menu Actions ---
    if (target.id === 'menu-new-workspace') {
        stateManager.createWorkspace();
    }

    if (target.id === 'menu-dup-layout') {
        stateManager.duplicateWorkspaceLayout();
    }

    if (target.id === 'menu-add-model') {
        const activeWs = stateManager.getActiveWorkspace();
        const otherModels = stateManager.getAllModels().filter(m => !activeWs.modelIds.includes(m.id));
        if (otherModels.length === 0) {
            alert("No other models available. Use 'File -> New Model' to create a new model first.");
        } else {
            const modelNames = otherModels.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n');
            const choice = prompt(`Select a model to add to this workspace (enter number 1-${otherModels.length}):\n${modelNames}`);
            const idx = parseInt(choice || '') - 1;
            if (idx >= 0 && idx < otherModels.length) {
                stateManager.addModelToWorkspace(otherModels[idx]);
            }
        }
    }

    if (target.id === 'menu-remove-model') {
        const wsModels = stateManager.getWorkspaceModels();
        if (wsModels.length === 0) {
            alert("No models in this workspace to remove.");
        } else {
            const modelNames = wsModels.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n');
            const choice = prompt(`Select a model to remove from this workspace (enter number 1-${wsModels.length}):\n${modelNames}`);
            const idx = parseInt(choice || '') - 1;
            if (idx >= 0 && idx < wsModels.length) {
                stateManager.removeModelFromWorkspace(wsModels[idx].id);
            }
        }
    }

    if (target.id === 'menu-save-workspace') {
        stateManager.saveWorkspace();
        alert("Workspace and all models saved successfully to browser local storage.");
    }

    if (target.id === 'menu-export-workspace') {
        const appState = stateManager.getAppState();
        const jsonString = JSON.stringify(appState, null, 2);
        fallbackSaveJson(jsonString, 'workspace_project.json');
    }

    if (target.id === 'menu-import-workspace') {
        const fileInput = document.getElementById('import-workspace-file');
        if (fileInput) {
            fileInput.click();
        } else {
            // Dynamically create a temporary file input
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = (ev) => {
                const file = (ev.target as HTMLInputElement).files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const parsed = JSON.parse(event.target?.result as string);
                        if (parsed.models && parsed.workspaces && parsed.activeWorkspaceId) {
                            stateManager.loadAppState(parsed);
                            console.log("Workspace state imported successfully.");
                        } else {
                            alert("Invalid workspace project file.");
                        }
                    } catch (err) {
                        alert("Failed to parse workspace project file: " + err);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        }
    }

    if (target.id === 'menu-reset-all') {
        if (confirm("CRITICAL: This will flush all local storage and reload the application. Proceed?")) {
            stateManager.clearWorkspace();
            window.location.reload();
        }
    }

    // --- Graph Actions & Simulation Buttons ---
    if (target.classList.contains('auto-arrange-btn')) {
        const panelId = target.dataset.panelId;
        if (panelId) {
            const comp = layoutManager.components.get(panelId);
            if (comp && comp.type === 'NODE_GRAPH') {
                comp.instance.autoArrange();
            }
        }
    }

    if (target.classList.contains('fit-view-btn')) {
        const panelId = target.dataset.panelId;
        if (panelId) {
            const comp = layoutManager.components.get(panelId);
            if (comp && comp.type === 'NODE_GRAPH') {
                comp.instance.fitToView();
            }
        }
    }

    const isExecutionBtn = target.id === 'init-btn' || 
                           target.id === 'exec-end-btn' || 
                           target.id === 'interrupt-btn' || 
                           target.id === 'terminate-btn' || 
                           target.id.match(/exec-(\d+)-btn/) !== null;

    if (isExecutionBtn) {
        if (!networkManager.isConnected()) {
            alert("Error: WebSocket is not connected to the Broker backend. Please ensure the Broker daemon is running.");
            return;
        }
    }

    if (target.id === 'init-btn') {
        const selected = stateManager.getSelectedRunTargets();
        selected.forEach(modelId => {
            executeModelCommand(modelId, 'INIT');
        });
    }

    const stepMatch = target.id.match(/exec-(\d+)-btn/);
    if (stepMatch) {
        const steps = parseInt(stepMatch[1]);
        const selected = stateManager.getSelectedRunTargets();
        selected.forEach(modelId => {
            executeModelCommand(modelId, 'STEP', { steps });
        });
    }

    if (target.id === 'exec-end-btn') {
        const selected = stateManager.getSelectedRunTargets();
        selected.forEach(modelId => {
            executeModelCommand(modelId, 'EXEC_ALL');
        });
    }

    if (target.id === 'interrupt-btn') {
        const selected = stateManager.getSelectedRunTargets();
        selected.forEach(modelId => {
            executeModelCommand(modelId, 'PAUSE');
        });
    }

    if (target.id === 'terminate-btn') {
        const selected = stateManager.getSelectedRunTargets();
        selected.forEach(modelId => {
            executeModelCommand(modelId, 'TERMINATE');
        });
    }
});


/**
 * Walk workspace cross-model connections to find the "remap partner" of a model.
 * A 2D model has a RemapNode whose 'in' port is connected FROM a node in the 1D model.
 * Returns the partner modelId, or null if none found.
 */
function findRemapPartner(modelId: string): string | null {
    const ws = stateManager.getActiveWorkspace();
    if (!ws) return null;
    const model = stateManager.getAllModels().find(m => m.id === modelId);
    if (!model) return null;
    const wsConns = (ws as any).connections as Array<{fromNode:string,fromPort:string,toNode:string,toPort:string}> || [];

    // Case 1: this model has a RemapNode — find the 1D model feeding its 'in' port.
    const remapNode = model.nodes.find((n: any) => n.type === 'RemapNode');
    if (remapNode) {
        const conn = wsConns.find(c => c.toNode === remapNode.id && c.toPort === 'in');
        if (conn) {
            for (const mId of ws.modelIds) {
                if (mId === modelId) continue;
                const m = stateManager.getAllModels().find((x: any) => x.id === mId);
                if (m?.nodes.some((n: any) => n.id === conn.fromNode)) return mId;
            }
        }
    }

    // Case 2: this model is the 1D source — find the 2D model whose RemapNode we feed.
    const modelNodeIds = new Set(model.nodes.map((n: any) => n.id));
    for (const conn of wsConns) {
        if (!modelNodeIds.has(conn.fromNode)) continue;
        for (const mId of ws.modelIds) {
            if (mId === modelId) continue;
            const m = stateManager.getAllModels().find((x: any) => x.id === mId);
            const target = m?.nodes.find((n: any) => n.id === conn.toNode);
            if (target?.type === 'RemapNode') return mId;
        }
    }
    return null;
}

function executeModelCommand(modelId: string, command: string, extra: Record<string, any> = {}) {
    if (!networkManager.isConnected()) {
        stateManager.pushTelemetry(modelId, "[ERROR] WebSocket is not connected to the Broker backend.");
        return;
    }
    const model = stateManager.getAllModels().find(m => m.id === modelId);
    const has2D = model?.nodes.some(n => n.type === 'CFDSolver2D') || false;

    if (command === "INIT") {
        const state = stateManager.getSimulationState(modelId);
        if (state) {
            if (has2D) {
                const solver2D = state.nodes.find(n => n.type === 'CFDSolver2D');
                const hwConn = state.connections.find(c => c.toNode === solver2D?.id && c.toPort === 'hardware');
                const hwNode = hwConn ? state.nodes.find(n => n.id === hwConn.fromNode) : null;
                const device = hwNode?.parameters?.device || 'cpu';
                networkManager.send({ command: "SET_DEVICE", modelId, device });

                const payload = serializeForSolver(state, "INIT_2D", modelId);
                console.log(`Sending INIT_2D payload for model ${modelId}:`, payload);
                networkManager.send(payload);
                stateManager.setModelStatus(modelId, 'INITIALIZED');

                const initMode = solver2D?.parameters?.init_mode || 'From1D';
                if (initMode === 'From1D' || initMode === 'Remap') {
                    const remapConn = state.connections.find(c => c.toNode === solver2D?.id && c.toPort === 'remap');
                    const remapNode = remapConn ? state.nodes.find(n => n.id === remapConn.fromNode) : null;
                    if (remapNode) {
                        const detConn = state.connections.find(c => c.toNode === solver2D?.id && c.toPort === 'detonator');
                        const detNode = detConn ? state.nodes.find(n => n.id === detConn.fromNode) : null;

                        const explosiveZ = detNode 
                            ? Number(detNode.parameters.explosive_z ?? 0.0)
                            : Number(remapNode.parameters.explosive_z ?? 0.0);
                        const explosiveR = detNode
                            ? Number(detNode.parameters.explosive_r ?? 0.0)
                            : Number(remapNode.parameters.explosive_r ?? 0.0);
                        const remapRadius = Number(remapNode.parameters.remap_radius ?? 0.5);

                        networkManager.send({
                            command: "REMAP",
                            modelId,
                            explosive_z: explosiveZ,
                            remap_radius: remapRadius,
                            explosive_r: explosiveR
                        });
                    }
                }
            } else {
                const payload = serializeForSolver(state, "INIT", modelId);
                console.log(`Sending INIT payload for model ${modelId}:`, payload);
                networkManager.send(payload);
                stateManager.setModelStatus(modelId, 'INITIALIZED');
            }
        }
    } else if (command === "STEP") {
        const steps = extra.steps || 1;
        const currentStatus = stateManager.getModelStatus(modelId);
        if (currentStatus === 'UNINITIALIZED' || currentStatus === 'TERMINATED') {
            const solverNode = model?.nodes.find(n => n.type === 'CFDSolver2D') || model?.nodes.find(n => n.type === 'CFDSolver');
            if (solverNode) {
                stateManager.pushTelemetry(solverNode.id, "[WARNING] Cannot execute simulation steps: Solver is uninitialized. Send INIT first.");
            }
            return;
        }
        if (has2D) {
            networkManager.send({ command: "STEP_2D", modelId, steps, cfl: getCflFromSolver() });
        } else {
            networkManager.send({ command: "STEP", modelId, steps, cfl: getCflFromSolver() });
        }
        stateManager.setModelStatus(modelId, 'RUNNING');
    } else if (command === "EXEC_ALL") {
        const currentStatus = stateManager.getModelStatus(modelId);
        if (currentStatus === 'UNINITIALIZED' || currentStatus === 'TERMINATED') {
            const solverNode = model?.nodes.find(n => n.type === 'CFDSolver2D') || model?.nodes.find(n => n.type === 'CFDSolver');
            if (solverNode) {
                stateManager.pushTelemetry(solverNode.id, "[WARNING] Cannot execute simulation: Solver is uninitialized. Send INIT first.");
            }
            return;
        }
        if (has2D) {
            networkManager.send({ command: "EXEC_ALL_2D", modelId, cfl: getCflFromSolver() });
        } else {
            networkManager.send({ command: "EXEC_ALL", modelId, cfl: getCflFromSolver() });
        }
        stateManager.setModelStatus(modelId, 'RUNNING');
    } else if (command === "PAUSE") {
        if (has2D) {
            networkManager.send({ command: "PAUSE_2D", modelId });
        } else {
            networkManager.send({ command: "PAUSE", modelId });
        }
        stateManager.setModelStatus(modelId, 'PAUSED');
    } else if (command === "TERMINATE") {
        if (has2D) {
            networkManager.send({ command: "TERMINATE_2D", modelId });
        } else {
            networkManager.send({ command: "TERMINATE", modelId });
        }
        stateManager.setModelStatus(modelId, 'TERMINATED');
        // The backend always clears both phases on any TERMINATE command.
        // Mirror that in the UI so the partner model doesn't stay stuck as RUNNING/PAUSED.
        const partner = findRemapPartner(modelId);
        if (partner) stateManager.setModelStatus(partner, 'TERMINATED');
    }
}

document.addEventListener('model-action', (e: any) => {
    const { modelId, command, steps } = e.detail;
    executeModelCommand(modelId, command, { steps });
});

function is2DFrame(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 12) return false;
    const view = new DataView(buffer);
    const nr = view.getUint32(0, true);
    const nz = view.getUint32(4, true);
    const n_channels = view.getUint32(8, true);
    const expected = nr * nz * n_channels * 4 + 12;
    return expected === buffer.byteLength;
}

networkManager.onMessage((data) => {
    if (data instanceof ArrayBuffer) {
        const view = new DataView(data);
        let modelId = "";
        let offset = 0;
        while (offset < data.byteLength) {
            const charCode = view.getUint8(offset++);
            if (charCode === 0) break;
            modelId += String.fromCharCode(charCode);
        }
        const payloadBuffer = data.slice(offset);
        
        let model = stateManager.getAllModels().find(m => m.id === modelId);
        const type = is2DFrame(payloadBuffer) ? 'CFDSolver2D' : 'CFDSolver';
        let solverNode = model?.nodes.find(n => n.type === type);
        
        if (!solverNode) {
            // Fallback: search all models in the active workspace
            const activeWs = stateManager.getActiveWorkspace();
            for (const mId of activeWs.modelIds) {
                const m = stateManager.getAllModels().find(x => x.id === mId);
                solverNode = m?.nodes.find(n => n.type === type);
                if (solverNode) {
                    model = m;
                    break;
                }
            }
        }
        
        if (solverNode) {
            stateManager.pushTelemetry(solverNode.id, payloadBuffer);
        }
        return;
    }

    if (typeof data !== 'string') return;

    try {
        const dataJson = JSON.parse(data);
        let modelId = dataJson.modelId;

        if (dataJson.type === 'resource_pulse') {
            layoutManager.broadcastResourceData(dataJson);
            return;
        }

        // Determine correct target solver type
        let targetType: 'CFDSolver2D' | 'CFDSolver' = 'CFDSolver';
        if (dataJson.type === 'progress_2d' || dataJson.type === 'TELEMETRY_2D') {
            targetType = 'CFDSolver2D';
        } else if (dataJson.type === 'progress' || dataJson.type === 'TELEMETRY') {
            targetType = 'CFDSolver';
        } else if (dataJson.type === 'log') {
            const msg = dataJson.message || "";
            const is2DLog = msg.includes("2D") || msg.includes("REMAP") || msg.includes("vtk");
            targetType = is2DLog ? 'CFDSolver2D' : 'CFDSolver';
        }

        // Find the model that actually contains the target solver type
        let model = stateManager.getAllModels().find(m => m.id === modelId);
        if (modelId && (!model || !model.nodes.some(n => n.type === targetType))) {
            const activeWs = stateManager.getActiveWorkspace();
            const foundModel = activeWs.modelIds
                .map(id => stateManager.getAllModels().find(m => m.id === id))
                .find(m => m?.nodes.some(n => n.type === targetType));
            if (foundModel) {
                modelId = foundModel.id;
                model = foundModel;
            }
        }

        if (dataJson.type === 'log') {
            if (modelId && model) {
                const solverNode = model.nodes.find(n => n.type === targetType);
                if (solverNode) {
                    stateManager.pushTelemetry(solverNode.id, dataJson.message);
                }
            }
            return;
        }

        if (dataJson.type === 'progress' || dataJson.type === 'progress_2d') {
            if (modelId) {
                stateManager.setModelProgress(modelId, dataJson.percent);
                stateManager.setModelSimTime(modelId, dataJson.sim_time);
                
                if (dataJson.percent === 100) {
                    stateManager.setModelStatus(modelId, 'PAUSED');
                }

                if (model) {
                    const solverNode = model.nodes.find(n => n.type === targetType);
                    if (solverNode) {
                        stateManager.pushTelemetry(solverNode.id, dataJson);
                    }
                }
            }
            return;
        }

        if (dataJson.type === 'TELEMETRY' || dataJson.type === 'TELEMETRY_2D') {
            if (modelId) {
                stateManager.setModelSimTime(modelId, dataJson.time);
                if (dataJson.time === 0) {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                    stateManager.setModelProgress(modelId, 0);
                } else if (dataJson.is_terminated === true) {
                    stateManager.setModelStatus(modelId, 'TERMINATED');
                }

                if (model) {
                    const solverNode = model.nodes.find(n => n.type === targetType);
                    if (solverNode) {
                        stateManager.pushTelemetry(solverNode.id, dataJson);
                    }
                }
            }
            return;
        }

    } catch (e) {
        // If not JSON, it's likely a generic kernel log string
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

function fallbackSaveJson(jsonString: string, filename: string = "model.json") {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(jsonString);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Fallback to trigger downloads when Filesystem Access API isn't available
function fallbackSaveBinary(buffer: ArrayBuffer, filename: string = "model.bin") {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", url);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);
}

