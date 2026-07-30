import { StateManager } from './state-manager.js';
import { SimulationState, SimulationStatus, LayoutNode } from './types.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver, serializeToBinary, deserializeFromBinary } from './serialization.js';
import { LayoutManager } from './layout-manager.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { CustomDialog } from './custom-dialog.js';

// Redirect console.error and unhandled errors to WebSocket (once connected)
const originalConsoleError = console.error;
const pendingLogs: string[] = [];

function sendLogToBroker(msg: string) {
    const net = (window as any).networkManager;
    if (net && net.isConnected()) {
        net.send({
            command: "BROWSER_LOG",
            message: msg
        });
    } else {
        pendingLogs.push(msg);
    }
}

// Flush pending logs when connected
window.addEventListener('load', () => {
    setInterval(() => {
        const net = (window as any).networkManager;
        if (net && net.isConnected() && pendingLogs.length > 0) {
            while (pendingLogs.length > 0) {
                const log = pendingLogs.shift();
                if (log) net.send({ command: "BROWSER_LOG", message: log });
            }
        }
    }, 1000);
});

console.error = function(...args) {
    originalConsoleError.apply(console, args);
    sendLogToBroker("[CONSOLE_ERROR] " + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

window.addEventListener('error', (event) => {
    sendLogToBroker("[UNHANDLED_ERROR] " + event.message + " at " + event.filename + ":" + event.lineno + ":" + event.colno);
});

window.addEventListener('unhandledrejection', (event) => {
    sendLogToBroker("[UNHANDLED_REJECTION] " + String(event.reason));
});

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
                left_bc: 'Reflecting',
                right_bc: 'Terminate',
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
                atm_temperature: 288.0,
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
                charge_mass: 0.853479,
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
            parameters: { init_mode: 'Multi-Material JWL', cfl: 0.4, flux_scheme: 'AUSM+', spatial_order: 2, temporal_order: 2 }
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
    const solver = state?.nodes?.find(n => n.type === 'CFDSolver3D') || state?.nodes?.find(n => n.type === 'CFDSolver2D') || state?.nodes?.find(n => n.type === 'CFDSolver');
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
    layoutManager.resetAllResourceManagers();
});

