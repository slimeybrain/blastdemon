import { StateManager } from './state-manager.js';
import { SimulationState, SimulationStatus, LayoutNode } from './types.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver, serializeToBinary, deserializeFromBinary } from './serialization.js';
import { LayoutManager } from './layout-manager.js';

console.log("BlastDaemon Workspace Initializing (Recursive Layout)...");

const initialState: SimulationState = {
    nodes: [
        {
            id: 'node-mesh', type: 'DomainMesh', x: 50, y: 50, displayMode: 'expanded',
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
            id: 'node-air', type: 'Material', x: 50, y: 180, displayMode: 'expanded',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                material_type: 'Air',
                atm_pressure: 101325.0,
                atm_temperature: 298.15,
                gamma: 1.4
            }
        },
        {
            id: 'node-material-explosive', type: 'Material', x: 50, y: 310, displayMode: 'expanded',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                material_type: 'JWL Charge',
                composition: 'TNT',
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
            id: 'node-explosive', type: 'Charge1D', x: 50, y: 500, displayMode: 'expanded',
            inputs: [{ id: 'material', label: 'Material' }],
            outputs: [{ id: 'out', label: 'Charge' }],
            parameters: {
                charge_radius: 0.05
            }
        },
        {
            id: 'node-painter', type: 'ThePainter', x: 300, y: 200, displayMode: 'expanded',
            inputs: [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Charge' }],
            outputs: [{ id: 'out', label: 'State' }],
            parameters: {}
        },
        {
            id: 'node-solver', type: 'CFDSolver', x: 550, y: 200, displayMode: 'expanded',
            inputs: [{ id: 'in', label: 'Initial State' }],
            outputs: [{ id: 'telemetry', label: 'Telemetry' }],
            parameters: { init_mode: 'Multi-Material JWL', cfl: 0.4, flux_scheme: 'AUSM+', spatial_order: 2, temporal_order: 2, output_mode: 'By Time', output_interval: 0.0001 }
        }
    ],
    connections: [
        { fromNode: 'node-mesh', fromPort: 'out', toNode: 'node-painter', toPort: 'mesh' },
        { fromNode: 'node-air', fromPort: 'out', toNode: 'node-painter', toPort: 'air' },
        { fromNode: 'node-material-explosive', fromPort: 'out', toNode: 'node-explosive', toPort: 'material' },
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
(window as any).networkManager = networkManager;

networkManager.onOpen(() => {
    const state = stateManager.getCurrentState();
    if (state) networkManager.send(serializeSimulationState(state));
    stateManager.setModelStatus('all', stateManager.getStatus());
});

networkManager.onClose(() => {
    stateManager.setModelStatus('all', stateManager.getStatus());
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

    if (target.id === 'menu-copy-model') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            stateManager.copyModelToClipboard(activeWs.activeModelId);
            console.log(`Copied active model to clipboard: ${activeWs.activeModelId}`);
        } else {
            alert("No active model to copy.");
        }
    }

    if (target.id === 'menu-paste-model') {
        const pasted = stateManager.pasteModelFromClipboard();
        if (pasted) {
            console.log(`Pasted model from clipboard: ${pasted.id}`);
        } else {
            alert("Clipboard is empty. Copy a model first.");
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

}); // end document click

// ─────────────────────────────────────────────────────────────────────────────
// Execution deduplication
// ─────────────────────────────────────────────────────────────────────────────



document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

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


});


// ─────────────────────────────────────────────────────────────────────────────
// Pipeline detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When two models are connected by a remap they form a single simulation
 * pipeline and must share one BlastSolver process.  This function detects that
 * relationship and returns a descriptor, or null if the model is standalone.
 *
 * The canonical processId for the shared process is always model2dId so that
 * the broker's "INIT_2D → existing process" fast-path works: the process was
 * already spawned when INIT (1D) was sent under that same ID.
 */
interface RemapPipeline {
    model1dId: string;   // model containing CFDSolver (1D phase)
    model2dId: string;   // model containing CFDSolver2D + RemapNode (2D phase)
    processId: string;   // canonical broker key = model2dId
}

