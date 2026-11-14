import { StateManager, createDefaultWorkstationLayout, prepareModelSavePayload, extractModelResources, resolveResourcePath } from './state-manager.js';
import { Model, SimulationState, SimulationStatus, LayoutNode, isDomainMesh3DNode, isDomainMesh2DNode } from './types.js';
import { NetworkManager } from './NetworkManager.js';
import { serializeSimulationState, serializeForSolver, serializeToBinary, deserializeFromBinary, isAirMaterialNode, isJWLMaterialNode, isIdealGasMaterialNode, resolveRemapInheritance } from './serialization.js';
import { LayoutManager } from './layout-manager.js';
import { estimateGraphMemory } from './memory-validator.js';
import {
    HostFileBrowserModal,
    recordRecentFolder,
    showRecentFoldersQuickMenu,
    uint8ArrayToBase64,
    base64ToUint8Array
} from './host-file-browser.js';
import { CustomDialog } from './custom-dialog.js';
import { PlaybackRingBuffer } from './playback-buffer.js';
import { TransportController, TransportControllerOptions } from './transport-controller.js';
import { PlatformBridge } from './PlatformBridge.js';
import { WorkspaceManager } from './workspace-manager.js';
import { ClusterNodeManager } from './ClusterNodeManager.js';

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
                material_model: 'Ideal Gas',
                preset: 'Air (Standard STP, gamma=1.4)',
                material_type: 'Air',
                atm_pressure: 101325.0,
                atm_temperature: 288.15,
                gamma: 1.4,
                ambient_rho: 1.225,
                ambient_p: 101325.0,
                density: 1.225
            }
        },
        {
            id: 'node-material-explosive', type: 'Material', x: 50, y: 310, displayMode: 'expanded',
            inputs: [], outputs: [{ id: 'out', label: 'Material' }],
            parameters: {
                material_model: 'JWL Detonation Gas',
                preset: 'TNT (Trinitrotoluene)',
                material_type: 'JWL Charge',
                composition: 'TNT',
                rho: 1630.0,
                detonation_energy: 4290000.0,
                det_vel: 6930.0,
                jwl_A: 373.77e9,
                jwl_B: 3.747e9,
                jwl_R1: 4.15,
                jwl_R2: 0.90,
                jwl_omega: 0.35,
                afterburn_enabled: true,
                afterburn_energy: 1.071e7,
                afterburn_fuel_fraction: 0.35,
                afterburn_stoich_ratio: 2.67,
                afterburn_ignition_temp: 800.0,
                afterburn_tau_chem: 1.0e-5,
                afterburn_c_edc: 0.15,
                afterburn_tau_expansion: 0.0,
                afterburn_ambient_o2_fraction: 0.233
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
            id: 'node-solver', type: 'CFDSolver', x: 550, y: 200, displayMode: 'expanded',
            inputs: [
                { id: 'mesh', label: 'Mesh' },
                { id: 'air', label: 'Air' },
                { id: 'charge', label: 'Charge' }
            ],
            outputs: [{ id: 'telemetry', label: 'Telemetry' }],
            parameters: { init_mode: 'Multi-Material JWL', cfl: 0.4, flux_scheme: 'AUSM+', space_time_scheme: 'ADER-2 (2nd-Order Space/Time)', spatial_order: 2, temporal_order: 2 }
        }
    ],
    connections: [
        { fromNode: 'node-mesh', fromPort: 'out', toNode: 'node-solver', toPort: 'mesh' },
        { fromNode: 'node-air', fromPort: 'out', toNode: 'node-solver', toPort: 'air' },
        { fromNode: 'node-material-explosive', fromPort: 'out', toNode: 'node-explosive', toPort: 'material' },
        { fromNode: 'node-explosive', fromPort: 'out', toNode: 'node-solver', toPort: 'charge' }
    ],
    layout: createDefaultWorkstationLayout()
};

const stateManager = new StateManager(initialState);

// Hydrate from localStorage if available (with auto-migration to Workstation layout)
const savedState = stateManager.loadWorkspace();
const activeState = stateManager.getCurrentState() || savedState || initialState;

const playbackBuffer = new PlaybackRingBuffer(1, 0);
(window as any).playbackBuffer = playbackBuffer;

const platformBridge = PlatformBridge.getInstance();
(window as any).platformBridge = platformBridge;

let layoutManager: LayoutManager;

function getTransportOptions(container?: HTMLElement): TransportControllerOptions {
    return {
        container,
        playbackBuffer,
        stateManager,
        onFrameDispatch: (frame, isLive, source) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                        comp.instance.dispatchFrame(frame, isLive);
                    }
                    if (comp.type === 'TRANSPORT_BAR' && comp.instance && comp.instance !== source) {
                        comp.instance.syncFrameFromExternal?.(frame.index, isLive);
                    }
                });
            }
        },
        onPlaybackStateChange: (isPlaying, source) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'TRANSPORT_BAR' && comp.instance && comp.instance !== source) {
                        comp.instance.setExternalPlaybackState?.(isPlaying);
                    }
                });
            }
        },
        onCameraSnap: (preset) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.snapCamera(preset);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.snapCameraPreset?.(preset);
                });
            }
        },
        onProjectionToggle: (perspective) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setProjection?.(perspective);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setProjection?.(perspective);
                });
            }
        },
        onSliceToggle: (plane, enabled, offset) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE' || comp.type === 'TELEMETRY_3D') && comp.instance) {
                        if (typeof comp.instance.setSlice === 'function') {
                            comp.instance.setSlice(plane, enabled, offset);
                        } else if (typeof comp.instance.updateSlicePlane === 'function') {
                            comp.instance.updateSlicePlane(plane, enabled, offset);
                        }
                    }
                });
            }
        },
        onSliceConfigChange: (slices) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setSlices?.(slices);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setSlices?.(slices);
                });
            }
        },
        onColormapChange: (colormap, min, max, targetLayer) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setColormap(colormap, min, max, targetLayer);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setColormap?.(colormap, min, max, targetLayer);
                });
            }
        },
        onQuantityChange: (quantity, targetLayer) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setQuantity?.(quantity, targetLayer);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setQuantity?.(quantity, targetLayer);
                });
            }
        },
        onLayerToggle: (layer, active) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setLayerVisibility?.(layer, active);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setLayerVisibility?.(layer, active);
                });
            }
        },
        onRefreshRateChange: (rate, modelId) => {
            const targetModel = (modelId ? stateManager.getAllModels().find(m => m.id === modelId) : null) || stateManager.getActiveModel();
            if (targetModel) {
                stateManager.setModelRefreshRate(targetModel.id, rate);
                const has3D = targetModel.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'Telemetry3DViewport' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D');
                if (has3D) {
                    sendView3DConfig(targetModel.id);
                }
                const has2D = targetModel.nodes.some(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D' || n.type === 'TelemetryContour');
                if (has2D) {
                    sendContourConfig(targetModel.id);
                }
                if (!has3D && !has2D) {
                    networkManager.send({
                        command: "TELEMETRY_CONFIG",
                        modelId: targetModel.id,
                        refresh_rate: rate
                    });
                }
            }
            if (layoutManager && targetModel) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setRefreshRate?.(rate, targetModel.id);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setRefreshRate?.(rate, targetModel.id);
                });
            }
        },
        onShadingChange: (key, val) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setShadingConfig?.({ [key]: val });
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setShadingConfig?.({ [key]: val });
                });
            }
        },
        onROIChange: (roi) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setROIConfig?.(roi);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setROIConfig?.(roi);
                });
            }
        },
        onParticleFilterChange: (filter) => {
            if (layoutManager) {
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setParticleFilter?.(filter);
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setParticleFilter?.(filter);
                });
            }
        },
        onSimCommand: (cmd, extra) => {
            const modelId = stateManager.getActiveModelId() || undefined;
            if (cmd === 'REFRESH' as any) {
                requestAndPlotCurrentState(modelId);
            } else {
                executeModelCommand(modelId, cmd, extra || {}, false, (extra as any)?.allowAutoRun !== false);
            }
        },
        onManualRefresh: () => {
            const modelId = stateManager.getActiveModelId() || undefined;
            requestAndPlotCurrentState(modelId);
        }
    };
}

const createTransportController = (container: HTMLElement) => new TransportController(getTransportOptions(container));
(window as any).createTransportController = createTransportController;

function getAllTransportControllers(): TransportController[] {
    const list: TransportController[] = [];
    if (layoutManager) {
        layoutManager.components.forEach(comp => {
            if (comp.type === 'TRANSPORT_BAR' && comp.instance) {
                list.push(comp.instance);
            }
        });
    }
    return list;
}

const transportDispatcher: any = new Proxy({}, {
    get(_target, prop: string) {
        const list = getAllTransportControllers();
        if (list.length > 0 && typeof (list[0] as any)[prop] !== 'function' && prop in list[0]) {
            return (list[0] as any)[prop];
        }
        return (...args: any[]) => {
            let lastResult: any;
            for (const tc of list) {
                const fn = (tc as any)[prop];
                if (typeof fn === 'function') {
                    lastResult = fn.apply(tc, args);
                }
            }
            return lastResult;
        };
    }
});
const transportController = transportDispatcher;
(window as any).transportController = transportController;

layoutManager = new LayoutManager('app-container', stateManager);
layoutManager.setTransportControllerFactory(createTransportController);

function getCflFromSolver(modelId: string): number {
    const model = stateManager.getAllModels().find(m => m.id === modelId);
    if (!model || !model.nodes) return 0.6;

    // Single Source of Truth: In coupled simulations, the Coupler node owns the authoritative CFL
    const coupler = model.nodes.find(n => n.type === 'FEMFSICoupler3D' || n.type === 'FSICoupler3D' || n.type === 'FSICoupler2D');
    if (coupler?.parameters?.cfl !== undefined && !isNaN(Number(coupler.parameters.cfl)) && Number(coupler.parameters.cfl) > 0) {
        return Number(coupler.parameters.cfl);
    }

    // Standalone / uncoupled domains
    const fem = model.nodes.find(n => n.type === 'FEMDomain3D');
    if (fem?.parameters?.cfl !== undefined && !isNaN(Number(fem.parameters.cfl)) && Number(fem.parameters.cfl) > 0) {
        return Number(fem.parameters.cfl);
    }

    const mpm = model.nodes.find(n => n.type === 'MPMDomain3D' || n.type === 'MPMDomain2D');
    if (mpm?.parameters?.cfl !== undefined && !isNaN(Number(mpm.parameters.cfl)) && Number(mpm.parameters.cfl) > 0) {
        return Number(mpm.parameters.cfl);
    }

    const solver = model?.nodes?.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
    if (solver?.parameters?.cfl !== undefined && !isNaN(Number(solver.parameters.cfl)) && Number(solver.parameters.cfl) > 0) {
        return Number(solver.parameters.cfl);
    }

    return 0.6;
}

function getEndTimeFromSolver(modelId: string): number {
    const model = stateManager.getAllModels().find(m => m.id === modelId);
    if (!model || !model.nodes) return 1.0;

    // Single Source of Truth: In coupled simulations, the Coupler node owns the authoritative endtime
    const coupler = model.nodes.find(n => n.type === 'FEMFSICoupler3D' || n.type === 'FSICoupler3D' || n.type === 'FSICoupler2D');
    if (coupler?.parameters?.endtime !== undefined && !isNaN(Number(coupler.parameters.endtime)) && Number(coupler.parameters.endtime) > 0) {
        return Number(coupler.parameters.endtime);
    }

    // Standalone / uncoupled domains
    const fem = model.nodes.find(n => n.type === 'FEMDomain3D');
    if (fem?.parameters?.endtime !== undefined && !isNaN(Number(fem.parameters.endtime)) && Number(fem.parameters.endtime) > 0) {
        return Number(fem.parameters.endtime);
    }

    const mpm = model.nodes.find(n => n.type === 'MPMDomain3D' || n.type === 'MPMDomain2D');
    if (mpm?.parameters?.endtime !== undefined && !isNaN(Number(mpm.parameters.endtime)) && Number(mpm.parameters.endtime) > 0) {
        return Number(mpm.parameters.endtime);
    }

    const solver = model?.nodes?.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
    if (solver?.parameters?.endtime !== undefined && !isNaN(Number(solver.parameters.endtime)) && Number(solver.parameters.endtime) > 0) {
        return Number(solver.parameters.endtime);
    }

    return 1.0;
}

(window as any).stateManager = stateManager;
(window as any).layoutManager = layoutManager;

let lastActiveModelId: string | null = stateManager.getActiveModelId();
stateManager.onStateChange(() => {
    const currentActiveModelId = stateManager.getActiveModelId();
    if (currentActiveModelId && currentActiveModelId !== lastActiveModelId) {
        lastActiveModelId = currentActiveModelId;
        const rate = stateManager.getModelRefreshRate(currentActiveModelId);
        if (layoutManager) {
            layoutManager.components.forEach(comp => {
                if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) comp.instance.setRefreshRate?.(rate, currentActiveModelId);
                if (comp.type === 'TELEMETRY_3D' && comp.instance) comp.instance.setRefreshRate?.(rate, currentActiveModelId);
                if (comp.type === 'TRANSPORT_BAR' && comp.instance) comp.instance.syncStateFromViewport?.();
            });
        }
        const activeModel = stateManager.getActiveModel();
        if (activeModel) {
            const has3D = activeModel.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'Telemetry3DViewport' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D');
            if (has3D) {
                sendView3DConfig(activeModel.id);
            }
            const hasContour = activeModel.nodes.some(n => n.type === 'TelemetryContour');
            if (hasContour) {
                sendContourConfig(activeModel.id);
            }
            if (!has3D && !hasContour && networkManager.isConnected()) {
                networkManager.send({
                    command: "TELEMETRY_CONFIG",
                    modelId: activeModel.id,
                    refresh_rate: rate
                });
            }
        }
    }
});

const wsUrl = new URLSearchParams(window.location.search).get('broker') || 'ws://localhost:8080';
const networkManager = new NetworkManager(wsUrl);
(window as any).networkManager = networkManager;

window.addEventListener('blastdemon-open-gauge-waveforms', ((e: CustomEvent) => {
    const targetModelId = e.detail?.modelId || stateManager.getActiveModelId() || undefined;
    if (layoutManager) {
        layoutManager.components.forEach(comp => {
            if ((comp.type === 'MULTI_VIEW_STAGE' || comp.type === 'VIEWPORT') && comp.instance && typeof comp.instance.openGaugeWaveformView === 'function') {
                comp.instance.openGaugeWaveformView(targetModelId);
            }
        });
    }
}) as EventListener);

let pendingLocalLoadMode: 'replace_active' | 'add_to_workspace' = 'replace_active';
const pendingHostLoadMode = new Map<string, 'replace_active' | 'add_to_workspace'>();

function getSafeBasename(pathOrName: string | undefined | null, fallback: string): string {
    const clean = (pathOrName || '').replace(/\\/g, '/').trim();
    if (!clean) return fallback;
    const slash = clean.lastIndexOf('/');
    const base = slash !== -1 ? clean.substring(slash + 1) : clean;
    return base || fallback;
}

function sanitizeModelFilenameSlug(name: string | undefined, ext: string = '.json'): string {
    const slug = (name || 'model')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'model';
    return slug.endsWith(ext) ? slug : `${slug}${ext}`;
}

function preloadModelSTLGeometries(model: Model | undefined): void {
    if (!model || !networkManager.isConnected()) return;
    const requested = new Set<string>();
    for (const node of model.nodes || []) {
        const stlRaw = node.parameters?.stl_file;
        if (typeof stlRaw === 'string' && stlRaw.trim() !== '' && stlRaw !== 'None specified') {
            const resolvedPath = resolveResourcePath(stlRaw, model.filename);
            if (resolvedPath && !requested.has(resolvedPath)) {
                requested.add(resolvedPath);
                networkManager.send({
                    command: 'LOAD_STL_GEOMETRY',
                    filePath: resolvedPath,
                    modelId: model.id
                });
            }
        }
    }
}

async function applyLoadedPayload(
    parsed: any,
    filePath: string | null,
    loadMode: 'replace_active' | 'add_to_workspace' = 'replace_active',
    showSuccessAlert: boolean = false
): Promise<void> {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Empty or invalid model payload.');
    }

    // 1. Self-contained Host Workspace bundle (blast_workspace_file)
    if (parsed.type === 'blast_workspace_file' && parsed.workspace) {
        const ws = parsed.workspace;
        const models = Array.isArray(parsed.models) ? parsed.models : [];
        if (filePath && filePath.includes('/')) {
            recordRecentFolder(filePath, false);
            const lastSlash = filePath.lastIndexOf('/');
            const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '.';
            models.forEach((m: any) => {
                const base = getSafeBasename(m.filename, sanitizeModelFilenameSlug(m.name || 'model', '.json'));
                m.filename = `${dirPath}/${base}`;
                if (Array.isArray(m.nodes)) {
                    m.nodes.forEach((n: any) => {
                        n.parameters = n.parameters || {};
                        if (n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D') {
                            if (!n.parameters.output_dir || String(n.parameters.output_dir).trim() === '') {
                                n.parameters.output_dir = dirPath;
                            }
                        } else if (n.type === 'VTKOutput' || n.type === 'Telemetry3DViewport') {
                            if (!n.parameters.vtk_dir || String(n.parameters.vtk_dir).trim() === '') {
                                n.parameters.vtk_dir = dirPath;
                            }
                        }
                    });
                }
            });
        }
        stateManager.importWorkspace(ws, models);
        stateManager.getWorkspaceModels().forEach(m => preloadModelSTLGeometries(m));
        const activeState = stateManager.getCurrentState();
        if (activeState) layoutManager.render(activeState);
        if (showSuccessAlert && filePath) {
            await CustomDialog.alert(`Workspace loaded and restored successfully from:\n${filePath}`);
        }
        return;
    }

    // 2. Full AppState project archive (models map + workspaces array)
    if (parsed.models && typeof parsed.models === 'object' && Array.isArray(parsed.workspaces)) {
        if (filePath && filePath.includes('/')) {
            recordRecentFolder(filePath, false);
        }
        stateManager.loadAppState(parsed);
        stateManager.getWorkspaceModels().forEach(m => preloadModelSTLGeometries(m));
        const activeState = stateManager.getCurrentState();
        if (activeState) layoutManager.render(activeState);
        if (showSuccessAlert && filePath) {
            await CustomDialog.alert(`Project archive loaded successfully from:\n${filePath}`);
        }
        return;
    }

    // 3. Single Model / SimulationState JSON or BLST binary payload
    if (Array.isArray(parsed.nodes)) {
        if (filePath && filePath.includes('/')) {
            recordRecentFolder(filePath, false);
        }
        const loadedModel = stateManager.loadModelData(parsed, filePath, { mode: loadMode });
        preloadModelSTLGeometries(loadedModel);
        const activeState = stateManager.getCurrentState();
        if (activeState) layoutManager.render(activeState);
        if (showSuccessAlert && filePath) {
            const actionLabel = loadMode === 'add_to_workspace' ? 'imported into workspace' : 'loaded';
            await CustomDialog.alert(`Model "${loadedModel.name}" ${actionLabel} successfully from:\n${filePath}`);
        }
        return;
    }

    throw new Error('Unrecognized file format (expected a BlastDaemon Model, Binary .blst, or Workspace JSON).');
}