// Event Delegation for Simulation Controls and Menus (since they are injected dynamically)
document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;

    // --- File Menu Actions (Model-level) ---
    if (target.id === 'menu-new-model') {
        const name = await CustomDialog.prompt("Enter name for the new model:", `Model ${stateManager.getAllModels().length + 1}`);
        if (name !== null) {
            stateManager.createModel(name.trim() || undefined);
        }
    }

    if (target.id === 'menu-rename-model') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            const model = stateManager.getWorkspaceModels().find(m => m.id === activeWs.activeModelId);
            if (model) {
                const newName = await CustomDialog.prompt("Enter new model name:", model.name, "Rename Model");
                if (newName && newName.trim() && newName.trim() !== model.name) {
                    stateManager.renameModel(model.id, newName.trim());
                }
            }
        } else {
            await CustomDialog.alert("No active model to rename.");
        }
    }

    if (target.id === 'menu-load-json') {
        const activeWs = stateManager.getActiveWorkspace();
        const startPath = activeWs.activeModelId 
            ? (stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)?.filename || "") 
            : "";
        const browser = new HostFileBrowserModal(networkManager, 'open', '', (path) => {
            networkManager.send({
                command: "LOAD_MODEL_FILE",
                modelId: activeWs.activeModelId || "default",
                filePath: path
            });
        });
        browser.open(startPath);
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
                
                // If model has a valid host absolute path, save directly
                if (model.filename && model.filename.includes('/')) {
                    networkManager.send({
                        command: "SAVE_MODEL_FILE",
                        modelId: model.id,
                        filePath: model.filename,
                        fileContent: jsonString
                    });
                } else {
                    // Fall back to Save As
                    const browser = new HostFileBrowserModal(networkManager, 'save', model.filename || `${model.name.toLowerCase().replace(/\s+/g, '_')}.json`, (path) => {
                        networkManager.send({
                            command: "SAVE_MODEL_FILE",
                            modelId: model.id,
                            filePath: path,
                            fileContent: jsonString
                        });
                    });
                    browser.open(model.filename || "");
                }
            }
        } else {
            await CustomDialog.alert("No active model to save.");
        }
    }

    if (target.id === 'menu-save-as-local') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            const model = stateManager.getWorkspaceModels().find(m => m.id === activeWs.activeModelId);
            if (model) {
                const jsonString = JSON.stringify({
                    name: model.name,
                    nodes: model.nodes,
                    connections: model.connections
                }, null, 2);
                
                const browser = new HostFileBrowserModal(networkManager, 'save', model.filename || `${model.name.toLowerCase().replace(/\s+/g, '_')}.json`, (path) => {
                    networkManager.send({
                        command: "SAVE_MODEL_FILE",
                        modelId: model.id,
                        filePath: path,
                        fileContent: jsonString
                    });
                });
                browser.open(model.filename || "");
            }
        } else {
            await CustomDialog.alert("No active model to save.");
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
            await CustomDialog.alert("No active model to save.");
        }
    }

    if (target.id === 'menu-copy-model') {
        const activeWs = stateManager.getActiveWorkspace();
        if (activeWs.activeModelId) {
            stateManager.copyModelToClipboard(activeWs.activeModelId);
            console.log(`Copied active model to clipboard: ${activeWs.activeModelId}`);
        } else {
            await CustomDialog.alert("No active model to copy.");
        }
    }

    if (target.id === 'menu-paste-model') {
        const pasted = stateManager.pasteModelFromClipboard();
        if (pasted) {
            console.log(`Pasted model from clipboard: ${pasted.id}`);
        } else {
            await CustomDialog.alert("Clipboard is empty. Copy a model first.");
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
            await CustomDialog.alert("No other models available. Use 'File -> New Model' to create a new model first.");
        } else {
            const modelNames = otherModels.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n');
            const choice = await CustomDialog.prompt(`Select a model to add to this workspace (enter number 1-${otherModels.length}):\n${modelNames}`);
            const idx = parseInt(choice || '') - 1;
            if (idx >= 0 && idx < otherModels.length) {
                stateManager.addModelToWorkspace(otherModels[idx]);
            }
        }
    }

    if (target.id === 'menu-remove-model') {
        const wsModels = stateManager.getWorkspaceModels();
        if (wsModels.length === 0) {
            await CustomDialog.alert("No models in this workspace to remove.");
        } else {
            const modelNames = wsModels.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n');
            const choice = await CustomDialog.prompt(`Select a model to remove from this workspace (enter number 1-${wsModels.length}):\n${modelNames}`);
            const idx = parseInt(choice || '') - 1;
            if (idx >= 0 && idx < wsModels.length) {
                stateManager.removeModelFromWorkspace(wsModels[idx].id);
            }
        }
    }

    if (target.id === 'menu-save-workspace') {
        stateManager.saveWorkspace();
        await CustomDialog.alert("Workspace and all models saved successfully to browser local storage.");
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
                reader.onload = async (event) => {
                    try {
                        const parsed = JSON.parse(event.target?.result as string);
                        if (parsed.models && parsed.workspaces && parsed.activeWorkspaceId) {
                            stateManager.loadAppState(parsed);
                            console.log("Workspace state imported successfully.");
                        } else {
                            await CustomDialog.alert("Invalid workspace project file.");
                        }
                    } catch (err) {
                        await CustomDialog.alert("Failed to parse workspace project file: " + err);
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        }
    }

    if (target.id === 'menu-save-workspace-host') {
        const activeWs = stateManager.getActiveWorkspace();
        if (!activeWs) {
            await CustomDialog.alert("No active workspace to save.");
            return;
        }

        const startPath = activeWs.activeModelId 
            ? (stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)?.filename || "") 
            : "";

        const browser = new HostFileBrowserModal(
            networkManager,
            'save',
            `${activeWs.name.toLowerCase().replace(/\s+/g, '_')}_workspace.json`,
            async (fullPath) => {
                const lastSlash = fullPath.lastIndexOf('/');
                const dirPath = lastSlash !== -1 ? fullPath.substring(0, lastSlash) : '.';

                // 1. Create directory on host
                networkManager.send({
                    command: "CREATE_DIR",
                    path: dirPath
                });

                // 2. Save each model referenced in this workspace to the directory
                const models = stateManager.getWorkspaceModels();
                models.forEach(model => {
                    const modelFilename = `${model.name.toLowerCase().replace(/\s+/g, '_')}.json`;
                    const modelPath = `${dirPath}/${modelFilename}`;
                    const modelJson = JSON.stringify({
                        name: model.name,
                        nodes: model.nodes,
                        connections: model.connections
                    }, null, 2);

                    networkManager.send({
                        command: "SAVE_MODEL_FILE",
                        modelId: `ws-silent-${model.id}`,
                        filePath: modelPath,
                        fileContent: modelJson
                    });
                });

                // 3. Save the self-contained workspace JSON
                const wsContent = JSON.stringify({
                    type: "blast_workspace_file",
                    version: 1,
                    workspace: {
                        id: activeWs.id,
                        name: activeWs.name,
                        layout: activeWs.layout,
                        connections: activeWs.connections,
                        modelIds: activeWs.modelIds,
                        activeModelId: activeWs.activeModelId
                    },
                    models: models.map(m => ({
                        id: m.id,
                        name: m.name,
                        filename: `${dirPath}/${m.name.toLowerCase().replace(/\s+/g, '_')}.json`,
                        nodes: m.nodes,
                        connections: m.connections
                    }))
                }, null, 2);

                networkManager.send({
                    command: "SAVE_MODEL_FILE",
                    modelId: "workspace",
                    filePath: fullPath,
                    fileContent: wsContent
                });
            }
        );
        browser.open(startPath);
    }

    if (target.id === 'menu-load-workspace-host') {
        const activeWs = stateManager.getActiveWorkspace();
        const startPath = activeWs.activeModelId 
            ? (stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)?.filename || "") 
            : "";

        const browser = new HostFileBrowserModal(
            networkManager,
            'open',
            '',
            (path) => {
                networkManager.send({
                    command: "LOAD_MODEL_FILE",
                    modelId: "workspace",
                    filePath: path
                });
            }
        );
        browser.open(startPath);
    }

    if (target.id === 'menu-reset-all') {
        const proceed = await CustomDialog.confirm("CRITICAL: This will flush all local storage and reload the application. Proceed?");
        if (proceed) {
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
    sourceModelId: string; // model containing source solver (1D or 2D phase)
    targetModelId: string; // model containing target solver + remapper node
    model1dId: string;     // alias for sourceModelId (backwards compatibility)
    model2dId: string;     // alias for targetModelId (backwards compatibility)
    sourceType: '1D' | '2D';
    processId: string;     // canonical broker key = targetModelId
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

        const toModel  = allModels.find(m => m.id === toModelId);
        const toNode   = toModel?.nodes.find(n => n.id === conn.toNode);
        if (!toNode) continue;

        if (toNode.type === 'RemapNode' || toNode.type === 'Remap1DTo2DNode' || toNode.type === 'Remap1DTo3DNode') {
            const isRemapConnected = toModel?.connections.some(c => c.fromNode === toNode.id && (c.toPort === 'remap' || c.toPort === 'in'));
            if (!isRemapConnected) continue;

            const fromModel = allModels.find(m => m.id === fromModelId);
            if (!fromModel?.nodes.some(n => n.type === 'CFDSolver')) continue;

            if (modelId === toModelId) {
                return {
                    sourceModelId: fromModelId,
                    targetModelId: toModelId,
                    model1dId: fromModelId,
                    model2dId: toModelId,
                    sourceType: '1D',
                    processId: toModelId,
                };
            }
        } else if (toNode.type === 'Remap2DTo3DNode') {
            const isRemapConnected = toModel?.connections.some(c => c.fromNode === toNode.id && (c.toPort === 'remap' || c.toPort === 'in'));
            if (!isRemapConnected) continue;

            const fromModel = allModels.find(m => m.id === fromModelId);
            if (!fromModel?.nodes.some(n => n.type === 'CFDSolver2D')) continue;

            if (modelId === toModelId) {
                return {
                    sourceModelId: fromModelId,
                    targetModelId: toModelId,
                    model1dId: fromModelId,
                    model2dId: toModelId,
                    sourceType: '2D',
                    processId: toModelId,
                };
            }
        }
    }
    return null;
}