function findRemapPipeline(modelId: string): RemapPipeline | null {
    const ws = stateManager.getActiveWorkspace();
    if (!ws) return null;

    const wsConns = ws.connections as Array<{fromNode:string,fromPort:string,toNode:string,toPort:string}>;
    const allModels = stateManager.getAllModels();

    // Fast node-id → modelId lookup.
    const nodeToModel = new Map<string, string>();
    for (const mId of ws.modelIds) {
        const m = allModels.find(x => x.id === mId);
        m?.nodes.forEach(n => nodeToModel.set(n.id, mId));
    }

    for (const conn of wsConns) {
        const fromModelId = nodeToModel.get(conn.fromNode);
        const toModelId   = nodeToModel.get(conn.toNode);
        if (!fromModelId || !toModelId || fromModelId === toModelId) continue;

        // Destination must be a RemapNode inside the 2D model.
        const toModel  = allModels.find(m => m.id === toModelId);
        const toNode   = toModel?.nodes.find(n => n.id === conn.toNode);
        if (toNode?.type !== 'RemapNode') continue;

        // Source must live in a model that has a 1D CFDSolver.
        const fromModel = allModels.find(m => m.id === fromModelId);
        if (!fromModel?.nodes.some(n => n.type === 'CFDSolver')) continue;

        // ONLY match if modelId is the 2D target model!
        if (modelId === toModelId) {
            return {
                model1dId: fromModelId,
                model2dId: toModelId,
                processId: toModelId,
            };
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command execution
// ─────────────────────────────────────────────────────────────────────────────

function executeModelCommand(modelId: string, command: string, extra: Record<string, any> = {}, fromGlobal: boolean = false) {
    if (!networkManager.isConnected()) {
        stateManager.pushTelemetry(modelId, "[ERROR] WebSocket is not connected to the Broker backend.");
        return;
    }

    const model    = stateManager.getAllModels().find(m => m.id === modelId);
    const has2D    = model?.nodes.some(n => n.type === 'CFDSolver2D') || false;
    const pipeline = findRemapPipeline(modelId);
    const has3D      = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;

    // Helper to get solver node for logging
    const getSolverNode = (mid: string) => {
        const m = stateManager.getAllModels().find(m => m.id === mid);
        return m?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
    };

    const sendContourConfig = (targetId: string) => {
        const m = stateManager.getAllModels().find(model => model.id === targetId);
        if (m) {
            const contourNode = m.nodes.find(n => n.type === 'TelemetryContour');
            if (contourNode) {
                const stride = Number(contourNode.parameters?.downsample_stride ?? 1);
                const rate = Number(contourNode.parameters?.refresh_rate ?? 0.0);
                networkManager.send({
                    command: "CONTOUR_CONFIG",
                    modelId: targetId,
                    stride,
                    refresh_rate: rate
                });
            }
        }
    };

    // Helper to perform remapping from 1D telemetry if available
    const tryRemapFrom1D = (targetModelId: string, pipe: any): boolean => {
        const model = stateManager.getAllModels().find(m => m.id === targetModelId);
        const model1d = stateManager.getAllModels().find(m => m.id === pipe.model1dId);
        const solver1DNode = model1d?.nodes.find(n => n.type === 'CFDSolver');
        const telemetry = solver1DNode ? stateManager.getTelemetry(solver1DNode.id + "-binary") : null;
        
        console.log(`[tryRemapFrom1D] targetModelId: ${targetModelId}, pipe.model1dId: ${pipe.model1dId}`);
        console.log(`[tryRemapFrom1D] solver1DNode:`, solver1DNode);
        console.log(`[tryRemapFrom1D] telemetry:`, telemetry);

        const solver2DNode = model?.nodes.find(n => n.type === 'CFDSolver2D');
        const solver3DNode = model?.nodes.find(n => n.type === 'CFDSolver3D');
        const activeSolverNode = solver2DNode || solver3DNode;

        if (activeSolverNode) {
            stateManager.pushTelemetry(activeSolverNode.id, `[DEBUG] tryRemapFrom1D starting. target=${targetModelId} 1dModel=${pipe.model1dId} node=${solver1DNode?.id ?? 'null'} telemetry=${telemetry ? ('ArrayBuffer(' + telemetry.byteLength + ')') : 'null'}`, targetModelId);
        }

        if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
            if (activeSolverNode) {
                const storeKeys = Array.from((stateManager as any).telemetryStore.keys()).join(', ');
                stateManager.pushTelemetry(activeSolverNode.id, `[WARNING] Cannot initialize: No 1D simulation telemetry found (telemetry=${telemetry ? typeof telemetry : 'null'}). Please run the 1D model first. Available telemetry keys: [${storeKeys}]`, targetModelId);
            }
            return false;
        }

        try {
            const cell_size = Number(solver1DNode!.parameters?.cell_size ?? 0.001);
            const view = new DataView(telemetry);
            const n_cells = view.getUint32(0, true);
            const n_channels = view.getUint32(4, true);
            const floats = new Float32Array(telemetry, 8);
            
            const r_1d: number[] = [];
            const states_1d: any[] = [];
            
            for (let i = 0; i < n_cells; i++) {
                r_1d.push((i + 0.5) * cell_size);
                const p = floats[0 * n_cells + i];
                const rho = floats[1 * n_cells + i];
                const u = floats[2 * n_cells + i];
                const E_specific = floats[3 * n_cells + i];
                const alpha1 = floats[4 * n_cells + i];
                const alpha2 = floats[5 * n_cells + i];
                const E = rho * (E_specific + 0.5 * u * u);
                
                states_1d.push({
                    rho,
                    u,
                    p,
                    E,
                    alpha1,
                    alpha2,
                    arho1: rho * alpha1,
                    arho2: rho * alpha2,
                    floor_status: 0
                });
            }
            
            const state = stateManager.getSimulationState(targetModelId);
            
            let explosiveX = 0.0;
            let explosiveY = 0.0;
            let explosiveZ = 0.0;
            let explosiveR = 0.0;
            let remapRadius = 0.5;

            if (solver3DNode) {
                const remapConn = state?.connections.find(c => c.toNode === solver3DNode.id && c.toPort === 'remap');
                const remapNode = remapConn ? state?.nodes.find(n => n.id === remapConn.fromNode) : null;
                const detConn = state?.connections.find(c => c.toNode === solver3DNode.id && c.toPort === 'detonator');
                const detNode = detConn ? state?.nodes.find(n => n.id === detConn.fromNode) : null;

                explosiveX = detNode ? Number(detNode.parameters.detonator_x ?? 0.0) : Number(remapNode?.parameters?.explosive_x ?? 0.0);
                explosiveY = detNode ? Number(detNode.parameters.detonator_y ?? 0.0) : Number(remapNode?.parameters?.explosive_y ?? 0.0);
                explosiveZ = detNode ? Number(detNode.parameters.detonator_z ?? 0.0) : Number(remapNode?.parameters?.explosive_z ?? 0.0);
                remapRadius = Number(remapNode?.parameters?.remap_radius ?? 0.5);
            } else if (solver2DNode) {
                const remapConn = state?.connections.find(c => c.toNode === solver2DNode.id && c.toPort === 'remap');
                const remapNode = remapConn ? state?.nodes.find(n => n.id === remapConn.fromNode) : null;
                const detConn = state?.connections.find(c => c.toNode === solver2DNode.id && c.toPort === 'detonator');
                const detNode = detConn ? state?.nodes.find(n => n.id === detConn.fromNode) : null;

                explosiveX = 0.0;
                explosiveY = 0.0;
                explosiveZ = detNode ? Number(detNode.parameters.detonator_z ?? 0.0) : Number(remapNode?.parameters?.explosive_z ?? 0.0);
                explosiveR = detNode ? Number(detNode.parameters.detonator_r ?? 0.0) : Number(remapNode?.parameters?.explosive_r ?? 0.0);
                remapRadius = Number(remapNode?.parameters?.remap_radius ?? 0.5);
            }

            // Extract all ambient air, atmospheric, and explosive/JWL properties from the 1D model
            const dummy1DState: SimulationState = {
                nodes: model1d?.nodes ?? [],
                connections: model1d?.connections ?? [],
                layout: {} as any
            };
            const serialized1D = JSON.parse(serializeForSolver(dummy1DState, "INIT", pipe.model1dId));

            console.log(`Sending REMAP parameters for modelId ${targetModelId} with parsed 1D states`);
            if (activeSolverNode) {
                stateManager.pushTelemetry(activeSolverNode.id, `[DEBUG] Sending REMAP command: explosive_z=${explosiveZ}, remap_radius=${remapRadius}, states_count=${states_1d.length}`, targetModelId);
            }
            networkManager.send({
                command: "REMAP",
                modelId: targetModelId,
                explosive_x: explosiveX,
                explosive_y: explosiveY,
                explosive_z: explosiveZ,
                explosive_r: explosiveR,
                remap_radius: remapRadius,
                r_1d: r_1d,
                states_1d: states_1d,
                
                // Inherited properties
                ambient_rho: serialized1D.ambient_rho,
                ambient_p: serialized1D.atm_pressure ?? serialized1D.ambient_p ?? 101325.0,
                atm_pressure: serialized1D.atm_pressure,
                atm_temperature: serialized1D.atm_temperature,
                gamma: serialized1D.gamma,
                is_ideal_gas: serialized1D.explosive_type === 'MaterialIdealGas' || serialized1D.init_mode === 'Ideal Gas' || serialized1D.is_ideal_gas === true,
                composition: serialized1D.composition,
                explosive_type: serialized1D.explosive_type,
                rho: serialized1D.rho,
                high_rho: serialized1D.rho,
                detonation_energy: serialized1D.detonation_energy,
                det_vel: serialized1D.det_vel,
                jwl_A: serialized1D.jwl_A,
                jwl_B: serialized1D.jwl_B,
                jwl_R1: serialized1D.jwl_R1,
                jwl_R2: serialized1D.jwl_R2,
                jwl_omega: serialized1D.jwl_omega
            });
            return true;
        } catch (err) {
            if (activeSolverNode) {
                stateManager.pushTelemetry(activeSolverNode.id, `[ERROR] Failed to parse 1D telemetry: ${err}`, targetModelId);
            }
            return false;
        }
    };

    // ── INIT ─────────────────────────────────────────────────────────────────
    if (command === "INIT") {
        if (stateManager.getModelStatus(modelId) === 'RUNNING') {
            const sn = getSolverNode(modelId);
            if (sn) stateManager.pushTelemetry(sn.id, "[WARNING] Cannot Init: Model is currently running. Pause or Terminate first.");
            return;
        }

        if (pipeline) {
            // Treat model as isolated: send INIT_2D first, then REMAP from 1D telemetry
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_2D", modelId);
                console.log(`Sending INIT_2D for 2D model ${modelId} in pipeline`);
                networkManager.send(payload);
                sendContourConfig(modelId);
                
                if (tryRemapFrom1D(modelId, pipeline)) {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                } else {
                    stateManager.setModelStatus(modelId, 'UNINITIALIZED');
                }
            }
        }
        else if (has3D) {
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                if (pipeline) {
                    const payload = serializeForSolver(state, "INIT_3D", modelId);
                    networkManager.send(payload);
                    if (tryRemapFrom1D(modelId, pipeline)) {
                        stateManager.setModelStatus(modelId, 'INITIALIZED');
                    }
                } else {
                    const payload = serializeForSolver(state, "INIT_3D", modelId);
                    networkManager.send(payload);
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                }
            }
        }
        else if (has2D) {
            // Standalone 2D model (Ideal Gas / JWL direct init — no remap partner).
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_2D", modelId);
                console.log(`Sending INIT_2D for standalone 2D model ${modelId}`);
                networkManager.send(payload);
                sendContourConfig(modelId);
                stateManager.setModelStatus(modelId, 'INITIALIZED');
            }
        } else {
            // Pure 1D model.
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT", modelId);
                console.log(`Sending INIT (1D) for model ${modelId}`);
                networkManager.send(payload);
                stateManager.setModelStatus(modelId, 'INITIALIZED');
            }
        }

    // ── STEP ──────────────────────────────────────────────────────────────────
    } else if (command === "STEP") {
        const steps = extra.steps || 1;
        const status = stateManager.getModelStatus(modelId);
        if (status === 'UNINITIALIZED' || status === 'TERMINATED') {
            const sn = getSolverNode(modelId);
            if (sn) stateManager.pushTelemetry(sn.id, "[WARNING] Cannot step: solver not initialised. Click Init first.");
            return;
        }
        const cfl = getCflFromSolver();
        
        const has3D = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;
        if (has3D) {
            networkManager.send({ command: "STEP_3D", modelId: modelId, steps, cfl });
        } else if (pipeline || has2D) {
            sendContourConfig(modelId);
            networkManager.send({ command: "STEP_2D", modelId: modelId, steps, cfl });
        } else {
            networkManager.send({ command: "STEP",    modelId: modelId, steps, cfl });
        }
        stateManager.setModelStatus(modelId, 'RUNNING');

    // ── EXEC_ALL ──────────────────────────────────────────────────────────────
    } else if (command === "EXEC_ALL") {
        const status = stateManager.getModelStatus(modelId);
        const cfl = getCflFromSolver();

        const has3D = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;

        if (status === 'UNINITIALIZED' || status === 'TERMINATED') {
            if (has3D) {
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_3D", modelId);
                    networkManager.send(payload);
                    networkManager.send({ command: "EXEC_ALL_3D", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            } else if (pipeline) {
                // Initialize model from 1D telemetry first, then run
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_2D", modelId);
                    console.log(`Sending INIT_2D for 2D model ${modelId} in pipeline`);
                    networkManager.send(payload);
                    sendContourConfig(modelId);
                    
                    if (tryRemapFrom1D(modelId, pipeline)) {
                        networkManager.send({ command: "EXEC_ALL_2D", modelId: modelId, cfl });
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                }
            } else if (has2D) {
                // Standalone 2D model
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_2D", modelId);
                    console.log(`[Auto-Run] Sending INIT_2D for standalone 2D model ${modelId}`);
                    networkManager.send(payload);
                    sendContourConfig(modelId);
                    networkManager.send({ command: "EXEC_ALL_2D", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            } else {
                // Pure 1D model
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT", modelId);
                    console.log(`[Auto-Run] Sending INIT for standalone 1D model ${modelId}`);
                    networkManager.send(payload);
                    networkManager.send({ command: "EXEC_ALL", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            }
        } else {
            // Already initialized / paused
            if (has3D) {
                networkManager.send({ command: "EXEC_ALL_3D", modelId: modelId, cfl });
            } else if (pipeline || has2D) {
                sendContourConfig(modelId);
                networkManager.send({ command: "EXEC_ALL_2D", modelId: modelId, cfl });
            } else {
                networkManager.send({ command: "EXEC_ALL",    modelId: modelId, cfl });
            }
            stateManager.setModelStatus(modelId, 'RUNNING');
        }

    // ── PAUSE ─────────────────────────────────────────────────────────────────
    } else if (command === "PAUSE") {
        const has3D = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;
        if (has3D) {
            networkManager.send({ command: "PAUSE_3D", modelId: modelId });
        } else if (pipeline || has2D) {
            networkManager.send({ command: "PAUSE_2D", modelId: modelId });
        } else {
            networkManager.send({ command: "PAUSE",    modelId: modelId });
        }
        stateManager.setModelStatus(modelId, 'PAUSED');

    // ── TERMINATE ─────────────────────────────────────────────────────────────
    } else if (command === "TERMINATE") {
        const has3D = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;
        if (has3D) {
            networkManager.send({ command: "TERMINATE_3D", modelId: modelId });
        } else if (pipeline || has2D) {
            networkManager.send({ command: "TERMINATE_2D", modelId: modelId });
        } else {
            networkManager.send({ command: "TERMINATE",    modelId: modelId });
        }
        stateManager.setModelStatus(modelId, 'TERMINATED');
        stateManager.setModelProgress(modelId, 0);
    }
}

document.addEventListener('model-action', (e: any) => {
    const { modelId, command, steps } = e.detail;
    if (!networkManager.isConnected()) {
        alert("Error: WebSocket is not connected to the Broker backend. Please ensure the Broker daemon is running.");
        return;
    }
    executeModelCommand(modelId, command, { steps }, false);
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
        
        let type: 'CFDSolver2D' | 'CFDSolver' | 'CFDSolver3D' = 'CFDSolver';
        let model = stateManager.getAllModels().find(m => m.id === modelId);
        if (model) {
            if (model.nodes.some(n => n.type === 'CFDSolver3D')) type = 'CFDSolver3D';
            else if (model.nodes.some(n => n.type === 'CFDSolver2D')) type = 'CFDSolver2D';
        }
        
        let solverNode = model?.nodes.find(n => n.type === type);
        
        if (solverNode) {
            stateManager.pushTelemetry(solverNode.id, payloadBuffer, modelId);
            stateManager.pushTelemetry(solverNode.id + "-binary", payloadBuffer, modelId);
            // Forward 3D slices to viewport
            if (type === 'CFDSolver3D') {
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TELEMETRY_3D') comp.instance.pushFrame(payloadBuffer.slice(0));
                });
            }
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
        let targetType: 'CFDSolver2D' | 'CFDSolver' | 'CFDSolver3D' = 'CFDSolver';
        if (dataJson.type === 'progress_3d' || dataJson.type === 'TELEMETRY_3D' || dataJson.scope === '3d') {
            targetType = 'CFDSolver3D';
        } else if (dataJson.type === 'progress_2d' || dataJson.type === 'TELEMETRY_2D' || dataJson.scope === '2d') {
            targetType = 'CFDSolver2D';
        } else if (dataJson.type === 'progress' || dataJson.type === 'TELEMETRY') {
            targetType = 'CFDSolver';
        } else if (dataJson.type === 'log') {
            const msg = dataJson.message || "";
            const is3DLog = msg.includes("3D") || msg.includes("3d");
            const is2DLog = msg.includes("2D") || msg.includes("REMAP") || msg.includes("vtk") || msg.includes("2d");
            if (is3DLog) targetType = 'CFDSolver3D';
            else if (is2DLog) targetType = 'CFDSolver2D';
            else targetType = 'CFDSolver';
        }

        let model = stateManager.getAllModels().find(m => m.id === modelId);

        if (dataJson.type === 'log') {
            if (modelId && model) {
                const solverNode = model.nodes.find(n => n.type === targetType);
                if (solverNode) {
                    stateManager.pushTelemetry(solverNode.id, dataJson.message, modelId);
                }
            }
            return;
        }

        if (dataJson.type === 'progress' || dataJson.type === 'progress_2d') {
            if (modelId) {
                stateManager.setModelProgress(modelId, dataJson.percent);
                stateManager.setModelSimTime(modelId, dataJson.sim_time);
                
                if (dataJson.percent === 100) {
                    const currentStatus = stateManager.getModelStatus(modelId);
                    if (currentStatus !== 'TERMINATED') {
                        stateManager.setModelStatus(modelId, 'PAUSED');
                    }
                } else if (dataJson.percent < 100) {
                    const currentStatus = stateManager.getModelStatus(modelId);
                    if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                }

                if (model) {
                    const solverNode = model.nodes.find(n => n.type === targetType);
                    if (solverNode) {
                        stateManager.pushTelemetry(solverNode.id, dataJson, modelId);
                    }
                }
            }
            return;
        }

        if (dataJson.type === 'TELEMETRY' || dataJson.type === 'TELEMETRY_2D' || dataJson.type === 'TELEMETRY_3D') {
            if (modelId) {
                stateManager.setModelSimTime(modelId, dataJson.time);
                if (dataJson.time === 0) {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                    stateManager.setModelProgress(modelId, 0);
                } else if (dataJson.is_terminated === true) {
                    stateManager.setModelStatus(modelId, 'TERMINATED');
                } else if (dataJson.type === 'TELEMETRY_2D') {
                    // Check if we just transitioned from 1D phase (progress is 100)
                    const currentProgress = stateManager.getModelProgress(modelId);
                    if (currentProgress === 100) {
                        stateManager.setModelProgress(modelId, 0);
                        stateManager.setModelStatus(modelId, 'PAUSED');
                    } else {
                        const currentStatus = stateManager.getModelStatus(modelId);
                        if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                            stateManager.setModelStatus(modelId, 'RUNNING');
                        }
                    }
                } else {
                    const currentStatus = stateManager.getModelStatus(modelId);
                    if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                }

                if (model) {
                    const solverNode = model.nodes.find(n => n.type === targetType);
                    if (solverNode) {
                        stateManager.pushTelemetry(solverNode.id, dataJson, modelId);
                    }
                }
                if (dataJson.type === 'TELEMETRY_3D') {
                    layoutManager.components.forEach(comp => {
                        if (comp.type === 'TELEMETRY_3D') comp.instance.updateTelemetry(dataJson);
                    });
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