const blastFileActions = {
    openModel: (options?: { initialFolder?: string; mode?: 'replace_active' | 'add_to_workspace'; targetModelId?: string }) => {
        const mode = options?.mode || 'replace_active';
        if (options?.targetModelId && mode === 'replace_active') {
            stateManager.setActiveModel(options.targetModelId);
        }
        const activeWs = stateManager.getActiveWorkspace();
        const activeModel = activeWs.activeModelId
            ? stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)
            : undefined;
        const startPath = options?.initialFolder || activeModel?.filename || '';

        if (networkManager.isConnected()) {
            const browser = new HostFileBrowserModal(networkManager, {
                title: mode === 'add_to_workspace' ? 'Import Model into Workspace (Host)' : 'Open Model File (Host)',
                mode: 'open',
                initialPath: startPath,
                filters: [
                    { label: 'Model & Workspace Files (*.json, *.blst, *.bin, *.model)', extensions: ['.json', '.blst', '.bin', '.model'] },
                    { label: 'JSON Model Files (*.json)', extensions: ['.json'] },
                    { label: 'Binary Model Files (*.blst, *.bin, *.model)', extensions: ['.blst', '.bin', '.model'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: (path) => {
                    const reqId = `load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    pendingHostLoadMode.set(reqId, mode);
                    networkManager.send({
                        command: 'LOAD_MODEL_FILE',
                        modelId: reqId,
                        filePath: path
                    });
                }
            });
            browser.open(startPath);
        } else {
            pendingLocalLoadMode = mode;
            const fileInput = document.getElementById('load-json-file') as HTMLInputElement | null;
            if (fileInput) fileInput.click();
        }
    },

    saveModel: async (targetModelId?: string, forceSaveAs: boolean = false) => {
        const activeWs = stateManager.getActiveWorkspace();
        const resolvedId = targetModelId || activeWs.activeModelId;
        const model = resolvedId ? stateManager.getAllModels().find(m => m.id === resolvedId) : undefined;
        if (!model) {
            await CustomDialog.alert('No active model to save.');
            return;
        }

        const rawBase = getSafeBasename(model.filename, sanitizeModelFilenameSlug(model.name, '.json'));
        const jsonDefaultFilename = rawBase.replace(/\.(blst|bin|model)$/i, '.json').endsWith('.json')
            ? rawBase.replace(/\.(blst|bin|model)$/i, '.json')
            : `${rawBase}.json`;

        if (networkManager.isConnected()) {
            if (!forceSaveAs && model.filename && model.filename.includes('/') && !/\.(blst|bin|model)$/i.test(model.filename)) {
                const prepared = prepareModelSavePayload(model, model.filename);
                networkManager.send({
                    command: 'SAVE_MODEL_FILE',
                    modelId: model.id,
                    filePath: model.filename,
                    fileContent: prepared.modelJson,
                    resources: prepared.resources
                });
            } else {
                const browser = new HostFileBrowserModal(networkManager, {
                    title: `Save Model As — ${model.name}`,
                    mode: 'save',
                    defaultFilename: jsonDefaultFilename,
                    initialPath: model.filename || '',
                    filters: [
                        { label: 'JSON Model Files (*.json)', extensions: ['.json'] },
                        { label: 'All Files (*.*)', extensions: ['*'] }
                    ],
                    onSelect: (path) => {
                        const prepared = prepareModelSavePayload(model, path);
                        networkManager.send({
                            command: 'SAVE_MODEL_FILE',
                            modelId: model.id,
                            filePath: path,
                            fileContent: prepared.modelJson,
                            resources: prepared.resources
                        });
                    }
                });
                browser.open(model.filename || '');
            }
        } else {
            const payload = {
                name: model.name,
                filename: jsonDefaultFilename,
                refresh_rate: model.refresh_rate ?? 0.5,
                fps: model.fps,
                views: model.views,
                activeViewId: model.activeViewId,
                nodes: model.nodes,
                connections: model.connections,
                layout: activeWs.layout
            };
            fallbackSaveJson(JSON.stringify(payload, null, 2), jsonDefaultFilename);
        }
    },

    saveModelAs: async (targetModelId?: string) => {
        await blastFileActions.saveModel(targetModelId, true);
    },

    openBinaryModel: (options?: { initialFolder?: string; mode?: 'replace_active' | 'add_to_workspace' }) => {
        const mode = options?.mode || 'replace_active';
        const activeWs = stateManager.getActiveWorkspace();
        const activeModel = activeWs.activeModelId
            ? stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)
            : undefined;
        const startPath = options?.initialFolder || activeModel?.filename || '';

        if (networkManager.isConnected()) {
            const browser = new HostFileBrowserModal(networkManager, {
                title: 'Open Binary Model (.blst / .bin)',
                mode: 'open',
                initialPath: startPath,
                filters: [
                    { label: 'Binary Model Files (*.blst, *.bin, *.model)', extensions: ['.blst', '.bin', '.model'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: (path) => {
                    const reqId = `load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    pendingHostLoadMode.set(reqId, mode);
                    networkManager.send({
                        command: 'LOAD_MODEL_FILE',
                        modelId: reqId,
                        filePath: path
                    });
                }
            });
            browser.open(startPath);
        } else {
            pendingLocalLoadMode = mode;
            const fileInput = document.getElementById('load-binary-file') as HTMLInputElement | null;
            if (fileInput) fileInput.click();
        }
    },

    saveBinaryModel: async (targetModelId?: string) => {
        const activeWs = stateManager.getActiveWorkspace();
        const resolvedId = targetModelId || activeWs.activeModelId;
        const model = resolvedId ? stateManager.getAllModels().find(m => m.id === resolvedId) : undefined;
        if (!model) {
            await CustomDialog.alert('No active model to save.');
            return;
        }

        const rawBase = getSafeBasename(model.filename, sanitizeModelFilenameSlug(model.name, '.blst'));
        const binDefaultFilename = /\.(blst|bin|model)$/i.test(rawBase)
            ? rawBase
            : `${rawBase.replace(/\.json$/i, '')}.blst`;

        if (networkManager.isConnected()) {
            const browser = new HostFileBrowserModal(networkManager, {
                title: `Save Binary Model — ${model.name}`,
                mode: 'save',
                defaultFilename: binDefaultFilename,
                initialPath: model.filename || '',
                filters: [
                    { label: 'BlastDaemon Binary Model (*.blst)', extensions: ['.blst'] },
                    { label: 'Binary Model (*.bin, *.model)', extensions: ['.bin', '.model'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: (path) => {
                    const prepared = prepareModelSavePayload(model, path);
                    const fullBinaryPayload = {
                        ...prepared.clonedModel,
                        layout: activeWs.layout
                    };
                    const buffer = serializeToBinary(fullBinaryPayload);
                    const b64 = uint8ArrayToBase64(new Uint8Array(buffer));
                    networkManager.send({
                        command: 'SAVE_MODEL_FILE',
                        modelId: model.id,
                        filePath: path,
                        encoding: 'base64',
                        fileContent: b64,
                        resources: prepared.resources
                    });
                }
            });
            browser.open(model.filename || '');
        } else {
            const fullBinaryPayload = {
                name: model.name,
                filename: binDefaultFilename,
                refresh_rate: model.refresh_rate ?? 0.5,
                fps: model.fps,
                views: model.views,
                activeViewId: model.activeViewId,
                nodes: model.nodes,
                connections: model.connections,
                layout: activeWs.layout
            };
            const buffer = serializeToBinary(fullBinaryPayload);
            fallbackSaveBinary(buffer, binDefaultFilename);
        }
    }
};

(window as any).blastFileActions = blastFileActions;

networkManager.onOpen(() => {
    const state = stateManager.getCurrentState();
    if (state) networkManager.send(serializeSimulationState(state));
    // Reset status to UNINITIALIZED so the UI knows the fresh Broker needs initialization
    stateManager.getAllModels().forEach(m => stateManager.setModelStatus(m.id, 'UNINITIALIZED'));
    stateManager.getWorkspaceModels().forEach(m => preloadModelSTLGeometries(m));
});

networkManager.onClose(() => {
    stateManager.setModelStatus('all', stateManager.getStatus());
    layoutManager.resetAllResourceManagers();
});

// Global Keyboard Shortcuts for File Open / Save / Save As
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (document.querySelector('.hfb-overlay, .cd-overlay')) return;
    const activeEl = document.activeElement as HTMLElement | null;
    const isCodeEditor = activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

    const key = e.key.toLowerCase();
    if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) {
            blastFileActions.saveModelAs();
        } else {
            blastFileActions.saveModel();
        }
    } else if (key === 'o' && !e.shiftKey && !isCodeEditor) {
        e.preventDefault();
        blastFileActions.openModel({ mode: 'replace_active' });
    }
});

// Event Delegation for Simulation Controls and Menus (since they are injected dynamically)
document.addEventListener('click', async (e) => {
    const rawTarget = e.target as HTMLElement;
    if (!rawTarget) return;
    const target = (rawTarget.closest('[id^="menu-"]') as HTMLElement) || rawTarget;

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
        blastFileActions.openModel({ mode: 'replace_active' });
    }

    if (target.id === 'menu-import-model-ws') {
        blastFileActions.openModel({ mode: 'add_to_workspace' });
    }

    if (target.id === 'menu-recent-folders') {
        const fileMenuAnchor = (document.querySelector('#global-menu-bar .menu-item.dropdown') as HTMLElement) || target;
        showRecentFoldersQuickMenu(
            fileMenuAnchor,
            (folderPath) => {
                blastFileActions.openModel({ initialFolder: folderPath, mode: 'replace_active' });
            },
            {
                title: 'Open Model / Workspace from Recent Folder',
                onBrowse: () => blastFileActions.openModel({ mode: 'replace_active' })
            }
        );
    }

    if (target.id === 'menu-save-json') {
        await blastFileActions.saveModel(undefined, false);
    }

    if (target.id === 'menu-save-as-local') {
        await blastFileActions.saveModelAs();
    }

    if (target.id === 'menu-load-binary') {
        blastFileActions.openBinaryModel({ mode: 'replace_active' });
    }

    if (target.id === 'menu-save-binary') {
        await blastFileActions.saveBinaryModel();
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
            await CustomDialog.alert("No other in-memory models available. Use 'File -> Import Model into Workspace...' to import from disk or 'File -> New Model' to create one.");
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
        const wsSlug = sanitizeModelFilenameSlug(stateManager.getActiveWorkspace()?.name || 'workspace', '_project.json');
        fallbackSaveJson(jsonString, wsSlug);
    }

    if (target.id === 'menu-import-workspace') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (ev) => {
            const file = (ev.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const parsed = JSON.parse(event.target?.result as string);
                    await applyLoadedPayload(parsed, file.name, 'replace_active', false);
                    await CustomDialog.alert(`Imported "${file.name}" successfully.`);
                } catch (err) {
                    await CustomDialog.alert("Failed to parse workspace / model file: " + err);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    if (target.id === 'menu-save-workspace-host') {
        const activeWs = stateManager.getActiveWorkspace();
        if (!activeWs) {
            await CustomDialog.alert("No active workspace to save.");
            return;
        }
        if (!networkManager.isConnected()) {
            await CustomDialog.alert("Broker is offline. Use 'Workspace -> Export Project Archive (Local JSON)...' while disconnected.");
            return;
        }

        const startPath = activeWs.activeModelId 
            ? (stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)?.filename || "") 
            : "";

        const browser = new HostFileBrowserModal(
            networkManager,
            {
                title: 'Save Workspace As (Host)',
                mode: 'save',
                defaultFilename: sanitizeModelFilenameSlug(activeWs.name, '_workspace.json'),
                initialPath: startPath,
                filters: [
                    { label: 'Workspace Files (*.json)', extensions: ['.json'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: async (fullPath) => {
                    const lastSlash = fullPath.lastIndexOf('/');
                    const dirPath = lastSlash !== -1 ? fullPath.substring(0, lastSlash) : '.';

                    // 1. Create directory on host
                    networkManager.send({
                        command: "CREATE_DIR",
                        path: dirPath
                    });

                    // 2. Save each model referenced in this workspace to the directory (including external resources)
                    const models = stateManager.getWorkspaceModels();
                    const savedModelsForWsJson: any[] = [];
                    const usedSlugs = new Set<string>();

                    models.forEach((model, idx) => {
                        let modelFilename = sanitizeModelFilenameSlug(model.name, '.json');
                        if (usedSlugs.has(modelFilename)) {
                            modelFilename = sanitizeModelFilenameSlug(`${model.name}_${idx + 1}`, '.json');
                        }
                        usedSlugs.add(modelFilename);
                        const modelPath = `${dirPath}/${modelFilename}`;
                        const prepared = prepareModelSavePayload(model, modelPath);

                        networkManager.send({
                            command: "SAVE_MODEL_FILE",
                            modelId: `ws-silent-${model.id}`,
                            filePath: modelPath,
                            fileContent: prepared.modelJson,
                            resources: prepared.resources
                        });

                        savedModelsForWsJson.push({
                            id: model.id,
                            name: model.name,
                            filename: modelPath,
                            refresh_rate: model.refresh_rate,
                            fps: model.fps,
                            views: model.views,
                            activeViewId: model.activeViewId,
                            nodes: prepared.clonedModel.nodes,
                            connections: prepared.clonedModel.connections
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
                        models: savedModelsForWsJson
                    }, null, 2);

                    networkManager.send({
                        command: "SAVE_MODEL_FILE",
                        modelId: "workspace",
                        filePath: fullPath,
                        fileContent: wsContent
                    });
                }
            }
        );
        browser.open(startPath);
    }

    if (target.id === 'menu-load-workspace-host') {
        if (!networkManager.isConnected()) {
            await CustomDialog.alert("Broker is offline. Use 'Workspace -> Import Project Archive (Local JSON)...' while disconnected.");
            return;
        }
        const activeWs = stateManager.getActiveWorkspace();
        const startPath = activeWs.activeModelId 
            ? (stateManager.getAllModels().find(m => m.id === activeWs.activeModelId)?.filename || "") 
            : "";

        const browser = new HostFileBrowserModal(
            networkManager,
            {
                title: 'Open Workspace File (Host)',
                mode: 'open',
                initialPath: startPath,
                filters: [
                    { label: 'Workspace Files (*.json)', extensions: ['.json'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: (path) => {
                    networkManager.send({
                        command: "LOAD_MODEL_FILE",
                        modelId: "workspace",
                        filePath: path
                    });
                }
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
    sourceModelId: string; // model containing source solver (1D, 2D, or 3D phase)
    targetModelId: string; // model containing target solver + remapper node
    model1dId: string;     // alias for sourceModelId (backwards compatibility)
    model2dId: string;     // alias for targetModelId (backwards compatibility)
    sourceType: '1D' | '2D' | '3D';
    processId: string;     // canonical broker key = targetModelId
}

const remap3DFiles = new Map<string, { remap_file: string; time: number }>();

function findRemapPipeline(modelId: string): RemapPipeline | null {
    const ws = stateManager.getActiveWorkspace();
    if (!ws) return null;

    const allModels = stateManager.getAllModels();
    const targetModel = allModels.find(m => m.id === modelId);

    // 1. Explicit Remap Node parameter check (Highest precedence: source_model_id configured on remap node)
    if (targetModel) {
        const remapNode = targetModel.nodes.find(n =>
            n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' ||
            n.type === 'Remap3DTo3DNode' || n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode'
        );
        if (remapNode && remapNode.parameters?.source_model_id && remapNode.parameters.source_model_id !== modelId) {
            const explicitSrc = allModels.find(m => m.id === remapNode.parameters.source_model_id);
            if (explicitSrc) {
                const is3D = remapNode.type === 'Remap3DTo3DNode';
                const is2D = !is3D && (remapNode.type === 'Remap2DTo3DNode' || (remapNode.type !== 'Remap1DTo2DNode' && remapNode.type !== 'Remap1DTo3DNode' && explicitSrc.nodes.some(n => n.type === 'CFDSolver2D') && !explicitSrc.nodes.some(n => n.type === 'CFDSolver')));
                return {
                    sourceModelId: explicitSrc.id,
                    targetModelId: modelId,
                    model1dId: explicitSrc.id,
                    model2dId: modelId,
                    sourceType: is3D ? '3D' : (is2D ? '2D' : '1D'),
                    processId: modelId,
                };
            }
        }

        // 2. Same-model intra-graph remap check (e.g., 1D CFDSolver -> RemapNode -> 2D CFDSolver2D in same model)
        if (remapNode) {
            const isRemapConnectedToTarget = targetModel.connections.some(c =>
                (c.fromNode === remapNode.id && (c.toPort === 'remap' || c.toPort === 'in')) ||
                (c.toNode === remapNode.id && c.fromPort === 'remap')
            ) || Boolean(remapNode.parameters?.target_solver);
            const upstreamConn = targetModel.connections.find(c =>
                c.toNode === remapNode.id && (c.toPort === 'in' || c.toPort === 'remap_in')
            );
            const upstreamNode = upstreamConn ? targetModel.nodes.find(n => n.id === upstreamConn.fromNode) : null;
            if (isRemapConnectedToTarget && upstreamNode) {
                if (upstreamNode.type === 'CFDSolver3D' || remapNode.type === 'Remap3DTo3DNode') {
                    return {
                        sourceModelId: modelId,
                        targetModelId: modelId,
                        model1dId: modelId,
                        model2dId: modelId,
                        sourceType: '3D',
                        processId: modelId,
                    };
                }
                if (upstreamNode.type === 'CFDSolver2D' || remapNode.type === 'Remap2DTo3DNode') {
                    return {
                        sourceModelId: modelId,
                        targetModelId: modelId,
                        model1dId: modelId,
                        model2dId: modelId,
                        sourceType: '2D',
                        processId: modelId,
                    };
                }
                if (upstreamNode.type === 'CFDSolver' || remapNode.type === 'RemapNode' || remapNode.type === 'Remap1DTo2DNode' || remapNode.type === 'Remap1DTo3DNode') {
                    return {
                        sourceModelId: modelId,
                        targetModelId: modelId,
                        model1dId: modelId,
                        model2dId: modelId,
                        sourceType: '1D',
                        processId: modelId,
                    };
                }
            }
        }
    }

    const wsConns = ws.connections as Array<{fromNode:string,fromPort:string,toNode:string,toPort:string}>;

    // Fast node-id → modelId lookup.
    const nodeToModel = new Map<string, string>();
    for (const mId of ws.modelIds) {
        const m = allModels.find(x => x.id === mId);
        m?.nodes.forEach(n => nodeToModel.set(n.id, mId));
    }

    const hasTargetSolverInModel = (m: any) => Boolean(m?.nodes?.some((n: any) =>
        n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' ||
        n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D'
    ));

    for (const conn of wsConns) {
        const fromModelId = nodeToModel.get(conn.fromNode);
        const toModelId   = nodeToModel.get(conn.toNode);
        if (!fromModelId || !toModelId || fromModelId === toModelId) continue;

        const toModel  = allModels.find(m => m.id === toModelId);
        const toNode   = toModel?.nodes.find(n => n.id === conn.toNode);
        if (!toNode) continue;

        if (toNode.type === 'RemapNode' || toNode.type === 'Remap1DTo2DNode' || toNode.type === 'Remap1DTo3DNode') {
            const isRemapConnected = toModel?.connections.some(c =>
                (c.fromNode === toNode.id && (c.toPort === 'remap' || c.toPort === 'in')) ||
                (c.toNode === toNode.id && c.fromPort === 'remap')
            ) || Boolean(toNode.parameters?.target_solver) || hasTargetSolverInModel(toModel);
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
            const isRemapConnected = toModel?.connections.some(c =>
                (c.fromNode === toNode.id && (c.toPort === 'remap' || c.toPort === 'in')) ||
                (c.toNode === toNode.id && c.fromPort === 'remap')
            ) || Boolean(toNode.parameters?.target_solver) || hasTargetSolverInModel(toModel);
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

    // Zero fallback: If no source model is explicitly specified or wired, return null.
    return null;
}

function sendContourConfig(targetId: string) {
    const m = stateManager.getAllModels().find(model => model.id === targetId);
    if (m) {
        const contourNode = m.nodes.find(n => n.type === 'TelemetryContour');
        const has2D = m.nodes.some(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');
        if (!contourNode && !has2D) return;
        const stride = Number(contourNode?.parameters?.downsample_stride ?? contourNode?.parameters?.stride ?? 1);
        const rate = stateManager.getModelRefreshRate(targetId);
        networkManager.send({
            command: "CONTOUR_CONFIG",
            modelId: targetId,
            stride,
            refresh_rate: rate
        });
    }
}

function sendView3DConfig(targetId: string) {
    const m = stateManager.getAllModels().find(model => model.id === targetId);
    if (m) {
        const view3DNode = m.nodes.find(n => n.type === 'Telemetry3DViewport');
        const carrierNode = m.nodes.find(n => isDomainMesh3DNode(n.type) || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'DomainMesh');
        const showObstacles = view3DNode ? (view3DNode.parameters?.show_obstacles !== false) : true;
        const obstaclesQuantity = view3DNode ? (view3DNode.parameters?.obstacles_quantity || 'pressure') : 'pressure';
        const showStl = view3DNode ? (view3DNode.parameters?.show_stl !== false) : true;
        const stlQuantity = view3DNode ? (view3DNode.parameters?.stl_quantity || 'pressure') : 'pressure';
        
        const rawSlices = (view3DNode?.parameters?.slices && view3DNode.parameters.slices.length > 0)
            ? view3DNode.parameters.slices
            : (carrierNode?.parameters?.slices || []);
        const slices = [...rawSlices];
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
        
        const rate = stateManager.getModelRefreshRate(targetId);
        networkManager.send({
            command: "VIEW3D_CONFIG",
            modelId: targetId,
            slices,
            refresh_rate: rate
        });
    }
}

function requestAndPlotCurrentState(targetId?: string) {
    let resolvedId = targetId || stateManager.getActiveModelId() || undefined;
    if (!resolvedId) {
        const all = stateManager.getAllModels();
        if (all.length > 0) resolvedId = all[0].id;
    }
    if (!resolvedId) return;
    const targetModelId = resolvedId;

    const model = stateManager.getAllModels().find(m => m.id === targetModelId);
    const is3D = model?.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');

    const modelStatus = stateManager.getModelStatus(targetModelId);
    const hasActiveSolver = modelStatus === 'INITIALIZED' || modelStatus === 'RUNNING' || modelStatus === 'PAUSED';
    if (networkManager.isConnected() && hasActiveSolver) {
        networkManager.send({
            command: "REFRESH_STATE",
            modelId: targetModelId
        });
        if (is3D) {
            sendView3DConfig(targetModelId);
        } else {
            sendContourConfig(targetModelId);
        }
    }

    // Re-dispatch latest recorded frame strictly for targetModelId (never cross-contaminate from other models)
    const latestFrame = playbackBuffer.getLatestFrameForModel(targetModelId);
    if (latestFrame && layoutManager) {
        layoutManager.components.forEach(comp => {
            if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                comp.instance.dispatchFrame(latestFrame, true);
            }
            if ((comp.type === 'TELEMETRY_3D' || comp.type === 'NODE_VIEWER') && comp.instance) {
                if (latestFrame.sliceBuffer) {
                    comp.instance.pushFrame(latestFrame.sliceBuffer, latestFrame.modelId);
                } else if (latestFrame.buffer && latestFrame.buffer !== latestFrame.mpmBuffer && latestFrame.buffer !== latestFrame.phaseParticlesBuffer && latestFrame.buffer !== latestFrame.femBuffer) {
                    comp.instance.pushFrame(latestFrame.buffer, latestFrame.modelId);
                }
                if (latestFrame.mpmBuffer) {
                    comp.instance.pushFrame(latestFrame.mpmBuffer, latestFrame.modelId);
                }
                if (latestFrame.phaseParticlesBuffer) {
                    comp.instance.pushFrame(latestFrame.phaseParticlesBuffer, latestFrame.modelId);
                }
                if (latestFrame.femBuffer) {
                    comp.instance.pushFrame(latestFrame.femBuffer, latestFrame.modelId);
                }
            }
        });
    }
}

const autoRunInFlight = new Set<string>();

function getUpstream1DTelemetry(pipe: any): ArrayBuffer | null {
    const srcId = pipe?.model1dId || pipe?.sourceModelId;
    if (!srcId) return null;
    const model1d = stateManager.getAllModels().find(m => m.id === srcId);
    const solver1DNode = model1d?.nodes.find(n => n.type === 'CFDSolver');
    let telemetry: any = null;
    if (solver1DNode) {
        telemetry = stateManager.getTelemetry(solver1DNode.id + "-binary");
        if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
            const raw = stateManager.getTelemetry(solver1DNode.id);
            if (raw instanceof ArrayBuffer) telemetry = raw;
        }
    }
    if ((!telemetry || !(telemetry instanceof ArrayBuffer)) && srcId) {
        const mBuf = stateManager.getTelemetry(srcId + "-binary");
        if (mBuf instanceof ArrayBuffer && !is2DFrame(mBuf)) telemetry = mBuf;
    }
    if ((!telemetry || !(telemetry instanceof ArrayBuffer)) && srcId) {
        const pb = (window as any).playbackBuffer || playbackBuffer;
        const frame = pb?.getLatestFrameForModel?.(srcId);
        const cand = frame?.buffer instanceof ArrayBuffer ? frame.buffer : (frame?.data instanceof ArrayBuffer ? frame.data : null);
        if (cand && !is2DFrame(cand)) telemetry = cand;
    }
    return telemetry instanceof ArrayBuffer ? telemetry : null;
}

function getUpstream2DTelemetry(pipe: any): ArrayBuffer | null {
    const srcId = pipe?.sourceModelId || pipe?.model2dId;
    if (!srcId) return null;
    const model2d = stateManager.getAllModels().find(m => m.id === srcId);
    const solver2DNode = model2d?.nodes.find(n => n.type === 'CFDSolver2D');
    let telemetry: any = null;
    if (solver2DNode) {
        telemetry = stateManager.getTelemetry(solver2DNode.id + "-binary");
        if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
            const raw = stateManager.getTelemetry(solver2DNode.id);
            if (raw instanceof ArrayBuffer) telemetry = raw;
        }
    }
    if ((!telemetry || !(telemetry instanceof ArrayBuffer)) && srcId) {
        const mBuf = stateManager.getTelemetry(srcId + "-binary");
        if (mBuf instanceof ArrayBuffer && is2DFrame(mBuf)) telemetry = mBuf;
    }
    if ((!telemetry || !(telemetry instanceof ArrayBuffer)) && srcId) {
        const pb = (window as any).playbackBuffer || playbackBuffer;
        const frame = pb?.getLatestFrameForModel?.(srcId);
        const cand = frame?.buffer instanceof ArrayBuffer ? frame.buffer : (frame?.data instanceof ArrayBuffer ? frame.data : null);
        if (cand && is2DFrame(cand)) telemetry = cand;
    }
    return telemetry instanceof ArrayBuffer ? telemetry : null;
}

function hasUpstream3DExportableState(srcModelId: string): boolean {
    if (!srcModelId) return false;
    const srcStatus = stateManager.getModelStatus(srcModelId);
    const srcTime = stateManager.getModelSimTime(srcModelId);
    const srcStep = stateManager.getModelStep(srcModelId);
    return (srcStatus === 'PAUSED' || srcStatus === 'INITIALIZED') && (srcTime > 0 || srcStep > 0);
}

function hasUpstreamRemapTelemetry(pipe: RemapPipeline | null): boolean {
    if (!pipe) return true;
    if (pipe.sourceType === '3D') {
        return remap3DFiles.has(pipe.sourceModelId) || hasUpstream3DExportableState(pipe.sourceModelId);
    }
    return pipe.sourceType === '2D'
        ? (getUpstream2DTelemetry(pipe) !== null)
        : (getUpstream1DTelemetry(pipe) !== null);
}

function dispatchRemapForPipeline(
    targetModelId: string,
    pipeline: RemapPipeline,
    allowAutoRun: boolean,
    command: string,
    extra: Record<string, any>
): boolean {
    if (pipeline.sourceType === '3D') {
        return tryRemapFrom3D(targetModelId, pipeline, allowAutoRun, command, extra);
    }
    if (pipeline.sourceType === '2D') {
        return tryRemapFrom2D(targetModelId, pipeline, allowAutoRun, command, extra);
    }
    return tryRemapFrom1D(targetModelId, pipeline, allowAutoRun, command, extra);
}

function tryRemapFrom1D(targetModelId: string, pipe: any, allowAutoRun: boolean = true, requestedCommand: string = "INIT", requestedExtra: Record<string, any> = {}): boolean {
    const model = stateManager.getAllModels().find(m => m.id === targetModelId);
    const srcModelId = pipe.model1dId || pipe.sourceModelId;
    const model1d = stateManager.getAllModels().find(m => m.id === srcModelId);
    const solver1DNode = model1d?.nodes.find(n => n.type === 'CFDSolver');
    const telemetry = getUpstream1DTelemetry(pipe);
    
    console.log(`[tryRemapFrom1D] targetModelId: ${targetModelId}, pipe.model1dId: ${srcModelId}`);
    console.log(`[tryRemapFrom1D] solver1DNode:`, solver1DNode);
    console.log(`[tryRemapFrom1D] telemetry:`, telemetry);

    const solver2DNode = model?.nodes.find(n => n.type === 'CFDSolver2D');
    const solver3DNode = model?.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
    const activeSolverNode = solver2DNode || solver3DNode;

    if (activeSolverNode) {
        stateManager.pushTelemetry(activeSolverNode.id, `[DEBUG] tryRemapFrom1D starting. target=${targetModelId} 1dModel=${srcModelId} node=${solver1DNode?.id ?? 'null'} telemetry=${telemetry ? ('ArrayBuffer(' + telemetry.byteLength + ')') : 'null'}`, targetModelId);
    }

    if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
        if (autoRunInFlight.has(srcModelId)) {
            console.log(`[tryRemapFrom1D] 1D model ${srcModelId} execution is already in flight. Awaiting completion.`);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            return false;
        }
        if (!allowAutoRun) {
            console.warn(`[tryRemapFrom1D] No 1D simulation telemetry found for ${srcModelId} and auto-run is disabled.`);
            return false;
        }
        if (activeSolverNode) {
            stateManager.pushTelemetry(activeSolverNode.id, `[INFO] No 1D simulation telemetry found. Automatically initializing and running 1D model (${srcModelId})...`, targetModelId);
        }
        if (srcModelId) {
            console.log(`[tryRemapFrom1D] Auto-running 1D model ${srcModelId} to generate remap profile.`);
            autoRunInFlight.add(srcModelId);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            stateManager.setModelStatus(srcModelId, 'UNINITIALIZED');
            executeModelCommand(srcModelId, "EXEC_ALL", { forceScope: '1d' }, false, true);
        }
        return false;
    }

    try {
        const meshConn1D = model1d?.connections.find(c => c.toNode === solver1DNode?.id && c.toPort === 'mesh');
        const meshNode1D = meshConn1D ? model1d?.nodes.find(n => n.id === meshConn1D.fromNode) : model1d?.nodes.find(n => n.type === 'DomainMesh');
        const cell_size = Number(meshNode1D?.parameters?.cell_size ?? 0.001);

        const chargeNode1D = model1d?.nodes.find(n => n.type === 'Charge1D');
        const matNode1D = model1d?.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)))
            || model1d?.nodes.find(n => n.type === 'Material' && n.parameters?.material_type !== 'Air');
        const airNode1D = model1d?.nodes.find(n => n.type === 'Material' && (isAirMaterialNode(n) || n.parameters?.material_type === 'Air'));
        const gamma = Number(airNode1D?.parameters?.gamma ?? solver1DNode?.parameters?.gamma ?? 1.4);

        const view = new DataView(telemetry);
        const n_cells = view.getUint32(0, true);
        const n_channels = view.getUint32(4, true);
        const floats = new Float32Array(telemetry, 8);
        
        const r_1d: number[] = [];
        const rho_1d: number[] = [];
        const ur_1d: number[] = [];
        const p_1d: number[] = [];
        const states_1d: any[] = [];

        // Planar channel layout in C++ CFDSolver::getTelemetryChannels() (9 channels):
        // Ch 0: Pressure | Ch 1: Density | Ch 2: Velocity | Ch 3: Specific Internal Energy (e)
        // Ch 4: Alpha1   | Ch 5: Alpha2  | Ch 6: AlphaAir | Ch 7: arho1 | Ch 8: arho2
        const p_offset      = 0 * n_cells;
        const rho_offset    = 1 * n_cells;
        const u_offset      = 2 * n_cells;
        const e_offset      = 3 * n_cells;
        const alpha1_offset = 4 * n_cells;
        const alpha2_offset = 5 * n_cells;
        const arho1_offset  = 7 * n_cells;
        const arho2_offset  = 8 * n_cells;

        for (let i = 0; i < n_cells; ++i) {
            const r = (i + 0.5) * cell_size;
            const p = floats[p_offset + i];
            const rho = floats[rho_offset + i];
            const u = floats[u_offset + i];
            const a1 = (n_channels > 4) ? floats[alpha1_offset + i] : 0.0;
            const a2 = (n_channels > 5) ? floats[alpha2_offset + i] : 1.0;
            const ar1 = (n_channels > 7) ? floats[arho1_offset + i] : (a1 * rho);
            const ar2 = (n_channels > 8) ? floats[arho2_offset + i] : (a2 * rho);
            const e_spec = (n_channels > 3)
                ? floats[e_offset + i]
                : ((gamma > 1.0 && rho > 0) ? (p / ((gamma - 1.0) * rho)) : 0.0);
            const E = rho * e_spec + 0.5 * rho * u * u;

            r_1d.push(r);
            p_1d.push(p);
            rho_1d.push(rho);
            ur_1d.push(u);

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

        const allModels = stateManager.getAllModels();
        const inherited = model ? resolveRemapInheritance(model, targetModelId, allModels) : null;
        const cp = inherited?.chargeParams;
        const ap = inherited?.airParams;

        const rho = cp?.rho ?? 1630.0;
        const charge_radius = cp?.charge_radius ?? 0.05;
        const atm_p = ap?.atm_pressure ?? 101325.0;
        const atm_t = ap?.atm_temperature ?? 288.15;
        const ambient_rho = ap?.ambient_rho ?? (atm_p / (287.058 * atm_t));
        const ambient_p = ap?.ambient_p ?? atm_p;
        const effGamma = ap?.gamma ?? gamma;

        const isIdeal1D = cp?.is_ideal_gas ?? false;
        const explosive_type = cp?.explosive_type ?? (isIdeal1D ? 'MaterialIdealGas' : 'MaterialExplosive');
        const material_type = cp?.material_type ?? (isIdeal1D ? 'Ideal Gas Charge' : 'JWL Charge');
        const composition = cp?.composition ?? 'TNT';
        const preset = cp?.preset;
        const detonation_energy = cp?.detonation_energy ?? 4290000;
        const det_vel = cp?.det_vel ?? 6930;
        const jwl_A = cp?.jwl_A ?? 373.77e9;
        const jwl_B = cp?.jwl_B ?? 3.747e9;
        const jwl_R1 = cp?.jwl_R1 ?? 4.15;
        const jwl_R2 = cp?.jwl_R2 ?? 0.90;
        const jwl_omega = cp?.jwl_omega ?? 0.35;

        const afterburn_enabled = cp?.afterburn_enabled ?? false;
        const afterburn_energy = cp?.afterburn_energy ?? 1.5e7;
        const afterburn_fuel_fraction = cp?.afterburn_fuel_fraction ?? 0.25;
        const afterburn_stoich_ratio = cp?.afterburn_stoich_ratio ?? 3.0;
        const afterburn_ignition_temp = cp?.afterburn_ignition_temp ?? 700.0;
        const afterburn_tau_chem = cp?.afterburn_tau_chem ?? 1.0e-5;
        const afterburn_c_edc = cp?.afterburn_c_edc ?? 0.15;
        const afterburn_tau_expansion = cp?.afterburn_tau_expansion ?? 0.0;
        const afterburn_ambient_o2_fraction = cp?.afterburn_ambient_o2_fraction ?? 0.233;

        const remapConn = model?.connections.find(c =>
            (c.toNode === solver2DNode?.id || c.toNode === solver3DNode?.id) && (c.toPort === 'remap' || c.toPort === 'in')
        );
        const remapNode = remapConn
            ? model?.nodes.find(n => n.id === remapConn.fromNode)
            : (inherited?.remapNode ?? model?.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode'));

        const meshConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'mesh');
        const meshNode3D = meshConn3D ? model?.nodes.find(n => n.id === meshConn3D.fromNode) : model?.nodes.find(n => isDomainMesh3DNode(n.type));

        const defaultCenterX = meshNode3D?.parameters?.xmin !== undefined && meshNode3D?.parameters?.xmax !== undefined
            ? (Number(meshNode3D.parameters.xmin) + Number(meshNode3D.parameters.xmax)) * 0.5 : 0.5;
        const defaultCenterY = meshNode3D?.parameters?.ymin !== undefined && meshNode3D?.parameters?.ymax !== undefined
            ? (Number(meshNode3D.parameters.ymin) + Number(meshNode3D.parameters.ymax)) * 0.5 : 0.5;
        const defaultCenterZ = meshNode3D?.parameters?.zmin !== undefined && meshNode3D?.parameters?.zmax !== undefined
            ? (Number(meshNode3D.parameters.zmin) + Number(meshNode3D.parameters.zmax)) * 0.5 : 0.1;

        const explosive_x = Number(remapNode?.parameters?.explosive_x ?? remapNode?.parameters?.center_x ?? defaultCenterX);
        const explosive_y = Number(remapNode?.parameters?.explosive_y ?? remapNode?.parameters?.center_y ?? defaultCenterY);
        const explosive_z = Number(remapNode?.parameters?.explosive_z ?? remapNode?.parameters?.center_z ?? remapNode?.parameters?.z_offset ?? defaultCenterZ);
        const explosive_r = Number(remapNode?.parameters?.explosive_r ?? 0.0);
        const rawRemapR = Number(remapNode?.parameters?.remap_radius ?? 0.0);
        const remap_radius = (Number.isFinite(rawRemapR) && rawRemapR > 0) ? rawRemapR : 0.0;
        const bc_x_min = String(meshNode3D?.parameters?.bc_x_min ?? solver3DNode?.parameters?.bc_x_min ?? 'Reflecting');
        const bc_x_max = String(meshNode3D?.parameters?.bc_x_max ?? solver3DNode?.parameters?.bc_x_max ?? 'Transmitting');
        const bc_y_min = String(meshNode3D?.parameters?.bc_y_min ?? solver3DNode?.parameters?.bc_y_min ?? 'Reflecting');
        const bc_y_max = String(meshNode3D?.parameters?.bc_y_max ?? solver3DNode?.parameters?.bc_y_max ?? 'Transmitting');
        const bc_z_min = String(meshNode3D?.parameters?.bc_z_min ?? solver3DNode?.parameters?.bc_z_min ?? 'Reflecting');
        const bc_z_max = String(meshNode3D?.parameters?.bc_z_max ?? solver3DNode?.parameters?.bc_z_max ?? 'Transmitting');

        const sourceTime = model1d ? stateManager.getModelSimTime(model1d.id) : 0.0;
        const srcGaugeTel = srcModelId ? stateManager.getTelemetry(srcModelId + "-gauges") : null;
        const upstream_gauge_history = srcGaugeTel?.gauges_history || undefined;

        console.log(`[tryRemapFrom1D] Sending REMAP payload for target ${targetModelId} with ${n_cells} cells (${n_channels} ch). Center: (${explosive_x}, ${explosive_y}, ${explosive_z}), radius: ${remap_radius || 'Full'}, charge_radius: ${charge_radius}, afterburn: ${afterburn_enabled}, sourceTime: ${sourceTime}`);
        networkManager.send({
            command: "REMAP",
            modelId: targetModelId,
            time: sourceTime,
            sim_time: sourceTime,
            explosive_x: explosive_x,
            explosive_y: explosive_y,
            explosive_z: explosive_z,
            explosive_r: explosive_r,
            remap_radius: remap_radius,
            charge_radius: charge_radius,
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
            gamma: effGamma,
            atm_pressure: atm_p,
            atm_temperature: atm_t,
            ambient_rho: ambient_rho,
            ambient_p: ambient_p,
            is_ideal_gas: isIdeal1D,
            material_type: material_type,
            explosive_type: explosive_type,
            composition: composition,
            preset: preset,
            rho: rho,
            high_rho: rho,
            detonation_energy: detonation_energy,
            det_vel: det_vel,
            jwl_A: jwl_A,
            jwl_B: jwl_B,
            jwl_R1: jwl_R1,
            jwl_R2: jwl_R2,
            jwl_omega: jwl_omega,
            afterburn_enabled: afterburn_enabled,
            afterburn_energy: afterburn_energy,
            afterburn_fuel_fraction: afterburn_fuel_fraction,
            afterburn_stoich_ratio: afterburn_stoich_ratio,
            afterburn_ignition_temp: afterburn_ignition_temp,
            afterburn_tau_chem: afterburn_tau_chem,
            afterburn_c_edc: afterburn_c_edc,
            afterburn_tau_expansion: afterburn_tau_expansion,
            afterburn_ambient_o2_fraction: afterburn_ambient_o2_fraction,
            upstream_gauge_history: upstream_gauge_history
        });
        if (sourceTime > 0) {
            stateManager.setModelSimTime(targetModelId, sourceTime);
        }
        return true;
    } catch (err) {
        if (activeSolverNode) {
            stateManager.pushTelemetry(activeSolverNode.id, `[ERROR] Failed to parse 1D telemetry: ${err}`, targetModelId);
        }
        return false;
    }
}

function tryRemapFrom2D(targetModelId: string, pipe: any, allowAutoRun: boolean = true, requestedCommand: string = "INIT", requestedExtra: Record<string, any> = {}): boolean {
    const model = stateManager.getAllModels().find(m => m.id === targetModelId);
    const sourceModelId = pipe.sourceModelId || pipe.model2dId;
    const model2d = stateManager.getAllModels().find(m => m.id === sourceModelId);
    const solver2DNode = model2d?.nodes.find(n => n.type === 'CFDSolver2D');
    const telemetry = getUpstream2DTelemetry(pipe);
    
    const solver3DNode = model?.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');

    if (solver3DNode) {
        stateManager.pushTelemetry(solver3DNode.id, `[DEBUG] tryRemapFrom2D starting. target=${targetModelId} 2dModel=${sourceModelId} node=${solver2DNode?.id ?? 'null'} telemetry=${telemetry ? ('ArrayBuffer(' + telemetry.byteLength + ')') : 'null'}`, targetModelId);
    }

    if (!telemetry || !(telemetry instanceof ArrayBuffer)) {
        if (autoRunInFlight.has(sourceModelId)) {
            console.log(`[tryRemapFrom2D] 2D model ${sourceModelId} execution is already in flight. Awaiting completion.`);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            return false;
        }
        if (!allowAutoRun) {
            console.warn(`[tryRemapFrom2D] No 2D simulation telemetry found for ${sourceModelId} and auto-run is disabled.`);
            return false;
        }
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[INFO] No 2D simulation telemetry found. Automatically initializing and running 2D model (${sourceModelId})...`, targetModelId);
        }
        if (sourceModelId) {
            console.log(`[tryRemapFrom2D] Auto-running 2D model ${sourceModelId} to generate remap profile.`);
            autoRunInFlight.add(sourceModelId);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            stateManager.setModelStatus(sourceModelId, 'UNINITIALIZED');
            executeModelCommand(sourceModelId, "EXEC_ALL", { forceScope: '2d' }, false, true);
        }
        return false;
    }

    try {
        const meshConn2D = model2d?.connections.find(c => c.toNode === solver2DNode?.id && c.toPort === 'mesh');
        const meshNode2D = meshConn2D ? model2d?.nodes.find(n => n.id === meshConn2D.fromNode) : model2d?.nodes.find(n => isDomainMesh2DNode(n.type) || n.type === 'DomainMesh');
        const raw_cell_size = Number(meshNode2D?.parameters?.cell_size ?? 0.005);
        const max_r = Number(meshNode2D?.parameters?.max_r ?? meshNode2D?.parameters?.domain_radius ?? 1.0);
        const max_z = Number(meshNode2D?.parameters?.max_z ?? meshNode2D?.parameters?.domain_height ?? max_r);

        const view = new DataView(telemetry);
        let nr = 0;
        let nz = 0;
        let num_materials = 2;
        let floats: Float32Array;
        let cell_size = raw_cell_size;

        const maybeNumLeaves = telemetry.byteLength >= 8 ? view.getUint32(0, true) : 0;
        const maybeAmrChannels = telemetry.byteLength >= 8 ? view.getUint32(4, true) : 0;
        const isAmrTelemetry = (solver2DNode?.parameters?.mesh_type === 'amr' || (maybeNumLeaves > 0 && maybeNumLeaves <= 65536 && (maybeAmrChannels === 6 || maybeAmrChannels === 7))) &&
            (8 + maybeNumLeaves * (2 + 256 * maybeAmrChannels) * 4 === telemetry.byteLength);

        if (isAmrTelemetry) {
            const num_leaves = maybeNumLeaves;
            const n_channels = maybeAmrChannels;
            const amrMaxLevels = Math.max(1, Number(solver2DNode?.parameters?.amr_max_levels ?? 3));
            const maxLvl = Math.max(0, amrMaxLevels - 1);
            const scaleFactor = 1 << maxLvl;
            const calcBaseNr = Math.max(16, Math.ceil(Math.round(max_r / raw_cell_size) / 16) * 16);
            const level0TilesR = Math.max(1, Math.ceil(calcBaseNr / 16));
            const dr_base = max_r / (level0TilesR * 16);
            const level0TilesZ = Math.max(1, Math.round(max_z / (dr_base * 16)));
            nr = (level0TilesR * 16) * scaleFactor;
            nz = (level0TilesZ * 16) * scaleFactor;
            cell_size = dr_base / scaleFactor;
            num_materials = n_channels >= 7 ? 3 : 2;
            floats = new Float32Array(nr * nz * n_channels);
            const floatsPerTile = 2 + 256 * n_channels;
            for (let l = 0; l < num_leaves; ++l) {
                const offset = 8 + l * floatsPerTile * 4;
                const meta1 = view.getUint32(offset, true);
                const meta2 = view.getUint32(offset + 4, true);
                const tile_r = meta1 >>> 16;
                const tile_z = meta1 & 0xFFFF;
                const level = (meta2 >>> 8) & 0xFF;
                const cellSizeInFinest = 1 << Math.max(0, maxLvl - level);
                const startR = tile_r * 16 * cellSizeInFinest;
                const startZ = tile_z * 16 * cellSizeInFinest;
                for (let i = 0; i < 16; ++i) {
                    for (let j = 0; j < 16; ++j) {
                        const cellIndex = i * 16 + j;
                        for (let ch = 0; ch < n_channels; ++ch) {
                            const val = view.getFloat32(offset + 8 + (cellIndex * n_channels + ch) * 4, true);
                            const chOffset = ch * nr * nz;
                            for (let rr = startR + i * cellSizeInFinest; rr < startR + (i + 1) * cellSizeInFinest && rr < nr; ++rr) {
                                for (let zz = startZ + j * cellSizeInFinest; zz < startZ + (j + 1) * cellSizeInFinest && zz < nz; ++zz) {
                                    floats[chOffset + rr * nz + zz] = val;
                                }
                            }
                        }
                    }
                }
            }
        } else {
            nr = view.getUint32(0, true);
            nz = view.getUint32(4, true);
            const n_channels = view.getUint32(8, true);
            num_materials = n_channels >= 7 ? 3 : 2;
            floats = new Float32Array(telemetry, 12, nr * nz * n_channels);
            // Adjust 2D cell_size for telemetry stride so 3D spatial extent equals original max_r / max_z
            const orig_nr = Math.round(max_r / raw_cell_size);
            const stride = (nr > 0 && orig_nr > 0) ? Math.max(1, Math.round(orig_nr / nr)) : 1;
            cell_size = raw_cell_size * stride;
        }
        
        const remapConn = model?.connections.find(c => c.toNode === solver3DNode?.id && (c.toPort === 'remap' || c.toPort === 'in'));
        const remapNode = remapConn ? model?.nodes.find(n => n.id === remapConn.fromNode) : model?.nodes.find(n => n.type === 'Remap2DTo3DNode' || n.type === 'RemapNode');

        // Extract 3D target domain parameters
        const meshConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'mesh');
        const meshNode3D = meshConn3D ? model?.nodes.find(n => n.id === meshConn3D.fromNode) : model?.nodes.find(n => isDomainMesh3DNode(n.type));
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

        const explosive_x = Number(remapNode?.parameters?.explosive_x ?? remapNode?.parameters?.center_x ?? default_x);
        const explosive_y = Number(remapNode?.parameters?.explosive_y ?? remapNode?.parameters?.center_y ?? default_y);
        const explosive_z = Number(remapNode?.parameters?.explosive_z ?? remapNode?.parameters?.center_z ?? remapNode?.parameters?.z_offset ?? default_z);
        const rawRemapR2D = Number(remapNode?.parameters?.remap_radius ?? 0.0);
        const remap_radius = (Number.isFinite(rawRemapR2D) && rawRemapR2D > 0) ? rawRemapR2D : 0.0;
        const nx_3d = Math.max(1, Math.round((xmax_3d - xmin_3d) / cell_size_3d));
        const ny_3d = Math.max(1, Math.round((ymax_3d - ymin_3d) / cell_size_3d));
        const nz_3d = Math.max(1, Math.round((zmax_3d - zmin_3d) / cell_size_3d));
        const device = String(solver3DNode?.parameters?.device ?? 'cuda');
        const precision = String(solver3DNode?.parameters?.precision ?? 'single');

        // Extract 2D source detonator/burst z location & inherited Charge/EOS/Air/Afterburn via SSOT
        const allModels = stateManager.getAllModels();
        const inherited = model ? resolveRemapInheritance(model, targetModelId, allModels) : null;
        const cp = inherited?.chargeParams;
        const ap = inherited?.airParams;
        const source_explosive_z = inherited?.sourceExplosiveOrigin?.z ?? 0.0;

        const gamma = ap?.gamma ?? 1.4;
        const atm_p = ap?.atm_pressure ?? 101325.0;
        const atm_t = ap?.atm_temperature ?? 288.15;
        const ambient_rho = ap?.ambient_rho ?? (atm_p / (287.058 * atm_t));

        const matType = cp?.material_type ?? 'JWL Charge';
        const is_ideal_gas = cp?.is_ideal_gas ?? false;
        const explosive_type = cp?.explosive_type ?? (is_ideal_gas ? 'MaterialIdealGas' : 'MaterialExplosive');
        const composition = cp?.composition ?? 'TNT';
        const preset = String(cp?.preset ?? composition);
        const rho = cp?.rho ?? 1630.0;
        const detonation_energy = cp?.detonation_energy ?? 4290000;
        const det_vel = cp?.det_vel ?? 6930;
        const jwl_A = cp?.jwl_A ?? 373.77e9;
        const jwl_B = cp?.jwl_B ?? 3.747e9;
        const jwl_R1 = cp?.jwl_R1 ?? 4.15;
        const jwl_R2 = cp?.jwl_R2 ?? 0.90;
        const jwl_omega = cp?.jwl_omega ?? 0.35;
        const charge_radius = (cp?.charge_radius && cp.charge_radius > 0) ? cp.charge_radius : 0.05;

        const afterburn_enabled = cp?.afterburn_enabled ?? false;
        const afterburn_energy = cp?.afterburn_energy ?? 1.5e7;
        const afterburn_fuel_fraction = cp?.afterburn_fuel_fraction ?? 0.25;
        const afterburn_stoich_ratio = cp?.afterburn_stoich_ratio ?? 3.0;
        const afterburn_ignition_temp = cp?.afterburn_ignition_temp ?? 700.0;
        const afterburn_tau_chem = cp?.afterburn_tau_chem ?? 1.0e-5;
        const afterburn_c_edc = cp?.afterburn_c_edc ?? 0.15;
        const afterburn_tau_expansion = cp?.afterburn_tau_expansion ?? 0.0;
        const afterburn_ambient_o2_fraction = cp?.afterburn_ambient_o2_fraction ?? 0.233;

        const bc_x_min = String(meshNode3D?.parameters?.bc_x_min ?? solver3DNode?.parameters?.bc_x_min ?? 'Reflecting');
        const bc_x_max = String(meshNode3D?.parameters?.bc_x_max ?? solver3DNode?.parameters?.bc_x_max ?? 'Transmitting');
        const bc_y_min = String(meshNode3D?.parameters?.bc_y_min ?? solver3DNode?.parameters?.bc_y_min ?? 'Reflecting');
        const bc_y_max = String(meshNode3D?.parameters?.bc_y_max ?? solver3DNode?.parameters?.bc_y_max ?? 'Transmitting');
        const bc_z_min = String(meshNode3D?.parameters?.bc_z_min ?? solver3DNode?.parameters?.bc_z_min ?? 'Reflecting');
        const bc_z_max = String(meshNode3D?.parameters?.bc_z_max ?? solver3DNode?.parameters?.bc_z_max ?? 'Transmitting');

        const sourceTime = model2d ? stateManager.getModelSimTime(model2d.id) : 0.0;
        const srcGaugeTel2D = sourceModelId ? stateManager.getTelemetry(sourceModelId + "-gauges") : null;
        const upstream_gauge_history = srcGaugeTel2D?.gauges_history || undefined;

        console.log(`[tryRemapFrom2D] Sending REMAP_2D payload for target ${targetModelId} with ${nr}x${nz} cells. 3D Center: (${explosive_x}, ${explosive_y}, ${explosive_z}), 2D detonator_z: ${source_explosive_z}, radius: ${remap_radius || 'Full'}, charge_radius: ${charge_radius}, afterburn: ${afterburn_enabled}, sourceTime: ${sourceTime}`);
        networkManager.send({
            command: "REMAP_2D",
            modelId: targetModelId,
            time: sourceTime,
            sim_time: sourceTime,
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
            charge_radius: charge_radius,
            num_materials: num_materials,
            gamma: gamma,
            atm_pressure: atm_p,
            atm_temperature: atm_t,
            ambient_rho: ambient_rho,
            ambient_p: atm_p,
            is_ideal_gas: is_ideal_gas,
            material_type: is_ideal_gas ? 'Ideal Gas Charge' : matType,
            explosive_type: explosive_type,
            composition: composition,
            preset: preset,
            rho: rho,
            detonation_energy: detonation_energy,
            det_vel: det_vel,
            jwl_A: jwl_A,
            jwl_B: jwl_B,
            jwl_R1: jwl_R1,
            jwl_R2: jwl_R2,
            jwl_omega: jwl_omega,
            afterburn_enabled: afterburn_enabled,
            afterburn_energy: afterburn_energy,
            afterburn_fuel_fraction: afterburn_fuel_fraction,
            afterburn_stoich_ratio: afterburn_stoich_ratio,
            afterburn_ignition_temp: afterburn_ignition_temp,
            afterburn_tau_chem: afterburn_tau_chem,
            afterburn_c_edc: afterburn_c_edc,
            afterburn_tau_expansion: afterburn_tau_expansion,
            afterburn_ambient_o2_fraction: afterburn_ambient_o2_fraction,
            upstream_gauge_history: upstream_gauge_history,
            telemetry_data: Array.from(floats)
        });
        if (sourceTime > 0) {
            stateManager.setModelSimTime(targetModelId, sourceTime);
        }
        return true;
    } catch (err) {
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[ERROR] Failed to parse 2D telemetry: ${err}`, targetModelId);
        }
        return false;
    }
}

function tryRemapFrom3D(targetModelId: string, pipe: any, allowAutoRun: boolean = true, requestedCommand: string = "INIT", requestedExtra: Record<string, any> = {}): boolean {
    const allModels = stateManager.getAllModels();
    const model = allModels.find(m => m.id === targetModelId);
    const sourceModelId = pipe.sourceModelId;
    const model3dSrc = allModels.find(m => m.id === sourceModelId);
    const solver3DNode = model?.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
    const remapFile = sourceModelId ? remap3DFiles.get(sourceModelId) : undefined;

    if (!remapFile) {
        if (autoRunInFlight.has(sourceModelId)) {
            console.log(`[tryRemapFrom3D] 3D model ${sourceModelId} execution is already in flight. Awaiting completion.`);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            return false;
        }
        if (sourceModelId && hasUpstream3DExportableState(sourceModelId)) {
            console.log(`[tryRemapFrom3D] Requesting EXPORT_REMAP_3D from completed 3D model ${sourceModelId}`);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            networkManager.send({
                command: "EXPORT_REMAP_3D",
                modelId: sourceModelId,
                targetModelId: targetModelId,
                remap_file: `/tmp/blastdaemon_remap3d_${sourceModelId}.bin`
            });
            return false;
        }
        if (!allowAutoRun) {
            console.warn(`[tryRemapFrom3D] No 3D remap snapshot found for ${sourceModelId} and auto-run is disabled.`);
            return false;
        }
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[INFO] No 3D remap snapshot found. Automatically running upstream 3D model (${sourceModelId})...`, targetModelId);
        }
        if (sourceModelId) {
            autoRunInFlight.add(sourceModelId);
            pipelineAutoRunPending.set(targetModelId, { command: requestedCommand, extra: requestedExtra });
            stateManager.setModelStatus(sourceModelId, 'UNINITIALIZED');
            executeModelCommand(sourceModelId, "EXEC_ALL", { forceScope: '3d' }, false, true);
        }
        return false;
    }

    try {
        const inherited = model ? resolveRemapInheritance(model, targetModelId, allModels) : null;
        const cp = inherited?.chargeParams;
        const ap = inherited?.airParams;

        const meshConn3D = model?.connections.find(c => c.toNode === solver3DNode?.id && c.toPort === 'mesh');
        const meshNode3D = meshConn3D ? model?.nodes.find(n => n.id === meshConn3D.fromNode) : model?.nodes.find(n => isDomainMesh3DNode(n.type));
        const defaultCenterX = meshNode3D?.parameters?.xmin !== undefined && meshNode3D?.parameters?.xmax !== undefined
            ? (Number(meshNode3D.parameters.xmin) + Number(meshNode3D.parameters.xmax)) * 0.5 : 0.5;
        const defaultCenterY = meshNode3D?.parameters?.ymin !== undefined && meshNode3D?.parameters?.ymax !== undefined
            ? (Number(meshNode3D.parameters.ymin) + Number(meshNode3D.parameters.ymax)) * 0.5 : 0.5;
        const defaultCenterZ = meshNode3D?.parameters?.zmin !== undefined && meshNode3D?.parameters?.zmax !== undefined
            ? (Number(meshNode3D.parameters.zmin) + Number(meshNode3D.parameters.zmax)) * 0.5 : 0.1;

        const remapNode = inherited?.remapNode ?? model?.nodes.find(n => n.type === 'Remap3DTo3DNode');
        const explosive_x = Number(remapNode?.parameters?.explosive_x ?? defaultCenterX);
        const explosive_y = Number(remapNode?.parameters?.explosive_y ?? defaultCenterY);
        const explosive_z = Number(remapNode?.parameters?.explosive_z ?? defaultCenterZ);
        const rawRemapR = Number(remapNode?.parameters?.remap_radius ?? 0.0);
        const remap_radius = (Number.isFinite(rawRemapR) && rawRemapR > 0) ? rawRemapR : 0.0;

        const srcOrigin = inherited?.sourceExplosiveOrigin ?? { x: defaultCenterX, y: defaultCenterY, z: defaultCenterZ };
        const sourceTime = model3dSrc ? stateManager.getModelSimTime(model3dSrc.id) : 0.0;
        const srcGaugeTel3D = sourceModelId ? stateManager.getTelemetry(sourceModelId + "-gauges") : null;
        const upstream_gauge_history = srcGaugeTel3D?.gauges_history || undefined;

        console.log(`[tryRemapFrom3D] Sending REMAP_3D payload for target ${targetModelId} from ${remapFile}. Target Center: (${explosive_x}, ${explosive_y}, ${explosive_z}), Source Origin: (${srcOrigin.x}, ${srcOrigin.y}, ${srcOrigin.z}), radius: ${remap_radius || 'Full'}, sourceTime: ${sourceTime}`);
        networkManager.send({
            command: "REMAP_3D",
            modelId: targetModelId,
            remap_file: remapFile,
            time: sourceTime,
            sim_time: sourceTime,
            explosive_x: explosive_x,
            explosive_y: explosive_y,
            explosive_z: explosive_z,
            source_explosive_x: srcOrigin.x,
            source_explosive_y: srcOrigin.y,
            source_explosive_z: srcOrigin.z,
            remap_radius: remap_radius,
            charge_radius: cp?.charge_radius ?? 0.05,
            gamma: ap?.gamma ?? 1.4,
            atm_pressure: ap?.atm_pressure ?? 101325.0,
            atm_temperature: ap?.atm_temperature ?? 288.15,
            ambient_rho: ap?.ambient_rho ?? 1.225,
            ambient_p: ap?.ambient_p ?? 101325.0,
            is_ideal_gas: cp?.is_ideal_gas ?? false,
            material_type: cp?.material_type ?? 'JWL Charge',
            explosive_type: cp?.explosive_type ?? 'MaterialExplosive',
            composition: cp?.composition ?? 'TNT',
            preset: cp?.preset ?? 'TNT',
            rho: cp?.rho ?? 1630.0,
            detonation_energy: cp?.detonation_energy ?? 4290000,
            det_vel: cp?.det_vel ?? 6930,
            jwl_A: cp?.jwl_A ?? 373.77e9,
            jwl_B: cp?.jwl_B ?? 3.747e9,
            jwl_R1: cp?.jwl_R1 ?? 4.15,
            jwl_R2: cp?.jwl_R2 ?? 0.90,
            jwl_omega: cp?.jwl_omega ?? 0.35,
            afterburn_enabled: cp?.afterburn_enabled ?? false,
            afterburn_energy: cp?.afterburn_energy ?? 1.5e7,
            afterburn_fuel_fraction: cp?.afterburn_fuel_fraction ?? 0.25,
            afterburn_stoich_ratio: cp?.afterburn_stoich_ratio ?? 3.0,
            afterburn_ignition_temp: cp?.afterburn_ignition_temp ?? 700.0,
            afterburn_tau_chem: cp?.afterburn_tau_chem ?? 1.0e-5,
            afterburn_c_edc: cp?.afterburn_c_edc ?? 0.15,
            afterburn_tau_expansion: cp?.afterburn_tau_expansion ?? 0.0,
            afterburn_ambient_o2_fraction: cp?.afterburn_ambient_o2_fraction ?? 0.233,
            upstream_gauge_history: upstream_gauge_history
        });
        if (sourceTime > 0) {
            stateManager.setModelSimTime(targetModelId, sourceTime);
        }
        return true;
    } catch (err) {
        if (solver3DNode) {
            stateManager.pushTelemetry(solver3DNode.id, `[ERROR] Failed to dispatch 3D remap: ${err}`, targetModelId);
        }
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command execution & Workspace Pipeline Engine
// ─────────────────────────────────────────────────────────────────────────────

const pipelineAutoRunPending = new Map<string, { command: string; extra: Record<string, any> }>();

function clearDownstreamAutoRun(sourceId: string, visited: Set<string> = new Set()): void {
    if (!sourceId || visited.has(sourceId)) return;
    visited.add(sourceId);
    autoRunInFlight.delete(sourceId);
    for (const m of stateManager.getAllModels()) {
        const pipe = findRemapPipeline(m.id);
        if (pipe && (pipe.sourceModelId === sourceId || pipe.model1dId === sourceId)) {
            if (m.id !== sourceId) {
                pipelineAutoRunPending.delete(m.id);
                clearDownstreamAutoRun(m.id, visited);
            }
        }
    }
}

function findActiveUpstreamAutoRunModelId(modelId: string): string | null {
    const visited = new Set<string>([modelId]);
    let curr: string | undefined = modelId;
    while (curr) {
        const p = findRemapPipeline(curr);
        if (!p || !p.sourceModelId || p.sourceModelId === curr || visited.has(p.sourceModelId)) break;
        visited.add(p.sourceModelId);
        const srcStatus = stateManager.getModelStatus(p.sourceModelId);
        if (autoRunInFlight.has(p.sourceModelId) || (srcStatus === 'RUNNING' && pipelineAutoRunPending.has(curr))) {
            return p.sourceModelId;
        }
        curr = p.sourceModelId;
    }
    return null;
}

function executeWorkspacePipeline(onlyModelIds?: string[]): void {
    const workspaceModels = stateManager.getAllModels();
    const allModels = (onlyModelIds && onlyModelIds.length > 0)
        ? workspaceModels.filter(m => onlyModelIds.includes(m.id))
        : workspaceModels;
    if (allModels.length === 0) return;

    // Find models with no upstream remap dependencies (root stages, typically Stage 1 or standalone)
    const downstreamTargetIds = new Set<string>();
    for (const m of allModels) {
        const pipe = findRemapPipeline(m.id);
        if (pipe && pipe.sourceModelId !== m.id) {
            downstreamTargetIds.add(m.id);
        }
    }

    const rootModels = allModels.filter(m => !downstreamTargetIds.has(m.id));
    const targetDownstreams = allModels.filter(m => downstreamTargetIds.has(m.id));

    if (rootModels.length > 0) {
        rootModels.forEach(rm => {
            console.log(`[Workspace Pipeline] Executing root stage model ${rm.name || rm.id}`);
            remap3DFiles.delete(rm.id);
            clearDownstreamAutoRun(rm.id);
            stateManager.setModelStatus(rm.id, 'UNINITIALIZED');
        });
        targetDownstreams.forEach(dm => {
            remap3DFiles.delete(dm.id);
            pipelineAutoRunPending.set(dm.id, {
                command: "EXEC_ALL",
                extra: { upstreamCompleted: true, skipUpstreamAutoRun: true }
            });
        });
        rootModels.forEach(rm => {
            if (targetDownstreams.length > 0) {
                autoRunInFlight.add(rm.id);
            }
            executeModelCommand(rm.id, "EXEC_ALL", { forceRestart: false }, false);
        });
    } else {
        targetDownstreams.forEach(dm => {
            remap3DFiles.delete(dm.id);
            pipelineAutoRunPending.set(dm.id, {
                command: "EXEC_ALL",
                extra: { upstreamCompleted: true, skipUpstreamAutoRun: true }
            });
        });
        allModels.forEach(m => {
            remap3DFiles.delete(m.id);
            stateManager.setModelStatus(m.id, 'UNINITIALIZED');
            executeModelCommand(m.id, "EXEC_ALL", { forceRestart: false }, false);
        });
    }
}

(window as any).isUpstreamAutoRunningFor = (mId?: string | null): boolean => {
    if (!mId) return false;
    const p = findRemapPipeline(mId);
    if (!p || p.sourceModelId === mId) return false;
    return Boolean(pipelineAutoRunPending.has(mId) || findActiveUpstreamAutoRunModelId(mId));
};

const awaitingInitResetByModel = new Set<string>();
const pausedByUserModels = new Set<string>();
const autoRecoveryRetryModels = new Set<string>();
const lastRunCmdTimeByModel = new Map<string, number>();
const lastResetTimeByModel = new Map<string, number>();

function markModelRunningStarted(mid: string): void {
    pausedByUserModels.delete(mid);
    lastRunCmdTimeByModel.set(mid, Date.now());
    stateManager.setModelStatus(mid, 'RUNNING');
}

function resetModelRunState(targetModelId: string): void {
    remap3DFiles.delete(targetModelId);
    awaitingInitResetByModel.add(targetModelId);
    lastResetTimeByModel.set(targetModelId, Date.now());
    pausedByUserModels.delete(targetModelId);
    lastRunCmdTimeByModel.delete(targetModelId);
    stateManager.setModelStatus(targetModelId, 'UNINITIALIZED');
    stateManager.setModelProgress(targetModelId, 0);
    stateManager.setModelSimTime(targetModelId, 0.0);
    stateManager.setModelStep(targetModelId, 0);
    layoutManager.components.forEach(comp => {
        if (comp.type === 'TELEMETRY_3D' && comp.instance) {
            comp.instance.resetSimulationData(targetModelId);
        }
        if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
            comp.instance.resetSimulationData?.(targetModelId);
        }
        if (comp.type === 'NODE_VIEWER' && comp.instance) {
            comp.instance.resetSimulationData?.(targetModelId);
        }
    });
}

function executeModelCommand(modelId?: string, command: string = "INIT", extra: Record<string, any> = {}, fromGlobal: boolean = false, allowAutoRun: boolean = true) {
    let resolvedId = modelId;
    if (!resolvedId || resolvedId === 'default' || resolvedId === '0') {
        resolvedId = stateManager.getActiveModelId() || undefined;
    }
    if (!resolvedId) {
        const all = stateManager.getAllModels();
        if (all.length > 0) resolvedId = all[0].id;
    }
    if (!resolvedId) {
        console.error("[executeModelCommand] No active model found in stateManager!");
        return;
    }
    const targetModelId = resolvedId;
    const modelRefreshRate = stateManager.getModelRefreshRate(targetModelId);
    const sendWithRefreshRate = (msg: Record<string, any>) => {
        networkManager.send({ ...msg, refresh_rate: msg.refresh_rate ?? modelRefreshRate });
    };

    if (!networkManager.isConnected()) {
        const msg = "WebSocket is currently connecting or not connected to the Broker backend.";
        stateManager.pushTelemetry(targetModelId, "[WARN] " + msg);
        console.warn("[executeModelCommand]", msg);
    }

    const model = stateManager.getAllModels().find(m => m.id === targetModelId);
    
    if (model) {
        const solver1Ds = model.nodes.filter(n => n.type === 'CFDSolver');
        const solver2Ds = model.nodes.filter(n => n.type === 'CFDSolver2D');
        const solver3Ds = model.nodes.filter(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
        const totalSolvers = solver1Ds.length + solver2Ds.length + solver3Ds.length;
        const isFSICoupled = model.nodes.some(n => n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
        const isRemapCoupled = model.nodes.some(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode' || n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode');
        if (totalSolvers > 1 && !isFSICoupled && !isRemapCoupled) {
            const msg = "Multiple solvers detected on the same canvas! BlastDaemon architecture requires exactly ONE solver per model tab (unless coupled via an FSI Coupler or Remap node). Please cut and paste your second simulation into a 'New Model'.";
            stateManager.pushTelemetry(targetModelId, "[ERROR] " + msg);
            alert(msg);
            return;
        }
    }

    const forceScope = extra?.forceScope as ('1d' | '2d' | undefined);
    let has1D        = model?.nodes.some(n => n.type === 'CFDSolver') || false;
    let has2D        = model?.nodes.some(n => n.type === 'CFDSolver2D') || false;
    let hasMPM2D     = model?.nodes.some(n => n.type === 'MPMDomain2D' || n.type === 'MPMObject2D') || false;
    let has3D        = model?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') || false;
    let hasFEM3D     = model?.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D') || false;
    let hasFEMFSI3D  = model?.nodes.some(n => n.type === 'FEMFSICoupler3D') || (hasFEM3D && has3D);
    let hasMPM3D     = model?.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D')
                      || (model?.nodes.some(n => {
                          if (n.type !== 'MarineHarbourDomain') return false;
                          const waterMode = String(n.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve');
                          const isPureFV = waterMode === 'Pure_FV' || waterMode === 'Pure FV';
                          if (isPureFV) return false;
                          const bedType = String(n.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField');
                          const hasWaterMPM = (Number(n.parameters?.nearfield_sleeve_radius ?? 2.5) > 0);
                          const hasBedMPM = (bedType !== 'Pure_FV' && bedType !== 'Pure FV' && bedType !== 'Pure_Hex8_FEM' && bedType !== 'Pure Hex8 FEM');
                          return hasWaterMPM || hasBedMPM;
                      }))
                      || false;
    const hasCoupler   = model?.nodes.some(n => n.type === 'FSICoupler2D') || false;
    const hasCoupler3D = model?.nodes.some(n => n.type === 'FSICoupler3D') || false;
    let hasFSI2D     = hasCoupler || (has2D && hasMPM2D);
    let hasFSI3D     = hasCoupler3D || (has3D && hasMPM3D);
    let pipeline     = findRemapPipeline(targetModelId);

    if (forceScope === '1d') {
        has1D = true;
        has2D = false;
        hasMPM2D = false;
        hasFSI2D = false;
        has3D = false;
        hasMPM3D = false;
        hasFSI3D = false;
        hasFEM3D = false;
        hasFEMFSI3D = false;
        pipeline = null;
    } else if (forceScope === '2d') {
        has3D = false;
        hasMPM3D = false;
        hasFSI3D = false;
        hasFEM3D = false;
        hasFEMFSI3D = false;
        if (pipeline && pipeline.sourceType === '2D' && pipeline.sourceModelId === targetModelId) {
            pipeline = null;
        }
    }

    // Helper to get solver node for logging
    const getSolverNode = (mid: string) => {
        const m = stateManager.getAllModels().find(m => m.id === mid);
        return m?.nodes.find(n => n.type === 'FEMFSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FSICoupler3D' || n.type === 'FSICoupler2D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver' || n.type === 'MPMDomain3D' || n.type === 'MPMDomain2D');
    };

    // ── Incomplete Model Gate ────────────────────────────────────────────────
    if (command === "INIT" || command === "EXEC_ALL" || command === "STEP") {
        const completeness = stateManager.isModelComplete(targetModelId);
        if (!completeness.complete) {
            const errorMsg = `Cannot execute simulation: Model is incomplete.\n\n${completeness.reason}`;
            stateManager.pushTelemetry(targetModelId, `[ERROR] ${completeness.reason}`);
            console.error(`[executeModelCommand] ${completeness.reason}`);
            CustomDialog.alert(errorMsg, "Model Incomplete");
            return;
        }
    }

    // ── Pre-flight Upstream Remap Check ──────────────────────────────────────
    const skipUpstreamAutoRun = Boolean(extra?.skipUpstreamAutoRun);
    const forceFullPipeline = Boolean(extra?.forceFullPipeline);
    const forceRestart = Boolean(extra?.forceRestart) || ((command === "STEP" || command === "EXEC_ALL") && stateManager.isModelAtEndTime(targetModelId));
    if ((command === "INIT" || command === "STEP" || command === "EXEC_ALL") && pipeline) {
        if (forceFullPipeline && !extra?.upstreamCompleted && pipeline.sourceModelId) {
            const srcModelId = pipeline.sourceModelId;
            if (!autoRunInFlight.has(srcModelId)) {
                autoRunInFlight.add(srcModelId);
                remap3DFiles.delete(srcModelId);
                remap3DFiles.delete(targetModelId);
                pipelineAutoRunPending.set(targetModelId, {
                    command,
                    extra: { ...extra, forceFullPipeline: false, upstreamCompleted: true }
                });
                stateManager.setModelStatus(srcModelId, 'UNINITIALIZED');
                executeModelCommand(srcModelId, "EXEC_ALL", { forceScope: pipeline.sourceType === '3D' ? '3d' : (pipeline.sourceType === '2D' ? '2d' : '1d') }, false, true);
                return;
            }
        }
        const status = stateManager.getModelStatus(targetModelId);
        const needsInit = command === "INIT" || forceRestart || status === 'UNINITIALIZED' || status === 'TERMINATED' || status === 'ERROR';
        if (needsInit && !hasUpstreamRemapTelemetry(pipeline)) {
            if (skipUpstreamAutoRun || !allowAutoRun) {
                const srcModel = stateManager.getAllModels().find(m => m.id === pipeline.sourceModelId);
                const srcLabel = srcModel?.name || pipeline.sourceModelId || 'upstream stage';
                const msg = `No upstream results found from '${srcLabel}'. Run that upstream stage first, or use 'Run Pipeline'.`;
                stateManager.pushTelemetry(targetModelId, `[WARN] ${msg}`);
                CustomDialog.alert(msg, "Upstream Stage Required");
                return;
            }
            dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
            return;
        }
    }

    // ── Pre-VRAM-Reclamation 3D Snapshot Export & GPU VRAM Reclamation ───────
    const currentTargetStatus = stateManager.getModelStatus(targetModelId);
    const isFreshInit = command === "INIT" || ((command === "STEP" || command === "EXEC_ALL") && (
        forceRestart ||
        currentTargetStatus === 'UNINITIALIZED' ||
        currentTargetStatus === 'TERMINATED' ||
        currentTargetStatus === 'ERROR'
    ));
    if (isFreshInit && pipeline && pipeline.sourceType === '3D' && !remap3DFiles.has(pipeline.sourceModelId)) {
        if (hasUpstream3DExportableState(pipeline.sourceModelId)) {
            console.log(`[Pre-Init Export] Requesting EXPORT_REMAP_3D from live 3D upstream ${pipeline.sourceModelId} before VRAM reclamation for ${targetModelId}`);
            pipelineAutoRunPending.set(targetModelId, { command, extra });
            networkManager.send({
                command: "EXPORT_REMAP_3D",
                modelId: pipeline.sourceModelId,
                targetModelId: targetModelId,
                remap_file: `/tmp/blastdaemon_remap3d_${pipeline.sourceModelId}.bin`
            });
            return;
        }
    }
    if (isFreshInit && (has3D || hasMPM3D || hasFEM3D || hasFSI3D || hasFEMFSI3D)) {
        for (const other of stateManager.getAllModels()) {
            if (other.id === targetModelId) continue;
            // Pure 1D models execute strictly on CPU memory and may serve as active upstream Remap sources;
            // never destroy their state or recorded gauge history during 3D GPU VRAM reclamation.
            const otherIsPure1D = other.nodes.some(n => n.type === 'CFDSolver') &&
                !other.nodes.some(n =>
                    n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' ||
                    n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' ||
                    n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D'
                );
            if (otherIsPure1D) continue;
            const otherStatus = stateManager.getModelStatus(other.id);
            if (otherStatus === 'INITIALIZED' || otherStatus === 'PAUSED') {
                networkManager.send({ command: "STOP", modelId: other.id });
                stateManager.setModelStatus(other.id, 'TERMINATED');
                stateManager.pushTelemetry(other.id, `[INFO] GPU VRAM released for ${model?.name || targetModelId}; stage transitioned to TERMINATED (results preserved).`, other.id);
            }
        }
    }

    // ── INIT ─────────────────────────────────────────────────────────────────
    if (command === "INIT") {
        const checkState = stateManager.getSimulationState(targetModelId);
        if (checkState) {
            const memEst = estimateGraphMemory(checkState);
            if (memEst.riskLevel === 'CRITICAL') {
                const proceed = confirm(`⚠️ CRITICAL MEMORY WARNING:\n\nThis model allocation is estimated to require ${memEst.summaryText}.\nAllocating extreme model sizes may exceed hardware limits.\n\nDo you want to proceed with allocation?`);
                if (!proceed) {
                    console.log(`[MEMORY GUARD] Model initialization for ${targetModelId} aborted by user.`);
                    return;
                }
            }
        }

        autoRunInFlight.delete(targetModelId);
        pipelineAutoRunPending.delete(targetModelId);
        autoRecoveryRetryModels.delete(targetModelId);
        clearDownstreamAutoRun(targetModelId);
        resetModelRunState(targetModelId);

        if (hasFEMFSI3D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_FEM_FSI_3D", targetModelId, model?.filename);
                console.log(`Sending INIT_FEM_FSI_3D for 3D FEM FSI model ${targetModelId}`);
                networkManager.send(payload);
                sendView3DConfig(targetModelId);
                if (pipeline) {
                    const success = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                    stateManager.setModelStatus(targetModelId, success ? 'INITIALIZED' : 'UNINITIALIZED');
                } else {
                    stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                }
            }
        }
        else if (hasFEM3D && !has3D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_FEM_3D", targetModelId, model?.filename);
                console.log(`Sending INIT_FEM_3D for 3D FEM model ${targetModelId}`);
                networkManager.send(payload);
                sendView3DConfig(targetModelId);
                stateManager.setModelStatus(targetModelId, 'INITIALIZED');
            }
        }
        else if (hasFSI3D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_FSI_3D", targetModelId, model?.filename);
                console.log(`Sending INIT_FSI_3D for 3D FSI model ${targetModelId}`);
                networkManager.send(payload);
                sendView3DConfig(targetModelId);
                if (pipeline) {
                    const success = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                    stateManager.setModelStatus(targetModelId, success ? 'INITIALIZED' : 'UNINITIALIZED');
                } else {
                    stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                }
            }
        }
        else if (hasMPM3D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_MPM_3D", targetModelId, model?.filename);
                networkManager.send(payload);
                sendView3DConfig(targetModelId);
                stateManager.setModelStatus(targetModelId, 'INITIALIZED');
            }
        }
        else if (has3D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_3D", targetModelId, model?.filename);
                networkManager.send(payload);
                sendView3DConfig(targetModelId);
                if (pipeline) {
                    const success = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                    stateManager.setModelStatus(targetModelId, success ? 'INITIALIZED' : 'UNINITIALIZED');
                } else {
                    stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                }
            }
        }
        else if (hasFSI2D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_FSI_2D", targetModelId, model?.filename);
                console.log(`Sending INIT_FSI_2D for 2D FSI model ${targetModelId}`);
                networkManager.send(payload);
                sendContourConfig(targetModelId);
                if (pipeline) {
                    const success = tryRemapFrom1D(targetModelId, pipeline, allowAutoRun, command, extra);
                    stateManager.setModelStatus(targetModelId, success ? 'INITIALIZED' : 'UNINITIALIZED');
                } else {
                    stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                }
            }
        }
        else if (hasMPM2D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_MPM", targetModelId, model?.filename);
                console.log(`Sending INIT_MPM for MPM 2D model ${targetModelId}`);
                networkManager.send(payload);
                sendContourConfig(targetModelId);
                stateManager.setModelStatus(targetModelId, 'INITIALIZED');
            }
        }
        else if (has2D) {
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT_2D", targetModelId, model?.filename);
                console.log(`Sending INIT_2D for 2D model ${targetModelId}`);
                networkManager.send(payload);
                sendContourConfig(targetModelId);
                if (pipeline) {
                    if (tryRemapFrom1D(targetModelId, pipeline, allowAutoRun, command, extra)) {
                        stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                    } else {
                        stateManager.setModelStatus(targetModelId, 'UNINITIALIZED');
                    }
                } else {
                    stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                }
            }
        } else if (has1D) {
            // Pure 1D model.
            const state = stateManager.getSimulationState(targetModelId);
            if (state) {
                const payload = serializeForSolver(state, "INIT", targetModelId, model?.filename);
                console.log(`Sending INIT (1D) for model ${targetModelId}`);
                networkManager.send(payload);
                stateManager.setModelStatus(targetModelId, 'INITIALIZED');
            }
        } else {
            const msg = "Cannot initialize simulation: No active physics solver domain node (such as FEMDomain3D, FEMFSICoupler3D, CFDSolver3D, MarineHarbourDomain, MPMDomain3D, or CFDSolver) was found in this model graph.";
            stateManager.pushTelemetry(targetModelId, `[ERROR] ${msg}`);
            CustomDialog.alert(msg, "Missing Solver Domain");
            stateManager.setModelStatus(targetModelId, 'INCOMPLETE');
            return;
        }

    // ── STEP ──────────────────────────────────────────────────────────────────
    } else if (command === "STEP") {
        const steps = extra.steps || 1;
        const status = stateManager.getModelStatus(targetModelId);
        if (status === 'RUNNING' && !forceRestart) {
            return;
        }
        const cfl = getCflFromSolver(targetModelId);
        const endtime = getEndTimeFromSolver(targetModelId);

        if (forceRestart || status === 'UNINITIALIZED' || status === 'TERMINATED' || status === 'ERROR') {
            resetModelRunState(targetModelId);
            if (hasFEMFSI3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FEM_FSI_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_FEM_FSI_3D for 3D FEM FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "STEP_FEM_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "STEP_FEM_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (hasFEM3D && !has3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FEM_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_FEM_3D for 3D FEM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    const femNode = state.nodes.find(n => n.type === 'FEMDomain3D');
                    const femCfl = Number(femNode?.parameters?.cfl ?? 0.3);
                    const refreshRate = stateManager.getModelRefreshRate(targetModelId);
                    sendWithRefreshRate({ command: "STEP_FEM_3D", modelId: targetModelId, steps, cfl: femCfl, endtime, refresh_rate: refreshRate });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasFSI3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FSI_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_FSI_3D for 3D FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "STEP_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "STEP_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (hasMPM3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_MPM_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_MPM_3D for 3D MPM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    const mpmNode = state.nodes.find(n => n.type === 'MPMDomain3D');
                    const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                    sendWithRefreshRate({ command: "STEP_MPM_3D", modelId: targetModelId, steps, cfl: mpmCfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasFSI2D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FSI_2D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_FSI_2D for 2D FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = tryRemapFrom1D(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "STEP_FSI_2D", modelId: targetModelId, steps, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "STEP_FSI_2D", modelId: targetModelId, steps, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (pipeline) {
                const is3D = has3D;
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const cmd = is3D ? "INIT_3D" : "INIT_2D";
                    const payload = serializeForSolver(state, cmd, targetModelId, model?.filename);
                    console.log(`[Auto-Init Step Pipeline] Sending ${cmd} for ${is3D ? '3D' : '2D'} model ${targetModelId} in pipeline`);
                    networkManager.send(payload);
                    if (is3D) sendView3DConfig(targetModelId); else sendContourConfig(targetModelId);

                    const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                    if (remapOk) {
                        const stepCmd = is3D ? "STEP_3D" : "STEP_2D";
                        sendWithRefreshRate({ command: stepCmd, modelId: targetModelId, steps, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    } else if (allowAutoRun && !skipUpstreamAutoRun) {
                        pipelineAutoRunPending.set(targetModelId, { command, extra });
                    } else {
                        stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                    }
                }
            } else if (has3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_3D", targetModelId, model?.filename);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    sendWithRefreshRate({ command: "STEP_3D", modelId: targetModelId, steps, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasMPM2D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_MPM", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_MPM for MPM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    const mpmNode = state.nodes.find(n => n.type === 'MPMDomain2D');
                    const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                    sendWithRefreshRate({ command: "STEP_MPM", modelId: targetModelId, steps, cfl: mpmCfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (has2D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_2D", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT_2D for standalone 2D model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    sendWithRefreshRate({ command: "STEP_2D", modelId: targetModelId, steps, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (has1D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT", targetModelId, model?.filename);
                    console.log(`[Auto-Init Step] Sending INIT for standalone 1D model ${targetModelId}`);
                    networkManager.send(payload);
                    sendWithRefreshRate({ command: "STEP", modelId: targetModelId, steps, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else {
                const msg = "Cannot execute step: No active physics solver domain node (such as FEMDomain3D, FEMFSICoupler3D, CFDSolver3D, MarineHarbourDomain, MPMDomain3D, or CFDSolver) was found in this model graph.";
                stateManager.pushTelemetry(targetModelId, `[ERROR] ${msg}`);
                CustomDialog.alert(msg, "Missing Solver Domain");
                stateManager.setModelStatus(targetModelId, 'INCOMPLETE');
                return;
            }
        } else {
            // Already initialized / paused
            if (hasFEMFSI3D) {
                sendView3DConfig(targetModelId);
                sendWithRefreshRate({ command: "STEP_FEM_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
            } else if (hasFEM3D && !has3D) {
                sendView3DConfig(targetModelId);
                const femNode = model?.nodes.find(n => n.type === 'FEMDomain3D');
                const femCfl = Number(femNode?.parameters?.cfl ?? 0.3);
                const refreshRate = stateManager.getModelRefreshRate(targetModelId);
                sendWithRefreshRate({ command: "STEP_FEM_3D", modelId: targetModelId, steps, cfl: femCfl, endtime, refresh_rate: refreshRate });
            } else if (hasFSI3D) {
                sendView3DConfig(targetModelId);
                sendWithRefreshRate({ command: "STEP_FSI_3D", modelId: targetModelId, steps, cfl, endtime });
            } else if (hasMPM3D) {
                sendView3DConfig(targetModelId);
                const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain3D');
                const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                sendWithRefreshRate({ command: "STEP_MPM_3D", modelId: targetModelId, steps, cfl: mpmCfl, endtime });
            } else if (has3D) {
                sendView3DConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "STEP_3D", modelId: targetModelId, steps, cfl, endtime, ...vtkParams });
            } else if (hasFSI2D) {
                sendContourConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "STEP_FSI_2D", modelId: targetModelId, steps, cfl, endtime, ...vtkParams });
            } else if (hasMPM2D) {
                sendContourConfig(targetModelId);
                const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain2D');
                const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                sendWithRefreshRate({ command: "STEP_MPM", modelId: targetModelId, steps, cfl: mpmCfl, endtime });
            } else if (pipeline || has2D) {
                sendContourConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "STEP_2D", modelId: targetModelId, steps, cfl, endtime, ...vtkParams });
            } else {
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "STEP",    modelId: targetModelId, steps, cfl, endtime, ...vtkParams });
            }
            markModelRunningStarted(targetModelId);
        }

    // ── EXEC_ALL ──────────────────────────────────────────────────────────────
    } else if (command === "EXEC_ALL") {
        const status = stateManager.getModelStatus(targetModelId);
        if (status === 'RUNNING' && !forceRestart) {
            return;
        }
        const cfl = getCflFromSolver(targetModelId);
        const endtime = getEndTimeFromSolver(targetModelId);

        if (forceRestart || status === 'UNINITIALIZED' || status === 'TERMINATED' || status === 'ERROR') {
            resetModelRunState(targetModelId);
            if (hasFEMFSI3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FEM_FSI_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_FEM_FSI_3D for 3D FEM FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "EXEC_ALL_FEM_FSI_3D", modelId: targetModelId, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "EXEC_ALL_FEM_FSI_3D", modelId: targetModelId, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (hasFEM3D && !has3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FEM_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_FEM_3D for 3D FEM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    const femNode = state.nodes.find(n => n.type === 'FEMDomain3D');
                    const femCfl = Number(femNode?.parameters?.cfl ?? 0.3);
                    const refreshRate = stateManager.getModelRefreshRate(targetModelId);
                    sendWithRefreshRate({ command: "EXEC_ALL_FEM_3D", modelId: targetModelId, cfl: femCfl, endtime, refresh_rate: refreshRate });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasFSI3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FSI_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_FSI_3D for 3D FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "EXEC_ALL_FSI_3D", modelId: targetModelId, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "EXEC_ALL_FSI_3D", modelId: targetModelId, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (hasMPM3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_MPM_3D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_MPM_3D for 3D MPM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    const mpmNode = state.nodes.find(n => n.type === 'MPMDomain3D');
                    const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                    sendWithRefreshRate({ command: "EXEC_ALL_MPM_3D", modelId: targetModelId, cfl: mpmCfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasFSI2D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_FSI_2D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_FSI_2D for 2D FSI model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    if (pipeline) {
                        const remapOk = tryRemapFrom1D(targetModelId, pipeline, allowAutoRun, command, extra);
                        if (remapOk) {
                            sendWithRefreshRate({ command: "EXEC_ALL_FSI_2D", modelId: targetModelId, cfl, endtime });
                            markModelRunningStarted(targetModelId);
                        } else if (allowAutoRun && !skipUpstreamAutoRun) {
                            pipelineAutoRunPending.set(targetModelId, { command, extra });
                        } else {
                            stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                        }
                    } else {
                        sendWithRefreshRate({ command: "EXEC_ALL_FSI_2D", modelId: targetModelId, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    }
                }
            } else if (pipeline) {
                const is3D = has3D;
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const cmd = is3D ? "INIT_3D" : "INIT_2D";
                    const payload = serializeForSolver(state, cmd, targetModelId, model?.filename);
                    console.log(`[Auto-Run Pipeline] Sending ${cmd} for ${is3D ? '3D' : '2D'} model ${targetModelId} in pipeline`);
                    networkManager.send(payload);
                    if (is3D) sendView3DConfig(targetModelId); else sendContourConfig(targetModelId);

                    const remapOk = dispatchRemapForPipeline(targetModelId, pipeline, allowAutoRun, command, extra);
                    if (remapOk) {
                        const execCmd = is3D ? "EXEC_ALL_3D" : "EXEC_ALL_2D";
                        sendWithRefreshRate({ command: execCmd, modelId: targetModelId, cfl, endtime });
                        markModelRunningStarted(targetModelId);
                    } else if (allowAutoRun && !skipUpstreamAutoRun) {
                        pipelineAutoRunPending.set(targetModelId, { command, extra });
                    } else {
                        stateManager.setModelStatus(targetModelId, 'INITIALIZED');
                    }
                }
            } else if (has3D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_3D", targetModelId, model?.filename);
                    networkManager.send(payload);
                    sendView3DConfig(targetModelId);
                    sendWithRefreshRate({ command: "EXEC_ALL_3D", modelId: targetModelId, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (hasMPM2D) {
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_MPM", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_MPM for MPM model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    const mpmNode = state.nodes.find(n => n.type === 'MPMDomain2D');
                    const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                    sendWithRefreshRate({ command: "EXEC_ALL_MPM", modelId: targetModelId, cfl: mpmCfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (has2D) {
                // Standalone 2D model
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT_2D", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT_2D for standalone 2D model ${targetModelId}`);
                    networkManager.send(payload);
                    sendContourConfig(targetModelId);
                    sendWithRefreshRate({ command: "EXEC_ALL_2D", modelId: targetModelId, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else if (has1D) {
                // Pure 1D model
                const state = stateManager.getSimulationState(targetModelId);
                if (state) {
                    const payload = serializeForSolver(state, "INIT", targetModelId, model?.filename);
                    console.log(`[Auto-Run] Sending INIT for standalone 1D model ${targetModelId}`);
                    networkManager.send(payload);
                    sendWithRefreshRate({ command: "EXEC_ALL", modelId: targetModelId, cfl, endtime });
                    markModelRunningStarted(targetModelId);
                }
            } else {
                const msg = "Cannot execute simulation: No active physics solver domain node (such as FEMDomain3D, FEMFSICoupler3D, CFDSolver3D, MarineHarbourDomain, MPMDomain3D, or CFDSolver) was found in this model graph.";
                stateManager.pushTelemetry(targetModelId, `[ERROR] ${msg}`);
                CustomDialog.alert(msg, "Missing Solver Domain");
                stateManager.setModelStatus(targetModelId, 'INCOMPLETE');
                return;
            }
        } else {
            // Already initialized / paused
            if (hasFEMFSI3D) {
                sendView3DConfig(targetModelId);
                sendWithRefreshRate({ command: "EXEC_ALL_FEM_FSI_3D", modelId: targetModelId, cfl, endtime });
            } else if (hasFEM3D && !has3D) {
                sendView3DConfig(targetModelId);
                const femNode = model?.nodes.find(n => n.type === 'FEMDomain3D');
                const femCfl = Number(femNode?.parameters?.cfl ?? 0.3);
                const refreshRate = stateManager.getModelRefreshRate(targetModelId);
                sendWithRefreshRate({ command: "EXEC_ALL_FEM_3D", modelId: targetModelId, cfl: femCfl, endtime, refresh_rate: refreshRate });
            } else if (hasFSI3D) {
                sendView3DConfig(targetModelId);
                sendWithRefreshRate({ command: "EXEC_ALL_FSI_3D", modelId: targetModelId, cfl, endtime });
            } else if (hasMPM3D) {
                sendView3DConfig(targetModelId);
                const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain3D');
                const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                sendWithRefreshRate({ command: "EXEC_ALL_MPM_3D", modelId: targetModelId, cfl: mpmCfl, endtime });
            } else if (has3D) {
                sendView3DConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "EXEC_ALL_3D", modelId: targetModelId, cfl, endtime, ...vtkParams });
            } else if (hasFSI2D) {
                sendContourConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "EXEC_ALL_FSI_2D", modelId: targetModelId, cfl, endtime, ...vtkParams });
            } else if (hasMPM2D) {
                sendContourConfig(targetModelId);
                const mpmNode = model?.nodes.find(n => n.type === 'MPMDomain2D');
                const mpmCfl = Number(mpmNode?.parameters?.cfl ?? 0.3);
                sendWithRefreshRate({ command: "EXEC_ALL_MPM", modelId: targetModelId, cfl: mpmCfl, endtime });
            } else if (pipeline || has2D) {
                sendContourConfig(targetModelId);
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "EXEC_ALL_2D", modelId: targetModelId, cfl, endtime, ...vtkParams });
            } else {
                const vtkNode = model?.nodes.find(n => n.type === 'VTKOutput');
                const vtkParams: Record<string, any> = vtkNode?.parameters ? { ...vtkNode.parameters } : {};
                if (typeof vtkParams.vtk_dir === 'string' && vtkParams.vtk_dir.trim() !== '') {
                    vtkParams.vtk_dir = resolveResourcePath(vtkParams.vtk_dir, model?.filename);
                }
                sendWithRefreshRate({ command: "EXEC_ALL",    modelId: targetModelId, cfl, endtime, ...vtkParams });
            }
            markModelRunningStarted(targetModelId);
        }
    }

    // ── PAUSE ─────────────────────────────────────────────────────────────────
    else if (command === "PAUSE") {
        const curStatus = stateManager.getModelStatus(targetModelId);
        if (curStatus !== 'RUNNING' && pipeline && pipeline.sourceModelId !== targetModelId && (autoRunInFlight.has(pipeline.sourceModelId) || pipelineAutoRunPending.has(targetModelId) || Boolean((window as any).isUpstreamAutoRunningFor?.(targetModelId)))) {
            const activeUpId = findActiveUpstreamAutoRunModelId(targetModelId) || pipeline.sourceModelId;
            autoRunInFlight.delete(activeUpId);
            clearDownstreamAutoRun(activeUpId);
            executeModelCommand(activeUpId, "PAUSE", {}, false, false);
            transportController.updateModelStatusDisplay?.();
            return;
        }
        if (hasFEMFSI3D) {
            networkManager.send({ command: "PAUSE_FEM_FSI_3D", modelId: targetModelId });
        } else if (hasFEM3D) {
            networkManager.send({ command: "PAUSE_FEM_3D", modelId: targetModelId });
        } else if (hasFSI3D) {
            networkManager.send({ command: "PAUSE_FSI_3D", modelId: targetModelId });
        } else if (hasMPM3D) {
            networkManager.send({ command: "PAUSE_MPM_3D", modelId: targetModelId });
        } else if (has3D) {
            networkManager.send({ command: "PAUSE_3D", modelId: targetModelId });
        } else if (hasFSI2D) {
            networkManager.send({ command: "PAUSE_FSI_2D", modelId: targetModelId });
        } else if (hasMPM2D) {
            networkManager.send({ command: "PAUSE_MPM", modelId: targetModelId });
        } else if (pipeline || has2D) {
            networkManager.send({ command: "PAUSE_2D", modelId: targetModelId });
        } else {
            networkManager.send({ command: "PAUSE",    modelId: targetModelId });
        }
        autoRunInFlight.delete(targetModelId);
        clearDownstreamAutoRun(targetModelId);
        pausedByUserModels.add(targetModelId);
        stateManager.setModelStatus(targetModelId, 'PAUSED');
        transportController.updateModelStatusDisplay?.();

    // ── TERMINATE ─────────────────────────────────────────────────────────────
    } else if (command === "TERMINATE") {
        const curStatus = stateManager.getModelStatus(targetModelId);
        if ((curStatus === 'UNINITIALIZED' || curStatus === 'TERMINATED' || curStatus === 'ERROR') && pipeline && pipeline.sourceModelId !== targetModelId) {
            const activeUpId = findActiveUpstreamAutoRunModelId(targetModelId);
            if (activeUpId) {
                autoRunInFlight.delete(activeUpId);
                clearDownstreamAutoRun(activeUpId);
                executeModelCommand(activeUpId, "TERMINATE", {}, false, false);
                transportController.updateModelStatusDisplay?.();
                return;
            }
        }
        if (hasFEMFSI3D) {
            networkManager.send({ command: "TERMINATE_FEM_FSI_3D", modelId: targetModelId });
        } else if (hasFEM3D) {
            networkManager.send({ command: "TERMINATE_FEM_3D", modelId: targetModelId });
        } else if (hasFSI3D) {
            networkManager.send({ command: "TERMINATE_FSI_3D", modelId: targetModelId });
        } else if (hasMPM3D) {
            networkManager.send({ command: "TERMINATE_MPM_3D", modelId: targetModelId });
        } else if (has3D) {
            networkManager.send({ command: "TERMINATE_3D", modelId: targetModelId });
        } else if (hasFSI2D) {
            networkManager.send({ command: "TERMINATE_FSI_2D", modelId: targetModelId });
        } else if (hasMPM2D) {
            networkManager.send({ command: "TERMINATE_MPM", modelId: targetModelId });
        } else if (pipeline || has2D) {
            networkManager.send({ command: "TERMINATE_2D", modelId: targetModelId });
        } else {
            networkManager.send({ command: "TERMINATE",    modelId: targetModelId });
        }
        networkManager.send({ command: "STOP", modelId: targetModelId });
        autoRunInFlight.delete(targetModelId);
        pipelineAutoRunPending.delete(targetModelId);
        pausedByUserModels.delete(targetModelId);
        awaitingInitResetByModel.delete(targetModelId);
        autoRecoveryRetryModels.delete(targetModelId);
        lastRunCmdTimeByModel.delete(targetModelId);
        lastResetTimeByModel.delete(targetModelId);
        clearDownstreamAutoRun(targetModelId);
        stateManager.setModelStatus(targetModelId, 'TERMINATED');
        transportController.updateModelStatusDisplay?.();
    // ── REFRESH ───────────────────────────────────────────────────────────────
    } else if (command === "REFRESH" || command === "REFRESH_STATE") {
        requestAndPlotCurrentState(targetModelId);
    }
}

(window as any).executeModelCommand = executeModelCommand;
(window as any).executeWorkspacePipeline = executeWorkspacePipeline;

document.addEventListener('model-action', async (e: any) => {
    const { modelId, command, steps, forceScope, skipUpstreamAutoRun, forceFullPipeline, forceRestart, allowAutoRun, extra } = e.detail || {};
    if (!networkManager.isConnected()) {
        await CustomDialog.alert("Error: WebSocket is not connected to the Broker backend. Please ensure the Broker daemon is running.");
        return;
    }
    const mergedExtra = {
        ...(extra || {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(forceScope !== undefined ? { forceScope } : {}),
        ...(skipUpstreamAutoRun !== undefined ? { skipUpstreamAutoRun } : {}),
        ...(forceFullPipeline !== undefined ? { forceFullPipeline } : {}),
        ...(forceRestart !== undefined ? { forceRestart } : {})
    };
    executeModelCommand(modelId, command, mergedExtra, false, allowAutoRun !== false);
});



const lastTelemetryTypeByModel = new Map<string, string>();

function is2DFrame(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 8) return false;
    const view = new DataView(buffer);
    const word0 = view.getUint32(0, true);
    const word1 = view.getUint32(4, true);
    if (word0 === 0x414d5232 || word0 === 0x4d504d32) return true;
    // Check 2D AMR leaf-tile frame layout: 8 + num_leaves * (2 + 256 * n_channels) * 4
    if (word0 > 0 && word0 <= 65536 && (word1 === 6 || word1 === 7)) {
        const expectedAmrBytes = 8 + word0 * (2 + 256 * word1) * 4;
        if (expectedAmrBytes === buffer.byteLength) return true;
    }
    if (buffer.byteLength < 12) return false;
    const nr = word0;
    const nz = word1;
    const n_channels = view.getUint32(8, true);
    if (nr === 0 || nz === 0 || nr > 65536 || nz > 65536 || n_channels < 3 || n_channels > 16) return false;
    const expected = nr * nz * n_channels * 4 + 12;
    if (expected === buffer.byteLength) return true;
    if (buffer.byteLength >= expected + 4) {
        const nParticles = view.getUint32(expected, true);
        if (expected + 4 + nParticles * 8 === buffer.byteLength) return true;
    }
    return false;
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

                if (meshId) {
                    stateManager.registerSTLVertices(meshId, vertices);
                }

                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                        comp.instance.setSTLGeometry?.(vertices, modelId, meshId);
                    }
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
                        comp.instance.render(state);
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
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                        comp.instance.setObstaclesGeometry?.(vertices, cells, modelId, meshId);
                    }
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

        const targetModelId = modelId || stateManager.getActiveModelId() || "";
        const model = stateManager.getAllModels().find(m => m.id === (modelId || targetModelId));
        const solverNodes = model?.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D') || [];
        if (solverNodes.length > 0) {
            const frameMagic = payloadBuffer.byteLength >= 4 ? new DataView(payloadBuffer).getUint32(0, true) : 0;
            const isHeavy3DStream = frameMagic === 0x4d504d33 || frameMagic === 0x50545033 || frameMagic === 0x43494c53 || frameMagic === 0x46454d33;
            if (!isHeavy3DStream) {
                const lastTelType = lastTelemetryTypeByModel.get(targetModelId);
                const frameIs2D = is2DFrame(payloadBuffer) || lastTelType === 'TELEMETRY_2D' || lastTelType === 'TELEMETRY_MPM_2D';
                let targetSolverNode = solverNodes[0];
                if (frameMagic === 0x4d504d32 || lastTelType === 'TELEMETRY_MPM_2D') {
                    targetSolverNode = solverNodes.find(n => n.type === 'MPMDomain2D' || n.type === 'CFDSolver2D' || n.type === 'FSICoupler2D') || solverNodes[0];
                } else if (frameIs2D) {
                    targetSolverNode = solverNodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D') || solverNodes[0];
                } else {
                    targetSolverNode = solverNodes.find(n => n.type === 'CFDSolver') || solverNodes[0];
                }
                stateManager.pushTelemetry(targetSolverNode.id, payloadBuffer, targetModelId);
                stateManager.setBinaryTelemetry(targetSolverNode.id, payloadBuffer, targetModelId);
                if (targetModelId && targetModelId !== targetSolverNode.id) {
                    stateManager.setBinaryTelemetry(targetModelId, payloadBuffer, targetModelId);
                }
            }
            const curStep = (targetModelId ? stateManager.getModelStep(targetModelId) : 0) || 0;
            const curTime = (targetModelId ? stateManager.getModelSimTime(targetModelId) : 0) || 0;
            const curDt = (targetModelId ? stateManager.getModelDt(targetModelId) : 0) || 0;
            const bufferedFrame = playbackBuffer.addFrame(payloadBuffer, { modelId: targetModelId, step: curStep, time: curTime, metrics: { dt: curDt } });
            const hasViewport = Array.from(layoutManager.components.values()).some((c: any) => c.type === 'VIEWPORT' || c.type === 'MULTI_VIEW_STAGE');
            const telemetry3DCount = Array.from(layoutManager.components.values()).filter((c: any) => c.type === 'TELEMETRY_3D' && c.instance).length;
            layoutManager.components.forEach(comp => {
                if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                    comp.instance.dispatchFrame(bufferedFrame, true);
                } else if (comp.type === 'TELEMETRY_3D' && comp.instance && !hasViewport) {
                    comp.instance.pushFrame(payloadBuffer, targetModelId, isHeavy3DStream && telemetry3DCount === 1);
                }
            });
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
                const filePath = dataJson.filePath || '';
                if (filePath) {
                    stateManager.registerSTLVertices(filePath, verts);
                }
                const state = stateManager.getSimulationState(modelId);
                const vpNodes = state?.nodes.filter(n => n.type === 'Telemetry3DViewport') || [];
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                        comp.instance.setSTLGeometry?.(verts, modelId, filePath);
                    }
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.setSTLGeometry(verts, modelId, filePath);
                    }
                });
                
                const activeModelId = stateManager.getActiveWorkspace()?.activeModelId;
                if (modelId === activeModelId && vpNodes.length > 0) {
                    layoutManager.components.forEach(comp => {
                        if (comp.type === 'NODE_GRAPH' && comp.instance) {
                            vpNodes.forEach(vpNode => {
                                comp.instance.setSTLGeometry(vpNode.id, verts, filePath);
                            });
                            comp.instance.render(state);
                        }
                    });
                }
                
                layoutManager.components.forEach(comp => {
                    if (comp.type === 'NODE_VIEWER' && comp.instance) {
                        comp.instance.setSTLGeometry(verts, modelId, filePath);
                    }
                    if (comp.type === 'PROPERTY_GRID' && comp.instance) {
                        comp.instance.updateLiveStats?.();
                        comp.instance.render?.(true);
                    }
                });
            } else {
                console.error("Broker failed to load STL geometry: " + dataJson.error);
            }
            return;
        }

        if (dataJson.type === 'obstacles_mesh') {
            if (dataJson.vertices && dataJson.cells) {
                const verts = new Float32Array(dataJson.vertices);
                const cells = new Int32Array(dataJson.cells);
                const modelId = dataJson.modelId;
                const meshId = dataJson.meshId || 'default';
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance) {
                        comp.instance.setObstaclesGeometry?.(verts, cells, modelId, meshId);
                    }
                    if (comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.setObstaclesGeometry(verts, cells, modelId, meshId);
                    }
                    if (comp.type === 'NODE_VIEWER' && comp.instance) {
                        comp.instance.setObstaclesGeometry(verts, cells, modelId, meshId);
                    }
                    if (comp.type === 'NODE_GRAPH' && comp.instance) {
                        const state = stateManager.getSimulationState(modelId);
                        const vpNodes = state?.nodes.filter(n => n.type === 'Telemetry3DViewport') || [];
                        vpNodes.forEach(vpNode => {
                            comp.instance.setObstaclesGeometry(vpNode.id, verts, cells, meshId);
                        });
                    }
                });
            }
            return;
        }

        if (dataJson.type === 'save_model_response') {
            if (typeof dataJson.modelId === 'string' && dataJson.modelId.startsWith('__raw_write__:')) {
                return;
            }
            if (dataJson.status === 'success') {
                let modelId = dataJson.modelId || '';
                const filePath = dataJson.filePath || '';
                const isWorkspaceSave = modelId === 'workspace';
                const isSilentSave = modelId.startsWith('ws-silent-');

                if (isSilentSave) {
                    modelId = modelId.substring(10);
                }

                if (filePath && filePath.includes('/')) {
                    recordRecentFolder(filePath, false);
                }

                const hasResourceErrors = Array.isArray(dataJson.resourceErrors) && dataJson.resourceErrors.length > 0;
                if (modelId && modelId !== 'all' && modelId !== 'workspace') {
                    stateManager.commitSavedModelMetadata(modelId, filePath, !hasResourceErrors);
                }

                const resourceSuffix = (dataJson.resourcesCopied && dataJson.resourcesCopied > 0)
                    ? ` (with ${dataJson.resourcesCopied} external resource${dataJson.resourcesCopied > 1 ? 's' : ''} bundled)`
                    : '';
                const warningMsg = hasResourceErrors
                    ? `\n\nResource Warnings:\n${dataJson.resourceErrors.join('\n')}`
                    : '';

                if (isWorkspaceSave) {
                    await CustomDialog.alert(`Workspace saved successfully to:\n${filePath}${resourceSuffix}${warningMsg}`);
                } else if (!isSilentSave) {
                    await CustomDialog.alert(`Model saved successfully to:\n${filePath}${resourceSuffix}${warningMsg}`);
                }
            } else {
                await CustomDialog.alert(`Error saving file:\n${dataJson.error}`);
            }
            return;
        }

        if (dataJson.type === 'load_model_response') {
            if (typeof dataJson.modelId === 'string' && dataJson.modelId.startsWith('__raw_read__:')) {
                return;
            }
            const reqId = String(dataJson.modelId || '');
            const loadMode = pendingHostLoadMode.get(reqId) || 'replace_active';
            pendingHostLoadMode.delete(reqId);

            if (dataJson.status === 'success') {
                const filePath = dataJson.filePath || '';
                try {
                    let loaded: any;
                    const rawContent = String(dataJson.fileContent ?? '');
                    if (dataJson.encoding === 'base64' || rawContent.startsWith('QkxTVA')) {
                        const bytes = base64ToUint8Array(rawContent.trim());
                        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                        loaded = deserializeFromBinary(buf);
                    } else {
                        loaded = JSON.parse(rawContent);
                    }
                    await applyLoadedPayload(loaded, filePath, loadMode, true);
                } catch (err) {
                    await CustomDialog.alert("Failed to parse loaded file: " + err);
                }
            } else {
                await CustomDialog.alert(`Error loading file:\n${dataJson.error}`);
            }
            return;
        }
        let modelId = dataJson.modelId;
        if (!modelId) {
            const activeWs = stateManager.getActiveWorkspace();
            modelId = activeWs?.activeModelId || stateManager.getAllModels()[0]?.id;
        }

        if (dataJson.type === 'resource_pulse') {
            layoutManager.broadcastResourceData(dataJson);
            return;
        }

        if (dataJson.type === 'REMAP_3D_READY') {
            const srcMid = dataJson.modelId || modelId;
            if (srcMid && dataJson.remap_file) {
                remap3DFiles.set(srcMid, dataJson.remap_file);
                console.log(`[REMAP_3D_READY] Cached 3D remap snapshot for ${srcMid}: ${dataJson.remap_file}`);
            }
            const targetMid = dataJson.targetModelId;
            const dispatchDownstream = (mId: string) => {
                const pending = pipelineAutoRunPending.get(mId);
                if (!pending) return;
                pipelineAutoRunPending.delete(mId);
                const initExtra = { ...(pending.extra || {}) };
                delete initExtra.forceRestart;
                executeModelCommand(mId, "INIT", initExtra, false, false);
                if (pending.command && pending.command !== "INIT" && stateManager.getModelStatus(mId) === 'INITIALIZED') {
                    const hasOwnDownstreamPending = stateManager.getAllModels().some(otherM => {
                        const p = findRemapPipeline(otherM.id);
                        return p && (p.sourceModelId === mId || p.model1dId === mId) && pipelineAutoRunPending.has(otherM.id);
                    });
                    if (hasOwnDownstreamPending) {
                        autoRunInFlight.add(mId);
                    }
                    executeModelCommand(mId, pending.command, { ...initExtra, forceRestart: false }, false, false);
                }
            };
            if (targetMid) {
                dispatchDownstream(targetMid);
            } else {
                for (const [mId] of Array.from(pipelineAutoRunPending.entries())) {
                    const pipe = findRemapPipeline(mId);
                    if (pipe && pipe.sourceType === '3D' && pipe.sourceModelId === srcMid) {
                        dispatchDownstream(mId);
                    }
                }
            }
            return;
        }

        // Determine correct target solver type
        let targetType: 'CFDSolver2D' | 'CFDSolver' | 'CFDSolver3D' | 'MPMDomain2D' | 'MPMDomain3D' | 'FEMDomain3D' | 'FEMFSICoupler3D' = 'CFDSolver';
        if (dataJson.scope === 'fem_3d' || dataJson.scope === 'fem') {
            targetType = 'FEMDomain3D';
        } else if (dataJson.scope === 'mpm_3d') {
            targetType = 'MPMDomain3D';
        } else if (dataJson.type === 'progress_3d' || dataJson.type === 'TELEMETRY_3D' || dataJson.scope === '3d') {
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
            if (scope === 'fem_3d' || scope === 'fem' || msg.includes("FEM") || msg.includes("fem")) targetType = 'FEMDomain3D';
            else if (scope === 'mpm_3d') targetType = 'MPMDomain3D';
            else if (scope === 'mpm_2d' || msg.includes("MPM") || msg.includes("mpm")) targetType = 'MPMDomain2D';
            else if (scope === '3d' || msg.includes("3D") || msg.includes("3d")) targetType = 'CFDSolver3D';
            else if (scope === '2d' || msg.includes("2D") || msg.includes("REMAP") || msg.includes("vtk") || msg.includes("2d")) targetType = 'CFDSolver2D';
            else targetType = 'CFDSolver';
        }

        let model = stateManager.getAllModels().find(m => m.id === modelId);

        if (dataJson.type === 'status') {
            if (modelId) {
                const incomingStatus = dataJson.status;
                if (incomingStatus === 'ERROR' && (dataJson.message || dataJson.reason || dataJson.error)) {
                    stateManager.recordModelError(modelId, {
                        message: dataJson.message || dataJson.reason || dataJson.error,
                        errorCode: dataJson.error_code,
                        summary: dataJson.summary,
                        details: dataJson.details,
                        step: dataJson.step,
                        simTime: dataJson.time ?? dataJson.sim_time,
                        dt: dataJson.dt,
                        scope: dataJson.scope,
                        level: 'ERROR',
                        device: dataJson.device,
                        precision: dataJson.precision,
                        kernelPhase: dataJson.kernel_phase,
                        exitCode: dataJson.exit_code,
                        signal: dataJson.signal
                    });
                }
                if (incomingStatus === 'PAUSED') {
                    const lastRunMs = lastRunCmdTimeByModel.get(modelId) || 0;
                    const lastResetMs = lastResetTimeByModel.get(modelId) || 0;
                    if (!pausedByUserModels.has(modelId) && ((Date.now() - lastRunMs < 600) || (Date.now() - lastResetMs < 600))) {
                        return;
                    }
                    stateManager.setModelStatus(modelId, 'PAUSED');
                    return;
                }
                if (incomingStatus === 'TERMINATED' && awaitingInitResetByModel.has(modelId) && (Date.now() - (lastResetTimeByModel.get(modelId) || 0) < 800)) {
                    return;
                }
                stateManager.setModelStatus(modelId, incomingStatus);
                if (incomingStatus === 'TERMINATED' || incomingStatus === 'ERROR') {
                    autoRunInFlight.delete(modelId);
                    pipelineAutoRunPending.delete(modelId);
                    pausedByUserModels.delete(modelId);
                    awaitingInitResetByModel.delete(modelId);
                    if (incomingStatus === 'ERROR') {
                        autoRecoveryRetryModels.delete(modelId);
                    }
                }
            }
            return;
        }

        if (dataJson.type === 'command_rejected') {
            if (modelId) {
                const rejectedCmd = String(dataJson.command || '');
                const reason = String(dataJson.reason || '');
                const isExecCmd = rejectedCmd.startsWith('EXEC_ALL') || rejectedCmd.startsWith('STEP') || rejectedCmd === 'EXEC_END';
                autoRunInFlight.delete(modelId);
                pausedByUserModels.delete(modelId);
                lastRunCmdTimeByModel.delete(modelId);

                if (isExecCmd && !autoRecoveryRetryModels.has(modelId)) {
                    autoRecoveryRetryModels.add(modelId);
                    stateManager.pushTelemetry(modelId, `[SYSTEM] Solver worker unavailable (${reason || rejectedCmd}); auto-reinitializing and retrying execution.`);
                    stateManager.setModelStatus(modelId, 'UNINITIALIZED');
                    const retryAction = rejectedCmd.startsWith('STEP') ? 'STEP' : 'EXEC_ALL';
                    executeModelCommand(modelId, retryAction, { forceRestart: true, isAutoRecovery: true }, false, true);
                } else {
                    if (isExecCmd) {
                        autoRecoveryRetryModels.delete(modelId);
                        stateManager.pushTelemetry(modelId, `[ERROR] Command ${rejectedCmd} rejected by Broker (${reason}): ${dataJson.message || 'Solver process inactive.'}`);
                        stateManager.setModelStatus(modelId, 'ERROR');
                    } else if (stateManager.getModelStatus(modelId) === 'RUNNING' || stateManager.getModelStatus(modelId) === 'PAUSED') {
                        stateManager.setModelStatus(modelId, 'TERMINATED');
                    }
                    transportController.updateModelStatusDisplay?.();
                }
            }
            return;
        }

        if (dataJson.type === 'log') {
            if (modelId && model) {
                if (dataJson.step !== undefined) {
                    stateManager.setModelStep(modelId, dataJson.step);
                }
                const solverNodes = model.nodes.filter(n => n.type === targetType || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver' || n.type === 'MPMDomain3D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler3D' || n.type === 'FSICoupler2D');
                solverNodes.forEach(sn => stateManager.pushTelemetry(sn.id, dataJson, modelId));
                const textNodes = model.nodes.filter(n => n.type === 'TelemetryText');
                textNodes.forEach(tn => stateManager.pushTelemetry(tn.id, dataJson, modelId));
                if (dataJson.level === 'ERROR') {
                    stateManager.recordModelError(modelId, {
                        message: dataJson.message || dataJson.text || dataJson.error || 'Solver reported an unspecified error.',
                        errorCode: dataJson.error_code,
                        summary: dataJson.summary,
                        details: dataJson.details,
                        step: dataJson.step ?? stateManager.getModelStep(modelId),
                        simTime: dataJson.time ?? dataJson.sim_time ?? stateManager.getModelSimTime(modelId),
                        dt: dataJson.dt,
                        scope: dataJson.scope,
                        level: dataJson.level,
                        device: dataJson.device,
                        precision: dataJson.precision,
                        kernelPhase: dataJson.kernel_phase,
                        exitCode: dataJson.exit_code,
                        signal: dataJson.signal
                    });
                    stateManager.setModelStatus(modelId, 'ERROR');
                    autoRunInFlight.delete(modelId);
                    pipelineAutoRunPending.delete(modelId);
                } else if (dataJson.level === 'INFO' && (dataJson.exit_code !== undefined || dataJson.signal !== undefined)) {
                    const latest = stateManager.getLatestModelError(modelId);
                    if (latest) {
                        if (dataJson.exit_code !== undefined) latest.exitCode = dataJson.exit_code;
                        if (dataJson.signal !== undefined) latest.signal = dataJson.signal;
                    }
                }
            } else {
                stateManager.pushTelemetry(dataJson);
            }
            return;
        }

        if (dataJson.type === 'progress' || dataJson.type === 'progress_2d') {
            if (modelId) {
                const isInitProgress = typeof dataJson.mode === 'string' && dataJson.mode.startsWith('INIT');

                if (isInitProgress) {
                    if (dataJson.percent === 100) {
                        awaitingInitResetByModel.delete(modelId);
                        autoRecoveryRetryModels.delete(modelId);
                        const currentStatus = stateManager.getModelStatus(modelId);
                        if (pausedByUserModels.has(modelId)) {
                            stateManager.setModelStatus(modelId, 'PAUSED');
                        } else if (currentStatus !== 'RUNNING') {
                            stateManager.setModelStatus(modelId, 'INITIALIZED');
                        }
                        stateManager.setModelProgress(modelId, 0);
                        if (dataJson.sim_time !== undefined) {
                            stateManager.setModelSimTime(modelId, dataJson.sim_time);
                        } else {
                            stateManager.setModelSimTime(modelId, 0.0);
                        }
                        if (dataJson.step !== undefined) {
                            stateManager.setModelStep(modelId, dataJson.step);
                        } else {
                            stateManager.setModelStep(modelId, 0);
                        }
                    }
                } else {
                    const currentStatus = stateManager.getModelStatus(modelId);
                    const resetAgeMs = Date.now() - (lastResetTimeByModel.get(modelId) || 0);
                    if (awaitingInitResetByModel.has(modelId)) {
                        if (lastRunCmdTimeByModel.has(modelId) && resetAgeMs > 500) {
                            awaitingInitResetByModel.delete(modelId);
                        } else {
                            return;
                        }
                    }
                    if (!lastRunCmdTimeByModel.has(modelId) && (currentStatus === 'INITIALIZED' || currentStatus === 'UNINITIALIZED') && resetAgeMs < 2000) {
                        return;
                    }

                    stateManager.setModelProgress(modelId, dataJson.percent);
                    if (dataJson.sim_time !== undefined) {
                        stateManager.setModelSimTime(modelId, dataJson.sim_time);
                    }
                    if (dataJson.step !== undefined) {
                        stateManager.setModelStep(modelId, dataJson.step);
                    }

                    if (dataJson.percent === 100) {
                        const latestStatus = stateManager.getModelStatus(modelId);
                        const wasTerminated = latestStatus === 'TERMINATED' || dataJson.is_terminated === true;
                        if (wasTerminated) {
                            pausedByUserModels.delete(modelId);
                            stateManager.setModelStatus(modelId, 'TERMINATED');
                            clearDownstreamAutoRun(modelId);
                        } else {
                            stateManager.setModelStatus(modelId, 'PAUSED');
                        }
                        autoRunInFlight.delete(modelId);
                        if (!wasTerminated) {
                            const isExecAll = typeof dataJson.mode === 'string' && dataJson.mode.startsWith('EXEC_ALL');
                            const allModels = stateManager.getAllModels();
                            let exportedStandalone3D = false;
                            for (const m of allModels) {
                                const pipe = findRemapPipeline(m.id);
                                if (!pipe || (pipe.sourceModelId !== modelId && pipe.model1dId !== modelId)) continue;

                                const isPendingAutoRun = pipelineAutoRunPending.has(m.id);
                                if (pipe.sourceType === '3D' && !remap3DFiles.has(modelId) && (isExecAll || isPendingAutoRun)) {
                                    if (isPendingAutoRun || !exportedStandalone3D) {
                                        if (!isPendingAutoRun) exportedStandalone3D = true;
                                        console.log(`[Pipeline Export] Upstream 3D model ${modelId} completed. Exporting 3D remap snapshot${isPendingAutoRun ? ` for ${m.id}` : ''}.`);
                                        networkManager.send({
                                            command: "EXPORT_REMAP_3D",
                                            modelId: modelId,
                                            ...(isPendingAutoRun ? { targetModelId: m.id } : {}),
                                            remap_file: `/tmp/blastdaemon_remap3d_${modelId}.bin`
                                        });
                                    }
                                    if (isPendingAutoRun) continue;
                                }
                                if (!isPendingAutoRun) continue;

                                console.log(`[Pipeline Auto-Init] Upstream model ${modelId} completed. Initializing downstream model ${m.id}`);
                                const pending = pipelineAutoRunPending.get(m.id)!;
                                pipelineAutoRunPending.delete(m.id);

                                if (m.id === modelId) {
                                    stateManager.setModelStatus(m.id, 'UNINITIALIZED');
                                }

                                const initExtra = { ...(pending.extra || {}) };
                                delete initExtra.forceRestart;
                                executeModelCommand(m.id, "INIT", initExtra, false, false);

                                if (pending.command && pending.command !== "INIT" && stateManager.getModelStatus(m.id) === 'INITIALIZED') {
                                    const hasOwnDownstreamPending = allModels.some(otherM => {
                                        const p = findRemapPipeline(otherM.id);
                                        return p && (p.sourceModelId === m.id || p.model1dId === m.id) && pipelineAutoRunPending.has(otherM.id);
                                    });
                                    if (hasOwnDownstreamPending) {
                                        autoRunInFlight.add(m.id);
                                    }
                                    executeModelCommand(m.id, pending.command, { ...initExtra, forceRestart: false }, false, false);
                                }
                            }
                        }
                    } else if (dataJson.percent < 100) {
                        const currentStatus = stateManager.getModelStatus(modelId);
                        if (currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                            stateManager.setModelStatus(modelId, 'RUNNING');
                        }
                    }
                }

                if (model) {
                    const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
                    solverNodes.forEach(sn => stateManager.pushTelemetry(sn.id, dataJson, modelId));
                }
            }
            return;
        }

        if (dataJson.type === 'TELEMETRY' || dataJson.type === 'TELEMETRY_2D' || dataJson.type === 'TELEMETRY_3D' || dataJson.type === 'TELEMETRY_MPM_2D' || dataJson.type === 'TELEMETRY_FEM_3D') {
            if (modelId) {
                const currentStatus = stateManager.getModelStatus(modelId);
                const msgStep = dataJson.step;
                const msgTime = dataJson.time;
                const isZeroResetFrame = (msgTime === undefined || msgTime === 0) && (msgStep === undefined || msgStep === 0);
                const resetAgeMs = Date.now() - (lastResetTimeByModel.get(modelId) || 0);

                if (awaitingInitResetByModel.has(modelId)) {
                    if (isZeroResetFrame || (lastRunCmdTimeByModel.has(modelId) && resetAgeMs > 500)) {
                        awaitingInitResetByModel.delete(modelId);
                    } else {
                        return;
                    }
                }
                if (!isZeroResetFrame && !lastRunCmdTimeByModel.has(modelId) && (currentStatus === 'INITIALIZED' || currentStatus === 'UNINITIALIZED') && resetAgeMs < 2000) {
                    return;
                }

                autoRecoveryRetryModels.delete(modelId);
                lastTelemetryTypeByModel.set(modelId, dataJson.type);
                const isReset = currentStatus === 'INITIALIZED' || currentStatus === 'UNINITIALIZED';
                const curSimTime = stateManager.getModelSimTime(modelId) || 0;
                const curStep = stateManager.getModelStep(modelId) || 0;

                if (dataJson.time !== undefined && (dataJson.time > 0 || isReset || curSimTime === 0)) {
                    stateManager.setModelSimTime(modelId, dataJson.time);
                }
                if (dataJson.step !== undefined && (dataJson.step > 0 || isReset || curStep === 0)) {
                    stateManager.setModelStep(modelId, dataJson.step);
                }
                if (dataJson.dt !== undefined && dataJson.dt > 0) {
                    stateManager.setModelDt(modelId, dataJson.dt);
                }
                const effectiveStep = stateManager.getModelStep(modelId);
                const effectiveTime = stateManager.getModelSimTime(modelId);
                const effectiveDt = stateManager.getModelDt(modelId);
                const activeModelId = stateManager.getActiveModelId();
                if (!activeModelId || modelId === activeModelId) {
                    transportController.updateExecutionStats(effectiveStep, effectiveTime, effectiveDt);
                } else if (pipelineAutoRunPending.has(activeModelId)) {
                    transportController.updateModelStatusDisplay?.();
                }

                if (isZeroResetFrame && currentStatus === 'UNINITIALIZED') {
                    stateManager.setModelStatus(modelId, 'INITIALIZED');
                    stateManager.setModelProgress(modelId, 0);
                } else if (dataJson.is_terminated === true) {
                    autoRunInFlight.delete(modelId);
                    pipelineAutoRunPending.delete(modelId);
                    pausedByUserModels.delete(modelId);
                    stateManager.setModelStatus(modelId, 'TERMINATED');
                } else if (dataJson.type === 'TELEMETRY_2D' || dataJson.type === 'TELEMETRY_MPM_2D' || dataJson.type === 'TELEMETRY_FEM_3D') {
                    // Check if we just transitioned from 1D phase (progress is 100)
                    const currentProgress = stateManager.getModelProgress(modelId);
                    if (currentProgress === 100 && !pausedByUserModels.has(modelId) && currentStatus === 'RUNNING') {
                        stateManager.setModelProgress(modelId, 0);
                        stateManager.setModelStatus(modelId, 'PAUSED');
                    } else if (!pausedByUserModels.has(modelId) && currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED' && currentStatus !== 'INITIALIZED') {
                        stateManager.setModelStatus(modelId, 'RUNNING');
                    }
                } else {
                    if (!pausedByUserModels.has(modelId) && currentStatus !== 'PAUSED' && currentStatus !== 'TERMINATED') {
                        if (currentStatus !== 'INITIALIZED' || (dataJson.step !== undefined && dataJson.step > 0) || (dataJson.time !== undefined && dataJson.time > 0)) {
                            stateManager.setModelStatus(modelId, 'RUNNING');
                        }
                    }
                }

                if (model) {
                    const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
                    solverNodes.forEach(sn => stateManager.pushTelemetry(sn.id, dataJson, modelId));
                }
                layoutManager.components.forEach(comp => {
                    if ((comp.type === 'VIEWPORT' || comp.type === 'MULTI_VIEW_STAGE') && comp.instance && typeof comp.instance.updateTelemetry === 'function') {
                        comp.instance.updateTelemetry(dataJson, modelId);
                    }
                    if ((dataJson.type === 'TELEMETRY_3D' || dataJson.type === 'TELEMETRY_FEM_3D') && comp.type === 'TELEMETRY_3D' && comp.instance) {
                        comp.instance.updateTelemetry(dataJson, modelId);
                    }
                    if (comp.type === 'NODE_VIEWER' && comp.instance && typeof comp.instance.updateTelemetry === 'function') {
                        comp.instance.updateTelemetry(dataJson, modelId);
                    }
                });
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
    const mode = pendingLocalLoadMode;
    pendingLocalLoadMode = 'replace_active';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const rawText = String(event.target?.result ?? '');
            const parsed = JSON.parse(rawText);
            await applyLoadedPayload(parsed, file.name, mode, false);
            console.log(`Loaded "${file.name}" successfully.`);
        } catch (err) {
            await CustomDialog.alert("Failed to parse JSON file: " + err);
        }
    };
    reader.readAsText(file);
    input.value = '';
});

document.getElementById('load-binary-file')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    const mode = pendingLocalLoadMode;
    pendingLocalLoadMode = 'replace_active';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            let buffer = event.target?.result as ArrayBuffer;
            // Support base64-encoded BLST files if encountered
            if (buffer && buffer.byteLength >= 6) {
                const head = new Uint8Array(buffer, 0, 6);
                const ascii = String.fromCharCode(...head);
                if (ascii === 'QkxTVA') {
                    const text = new TextDecoder().decode(new Uint8Array(buffer)).trim();
                    const decoded = base64ToUint8Array(text);
                    buffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
                }
            }
            const parsed = deserializeFromBinary(buffer);
            await applyLoadedPayload(parsed, file.name, mode, false);
            console.log(`Loaded binary model "${file.name}" successfully.`);
        } catch (err) {
            await CustomDialog.alert("Failed to parse Binary file: " + err);
        }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
});

function fallbackSaveJson(jsonString: string, filename: string = "model.json") {
    const blob = new Blob([jsonString], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", url);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Fallback to trigger downloads when Filesystem Access API isn't available
function fallbackSaveBinary(buffer: ArrayBuffer, filename: string = "model.blst") {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", url);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