function sendContourConfig(targetId: string) {
    const m = stateManager.getAllModels().find(model => model.id === targetId);
    if (m) {
        const contourNode = m.nodes.find(n => n.type === 'TelemetryContour');
        if (contourNode) {
            const isConnected = m.connections.some(c => c.toNode === contourNode.id || c.fromNode === contourNode.id);
            if (!isConnected) return;
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
}

function sendView3DConfig(targetId: string) {
    const m = stateManager.getAllModels().find(model => model.id === targetId);
    if (m) {
        const view3DNode = m.nodes.find(n => n.type === 'Telemetry3DViewport');
        if (view3DNode) {
            const isConnected = m.connections.some(c => c.toNode === view3DNode.id || c.fromNode === view3DNode.id);
            if (!isConnected) return;
            const showObstacles = view3DNode.parameters?.show_obstacles === true;
            const obstaclesQuantity = view3DNode.parameters?.obstacles_quantity || 'pressure';
            const showStl = view3DNode.parameters?.show_stl === true;
            const stlQuantity = view3DNode.parameters?.stl_quantity || 'pressure';
            
            const slices = [...(view3DNode.parameters?.slices || [])];
            if (showObstacles) {
                slices.push({
                    axis: 'obstacles',
                    offset: 0.0,
                    quantities: [obstaclesQuantity],
                    stride: 1
                });
            }
            if (showStl) {
                slices.push({
                    axis: 'volume',
                    offset: 0.0,
                    quantities: [stlQuantity],
                    stride: 1
                });
            }
            
            const rate = Number(view3DNode.parameters?.refresh_rate ?? 2.0);
            networkManager.send({
                command: "VIEW3D_CONFIG",
                modelId: targetId,
                slices,
                refresh_rate: rate
            });
        }
    }
}

function tryRemapFrom1D(targetModelId: string, pipe: any): boolean {
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
            stateManager.pushTelemetry(activeSolverNode.id, `[INFO] No 1D simulation telemetry found. Automatically initializing and running 1D model (${pipe.model1dId})...`, targetModelId);
        }
        if (pipe.model1dId) {
            console.log(`[tryRemapFrom1D] Auto-running 1D model ${pipe.model1dId} to generate remap profile.`);
            executeModelCommand(pipe.model1dId, "INIT", {}, false);
            executeModelCommand(pipe.model1dId, "EXEC_ALL", {}, false);
        }
        return false;
    }

    try {
        const meshConn1D = model1d?.connections.find(c => c.toNode === solver1DNode!.id && c.toPort === 'mesh');
        const meshNode1D = meshConn1D ? model1d?.nodes.find(n => n.id === meshConn1D.fromNode) : model1d?.nodes.find(n => n.type === 'DomainMesh');
        const cell_size = Number(meshNode1D?.parameters?.cell_size ?? 0.001);
        const gamma = Number(solver1DNode?.parameters?.gamma ?? 1.4);

        const view = new DataView(telemetry);
        const n_cells = view.getUint32(0, true);
        const n_channels = view.getUint32(4, true);
        const floats = new Float32Array(telemetry, 8);
        
        const r_1d: number[] = [];
        const rho_1d: number[] = [];
        const ur_1d: number[] = [];
        const p_1d: number[] = [];
        const states_1d: any[] = [];

        // Planar channel layout in C++ getTelemetryChannels():
        // Ch 0: Pressure | Ch 1: Density | Ch 2: Velocity | Ch 3: Internal Energy | Ch 4: Alpha1 | Ch 5: Alpha2 | Ch 6: Air
        const p_offset      = 0 * n_cells;
        const rho_offset    = 1 * n_cells;
        const u_offset      = 2 * n_cells;
        const alpha1_offset = 4 * n_cells;
        const alpha2_offset = 5 * n_cells;

        for (let i = 0; i < n_cells; ++i) {
            const r = (i + 0.5) * cell_size;
            const p = floats[p_offset + i];
            const rho = floats[rho_offset + i];
            const u = floats[u_offset + i];
            const a1 = (n_channels > 4) ? floats[alpha1_offset + i] : 0.0;
            const a2 = (n_channels > 5) ? floats[alpha2_offset + i] : 1.0;

            r_1d.push(r);
            p_1d.push(p);
            rho_1d.push(rho);
            ur_1d.push(u);

            const ar1 = a1 * rho;
            const ar2 = a2 * rho;
            const E = (gamma > 1.0) ? (p / (gamma - 1.0) + 0.5 * rho * u * u) : p;

            states_1d.push({
                rho: rho,
                u: u,
                p: p,
                E: E,
                alpha1: a1,
                alpha2: a2,
                arho1: ar1,
                arho2: ar2
            });
        }

        const serialized1D = solver1DNode?.parameters || {};

        const remapConn = model?.connections.find(c => (c.toNode === solver2DNode?.id || c.toNode === solver3DNode?.id) && c.toPort === 'remap');
        const remapNode = remapConn ? model?.nodes.find(n => n.id === remapConn.fromNode) : null;

        const explosive_x = Number(remapNode?.parameters?.explosive_x ?? 0.5);
        const explosive_y = Number(remapNode?.parameters?.explosive_y ?? 0.5);
        const explosive_z = Number(remapNode?.parameters?.explosive_z ?? (remapNode?.parameters?.explosive_r ?? 0.1));
        const explosive_r = Number(remapNode?.parameters?.explosive_r ?? 0.0);
        const remap_radius = Number(remapNode?.parameters?.remap_radius ?? (n_cells * cell_size));

        const meshConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'mesh');
        const meshNode3D = meshConn3D ? model?.nodes.find(n => n.id === meshConn3D.fromNode) : null;
        const bc_x_min = String(meshNode3D?.parameters?.bc_x_min ?? solver3DNode?.parameters?.bc_x_min ?? 'Reflecting');
        const bc_x_max = String(meshNode3D?.parameters?.bc_x_max ?? solver3DNode?.parameters?.bc_x_max ?? 'Transmitting');
        const bc_y_min = String(meshNode3D?.parameters?.bc_y_min ?? solver3DNode?.parameters?.bc_y_min ?? 'Reflecting');
        const bc_y_max = String(meshNode3D?.parameters?.bc_y_max ?? solver3DNode?.parameters?.bc_y_max ?? 'Transmitting');
        const bc_z_min = String(meshNode3D?.parameters?.bc_z_min ?? solver3DNode?.parameters?.bc_z_min ?? 'Reflecting');
        const bc_z_max = String(meshNode3D?.parameters?.bc_z_max ?? solver3DNode?.parameters?.bc_z_max ?? 'Transmitting');

        console.log(`[tryRemapFrom1D] Sending REMAP payload for target ${targetModelId} with ${n_cells} cells. Center: (${explosive_x}, ${explosive_y}, ${explosive_z}), radius: ${remap_radius}`);
        networkManager.send({
            command: "REMAP",
            modelId: targetModelId,
            explosive_x: explosive_x,
            explosive_y: explosive_y,
            explosive_z: explosive_z,
            explosive_r: explosive_r,
            remap_radius: remap_radius,
            bc_x_min: bc_x_min,
            bc_x_max: bc_x_max,
            bc_y_min: bc_y_min,
            bc_y_max: bc_y_max,
            bc_z_min: bc_z_min,
            bc_z_max: bc_z_max,
            r_1d: r_1d,
            states_1d: states_1d,
            rho_1d: rho_1d,
            ur_1d: ur_1d,
            p_1d: p_1d,
            ambient_rho: Number(serialized1D.ambient_rho ?? 1.225),
            ambient_p: Number(serialized1D.ambient_p ?? 101325.0),
            gamma: Number(serialized1D.gamma ?? 1.4),
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
}

function tryRemapFrom2D(targetModelId: string, pipe: any): boolean {
    const model = stateManager.getAllModels().find(m => m.id === targetModelId);
    const model2d = stateManager.getAllModels().find(m => m.id === (pipe.sourceModelId || pipe.model2dId));
    const solver2DNode = model2d?.nodes.find(n => n.type === 'CFDSolver2D');
    const telemetry = solver2DNode ? stateManager.getTelemetry(solver2DNode.id + "-binary") : null;
    
    const solver3DNode = model?.nodes.find(n => n.type === 'CFDSolver3D');

    if (solver3DNode) {
        stateManager.pushTelemetry(solver3DNode.id, `[DEBUG] tryRemapFrom2D starting. target=${targetModelId} 2dModel=${pipe.sourceModelId || pipe.model2dId} node=${solver2DNode?.id ?? 'null'} telemetry=${telemetry ? ('ArrayBuffer(' + telemetry.byteLength + ')') : 'null'}`, targetModelId);
    }

    if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[INFO] No 2D simulation telemetry found. Automatically initializing and running 2D model (${pipe.sourceModelId || pipe.model2dId})...`, targetModelId);
        }
        const sId = pipe.sourceModelId || pipe.model2dId;
        if (sId) {
            console.log(`[tryRemapFrom2D] Auto-running 2D model ${sId} to generate remap profile.`);
            executeModelCommand(sId, "INIT", {}, false);
            executeModelCommand(sId, "EXEC_ALL", {}, false);
        }
        return false;
    }

    try {
        const meshConn2D = model2d?.connections.find(c => c.toNode === solver2DNode!.id && c.toPort === 'mesh');
        const meshNode2D = meshConn2D ? model2d?.nodes.find(n => n.id === meshConn2D.fromNode) : null;
        const raw_cell_size = Number(meshNode2D?.parameters?.cell_size ?? 0.005);
        const max_r = Number(meshNode2D?.parameters?.max_r ?? 1.0);
        const max_z = Number(meshNode2D?.parameters?.max_z ?? 1.0);

        const view = new DataView(telemetry);
        const nr = view.getUint32(0, true);
        const nz = view.getUint32(4, true);
        const num_materials = view.getUint32(8, true);
        const floats = new Float32Array(telemetry, 12);

        // Adjust 2D cell_size for telemetry stride so 3D spatial extent equals original max_r / max_z
        const orig_nr = Math.round(max_r / raw_cell_size);
        const stride = (nr > 0 && orig_nr > 0) ? Math.max(1, Math.round(orig_nr / nr)) : 1;
        const cell_size = raw_cell_size * stride;
        
        const remapConn = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'remap');
        const remapNode = remapConn ? model?.nodes.find(n => n.id === remapConn.fromNode) : null;

        // Extract 3D target domain parameters
        const meshConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'mesh');
        const meshNode3D = meshConn3D ? model?.nodes.find(n => n.id === meshConn3D.fromNode) : null;
        const cell_size_3d = Number(meshNode3D?.parameters?.cell_size ?? 0.01);
        const xmin_3d = Number(meshNode3D?.parameters?.xmin ?? meshNode3D?.parameters?.x_min ?? 0.0);
        const xmax_3d = Number(meshNode3D?.parameters?.xmax ?? meshNode3D?.parameters?.x_max ?? 1.0);
        const ymin_3d = Number(meshNode3D?.parameters?.ymin ?? meshNode3D?.parameters?.y_min ?? 0.0);
        const ymax_3d = Number(meshNode3D?.parameters?.ymax ?? meshNode3D?.parameters?.y_max ?? 1.0);
        const zmin_3d = Number(meshNode3D?.parameters?.zmin ?? meshNode3D?.parameters?.z_min ?? 0.0);
        const zmax_3d = Number(meshNode3D?.parameters?.zmax ?? meshNode3D?.parameters?.z_max ?? 1.0);

        // Auto-inherit explosive_x/y/z from 3D charge/detonator node if connected, or fallback to domain center
        const detConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && (c.toPort === 'detonator' || c.toPort === 'detonator_location'));
        const detNode3D = detConn3D ? model?.nodes.find(n => n.id === detConn3D.fromNode) : null;
        const chargeConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
        const chargeNode3D = chargeConn3D ? model?.nodes.find(n => n.id === chargeConn3D.fromNode) : null;

        let default_x = (xmin_3d + xmax_3d) / 2.0;
        let default_y = (ymin_3d + ymax_3d) / 2.0;
        let default_z = zmin_3d;

        if (detNode3D?.parameters) {
            default_x = Number(detNode3D.parameters.detonator_x ?? detNode3D.parameters.x ?? default_x);
            default_y = Number(detNode3D.parameters.detonator_y ?? detNode3D.parameters.y ?? default_y);
            default_z = Number(detNode3D.parameters.detonator_z ?? detNode3D.parameters.z ?? default_z);
        } else if (chargeNode3D?.parameters) {
            default_x = Number(chargeNode3D.parameters.x ?? chargeNode3D.parameters.charge_x ?? default_x);
            default_y = Number(chargeNode3D.parameters.y ?? chargeNode3D.parameters.charge_y ?? default_y);
            default_z = Number(chargeNode3D.parameters.z ?? chargeNode3D.parameters.charge_z ?? default_z);
        }

        const explosive_x = Number(remapNode?.parameters?.explosive_x ?? default_x);
        const explosive_y = Number(remapNode?.parameters?.explosive_y ?? default_y);
        const explosive_z = Number(remapNode?.parameters?.explosive_z ?? default_z);
        const remap_radius = Number(remapNode?.parameters?.remap_radius ?? 0.0);
        const nx_3d = Math.max(1, Math.round((xmax_3d - xmin_3d) / cell_size_3d));
        const ny_3d = Math.max(1, Math.round((ymax_3d - ymin_3d) / cell_size_3d));
        const nz_3d = Math.max(1, Math.round((zmax_3d - zmin_3d) / cell_size_3d));
        const device = String(solver3DNode?.parameters?.device ?? 'cuda');
        const precision = String(solver3DNode?.parameters?.precision ?? 'single');

        // Extract 2D source detonator z location
        const detConn2D = model2d?.connections.find(c => c.toNode === solver2DNode!.id && c.toPort === 'detonator');
        const detNode2D = detConn2D ? model2d?.nodes.find(n => n.id === detConn2D.fromNode) : null;
        let source_explosive_z = 0.0;
        if (detNode2D && detNode2D.parameters) {
            source_explosive_z = Number(detNode2D.parameters.detonator_z ?? detNode2D.parameters.explosive_z ?? 0.0);
        } else {
            const chargeConn2D = model2d?.connections.find(c => c.toNode === solver2DNode!.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            const chargeNode2D = chargeConn2D ? model2d?.nodes.find(n => n.id === chargeConn2D.fromNode) : null;
            if (chargeNode2D && chargeNode2D.parameters) {
                source_explosive_z = Number(chargeNode2D.parameters.charge_z ?? chargeNode2D.parameters.explosive_z ?? 0.0);
            }
        }

        // Extract material and ambient parameters from 2D model
        const airConn2D = model2d?.connections.find(c => c.toNode === solver2DNode!.id && c.toPort === 'air');
        const airNode2D = airConn2D ? model2d?.nodes.find(n => n.id === airConn2D.fromNode) : null;
        const gamma = Number(airNode2D?.parameters?.gamma ?? solver2DNode?.parameters?.gamma ?? 1.4);
        const atm_p = Number(airNode2D?.parameters?.atm_pressure ?? 101325.0);
        const atm_t = Number(airNode2D?.parameters?.atm_temperature ?? 288.0);
        const ambient_rho = atm_p / (287.058 * atm_t);

        const expConn2D = model2d?.connections.find(c => c.toNode === solver2DNode!.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
        const chargeNode2D = expConn2D ? model2d?.nodes.find(n => n.id === expConn2D.fromNode) : null;
        const matConn2D = chargeNode2D ? model2d?.connections.find(c => c.toNode === chargeNode2D.id && c.toPort === 'material') : null;
        const matNode2D = matConn2D ? model2d?.nodes.find(n => n.id === matConn2D.fromNode) : null;

        const matType = matNode2D?.parameters?.material_type ?? 'JWL Charge';
        const explosive_type = matType === 'Ideal Gas Charge' ? 'MaterialIdealGas' : 'MaterialExplosive';
        const composition = matNode2D?.parameters?.composition ?? 'TNT';
        const rho = Number(matNode2D?.parameters?.rho ?? 1630.0);
        const detonation_energy = Number(matNode2D?.parameters?.detonation_energy ?? 4290000);
        const det_vel = Number(matNode2D?.parameters?.det_vel ?? 6930);
        const jwl_A = Number(matNode2D?.parameters?.jwl_A ?? 373.77e9);
        const jwl_B = Number(matNode2D?.parameters?.jwl_B ?? 3.747e9);
        const jwl_R1 = Number(matNode2D?.parameters?.jwl_R1 ?? 4.15);
        const jwl_R2 = Number(matNode2D?.parameters?.jwl_R2 ?? 0.90);
        const jwl_omega = Number(matNode2D?.parameters?.jwl_omega ?? 0.35);

        const bc_x_min = String(meshNode3D?.parameters?.bc_x_min ?? solver3DNode?.parameters?.bc_x_min ?? 'Reflecting');
        const bc_x_max = String(meshNode3D?.parameters?.bc_x_max ?? solver3DNode?.parameters?.bc_x_max ?? 'Transmitting');
        const bc_y_min = String(meshNode3D?.parameters?.bc_y_min ?? solver3DNode?.parameters?.bc_y_min ?? 'Reflecting');
        const bc_y_max = String(meshNode3D?.parameters?.bc_y_max ?? solver3DNode?.parameters?.bc_y_max ?? 'Transmitting');
        const bc_z_min = String(meshNode3D?.parameters?.bc_z_min ?? solver3DNode?.parameters?.bc_z_min ?? 'Reflecting');
        const bc_z_max = String(meshNode3D?.parameters?.bc_z_max ?? solver3DNode?.parameters?.bc_z_max ?? 'Transmitting');

        console.log(`[tryRemapFrom2D] Sending REMAP_2D payload for target ${targetModelId} with ${nr}x${nz} cells. 3D Center: (${explosive_x}, ${explosive_y}, ${explosive_z}), 2D detonator_z: ${source_explosive_z}, radius: ${remap_radius}`);
        networkManager.send({
            command: "REMAP_2D",
            modelId: targetModelId,
            nr: nr,
            nz: nz,
            cell_size: cell_size,
            max_r: max_r,
            max_z: max_z,
            cell_size_3d: cell_size_3d,
            xmin_3d: xmin_3d,
            ymin_3d: ymin_3d,
            zmin_3d: zmin_3d,
            nx_3d: nx_3d,
            ny_3d: ny_3d,
            nz_3d: nz_3d,
            device: device,
            precision: precision,
            bc_x_min: bc_x_min,
            bc_x_max: bc_x_max,
            bc_y_min: bc_y_min,
            bc_y_max: bc_y_max,
            bc_z_min: bc_z_min,
            bc_z_max: bc_z_max,
            explosive_x: explosive_x,
            explosive_y: explosive_y,
            explosive_z: explosive_z,
            source_explosive_z: source_explosive_z,
            remap_radius: remap_radius,
            num_materials: num_materials,
            gamma: gamma,
            ambient_rho: ambient_rho,
            ambient_p: atm_p,
            explosive_type: explosive_type,
            composition: composition,
            rho: rho,
            detonation_energy: detonation_energy,
            det_vel: det_vel,
            jwl_A: jwl_A,
            jwl_B: jwl_B,
            jwl_R1: jwl_R1,
            jwl_R2: jwl_R2,
            jwl_omega: jwl_omega,
            telemetry_data: Array.from(floats)
        });
        return true;
    } catch (err) {
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[ERROR] Failed to parse 2D telemetry: ${err}`, targetModelId);
        }
        return false;
    }
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
    
    if (model) {
        const solver1Ds = model.nodes.filter(n => n.type === 'CFDSolver');
        const solver2Ds = model.nodes.filter(n => n.type === 'CFDSolver2D');
        const solver3Ds = model.nodes.filter(n => n.type === 'CFDSolver3D');
        const totalSolvers = solver1Ds.length + solver2Ds.length + solver3Ds.length;
        const isFSICoupled = model.nodes.some(n => n.type === 'FSICoupler2D');
        if (totalSolvers > 1 && !isFSICoupled) {
            const msg = "Multiple solvers detected on the same canvas! BlastDaemon architecture requires exactly ONE solver per model tab (unless coupled via an FSI Coupler node). Please cut and paste your second simulation into a 'New Model'.";
            stateManager.pushTelemetry(modelId, "[ERROR] " + msg);
            alert(msg);
            return;
        }
    }

    const has2D       = model?.nodes.some(n => n.type === 'CFDSolver2D') || false;
    const hasMPM2D    = model?.nodes.some(n => n.type === 'MPMDomain2D') || false;
    const hasCoupler  = model?.nodes.some(n => n.type === 'FSICoupler2D') || false;
    const hasFSI2D    = hasCoupler || (has2D && hasMPM2D);
    const pipeline = findRemapPipeline(modelId);
    const has3D      = model?.nodes.some(n => n.type === 'CFDSolver3D') || false;

    // Helper to get solver node for logging
    const getSolverNode = (mid: string) => {
        const m = stateManager.getAllModels().find(m => m.id === mid);
        return m?.nodes.find(n => n.type === 'FSICoupler2D' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver' || n.type === 'MPMDomain2D');
    };
    // ── INIT ─────────────────────────────────────────────────────────────────
    if (command === "INIT") {
        stateManager.setModelProgress(modelId, 0);
        stateManager.setModelSimTime(modelId, 0.0);

        if (has3D) {
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_3D", modelId, model?.filename);
                console.log(`[INIT_3D] Payload for ${modelId}:`, JSON.parse(payload));
                networkManager.send(payload);
                sendView3DConfig(modelId);
                if (pipeline) {
                    const success = pipeline.sourceType === '2D' ? tryRemapFrom2D(modelId, pipeline) : tryRemapFrom1D(modelId, pipeline);
                    if (success) {
                        stateManager.setModelStatus(modelId, 'INITIALIZED');
                    } else {
                        stateManager.setModelStatus(modelId, 'UNINITIALIZED');
                    }
                } else {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                }
            }
        }
        else if (hasFSI2D) {
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_FSI_2D", modelId, model?.filename);
                console.log(`Sending INIT_FSI_2D for 2D FSI model ${modelId}`);
                networkManager.send(payload);
                sendContourConfig(modelId);
                stateManager.setModelStatus(modelId, 'INITIALIZED');
            }
        }
        else if (hasMPM2D) {
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_MPM", modelId, model?.filename);
                console.log(`Sending INIT_MPM for MPM 2D model ${modelId}`);
                networkManager.send(payload);
                sendContourConfig(modelId);
                stateManager.setModelStatus(modelId, 'INITIALIZED');
            }
        }
        else if (has2D) {
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_2D", modelId, model?.filename);
                console.log(`Sending INIT_2D for 2D model ${modelId}`);
                networkManager.send(payload);
                sendContourConfig(modelId);
                if (pipeline) {
                    if (tryRemapFrom1D(modelId, pipeline)) {
                        stateManager.setModelStatus(modelId, 'INITIALIZED');
                    } else {
                        stateManager.setModelStatus(modelId, 'UNINITIALIZED');
                    }
                } else {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                }
            }
        } else {
            // Pure 1D model.
            const state = stateManager.getSimulationState(modelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT", modelId, model?.filename);
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
            sendView3DConfig(modelId);
            networkManager.send({ command: "STEP_3D", modelId: modelId, steps, cfl });
        } else if (hasFSI2D) {
            sendContourConfig(modelId);
            networkManager.send({ command: "STEP_FSI_2D", modelId: modelId, steps, cfl });
        } else if (hasMPM2D) {
            sendContourConfig(modelId);
            const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain2D');
            const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
            networkManager.send({ command: "STEP_MPM", modelId: modelId, steps, cfl: mpmCfl });
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
                    const payload = serializeForSolver(state, "INIT_3D", modelId, model?.filename);
                    console.log(`[INIT_3D] Payload for ${modelId}:`, JSON.parse(payload));
                    networkManager.send(payload);
                    sendView3DConfig(modelId);
                    networkManager.send({ command: "EXEC_ALL_3D", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            } else if (hasFSI2D) {
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FSI_2D", modelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_FSI_2D for 2D FSI model ${modelId}`);
                    networkManager.send(payload);
                    sendContourConfig(modelId);
                    networkManager.send({ command: "EXEC_ALL_FSI_2D", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            } else if (hasMPM2D) {
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_MPM", modelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_MPM for MPM model ${modelId}`);
                    networkManager.send(payload);
                    sendContourConfig(modelId);
                    const mpmNode = state.nodes.find(n => n.type === 'MPMDomain2D');
                    const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                    networkManager.send({ command: "EXEC_ALL_MPM", modelId: modelId, cfl: mpmCfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            } else if (pipeline) {
                // Initialize model from 1D telemetry first, then run
                const state = stateManager.getSimulationState(modelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_2D", modelId, model?.filename);
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
                    const payload = serializeForSolver(state, "INIT_2D", modelId, model?.filename);
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
                    const payload = serializeForSolver(state, "INIT", modelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT for standalone 1D model ${modelId}`);
                    networkManager.send(payload);
                    networkManager.send({ command: "EXEC_ALL", modelId: modelId, cfl });
                    stateManager.setModelStatus(modelId, 'RUNNING');
                }
            }
        } else {
            // Already initialized / paused
            if (has3D) {
                sendView3DConfig(modelId);
                networkManager.send({ command: "EXEC_ALL_3D", modelId: modelId, cfl });
            } else if (hasFSI2D) {
                sendContourConfig(modelId);
                networkManager.send({ command: "EXEC_ALL_FSI_2D", modelId: modelId, cfl });
            } else if (hasMPM2D) {
                sendContourConfig(modelId);
                const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain2D');
                const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                networkManager.send({ command: "EXEC_ALL_MPM", modelId: modelId, cfl: mpmCfl });
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
        } else if (hasFSI2D) {
            networkManager.send({ command: "PAUSE_FSI_2D", modelId: modelId });
        } else if (hasMPM2D) {
            networkManager.send({ command: "PAUSE_MPM", modelId: modelId });
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
        } else if (hasFSI2D) {
            networkManager.send({ command: "TERMINATE_FSI_2D", modelId: modelId });
        } else if (pipeline || has2D) {
            networkManager.send({ command: "TERMINATE_2D", modelId: modelId });
        } else {
            networkManager.send({ command: "TERMINATE",    modelId: modelId });
        }
        stateManager.setModelStatus(modelId, 'TERMINATED');
        stateManager.setModelProgress(modelId, 0);
    }
}

document.addEventListener('model-action', async (e: any) => {
    const { modelId, command, steps } = e.detail;
    if (!networkManager.isConnected()) {
        await CustomDialog.alert("Error: WebSocket is not connected to the Broker backend. Please ensure the Broker daemon is running.");
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

networkManager.onMessage(async (data) => {
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
        
        if (payloadBuffer.byteLength >= 4) {
            const pView = new DataView(payloadBuffer);
            const magic = pView.getUint32(0, true);

            // Binary STL Mesh Frame ("BSTL")
            if (magic === 0x4253544c) {
                let pOffset = 4;
                const meshIdLen = pView.getUint32(pOffset, true); pOffset += 4;
                const meshIdBytes = new Uint8Array(payloadBuffer, pOffset, meshIdLen); pOffset += meshIdLen;
                const meshId = new TextDecoder().decode(meshIdBytes);
                const numFloats = pView.getUint32(pOffset, true); pOffset += 4;
                
                const vertBuffer = payloadBuffer.slice(pOffset, pOffset + numFloats * 4);
                const vertices = new Float32Array(vertBuffer);

                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.setSTLGeometry(vertices, modelId, meshId);
                    }
                    if (comp.type === 'NODE_VIEWER' && comp.instance) {
                        comp.instance.setSTLGeometry(vertices, modelId, meshId);
                    }
                    if (comp.type === 'NODE_GRAPH' && comp.instance) {
                        const state = stateManager.getSimulationState(modelId);
                        const vpNodes = state?.nodes.filter(n => n.type === 'Telemetry3DViewport') || [];
                        vpNodes.forEach(vpNode => {
                            comp.instance.setSTLGeometry(vpNode.id, vertices, meshId);
                        });
                    }
                });
                return;
            }

            // Binary Obstacle Surface Mesh Frame ("BOBS")
            if (magic === 0x424f4253) {
                let pOffset = 4;
                const meshIdLen = pView.getUint32(pOffset, true); pOffset += 4;
                const meshIdBytes = new Uint8Array(payloadBuffer, pOffset, meshIdLen); pOffset += meshIdLen;
                const meshId = new TextDecoder().decode(meshIdBytes);
                const numVerts = pView.getUint32(pOffset, true); pOffset += 4;
                const numCells = pView.getUint32(pOffset, true); pOffset += 4;
                
                const vertBuffer = payloadBuffer.slice(pOffset, pOffset + numVerts * 4);
                const vertices = new Float32Array(vertBuffer);
                pOffset += numVerts * 4;

                const cellBuffer = payloadBuffer.slice(pOffset, pOffset + numCells * 4);
                const cells = new Int32Array(cellBuffer);

                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.setObstaclesGeometry(vertices, cells, modelId, meshId);
                    }
                    if (comp.type === 'NODE_VIEWER' && comp.instance) {
                        comp.instance.setObstaclesGeometry(vertices, cells, modelId, meshId);
                    }
                    if (comp.type === 'NODE_GRAPH' && comp.instance) {
                        const state = stateManager.getSimulationState(modelId);
                        const vpNodes = state?.nodes.filter(n => n.type === 'Telemetry3DViewport') || [];
                        vpNodes.forEach(vpNode => {
                            comp.instance.setObstaclesGeometry(vpNode.id, vertices, cells, meshId);
                        });
                    }
                });
                return;
            }
        }

        const model = stateManager.getAllModels().find(m => m.id === modelId);
        const solverNodes = model?.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D') || [];
        if (solverNodes.length > 0) {
            solverNodes.forEach(solverNode => {
                stateManager.pushTelemetry(solverNode.id, payloadBuffer, modelId);
                stateManager.pushTelemetry(solverNode.id + "-binary", payloadBuffer, modelId);
            });
            if (model?.nodes.some(n => n.type === 'CFDSolver3D')) {
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TELEMETRY_3D') comp.instance.pushFrame(payloadBuffer.slice(0), modelId);
                    if (comp.type === 'NODE_VIEWER' && comp.instance) comp.instance.pushFrame(payloadBuffer.slice(0), modelId);
                });
            }
        }
        return;
    }

    if (typeof data !== 'string') return;

    try {
        const dataJson = JSON.parse(data);
        if (dataJson.type === 'load_stl_response') {
            if (dataJson.status === 'success') {
                const verts = new Float32Array(dataJson.vertices);
                const modelId = dataJson.modelId;
                const state = stateManager.getSimulationState(modelId);
                const vpNodes = state?.nodes.filter(n => n.type === 'Telemetry3DViewport') || [];
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.setSTLGeometry(verts, modelId);
                    }
                });
                
                const activeModelId = stateManager.getActiveWorkspace()?.activeModelId;
                if (modelId === activeModelId && vpNodes.length > 0) {
                    layoutManager.components.forEach(comp => {
                        if (comp.type === 'NODE_GRAPH' && comp.instance) {
                            vpNodes.forEach(vpNode => {
                                comp.instance.setSTLGeometry(vpNode.id, verts);
                            });
                        }
                    });
                }
                
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'NODE_VIEWER' && comp.instance) {
                        comp.instance.setSTLGeometry(verts, modelId);
                    }
                });
            } else {
                console.error("Broker failed to load STL geometry: " + dataJson.error);
            }
            return;
        }

        if (dataJson.type === 'save_model_response') {
            if (dataJson.status === 'success') {
                let modelId = dataJson.modelId;
                const filePath = dataJson.filePath;
                const isWorkspaceSave = modelId === 'workspace';
                const isSilentSave = modelId.startsWith('ws-silent-');

                if (isSilentSave) {
                    modelId = modelId.substring(10);
                }

                if (modelId && modelId !== 'all' && modelId !== 'workspace') {
                    stateManager.setModelFilename(modelId, filePath);

                    const model = stateManager.getAllModels().find(m => m.id === modelId);
                    if (model) {
                        const lastSlash = filePath.lastIndexOf('/');
                        const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '.';

                        model.nodes.forEach(n => {
                            if (n.type === 'VirtualGauges') {
                                stateManager.updateNodeParameters(n.id, { output_dir: dirPath });
                            }
                            if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                                stateManager.updateNodeParameters(n.id, { vtk_dir: dirPath });
                            }
                        });
                    }
                }
                
                if (isWorkspaceSave) {
                    await CustomDialog.alert(`Workspace saved successfully to:\n${filePath}`);
                } else if (!isSilentSave) {
                    await CustomDialog.alert(`Model saved successfully to:\n${filePath}`);
                }
            } else {
                await CustomDialog.alert(`Error saving file:\n${dataJson.error}`);
            }
            return;
        }

        if (dataJson.type === 'load_model_response') {
            if (dataJson.status === 'success') {
                const modelId = dataJson.modelId;
                const filePath = dataJson.filePath;
                try {
                    const loaded = JSON.parse(dataJson.fileContent);
                    if (loaded.type === 'blast_workspace_file') {
                        const ws = loaded.workspace;
                        const models = loaded.models || [];
                        
                        // Dynamically update model filenames to reflect the loaded directory on host if needed
                        const lastSlash = filePath.lastIndexOf('/');
                        const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '.';
                        
                        models.forEach((m: any) => {
                            if (m.filename) {
                                const mSlash = m.filename.lastIndexOf('/');
                                const mBasename = mSlash !== -1 ? m.filename.substring(mSlash + 1) : `${m.name.toLowerCase().replace(/\s+/g, '_')}.json`;
                                m.filename = `${dirPath}/${mBasename}`;
                            } else {
                                m.filename = `${dirPath}/${m.name.toLowerCase().replace(/\s+/g, '_')}.json`;
                            }
                            
                            // Update gauge / vtk output directories to this directory path as well
                            if (m.nodes) {
                                m.nodes.forEach((n: any) => {
                                    if (n.type === 'VirtualGauges') {
                                        n.parameters = n.parameters || {};
                                        n.parameters.output_dir = dirPath;
                                    } else if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                                        n.parameters = n.parameters || {};
                                        n.parameters.vtk_dir = dirPath;
                                    }
                                });
                            }
                        });

                        stateManager.importWorkspace(ws, models);
                        
                        const activeState = stateManager.getCurrentState();
                        if (activeState) {
                            layoutManager.render(activeState);
                        }
                        await CustomDialog.alert(`Workspace loaded and restored successfully from:\n${filePath}`);
                    } else {
                        const activeWs = stateManager.getActiveWorkspace();
                        const state: SimulationState = {
                            nodes: loaded.nodes || [],
                            connections: loaded.connections || [],
                            layout: loaded.layout || activeWs.layout
                        };
                        stateManager.pushState(state);

                        if (activeWs.activeModelId) {
                            stateManager.setModelFilename(activeWs.activeModelId, filePath);

                            const model = stateManager.getAllModels().find(m => m.id === activeWs.activeModelId);
                            if (model) {
                                const lastSlash = filePath.lastIndexOf('/');
                                const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '.';

                                model.nodes.forEach(n => {
                                    if (n.type === 'VirtualGauges') {
                                        stateManager.updateNodeParameters(n.id, { output_dir: dirPath });
                                    } else if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                                        stateManager.updateNodeParameters(n.id, { vtk_dir: dirPath });
                                    }
                                });
                            }
                        }
                        layoutManager.render(state);
                        await CustomDialog.alert(`Model loaded successfully from:\n${filePath}`);
                    }
                } catch (err) {
                    await CustomDialog.alert("Failed to parse loaded file: " + err);
                }
            } else {
                await CustomDialog.alert(`Error loading file:\n${dataJson.error}`);
            }
            return;
        }
        let modelId = dataJson.modelId;

        if (dataJson.type === 'resource_pulse') {
            layoutManager.broadcastResourceData(dataJson);
            return;
        }

        // Determine correct target solver type
        let targetType: 'CFDSolver2D' | 'CFDSolver' | 'CFDSolver3D' | 'MPMDomain2D' = 'CFDSolver';
        if (dataJson.type === 'progress_3d' || dataJson.type === 'TELEMETRY_3D' || dataJson.scope === '3d') {
            targetType = 'CFDSolver3D';
        } else if (dataJson.type === 'progress_2d' || dataJson.type === 'TELEMETRY_2D' || dataJson.scope === '2d') {
            targetType = 'CFDSolver2D';
        } else if (dataJson.scope === 'mpm_2d') {
            targetType = 'MPMDomain2D';
        } else if (dataJson.type === 'progress' || dataJson.type === 'TELEMETRY') {
            targetType = 'CFDSolver';
        } else if (dataJson.type === 'log') {
            const msg = dataJson.message || "";
            const scope = dataJson.scope || "";
            if (scope === 'mpm_2d' || msg.includes("MPM") || msg.includes("mpm")) targetType = 'MPMDomain2D';
            else if (scope === '3d' || msg.includes("3D") || msg.includes("3d")) targetType = 'CFDSolver3D';
            else if (scope === '2d' || msg.includes("2D") || msg.includes("REMAP") || msg.includes("vtk") || msg.includes("2d")) targetType = 'CFDSolver2D';
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
                    // Auto-trigger remap for downstream pipeline 2D/3D model if any!
                    const allModels = stateManager.getAllModels();
                    for (const m of allModels) {
                        const pipe = findRemapPipeline(m.id);
                        if (pipe && (pipe.sourceModelId === modelId || pipe.model1dId === modelId)) {
                            console.log(`[Pipeline Auto-Init] Model ${modelId} completed. Initializing downstream model ${m.id}`);
                            const mState = stateManager.getSimulationState(m.id);
                            if (mState) {
                                const is3D = m.nodes.some(n => n.type === 'CFDSolver3D');
                                const cmd = is3D ? "INIT_3D" : "INIT_2D";
                                const payload = serializeForSolver(mState, cmd, m.id, m.filename);
                                networkManager.send(payload);
                                if (is3D) sendView3DConfig(m.id); else sendContourConfig(m.id);
                                const remapOk = pipe.sourceType === '2D' ? tryRemapFrom2D(m.id, pipe) : tryRemapFrom1D(m.id, pipe);
                                if (remapOk) {
                                    stateManager.setModelStatus(m.id, 'INITIALIZED');
                                }
                            }
                        }
                    }
                } else if (dataJson.percent < 100) {
                    const currentStatus = stateManager.getModelStatus(modelId);
                    if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                }

                if (model) {
                    const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');
                    solverNodes.forEach(sn => stateManager.pushTelemetry(sn.id, dataJson, modelId));
                }
            }
            return;
        }

        if (dataJson.type === 'TELEMETRY' || dataJson.type === 'TELEMETRY_2D' || dataJson.type === 'TELEMETRY_3D' || dataJson.type === 'TELEMETRY_MPM_2D') {
            if (modelId) {
                stateManager.setModelSimTime(modelId, dataJson.time);
                const currentStatus = stateManager.getModelStatus(modelId);

                if (dataJson.time === 0 && currentStatus === 'UNINITIALIZED') {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                    stateManager.setModelProgress(modelId, 0);
                } else if (dataJson.is_terminated === true) {
                    stateManager.setModelStatus(modelId, 'TERMINATED');
                } else if (dataJson.type === 'TELEMETRY_2D' || dataJson.type === 'TELEMETRY_MPM_2D') {
                    // Check if we just transitioned from 1D phase (progress is 100)
                    const currentProgress = stateManager.getModelProgress(modelId);
                    if (currentProgress === 100) {
                        stateManager.setModelProgress(modelId, 0);
                        stateManager.setModelStatus(modelId, 'PAUSED');
                    } else if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED' && currentStatus !== 'INITIALIZED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                } else {
                    if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED' && currentStatus !== 'INITIALIZED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                }

                if (model) {
                    const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');
                    solverNodes.forEach(sn => stateManager.pushTelemetry(sn.id, dataJson, modelId));
                }
                if (dataJson.type === 'TELEMETRY_3D') {
                    layoutManager.components.forEach(comp => {
                        if (comp.type === 'TELEMETRY_3D') comp.instance.updateTelemetry(dataJson, modelId);
                        if (comp.type === 'NODE_VIEWER' && comp.instance) comp.instance.updateTelemetry(dataJson, modelId);
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
                reader.onload = async (event) => {
                    try {
                        const state = JSON.parse(event.target?.result as string) as SimulationState;
                        stateManager.pushState(state);
                        const activeWs = stateManager.getActiveWorkspace();
                        if (activeWs.activeModelId) {
                            stateManager.setModelFilename(activeWs.activeModelId, file.name);
                            
                            const model = stateManager.getAllModels().find(m => m.id === activeWs.activeModelId);
                            if (model) {
                                const dirPath = "/home/chris/antigrav/blastdemon";
                                model.nodes.forEach(n => {
                                    if (n.type === 'VirtualGauges') {
                                        if (!n.parameters.output_dir || n.parameters.output_dir === '') {
                                            stateManager.updateNodeParameters(n.id, { output_dir: dirPath });
                                        }
                                    } else if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                                        if (!n.parameters.vtk_dir || n.parameters.vtk_dir === '') {
                                            stateManager.updateNodeParameters(n.id, { vtk_dir: dirPath });
                                        }
                                    }
                                });
                            }
                        }
                        layoutManager.render(state);
                        console.log("Model loaded successfully from JSON.");
                    } catch (err) {
                        await CustomDialog.alert("Failed to parse JSON file: " + err);
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
    reader.onload = async (event) => {
        try {
            const buffer = event.target?.result as ArrayBuffer;
            const state = deserializeFromBinary(buffer);
            stateManager.pushState(state);
            const activeWs = stateManager.getActiveWorkspace();
            if (activeWs.activeModelId) {
                stateManager.setModelFilename(activeWs.activeModelId, file.name);
                
                const model = stateManager.getAllModels().find(m => m.id === activeWs.activeModelId);
                if (model) {
                    const dirPath = "/home/chris/antigrav/blastdemon";
                    model.nodes.forEach(n => {
                        if (n.type === 'VirtualGauges') {
                            if (!n.parameters.output_dir || n.parameters.output_dir === '') {
                                stateManager.updateNodeParameters(n.id, { output_dir: dirPath });
                            }
                        } else if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                            if (!n.parameters.vtk_dir || n.parameters.vtk_dir === '') {
                                stateManager.updateNodeParameters(n.id, { vtk_dir: dirPath });
                            }
                        }
                    });
                }
            }
            layoutManager.render(state);
            console.log("Model loaded successfully from Binary.");
        } catch (err) {
            await CustomDialog.alert("Failed to parse Binary file: " + err);
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

