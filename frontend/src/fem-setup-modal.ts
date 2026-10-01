// ============================================================================
// BlastDemon FEM Preprocessor & Assembly Setup Modal
// Interactive 3-pane industrial preprocessor for parts, sets, materials,
// boundary conditions, contact interfaces, and 3D visualization.
// Zero-dependency pure TypeScript, HTML5 Canvas, and CSS.
// ============================================================================

import { Node, Model } from './types.js';
import { StateManager, getLSDynaDeckMeta, KNOWN_KEYWORD_DECKS } from './state-manager.js';
import {
    FEMSetupConfig,
    FEMPartConfig,
    FEMEntitySet,
    FEMBoundaryCondition,
    FEMContactConfig,
    FEMMaterialDefinition,
    FEMSectionType,
    CAD_PALETTE,
    createDefaultFEMSetupConfig,
    getPartColor
} from './fem-setup-types.js';
import { FEMDeckParser, ParsedFEMPreview } from './fem-deck-parser.js';

type SetupTab = 'parts' | 'sets' | 'materials' | 'bcs' | 'contacts';

export class FEMSetupModal {
    private overlay: HTMLDivElement | null = null;
    private stateManager: StateManager;
    private femNode: Node;
    private model: Model;
    private onCloseCallback?: () => void;

    // Core Data State
    private config: FEMSetupConfig;
    private preview: ParsedFEMPreview | null = null;
    private isDirty: boolean = false;

    // Active Navigation
    private activeTab: SetupTab = 'parts';
    private selectedPartId: number | null = null;
    private selectedSetId: number | null = null;
    private selectedMatId: number | null = null;
    private selectedBCId: string | null = null;
    private selectedContactId: string | null = null;
    private searchQuery: string = '';

    // 3D Viewport State
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private cameraTheta: number = Math.PI / 4;      // Azimuth (rad)
    private cameraPhi: number = Math.PI / 6;        // Elevation (rad)
    private cameraDistance: number = 2.5;           // Normalized camera distance
    private cameraTarget: [number, number, number] = [0, 0, 0];
    private panOffset: [number, number] = [0, 0];
    private isDragging: boolean = false;
    private isPanning: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    private explodedFactor: number = 0.0;           // 0.0 to 1.0 exploded view slider
    private showBCGlyphs: boolean = true;
    private showWireframe: boolean = true;
    private showShaded: boolean = true;
    private showXRay: boolean = false;
    private showGhostSuppressed: boolean = true;
    private animFrameId: number | null = null;
    private lastRenderedCount: number = 0;
    private lastLODActive: boolean = false;

    // High-performance preallocated persistent typed buffers for 60 FPS zero-allocation rendering
    private projX: Float32Array = new Float32Array(16384);
    private projY: Float32Array = new Float32Array(16384);
    private projDepth: Float32Array = new Float32Array(16384);
    private projStatus: Uint8Array = new Uint8Array(16384); // 0: uncomputed, 1: valid, 2: clipped
    private nodeBufferCapacity: number = 16384;

    private itemIndices: Int32Array = new Int32Array(32768);
    private itemDepths: Float32Array = new Float32Array(32768);
    private itemTypes: Uint8Array = new Uint8Array(32768); // 0: quad, 1: tri, 2: line
    private itemPartIds: Uint16Array = new Uint16Array(32768);
    private itemX0: Float32Array = new Float32Array(32768);
    private itemY0: Float32Array = new Float32Array(32768);
    private itemX1: Float32Array = new Float32Array(32768);
    private itemY1: Float32Array = new Float32Array(32768);
    private itemX2: Float32Array = new Float32Array(32768);
    private itemY2: Float32Array = new Float32Array(32768);
    private itemX3: Float32Array = new Float32Array(32768);
    private itemY3: Float32Array = new Float32Array(32768);
    private itemR: Uint8Array = new Uint8Array(32768);
    private itemG: Uint8Array = new Uint8Array(32768);
    private itemB: Uint8Array = new Uint8Array(32768);
    private itemBufferCapacity: number = 32768;

    private ensureNodeCapacity(needed: number): void {
        if (this.nodeBufferCapacity >= needed) return;
        const newCap = Math.max(needed + 1024, Math.floor(this.nodeBufferCapacity * 1.5));
        this.projX = new Float32Array(newCap);
        this.projY = new Float32Array(newCap);
        this.projDepth = new Float32Array(newCap);
        this.projStatus = new Uint8Array(newCap);
        this.nodeBufferCapacity = newCap;
    }

    private ensureItemCapacity(needed: number): void {
        if (this.itemBufferCapacity >= needed) return;
        const newCap = Math.max(needed + 2048, Math.floor(this.itemBufferCapacity * 1.5));
        this.itemIndices = new Int32Array(newCap);
        this.itemDepths = new Float32Array(newCap);
        this.itemTypes = new Uint8Array(newCap);
        this.itemPartIds = new Uint16Array(newCap);
        this.itemX0 = new Float32Array(newCap);
        this.itemY0 = new Float32Array(newCap);
        this.itemX1 = new Float32Array(newCap);
        this.itemY1 = new Float32Array(newCap);
        this.itemX2 = new Float32Array(newCap);
        this.itemY2 = new Float32Array(newCap);
        this.itemX3 = new Float32Array(newCap);
        this.itemY3 = new Float32Array(newCap);
        this.itemR = new Uint8Array(newCap);
        this.itemG = new Uint8Array(newCap);
        this.itemB = new Uint8Array(newCap);
        this.itemBufferCapacity = newCap;
    }

    // UI Container References
    private listPaneEl: HTMLElement | null = null;
    private inspectorPaneEl: HTMLElement | null = null;
    private footerStatusEl: HTMLElement | null = null;


    constructor(
        stateManager: StateManager,
        femNode: Node,
        model: Model,
        onClose?: () => void
    ) {
        this.stateManager = stateManager;
        this.femNode = femNode;
        this.model = model;
        this.onCloseCallback = onClose;

        // Sync viewport display preferences
        const vpNode = this.model.nodes.find(n => n.type === 'Telemetry3DViewport' || (n.type as string) === 'View3D');
        if (vpNode) {
            if (vpNode.parameters.femWireframe !== undefined) {
                this.showWireframe = Boolean(vpNode.parameters.femWireframe);
            }
            if (vpNode.parameters.femSolid !== undefined) {
                this.showShaded = Boolean(vpNode.parameters.femSolid);
            }
        }

        // Initialize or restore config from node parameters
        this.config = this.loadInitialConfig();
        this.initPreview();
        this.createDOM();
    }

    private loadInitialConfig(): FEMSetupConfig {
        const structuralNodes = this.model.nodes.filter(n =>
            ['FEMObject3D', 'LSDynaImporter3D', 'FEMBeam3D', 'FEMRebar3D'].includes(n.type)
        );

        // Check if fem_setup is already saved on femNode or on a domain node in this model
        let existingSetup: FEMSetupConfig | null = null;
        if (this.femNode.parameters.fem_setup && typeof this.femNode.parameters.fem_setup === 'object') {
            existingSetup = this.femNode.parameters.fem_setup;
        } else {
            const domainNode = this.model.nodes.find(n => n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
            if (domainNode?.parameters.fem_setup && typeof domainNode.parameters.fem_setup === 'object') {
                existingSetup = domainNode.parameters.fem_setup;
            }
        }

        const config: FEMSetupConfig = existingSetup
            ? JSON.parse(JSON.stringify(existingSetup))
            : createDefaultFEMSetupConfig();

        // 1. Synchronize Canvas Materials into this.config.materials
        this.syncModelMaterialsIntoConfig(config);

        // 2. Synchronize Model Structural Nodes into this.config.parts
        this.syncModelNodesIntoParts(config, structuralNodes);

        // 3. Preselect the appropriate part (the clicked node, or the first part)
        const matchingPart = config.parts.find(p => p.node_id === this.femNode.id);
        if (matchingPart) {
            this.selectedPartId = matchingPart.part_id;
        } else if (config.parts.length > 0) {
            this.selectedPartId = config.parts[0].part_id;
        }

        return config;
    }

    private syncModelMaterialsIntoConfig(config: FEMSetupConfig): void {
        for (const node of this.model.nodes) {
            if (
                node.type.includes('Material') ||
                node.type.includes('Constitutive') ||
                (node.type as string) === 'MaterialTable' ||
                node.parameters.model_type !== undefined
            ) {
                const nodeName = String(node.parameters.name || node.parameters.material_name || node.parameters.preset || node.id);
                const existing = config.materials.find(m => m.name === nodeName || (m.parameters as any)?.node_id === node.id);
                if (existing) {
                    if (node.parameters.density !== undefined) existing.density = Number(node.parameters.density);
                    if (node.parameters.youngs_modulus !== undefined || node.parameters.e !== undefined) {
                        existing.youngs_modulus = Number(node.parameters.youngs_modulus ?? node.parameters.e);
                    }
                    if (node.parameters.poissons_ratio !== undefined || node.parameters.nu !== undefined) {
                        existing.poissons_ratio = Number(node.parameters.poissons_ratio ?? node.parameters.nu);
                    }
                    if (node.parameters.yield_stress !== undefined) existing.yield_stress = Number(node.parameters.yield_stress);
                    if (node.parameters.hardening_modulus !== undefined) existing.hardening_modulus = Number(node.parameters.hardening_modulus);
                    if (node.parameters.failure_strain !== undefined) existing.failure_strain = Number(node.parameters.failure_strain);
                } else {
                    const nextId = Math.max(0, ...config.materials.map(m => m.mat_id)) + 1;
                    config.materials.push({
                        mat_id: nextId,
                        name: nodeName,
                        source: 'canvas_node',
                        model_type: String(node.parameters.material_model || node.parameters.model_type || 'PiecewiseLinearPlasticity'),
                        density: Number(node.parameters.density ?? 7850),
                        youngs_modulus: Number(node.parameters.youngs_modulus ?? (node.parameters.e ?? 210e9)),
                        poissons_ratio: Number(node.parameters.poissons_ratio ?? (node.parameters.nu ?? 0.30)),
                        yield_stress: Number(node.parameters.yield_stress ?? 400e6),
                        hardening_modulus: Number(node.parameters.hardening_modulus ?? 1e9),
                        failure_strain: Number(node.parameters.failure_strain ?? 0.25),
                        parameters: { ...node.parameters, node_id: node.id }
                    });
                }
            }
        }
    }

    private syncModelNodesIntoParts(config: FEMSetupConfig, structuralNodes: Node[]): void {
        if (structuralNodes.length === 0) {
            if (config.parts.length === 0) {
                const p = this.femNode.parameters;
                config.parts.push({
                    part_id: 1,
                    node_id: this.femNode.id,
                    name: String(p.name || this.femNode.id),
                    section_type: (p.section_type || 'SolidHex8') as FEMSectionType,
                    section_properties: {
                        thickness: Number(p.thickness ?? 0.005),
                        diameter: Number(p.diameter ?? (p.radius ? p.radius * 2 : 0.00953)),
                        hourglass_type: 'Flanagan-Belytschko',
                        hourglass_coeff: 0.10
                    },
                    material_assignment: String(p.material || 'DEFAULT'),
                    color: getPartColor(0),
                    visible: p.visible !== false && !p.hidden,
                    suppressed: p.suppressed === true,
                    initial_velocity: [
                        Number(p.vel_x ?? p.vx ?? 0),
                        Number(p.vel_y ?? p.vy ?? 0),
                        Number(p.vel_z ?? p.vz ?? 0)
                    ],
                    num_elements: 0,
                    num_nodes: 0,
                    bounds: [0, 1, 0, 1, 0, 1],
                    shape_type: (p.shape_type || 'Box') as any,
                    pos_x: Number(p.pos_x ?? 0),
                    pos_y: Number(p.pos_y ?? 0),
                    pos_z: Number(p.pos_z ?? 0),
                    size_x: Number(p.size_x ?? 1.0),
                    size_y: Number(p.size_y ?? 1.0),
                    size_z: Number(p.size_z ?? 1.0),
                    radius: Number(p.radius ?? 0.1),
                    height: Number(p.height ?? 0.2),
                    origin_mode: p.origin_mode || 'Center',
                    nx: Math.max(1, Math.min(100, Number(p.nx ?? 10))),
                    ny: Math.max(1, Math.min(100, Number(p.ny ?? 10))),
                    nz: Math.max(1, Math.min(100, Number(p.nz ?? 10)))
                });
            }
            return;
        }

        // If there are real structural nodes in the active model, purge dummy placeholder parts
        if (structuralNodes.length > 0) {
            config.parts = config.parts.filter(pt =>
                structuralNodes.some(n => n.id === pt.node_id || (p => (p.name || n.id) === pt.name)(n.parameters))
            );
        }

        // For each real structural node in the model
        for (let idx = 0; idx < structuralNodes.length; idx++) {
            const node = structuralNodes[idx];
            const p = node.parameters;
            let existingPart = config.parts.find(pt => pt.node_id === node.id || pt.name === (p.name || node.id));

            // Find connected material for this node
            let matAssignment = String(p.material || 'DEFAULT');
            const matConn = this.model.connections.find(c =>
                (c.toNode === node.id || c.fromNode === node.id) &&
                (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'importer')
            );
            if (matConn) {
                matAssignment = matConn.toNode === node.id ? matConn.fromNode : matConn.toNode;
            }

            const isLSDyna = node.type === 'LSDynaImporter3D' || !!p.k_file || p.mesh_source === 'LS-DYNA Keyword File' || p.shape_type === 'LS-DYNA File';
            const kFile = p.k_file || p.filename || p.file_path || (node.type === 'LSDynaImporter3D' ? 'concrete_cubicle_30mm.k' : undefined);
            const deckMeta = kFile ? getLSDynaDeckMeta(kFile) : undefined;

            let secType: FEMSectionType = 'SolidHex8';
            if (node.type === 'FEMBeam3D') secType = 'Beam3D';
            else if (node.type === 'FEMRebar3D') secType = 'Truss1D';
            else if (p.shape_type === 'Plate' || p.shape_type === 'Shell') secType = 'Shell4';
            else if (p.section_type) secType = p.section_type as FEMSectionType;

            if (existingPart) {
                existingPart.node_id = node.id;
                existingPart.name = String(p.name || existingPart.name || node.id);
                if (matAssignment !== 'DEFAULT' || !existingPart.material_assignment) {
                    existingPart.material_assignment = matAssignment;
                }
                if (isLSDyna) {
                    existingPart.shape_type = 'LS-DYNA File';
                    if (kFile) existingPart.k_file = kFile;
                    if (p.scale_factor !== undefined) existingPart.scale_factor = Number(p.scale_factor);
                    if (deckMeta) {
                        existingPart.bounds = deckMeta.bounds;
                        existingPart.num_elements = deckMeta.totalElements;
                        existingPart.num_nodes = deckMeta.numNodes;
                        if (!existingPart.size_x || existingPart.size_x === 0.1) {
                            existingPart.pos_x = deckMeta.bounds[0];
                            existingPart.pos_y = deckMeta.bounds[2];
                            existingPart.pos_z = deckMeta.bounds[4];
                            existingPart.size_x = deckMeta.bounds[1] - deckMeta.bounds[0];
                            existingPart.size_y = deckMeta.bounds[3] - deckMeta.bounds[2];
                            existingPart.size_z = deckMeta.bounds[5] - deckMeta.bounds[4];
                        }
                    }
                } else {
                    if (p.pos_x !== undefined) existingPart.pos_x = Number(p.pos_x);
                    if (p.pos_y !== undefined) existingPart.pos_y = Number(p.pos_y);
                    if (p.pos_z !== undefined) existingPart.pos_z = Number(p.pos_z);
                    if (p.size_x !== undefined) existingPart.size_x = Number(p.size_x);
                    if (p.size_y !== undefined) existingPart.size_y = Number(p.size_y);
                    if (p.size_z !== undefined) existingPart.size_z = Number(p.size_z);
                    if (p.radius !== undefined) existingPart.radius = Number(p.radius);
                    if (p.inner_radius !== undefined) existingPart.inner_radius = Number(p.inner_radius);
                    if (p.height !== undefined) existingPart.height = Number(p.height);
                    if (p.nx !== undefined) existingPart.nx = Math.max(1, Math.min(100, Number(p.nx)));
                    if (p.ny !== undefined) existingPart.ny = Math.max(1, Math.min(100, Number(p.ny)));
                    if (p.nz !== undefined) existingPart.nz = Math.max(1, Math.min(100, Number(p.nz)));
                    if (p.origin_mode) existingPart.origin_mode = p.origin_mode;
                    if (p.shape_type) existingPart.shape_type = p.shape_type as any;
                }
                if (p.section_type) existingPart.section_type = p.section_type as any;
                if (p.node1_x !== undefined) existingPart.node1 = [Number(p.node1_x), Number(p.node1_y ?? 0), Number(p.node1_z ?? 0)];
                if (p.node2_x !== undefined) existingPart.node2 = [Number(p.node2_x), Number(p.node2_y ?? 0), Number(p.node2_z ?? 0)];
                if (p.vel_x !== undefined || p.vel_y !== undefined || p.vel_z !== undefined) {
                    existingPart.initial_velocity = [
                        Number(p.vel_x ?? 0),
                        Number(p.vel_y ?? 0),
                        Number(p.vel_z ?? 0)
                    ];
                }
            } else {
                const partId = Math.max(0, ...config.parts.map(pt => pt.part_id)) + 1;
                const newPart: FEMPartConfig = {
                    part_id: partId,
                    node_id: node.id,
                    name: String(p.name || p.title || node.id),
                    section_type: secType,
                    section_properties: {
                        thickness: Number(p.thickness ?? (isLSDyna ? 0.04 : 0.005)),
                        diameter: Number(p.diameter ?? (p.radius ? p.radius * 2 : 0.00953)),
                        hourglass_type: 'Flanagan-Belytschko',
                        hourglass_coeff: 0.10
                    },
                    material_assignment: matAssignment,
                    color: p.color || getPartColor(idx),
                    visible: p.visible !== false && !p.hidden,
                    suppressed: p.suppressed === true,
                    initial_velocity: [
                        Number(p.vel_x ?? p.vx ?? 0),
                        Number(p.vel_y ?? p.vy ?? 0),
                        Number(p.vel_z ?? p.vz ?? 0)
                    ],
                    num_elements: deckMeta?.totalElements ?? (isLSDyna ? 211010 : 0),
                    num_nodes: deckMeta?.numNodes ?? (isLSDyna ? 213270 : 0),
                    bounds: deckMeta?.bounds ?? (isLSDyna ? [0, 3.68, 0, 3.68, 0, 2.68] : [0, 1, 0, 1, 0, 1]),
                    shape_type: (isLSDyna ? 'LS-DYNA File' : (p.shape_type || (node.type === 'FEMBeam3D' ? 'Beam' : 'Box'))) as any,
                    pos_x: deckMeta ? deckMeta.bounds[0] : Number(p.pos_x ?? 0),
                    pos_y: deckMeta ? deckMeta.bounds[2] : Number(p.pos_y ?? 0),
                    pos_z: deckMeta ? deckMeta.bounds[4] : Number(p.pos_z ?? 0),
                    size_x: deckMeta ? (deckMeta.bounds[1] - deckMeta.bounds[0]) : Number(p.size_x ?? (isLSDyna ? 3.68 : 1.0)),
                    size_y: deckMeta ? (deckMeta.bounds[3] - deckMeta.bounds[2]) : Number(p.size_y ?? (isLSDyna ? 3.68 : 1.0)),
                    size_z: deckMeta ? (deckMeta.bounds[5] - deckMeta.bounds[4]) : Number(p.size_z ?? (isLSDyna ? 2.68 : 1.0)),
                    radius: Number(p.radius ?? 0.1),
                    height: Number(p.height ?? 0.2),
                    origin_mode: p.origin_mode || 'Center',
                    nx: Math.max(1, Math.min(100, Number(p.nx ?? (isLSDyna ? 20 : 10)))),
                    ny: Math.max(1, Math.min(100, Number(p.ny ?? (isLSDyna ? 20 : 10)))),
                    nz: Math.max(1, Math.min(100, Number(p.nz ?? (isLSDyna ? 20 : 10)))),
                    node1: [Number(p.node1_x ?? 0), Number(p.node1_y ?? 0), Number(p.node1_z ?? 0)],
                    node2: [Number(p.node2_x ?? 1), Number(p.node2_y ?? 0), Number(p.node2_z ?? 0)],
                    k_file: kFile,
                    scale_factor: Number(p.scale_factor ?? 1.0)
                };
                config.parts.push(newPart);
            }
        }
    }

    private findActiveFEMBuffer(): ArrayBuffer | null {
        // 1. Check StateManager cache
        const smBuf = this.stateManager.getLatestFEMBuffer(this.model.id);
        if (smBuf && smBuf.byteLength >= 24) {
            const m = new DataView(smBuf).getUint32(0, true);
            if (m === 0x46454d33) return smBuf;
        }

        // 2. Check PlaybackRingBuffer
        const pb = (window as any).playbackBuffer;
        if (pb) {
            if (typeof pb.getLatestFEMBuffer === 'function') {
                const b = pb.getLatestFEMBuffer(this.model.id);
                if (b && b.byteLength >= 24) return b;
            }
            const latest = pb.getLatestFrameForModel?.(this.model.id) || pb.getLatestFrame?.();
            if (latest?.femBuffer && latest.femBuffer.byteLength >= 24) {
                const m = new DataView(latest.femBuffer).getUint32(0, true);
                if (m === 0x46454d33) return latest.femBuffer;
            }
            if (Array.isArray(pb.frames)) {
                for (let i = pb.frames.length - 1; i >= 0; i--) {
                    const f = pb.frames[i];
                    if (f.femBuffer && f.femBuffer.byteLength >= 24) {
                        const m = new DataView(f.femBuffer).getUint32(0, true);
                        if (m === 0x46454d33) return f.femBuffer;
                    }
                }
            }
        }

        // 3. Check visual nodes in model for any cached FEM buffer
        for (const node of this.model.nodes) {
            if (['Telemetry3DViewport', 'TelemetryContour', 'FEMDomain3D', 'FEMFSICoupler3D'].includes(node.type)) {
                const tData = this.stateManager.getTelemetry(node.id);
                if (tData instanceof ArrayBuffer && tData.byteLength >= 24) {
                    const m = new DataView(tData).getUint32(0, true);
                    if (m === 0x46454d33) return tData;
                }
            }
        }

        return null;
    }

    private initPreview(): void {
        const modelStatus = this.stateManager.getModelStatus(this.model.id);
        const hasSimulated = modelStatus !== 'UNINITIALIZED' && modelStatus !== 'INCOMPLETE';
        const hasParametricParts = this.config.parts.some(p => p.shape_type !== 'LS-DYNA File');

        // Priority 1: Check for active simulation telemetry mesh from solver (FEM3 / 0x46454d33)
        // Only adopt telemetry if the model has actively simulated and has not been invalidated
        if (hasSimulated && !hasParametricParts) {
            const femBuffer = this.findActiveFEMBuffer();
            if (femBuffer) {
                const parsed = FEMDeckParser.parseTelemetryMesh(femBuffer, this.femNode.parameters?.name || this.model.name);
                if (parsed && parsed.elements.length > 0) {
                    this.preview = parsed;
                    this.mergeParsedWithExistingConfig();
                    this.calculateModelBounds();
                    return;
                }
            }
        }

        // Priority 2: Check for embedded deck content on node parameters
        const p = this.femNode.parameters;
        if ((p.mesh_source === 'LS-DYNA Keyword File' || p.k_file || this.femNode.type === 'LSDynaImporter3D') && p.deck_content) {
            try {
                this.preview = FEMDeckParser.parse(String(p.deck_content));
                this.mergeParsedWithExistingConfig();
                this.calculateModelBounds();
                return;
            } catch (e) {
                console.warn('[FEMSetupModal] Error parsing stored deck content:', e);
            }
        }

        // Priority 3: Check if node or any part has a known LS-DYNA keyword deck or k_file
        const kFile = p.k_file || p.filename || p.file_path || (this.femNode.type === 'LSDynaImporter3D' ? 'concrete_cubicle_30mm.k' : null);
        if (kFile && (p.shape_type === 'LS-DYNA File' || this.femNode.type === 'LSDynaImporter3D')) {
            const meta = getLSDynaDeckMeta(kFile);
            if (meta) {
                this.preview = FEMDeckParser.generateKnownDeckPreview(meta, this.femNode.parameters?.name || this.model.name);
                this.mergeParsedWithExistingConfig();
                this.calculateModelBounds();
                return;
            }
        }

        // Priority 4: Rebuild preview from assembly parts
        this.rebuildPreview();
    }

    public rebuildPreview(): void {
        this.preview = FEMDeckParser.generateAssemblyPreview(this.config.parts);
        this.calculateModelBounds();
        this.requestRender();
    }

    private mergeParsedWithExistingConfig(): void {
        if (!this.preview) return;

        const hasOnlyDefaultBox = this.config.parts.length === 1 && (
            (this.config.parts[0].shape_type === 'Box' || !this.config.parts[0].shape_type) &&
            this.config.parts[0].size_x === 0.1 &&
            this.config.parts[0].size_y === 0.1 &&
            this.config.parts[0].size_z === 0.1
        );

        // If config has no parts yet or has a single placeholder part, adopt preview parts
        if ((this.config.parts.length === 0 || hasOnlyDefaultBox) && this.preview.config.parts.length > 0) {
            const preservedNodeId = this.config.parts[0]?.node_id || this.femNode.id;
            this.config.parts = JSON.parse(JSON.stringify(this.preview.config.parts));
            if (this.config.parts.length > 0 && preservedNodeId) {
                this.config.parts[0].node_id = preservedNodeId;
            }
        } else {
            // Update node/element counts and bounds from preview while preserving user overrides
            for (const prevPart of this.preview.config.parts) {
                const existing = this.config.parts.find(p => p.part_id === prevPart.part_id);
                if (existing) {
                    existing.num_elements = prevPart.num_elements;
                    existing.num_nodes = prevPart.num_nodes;
                    existing.bounds = prevPart.bounds;
                    if (prevPart.shape_type) existing.shape_type = prevPart.shape_type;
                    if (prevPart.section_type && existing.section_type === 'SolidHex8') existing.section_type = prevPart.section_type;
                    if (prevPart.size_x !== undefined && (existing.size_x === 0.1 || !existing.size_x)) existing.size_x = prevPart.size_x;
                    if (prevPart.size_y !== undefined && (existing.size_y === 0.1 || !existing.size_y)) existing.size_y = prevPart.size_y;
                    if (prevPart.size_z !== undefined && (existing.size_z === 0.1 || !existing.size_z)) existing.size_z = prevPart.size_z;
                    if (prevPart.pos_x !== undefined) existing.pos_x = prevPart.pos_x;
                    if (prevPart.pos_y !== undefined) existing.pos_y = prevPart.pos_y;
                    if (prevPart.pos_z !== undefined) existing.pos_z = prevPart.pos_z;
                    if (prevPart.k_file) existing.k_file = prevPart.k_file;
                } else {
                    this.config.parts.push(JSON.parse(JSON.stringify(prevPart)));
                }
            }
        }

        // Merge sets from preview
        if (this.preview.config.sets && this.preview.config.sets.length > 0) {
            for (const pSet of this.preview.config.sets) {
                if (!this.config.sets.some(s => s.set_id === pSet.set_id || s.name === pSet.name)) {
                    this.config.sets.push(JSON.parse(JSON.stringify(pSet)));
                }
            }
        }

        // Merge materials from preview/deck
        if (this.preview.config.materials && this.preview.config.materials.length > 0) {
            for (const pMat of this.preview.config.materials) {
                if (!this.config.materials.some(m => m.mat_id === pMat.mat_id || m.name === pMat.name)) {
                    this.config.materials.push(JSON.parse(JSON.stringify(pMat)));
                }
            }
        }

        // Merge boundary conditions from preview
        if (this.preview.config.boundary_conditions && this.preview.config.boundary_conditions.length > 0) {
            for (const pBc of this.preview.config.boundary_conditions) {
                if (!this.config.boundary_conditions.some(b => b.id === pBc.id || b.name === pBc.name)) {
                    this.config.boundary_conditions.push(JSON.parse(JSON.stringify(pBc)));
                }
            }
        }

        // Set default selection
        if (this.config.parts.length > 0 && this.selectedPartId === null) {
            this.selectedPartId = this.config.parts[0].part_id;
        }
    }

    private calculateModelBounds(): void {
        if (!this.preview || this.preview.nodeCoords.length === 0) return;
        const coords = this.preview.nodeCoords;
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < coords.length; i += 3) {
            const x = coords[i];
            const y = coords[i + 1];
            const z = coords[i + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }

        this.cameraTarget = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];
        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);
        this.cameraDistance = span * 2.2;
        this.panOffset = [0, 0];
        this.requestRender();
    }

    private getCanvasMaterials(): { id: string; name: string; model_type: string; density?: number; youngs_modulus?: number; poissons_ratio?: number }[] {
        const mats: { id: string; name: string; model_type: string; density?: number; youngs_modulus?: number; poissons_ratio?: number }[] = [];
        for (const node of this.model.nodes) {
            if (
                node.type.includes('Material') ||
                node.type.includes('Constitutive') ||
                (node.type as string) === 'MaterialTable' ||
                node.parameters.model_type !== undefined
            ) {
                mats.push({
                    id: node.id,
                    name: String(node.parameters.name || node.parameters.material_name || node.id),
                    model_type: String(node.parameters.model_type || node.type),
                    density: node.parameters.density ? Number(node.parameters.density) : undefined,
                    youngs_modulus: node.parameters.youngs_modulus ? Number(node.parameters.youngs_modulus) : (node.parameters.e ? Number(node.parameters.e) : undefined),
                    poissons_ratio: node.parameters.poissons_ratio ? Number(node.parameters.poissons_ratio) : (node.parameters.nu ? Number(node.parameters.nu) : undefined)
                });
            }
        }
        return mats;
    }

    // ========================================================================
    // DOM Creation & Layout Structure
    // ========================================================================
    private createDOM(): void {
        const existing = document.querySelector('.fem-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'fem-modal-overlay';
        this.overlay = overlay;

        // Escape key listener
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (this.isDirty) {
                    this.saveAndApply();
                } else {
                    this.close();
                }
            }
        };
        window.addEventListener('keydown', keyHandler);

        const box = document.createElement('div');
        box.className = 'fem-modal-box';
        overlay.appendChild(box);

        // 1. Header
        const header = this.createHeader();
        box.appendChild(header);

        // 2. Main 3-Pane Body
        const main = document.createElement('div');
        main.className = 'fem-modal-main';

        // 2a. Left Pane (List / Tabs)
        const leftPane = document.createElement('div');
        leftPane.className = 'fem-modal-left-pane';
        this.listPaneEl = leftPane;
        main.appendChild(leftPane);

        // 2b. Center Pane (3D Canvas + Toolbar)
        const centerPane = this.createCenterPane();
        main.appendChild(centerPane);

        // 2c. Right Pane (Property Inspector)
        const rightPane = document.createElement('div');
        rightPane.className = 'fem-modal-right-pane';
        this.inspectorPaneEl = rightPane;
        main.appendChild(rightPane);

        box.appendChild(main);

        // 3. Footer
        const footer = this.createFooter();
        box.appendChild(footer);

        document.body.appendChild(overlay);

        // Initial Render
        this.renderTabsAndList();
        this.renderInspector();
        this.setupCanvasAndAnimation();
    }

    private createHeader(): HTMLElement {
        const header = document.createElement('div');
        header.className = 'fem-modal-header';

        const titleBox = document.createElement('div');
        titleBox.className = 'fem-modal-title-box';

        const icon = document.createElement('span');
        icon.className = 'fem-modal-title-icon';
        icon.textContent = '⚙️';

        const text = document.createElement('div');
        text.className = 'fem-modal-title-text';
        const nodeName = this.femNode.parameters.name || this.femNode.id;
        text.innerHTML = `<strong>Industrial FEM Preprocessor & Assembly Setup</strong> <span class="fem-modal-tag">${this.model.name} · ${nodeName}</span>`;

        titleBox.appendChild(icon);
        titleBox.appendChild(text);

        const headerActions = document.createElement('div');
        headerActions.className = 'fem-modal-header-actions';

        // Import .k Deck button
        const importBtn = document.createElement('button');
        importBtn.className = 'fem-btn fem-btn-secondary';
        importBtn.innerHTML = '<span>📥</span> <span>Import Keyword Deck (*.k)...</span>';
        importBtn.title = 'Import an LS-DYNA Keyword Deck (.k, .key, .dyn) from your computer';
        importBtn.onclick = () => this.triggerFileImport();
        headerActions.appendChild(importBtn);

        // Export Deck Config
        const exportBtn = document.createElement('button');
        exportBtn.className = 'fem-btn fem-btn-secondary';
        exportBtn.innerHTML = '<span>📤</span> <span>Export JSON</span>';
        exportBtn.title = 'Export the full FEM assembly configuration to JSON';
        exportBtn.onclick = () => this.exportSetupJSON();
        headerActions.appendChild(exportBtn);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fem-modal-close-btn';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Close Window (Esc)';
        closeBtn.onclick = () => {
            if (this.isDirty) {
                this.saveAndApply();
            } else {
                this.close();
            }
        };
        headerActions.appendChild(closeBtn);

        header.appendChild(titleBox);
        header.appendChild(headerActions);
        return header;
    }

    private createCenterPane(): HTMLElement {
        const center = document.createElement('div');
        center.className = 'fem-modal-center-pane';

        // Floating 3D Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'fem-viewport-toolbar';

        // View presets
        const viewGroup = document.createElement('div');
        viewGroup.className = 'fem-btn-group';

        const addViewBtn = (label: string, title: string, onClick: () => void) => {
            const btn = document.createElement('button');
            btn.className = 'fem-toolbar-btn';
            btn.textContent = label;
            btn.title = title;
            btn.onclick = onClick;
            viewGroup.appendChild(btn);
        };

        addViewBtn('Iso', 'Isometric View', () => this.setCameraPreset(Math.PI / 4, Math.PI / 6));
        addViewBtn('+X', 'Right View (+X)', () => this.setCameraPreset(0, 0));
        addViewBtn('-X', 'Left View (-X)', () => this.setCameraPreset(Math.PI, 0));
        addViewBtn('+Y', 'Back View (+Y)', () => this.setCameraPreset(Math.PI / 2, 0));
        addViewBtn('-Y', 'Front View (-Y)', () => this.setCameraPreset(-Math.PI / 2, 0));
        addViewBtn('+Z', 'Top View (+Z)', () => this.setCameraPreset(0, Math.PI / 2 - 0.01));
        addViewBtn('-Z', 'Bottom View (-Z)', () => this.setCameraPreset(0, -Math.PI / 2 + 0.01));
        addViewBtn('Fit', 'Reset and Fit Camera to Model Bounds', () => this.calculateModelBounds());
        toolbar.appendChild(viewGroup);

        // Separator
        const sep1 = document.createElement('div');
        sep1.className = 'fem-toolbar-separator';
        toolbar.appendChild(sep1);

        // Exploded View Slider
        const explodeBox = document.createElement('div');
        explodeBox.className = 'fem-explode-control';
        explodeBox.title = 'Exploded Assembly View: Displace components radially outward to inspect internal geometry';

        const explodeLabel = document.createElement('span');
        explodeLabel.className = 'fem-explode-label';
        explodeLabel.innerHTML = '💥 Explode:';

        const explodeSlider = document.createElement('input');
        explodeSlider.type = 'range';
        explodeSlider.min = '0';
        explodeSlider.max = '100';
        explodeSlider.value = String(Math.round(this.explodedFactor * 100));
        explodeSlider.className = 'fem-slider';
        explodeSlider.oninput = () => {
            this.explodedFactor = Number(explodeSlider.value) / 100.0;
            explodeVal.textContent = `${explodeSlider.value}%`;
            this.requestRender();
        };

        const explodeVal = document.createElement('span');
        explodeVal.className = 'fem-explode-val';
        explodeVal.textContent = `${Math.round(this.explodedFactor * 100)}%`;

        explodeBox.appendChild(explodeLabel);
        explodeBox.appendChild(explodeSlider);
        explodeBox.appendChild(explodeVal);
        toolbar.appendChild(explodeBox);

        // Toggles
        const togglesGroup = document.createElement('div');
        togglesGroup.className = 'fem-btn-group';

        const addToggleBtn = (label: string, title: string, isActive: () => boolean, onToggle: (active: boolean) => void) => {
            const btn = document.createElement('button');
            btn.className = `fem-toolbar-btn ${isActive() ? 'active' : ''}`;
            btn.textContent = label;
            btn.title = title;
            btn.onclick = () => {
                const next = !isActive();
                onToggle(next);
                btn.className = `fem-toolbar-btn ${next ? 'active' : ''}`;
                this.requestRender();
            };
            togglesGroup.appendChild(btn);
        };

        addToggleBtn('Wire', 'Toggle Mesh Wireframe', () => this.showWireframe, (v) => {
            this.showWireframe = v;
            const vp = this.model.nodes.find(n => n.type === 'Telemetry3DViewport' || (n.type as string) === 'View3D');
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femWireframe: v });
            }
        });
        addToggleBtn('Shade', 'Toggle Shaded Surfaces', () => this.showShaded, (v) => {
            this.showShaded = v;
            const vp = this.model.nodes.find(n => n.type === 'Telemetry3DViewport' || (n.type as string) === 'View3D');
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femSolid: v });
            }
        });
        addToggleBtn('X-Ray', 'Toggle Translucent / X-Ray Solid Inspection to reveal internal rebar & cavities', () => this.showXRay, (v) => { this.showXRay = v; });
        addToggleBtn('BCs', 'Toggle 3D Boundary Condition Glyphs', () => this.showBCGlyphs, (v) => { this.showBCGlyphs = v; });
        addToggleBtn('Ghost', 'Toggle Ghosted Wireframe for Suppressed Parts', () => this.showGhostSuppressed, (v) => { this.showGhostSuppressed = v; });

        toolbar.appendChild(togglesGroup);
        center.appendChild(toolbar);

        // Canvas element
        const canvas = document.createElement('canvas');
        canvas.className = 'fem-viewport-canvas';
        this.canvas = canvas;
        center.appendChild(canvas);

        // Viewport Overlay Readout
        const overlayReadout = document.createElement('div');
        overlayReadout.className = 'fem-viewport-overlay';
        overlayReadout.id = 'fem-viewport-readout';
        overlayReadout.innerHTML = `
            <div><strong>Parts:</strong> ${this.config.parts.length} | <strong>Sets:</strong> ${this.config.sets.length}</div>
            <div><strong>Elements:</strong> ${this.getTotalElements()} | <strong>Nodes:</strong> ${this.getTotalNodes()}</div>
            <div style="font-size: 10px; color: #64748b; margin-top: 4px;">Left Drag: Orbit | Right/Shift Drag: Pan | Scroll: Zoom</div>
        `;
        center.appendChild(overlayReadout);

        return center;
    }

    private createFooter(): HTMLElement {
        const footer = document.createElement('div');
        footer.className = 'fem-modal-footer';

        const status = document.createElement('div');
        status.className = 'fem-modal-footer-status';
        status.innerHTML = `<span>Assembly: <strong>${this.config.parts.filter(p => !p.suppressed).length}</strong> active parts, <strong>${this.config.boundary_conditions.filter(b => b.active).length}</strong> active BCs</span>`;
        this.footerStatusEl = status;

        const actions = document.createElement('div');
        actions.className = 'fem-modal-footer-actions';

        // Revert to deck defaults
        const revertBtn = document.createElement('button');
        revertBtn.className = 'fem-btn fem-btn-secondary';
        revertBtn.textContent = 'Reset to Deck Defaults';
        revertBtn.title = 'Discard component modifications and re-parse original deck';
        revertBtn.onclick = () => {
            if (confirm('Discard all part and boundary condition modifications and reload the original deck?')) {
                this.config = createDefaultFEMSetupConfig();
                this.initPreview();
                this.isDirty = true;
                this.renderTabsAndList();
                this.renderInspector();
                this.requestRender();
            }
        };

        // Cancel button
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'fem-btn fem-btn-secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => this.close();

        // Save & Apply button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'fem-btn fem-btn-primary';
        saveBtn.innerHTML = '<span>⚡</span> <span>Apply & Save Assembly</span>';
        saveBtn.title = 'Persist assembly configuration, update solver nodes, and re-initialize physical model state';
        saveBtn.onclick = () => this.saveAndApply();

        actions.appendChild(revertBtn);
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);

        footer.appendChild(status);
        footer.appendChild(actions);
        return footer;
    }

    // ========================================================================
    // Left Pane (Tabs & Lists)
    // ========================================================================
    private renderTabsAndList(): void {
        if (!this.listPaneEl) return;
        this.listPaneEl.innerHTML = '';

        // Tab Strip
        const tabStrip = document.createElement('div');
        tabStrip.className = 'fem-tab-strip';

        const addTab = (tab: SetupTab, label: string, icon: string, count: number) => {
            const btn = document.createElement('button');
            btn.className = `fem-tab-btn ${this.activeTab === tab ? 'active' : ''}`;
            btn.innerHTML = `<span class="fem-tab-icon">${icon}</span> <span>${label}</span> <span class="fem-tab-count">${count}</span>`;
            btn.onclick = () => {
                this.activeTab = tab;
                this.renderTabsAndList();
                this.renderInspector();
            };
            tabStrip.appendChild(btn);
        };

        addTab('parts', 'Parts', '🧩', this.config.parts.length);
        addTab('sets', 'Sets', '🏷️', this.config.sets.length);
        addTab('materials', 'Materials', '🧪', this.config.materials.length + this.getCanvasMaterials().length);
        addTab('bcs', 'Fixity / BCs', '⚓', this.config.boundary_conditions.length);
        addTab('contacts', 'Contacts', '🤝', this.config.contacts.length);

        this.listPaneEl.appendChild(tabStrip);

        // Search & Sub-toolbar
        const subToolbar = document.createElement('div');
        subToolbar.className = 'fem-list-toolbar';

        const search = document.createElement('input');
        search.type = 'text';
        search.className = 'fem-search-input';
        search.placeholder = `Search ${this.activeTab}...`;
        search.value = this.searchQuery;
        search.oninput = () => {
            this.searchQuery = search.value.toLowerCase().trim();
            this.renderListContent(listContainer);
        };
        subToolbar.appendChild(search);

        this.listPaneEl.appendChild(subToolbar);

        // List Container
        const listContainer = document.createElement('div');
        listContainer.className = 'fem-list-container';
        this.renderListContent(listContainer);
        this.listPaneEl.appendChild(listContainer);
    }

    private renderListContent(container: HTMLElement): void {
        container.innerHTML = '';

        if (this.activeTab === 'parts') {
            this.renderPartsList(container);
        } else if (this.activeTab === 'sets') {
            this.renderSetsList(container);
        } else if (this.activeTab === 'materials') {
            this.renderMaterialsList(container);
        } else if (this.activeTab === 'bcs') {
            this.renderBCsList(container);
        } else if (this.activeTab === 'contacts') {
            this.renderContactsList(container);
        }
    }

    // --- Tab 1: Parts List ---
    private renderPartsList(container: HTMLElement): void {
        const parts = this.config.parts.filter(p =>
            !this.searchQuery ||
            p.name.toLowerCase().includes(this.searchQuery) ||
            String(p.part_id).includes(this.searchQuery)
        );

        if (parts.length === 0) {
            container.innerHTML = `<div class="fem-empty-state">No components match your search.</div>`;
            return;
        }

        // Quick bulk actions bar
        const bulkBar = document.createElement('div');
        bulkBar.className = 'fem-bulk-actions-bar';

        const showAllBtn = document.createElement('button');
        showAllBtn.className = 'fem-mini-btn';
        showAllBtn.textContent = '👁 Show All';
        showAllBtn.onclick = () => {
            this.config.parts.forEach(p => { p.visible = true; });
            this.isDirty = true;
            this.renderListContent(container);
            this.requestRender();
        };

        const invertVisBtn = document.createElement('button');
        invertVisBtn.className = 'fem-mini-btn';
        invertVisBtn.textContent = '🔄 Invert';
        invertVisBtn.onclick = () => {
            this.config.parts.forEach(p => { p.visible = !p.visible; });
            this.isDirty = true;
            this.renderListContent(container);
            this.requestRender();
        };

        const unsuppressAllBtn = document.createElement('button');
        unsuppressAllBtn.className = 'fem-mini-btn';
        unsuppressAllBtn.textContent = '✅ Unsuppress All';
        unsuppressAllBtn.onclick = () => {
            this.config.parts.forEach(p => { p.suppressed = false; });
            this.isDirty = true;
            this.renderListContent(container);
            this.requestRender();
        };

        const newPartBtn = document.createElement('button');
        newPartBtn.className = 'fem-mini-btn primary';
        newPartBtn.innerHTML = '<span>➕</span> <span>New Part</span>';
        newPartBtn.title = 'Create a new independent component part';
        newPartBtn.onclick = () => this.createNewCustomPart();

        bulkBar.appendChild(showAllBtn);
        bulkBar.appendChild(invertVisBtn);
        bulkBar.appendChild(unsuppressAllBtn);
        bulkBar.appendChild(newPartBtn);
        container.appendChild(bulkBar);

        // List items
        for (const part of parts) {
            const item = document.createElement('div');
            item.className = `fem-list-item ${this.selectedPartId === part.part_id ? 'selected' : ''} ${part.suppressed ? 'suppressed' : ''}`;

            item.onclick = (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return;
                this.selectedPartId = part.part_id;
                this.renderListContent(container);
                this.renderInspector();
                this.requestRender();
            };

            // Double click focuses camera on part
            item.ondblclick = () => {
                this.focusOnPart(part);
            };

            // Visibility Eye Toggle
            const eyeBtn = document.createElement('button');
            eyeBtn.className = `fem-icon-btn ${part.visible ? 'visible' : 'hidden'}`;
            eyeBtn.innerHTML = part.visible ? '👁' : '🚫';
            eyeBtn.title = part.visible ? 'Hide Part' : 'Show Part';
            eyeBtn.onclick = (e) => {
                e.stopPropagation();
                part.visible = !part.visible;
                this.isDirty = true;
                this.renderListContent(container);
                this.requestRender();
            };
            item.appendChild(eyeBtn);

            // Color Chip
            const colorChip = document.createElement('div');
            colorChip.className = 'fem-color-chip';
            colorChip.style.backgroundColor = part.color;
            item.appendChild(colorChip);

            // Part Info Box
            const info = document.createElement('div');
            info.className = 'fem-item-info';

            const titleRow = document.createElement('div');
            titleRow.className = 'fem-item-title-row';

            const name = document.createElement('span');
            name.className = 'fem-item-name';
            name.textContent = `PID ${part.part_id}: ${part.name}`;

            const badge = document.createElement('span');
            badge.className = `fem-badge ${part.section_type.toLowerCase()}`;
            badge.textContent = part.section_type;

            titleRow.appendChild(name);
            titleRow.appendChild(badge);

            const detailsRow = document.createElement('div');
            detailsRow.className = 'fem-item-details-row';
            detailsRow.innerHTML = `
                <span>${part.num_elements.toLocaleString()} elems</span> ·
                <span>${part.num_nodes.toLocaleString()} nodes</span> ·
                <span class="fem-mat-tag">${this.formatMaterialLabel(part.material_assignment)}</span>
            `;

            info.appendChild(titleRow);
            info.appendChild(detailsRow);
            item.appendChild(info);

            // Suppressed badge / toggle
            const supToggle = document.createElement('input');
            supToggle.type = 'checkbox';
            supToggle.checked = !part.suppressed;
            supToggle.className = 'fem-checkbox';
            supToggle.title = part.suppressed ? 'Suppressed (Omitted from solve)' : 'Active (Included in solve)';
            supToggle.onchange = (e) => {
                e.stopPropagation();
                part.suppressed = !supToggle.checked;
                this.isDirty = true;
                this.renderListContent(container);
                this.renderInspector();
                this.requestRender();
            };
            item.appendChild(supToggle);

            container.appendChild(item);
        }
    }

    // --- Tab 2: Sets List ---
    private renderSetsList(container: HTMLElement): void {
        const sets = this.config.sets.filter(s =>
            !this.searchQuery ||
            s.name.toLowerCase().includes(this.searchQuery) ||
            String(s.set_id).includes(this.searchQuery)
        );

        // Add Set wizard button
        const addBar = document.createElement('div');
        addBar.className = 'fem-bulk-actions-bar';

        const addSetBtn = document.createElement('button');
        addSetBtn.className = 'fem-mini-btn primary';
        addSetBtn.innerHTML = '<span>➕</span> <span>Create Geometric Set...</span>';
        addSetBtn.onclick = () => this.openCreateSetWizard();
        addBar.appendChild(addSetBtn);

        container.appendChild(addBar);

        if (sets.length === 0) {
            container.innerHTML += `<div class="fem-empty-state">No entity sets defined. Click "+ Create Geometric Set" to select nodes on a boundary plane or bounding box.</div>`;
            return;
        }

        for (const set of sets) {
            const item = document.createElement('div');
            item.className = `fem-list-item ${this.selectedSetId === set.set_id ? 'selected' : ''}`;
            item.onclick = () => {
                this.selectedSetId = set.set_id;
                this.renderListContent(container);
                this.renderInspector();
                this.requestRender();
            };

            const icon = document.createElement('span');
            icon.className = 'fem-set-icon';
            icon.textContent = set.set_type === 'NODE' ? '📍' : (set.set_type === 'PART' ? '📦' : '🔺');
            item.appendChild(icon);

            const info = document.createElement('div');
            info.className = 'fem-item-info';

            const titleRow = document.createElement('div');
            titleRow.className = 'fem-item-title-row';

            const name = document.createElement('span');
            name.className = 'fem-item-name';
            name.textContent = `SID ${set.set_id}: ${set.name}`;

            const badge = document.createElement('span');
            badge.className = 'fem-badge';
            badge.textContent = `${set.set_type}_SET`;

            titleRow.appendChild(name);
            titleRow.appendChild(badge);

            const detailsRow = document.createElement('div');
            detailsRow.className = 'fem-item-details-row';
            detailsRow.innerHTML = `
                <span>${set.entity_ids.length.toLocaleString()} entities</span> ·
                <span style="color: #64748b;">Source: ${set.source}</span>
            `;

            info.appendChild(titleRow);
            info.appendChild(detailsRow);
            item.appendChild(info);

            // Delete Set button
            const delBtn = document.createElement('button');
            delBtn.className = 'fem-icon-btn danger';
            delBtn.innerHTML = '🗑️';
            delBtn.title = 'Delete Set';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Delete set "${set.name}"?`)) {
                    this.config.sets = this.config.sets.filter(s => s.set_id !== set.set_id);
                    if (this.selectedSetId === set.set_id) this.selectedSetId = null;
                    this.isDirty = true;
                    this.renderListContent(container);
                    this.renderInspector();
                    this.requestRender();
                }
            };
            item.appendChild(delBtn);

            container.appendChild(item);
        }
    }

    // --- Tab 3: Materials List ---
    private renderMaterialsList(container: HTMLElement): void {
        const canvasMats = this.getCanvasMaterials();

        // Section A: Canvas Material Nodes (Live Connected)
        const canvasHeader = document.createElement('div');
        canvasHeader.className = 'fem-section-subhead';
        canvasHeader.innerHTML = `<span>⚡ Connected Canvas Material Nodes (${canvasMats.length})</span>`;
        container.appendChild(canvasHeader);

        if (canvasMats.length === 0) {
            const emptyNotice = document.createElement('div');
            emptyNotice.className = 'fem-empty-state-small';
            emptyNotice.textContent = 'No Material nodes currently wired on the canvas. You can add JohnsonCook, Concrete, or Elastic material nodes to the graph.';
            container.appendChild(emptyNotice);
        } else {
            for (const cMat of canvasMats) {
                const item = document.createElement('div');
                item.className = 'fem-list-item material';

                const icon = document.createElement('span');
                icon.textContent = '🔬';
                item.appendChild(icon);

                const info = document.createElement('div');
                info.className = 'fem-item-info';

                const titleRow = document.createElement('div');
                titleRow.className = 'fem-item-title-row';
                titleRow.innerHTML = `<span class="fem-item-name">${cMat.name}</span> <span class="fem-badge canvas">CANVAS</span>`;

                const detailsRow = document.createElement('div');
                detailsRow.className = 'fem-item-details-row';
                const assignedCount = this.config.parts.filter(p => p.material_assignment === cMat.id).length;
                detailsRow.innerHTML = `<span>${cMat.model_type}</span> · <span style="color: #38bdf8;">Assigned to ${assignedCount} parts</span>`;

                info.appendChild(titleRow);
                info.appendChild(detailsRow);
                item.appendChild(info);

                // Quick Apply button
                const applyBtn = document.createElement('button');
                applyBtn.className = 'fem-mini-btn';
                applyBtn.textContent = 'Assign...';
                applyBtn.onclick = () => {
                    this.openAssignMaterialDialog(cMat.id, cMat.name);
                };
                item.appendChild(applyBtn);

                container.appendChild(item);
            }
        }

        // Section B: Deck / Model Embedded Materials
        const deckHeader = document.createElement('div');
        deckHeader.className = 'fem-section-subhead';
        deckHeader.style.marginTop = '16px';
        deckHeader.style.display = 'flex';
        deckHeader.style.justifyContent = 'space-between';
        deckHeader.style.alignItems = 'center';
        deckHeader.innerHTML = `<span>📄 Imported / Custom Materials (${this.config.materials.length})</span>`;

        const newMatBtn = document.createElement('button');
        newMatBtn.className = 'fem-mini-btn primary';
        newMatBtn.innerHTML = '<span>➕</span> <span>New Material</span>';
        newMatBtn.title = 'Create a new constitutive material definition';
        newMatBtn.onclick = () => this.createNewMaterial();
        deckHeader.appendChild(newMatBtn);

        container.appendChild(deckHeader);

        for (const dMat of this.config.materials) {
            const item = document.createElement('div');
            item.className = `fem-list-item material ${this.selectedMatId === dMat.mat_id ? 'selected' : ''}`;
            item.onclick = () => {
                this.selectedMatId = dMat.mat_id;
                this.renderListContent(container);
                this.renderInspector();
            };

            const icon = document.createElement('span');
            icon.textContent = '🧪';
            item.appendChild(icon);

            const info = document.createElement('div');
            info.className = 'fem-item-info';

            const titleRow = document.createElement('div');
            titleRow.className = 'fem-item-title-row';
            titleRow.innerHTML = `<span class="fem-item-name">MID ${dMat.mat_id}: ${dMat.name}</span> <span class="fem-badge">${dMat.model_type}</span>`;

            const detailsRow = document.createElement('div');
            detailsRow.className = 'fem-item-details-row';
            const assignedCount = this.config.parts.filter(p => p.material_assignment === `DECK_MAT_${dMat.mat_id}` || p.material_assignment === String(dMat.mat_id)).length;
            detailsRow.innerHTML = `<span>E: ${(dMat.youngs_modulus / 1e9).toFixed(1)} GPa</span> · <span>rho: ${dMat.density.toFixed(0)} kg/m³</span> · <span>${assignedCount} parts</span>`;

            info.appendChild(titleRow);
            info.appendChild(detailsRow);
            item.appendChild(info);

            container.appendChild(item);
        }
    }

    // --- Tab 4: Boundary Conditions List ---
    private renderBCsList(container: HTMLElement): void {
        const bcs = this.config.boundary_conditions.filter(b =>
            !this.searchQuery ||
            b.name.toLowerCase().includes(this.searchQuery) ||
            b.id.toLowerCase().includes(this.searchQuery)
        );

        // Add BC Toolbar
        const addBar = document.createElement('div');
        addBar.className = 'fem-bulk-actions-bar';

        const addBcBtn = document.createElement('button');
        addBcBtn.className = 'fem-mini-btn primary';
        addBcBtn.innerHTML = '<span>➕</span> <span>Add Boundary Condition...</span>';
        addBcBtn.onclick = () => this.openCreateBCWizard();
        addBar.appendChild(addBcBtn);

        container.appendChild(addBar);

        if (bcs.length === 0) {
            container.innerHTML += `<div class="fem-empty-state">No boundary conditions defined. Click "+ Add Boundary Condition" to constrain nodes (clamped, pinned, roller, symmetry) or apply prescribed velocities.</div>`;
            return;
        }

        for (const bc of bcs) {
            const item = document.createElement('div');
            item.className = `fem-list-item ${this.selectedBCId === bc.id ? 'selected' : ''} ${!bc.active ? 'suppressed' : ''}`;
            item.onclick = () => {
                this.selectedBCId = bc.id;
                this.renderListContent(container);
                this.renderInspector();
                this.requestRender();
            };

            const icon = document.createElement('span');
            icon.className = 'fem-set-icon';
            icon.textContent = bc.bc_type === 'SPC' ? '⚓' : '🚀';
            item.appendChild(icon);

            const info = document.createElement('div');
            info.className = 'fem-item-info';

            const titleRow = document.createElement('div');
            titleRow.className = 'fem-item-title-row';

            const name = document.createElement('span');
            name.className = 'fem-item-name';
            name.textContent = bc.name;

            const badge = document.createElement('span');
            badge.className = 'fem-badge bc';
            badge.textContent = bc.bc_type;

            titleRow.appendChild(name);
            titleRow.appendChild(badge);

            const detailsRow = document.createElement('div');
            detailsRow.className = 'fem-item-details-row';

            // DOFs pill
            const dofStr = ['Tx', 'Ty', 'Tz', 'Rx', 'Ry', 'Rz']
                .map((d, idx) => bc.dofs[idx] ? `<span class="fem-dof-on">${d}</span>` : `<span class="fem-dof-off">${d}</span>`)
                .join(' ');

            detailsRow.innerHTML = `
                <span>Target: ${bc.target_type} (${bc.target_id})</span> ·
                <span class="fem-dof-pills">${dofStr}</span>
            `;

            info.appendChild(titleRow);
            info.appendChild(detailsRow);
            item.appendChild(info);

            // Active toggle
            const activeToggle = document.createElement('input');
            activeToggle.type = 'checkbox';
            activeToggle.checked = bc.active;
            activeToggle.className = 'fem-checkbox';
            activeToggle.title = bc.active ? 'Active BC' : 'Disabled BC';
            activeToggle.onchange = (e) => {
                e.stopPropagation();
                bc.active = activeToggle.checked;
                this.isDirty = true;
                this.renderListContent(container);
                this.renderInspector();
                this.requestRender();
            };
            item.appendChild(activeToggle);

            // Delete BC
            const delBtn = document.createElement('button');
            delBtn.className = 'fem-icon-btn danger';
            delBtn.innerHTML = '🗑️';
            delBtn.title = 'Delete Boundary Condition';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Delete boundary condition "${bc.name}"?`)) {
                    this.config.boundary_conditions = this.config.boundary_conditions.filter(b => b.id !== bc.id);
                    if (this.selectedBCId === bc.id) this.selectedBCId = null;
                    this.isDirty = true;
                    this.renderListContent(container);
                    this.renderInspector();
                    this.requestRender();
                }
            };
            item.appendChild(delBtn);

            container.appendChild(item);
        }
    }

    // --- Tab 5: Contacts List ---
    private renderContactsList(container: HTMLElement): void {
        const contacts = this.config.contacts;

        const addBar = document.createElement('div');
        addBar.className = 'fem-bulk-actions-bar';

        const addContactBtn = document.createElement('button');
        addContactBtn.className = 'fem-mini-btn primary';
        addContactBtn.innerHTML = '<span>➕</span> <span>Add Contact Definition...</span>';
        addContactBtn.onclick = () => this.openCreateContactWizard();
        addBar.appendChild(addContactBtn);

        container.appendChild(addBar);

        if (contacts.length === 0) {
            container.innerHTML += `<div class="fem-empty-state">No explicit contact interfaces defined. The solver will use global default contact penalty and friction.</div>`;
            return;
        }

        for (const c of contacts) {
            const item = document.createElement('div');
            item.className = `fem-list-item ${this.selectedContactId === c.id ? 'selected' : ''}`;
            item.onclick = () => {
                this.selectedContactId = c.id;
                this.renderListContent(container);
                this.renderInspector();
            };

            const icon = document.createElement('span');
            icon.textContent = '🤝';
            item.appendChild(icon);

            const info = document.createElement('div');
            info.className = 'fem-item-info';

            const titleRow = document.createElement('div');
            titleRow.className = 'fem-item-title-row';
            titleRow.innerHTML = `<span class="fem-item-name">${c.name}</span> <span class="fem-badge">${c.contact_type}</span>`;

            const detailsRow = document.createElement('div');
            detailsRow.className = 'fem-item-details-row';
            detailsRow.innerHTML = `<span>Penalty: ${c.penalty_scale}</span> · <span>mu_s: ${c.friction_static}</span> · <span>mu_k: ${c.friction_kinetic}</span>`;

            info.appendChild(titleRow);
            info.appendChild(detailsRow);
            item.appendChild(info);

            container.appendChild(item);
        }
    }

    // ========================================================================
    // Right Pane: Contextual Property Inspector
    // ========================================================================
    private renderInspector(): void {
        if (!this.inspectorPaneEl) return;
        this.inspectorPaneEl.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'fem-inspector-header';
        title.textContent = 'Properties & Setup';
        this.inspectorPaneEl.appendChild(title);

        const content = document.createElement('div');
        content.className = 'fem-inspector-content';
        this.inspectorPaneEl.appendChild(content);

        if (this.activeTab === 'parts') {
            this.renderPartInspector(content);
        } else if (this.activeTab === 'sets') {
            this.renderSetInspector(content);
        } else if (this.activeTab === 'materials') {
            this.renderMaterialInspector(content);
        } else if (this.activeTab === 'bcs') {
            this.renderBCInspector(content);
        } else if (this.activeTab === 'contacts') {
            this.renderContactInspector(content);
        }
    }

    private renderPartInspector(container: HTMLElement): void {
        const part = this.config.parts.find(p => p.part_id === this.selectedPartId);
        if (!part) {
            container.innerHTML = `<div class="fem-empty-state">Select a component part on the left to view and modify its properties.</div>`;
            return;
        }

        const addRow = (label: string, element: HTMLElement) => {
            const row = document.createElement('div');
            row.className = 'fem-inspector-row';
            const lbl = document.createElement('label');
            lbl.className = 'fem-row-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(element);
            container.appendChild(row);
        };

        const linkedNode = part.node_id ? this.model.nodes.find(n => n.id === part.node_id) : null;
        const linkBadge = document.createElement('div');
        linkBadge.style.display = 'flex';
        linkBadge.style.alignItems = 'center';
        linkBadge.style.justifyContent = 'space-between';
        linkBadge.style.marginBottom = '12px';
        linkBadge.style.padding = '8px 10px';
        linkBadge.style.background = 'rgba(56, 189, 248, 0.08)';
        linkBadge.style.border = '1px solid rgba(56, 189, 248, 0.25)';
        linkBadge.style.borderRadius = '6px';
        const entityLabel = linkedNode ? (linkedNode.parameters.name || linkedNode.id) : (part.node_id || `Part ${part.part_id}`);
        const entityType = linkedNode ? linkedNode.type : 'FEM Component';
        linkBadge.innerHTML = `
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #38bdf8;">
                <span>🔗</span>
                <span><strong>Active Model Entity:</strong> ${entityLabel}</span>
            </div>
            <span class="fem-badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; font-size: 10px;">${entityType}</span>
        `;
        container.appendChild(linkBadge);

        // Part Title / Name
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'fem-text-input';
        nameInput.value = part.name;
        nameInput.onchange = () => {
            part.name = nameInput.value.trim() || `Part_${part.part_id}`;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('Part Name', nameInput);

        // Editable Element Formulation Selector
        const secSelect = document.createElement('select');
        secSelect.className = 'fem-select';
        const formOptions: { value: FEMSectionType; label: string }[] = [
            { value: 'SolidHex8', label: 'SolidHex8 (Standard 1-Point Reduced / FB Hourglass)' },
            { value: 'SolidHex8_Full', label: 'SolidHex8_Full (2×2×2 Full Gauss Integration)' },
            { value: 'SolidTet4', label: 'SolidTet4 (4-Node Linear Constant Strain Tet)' },
            { value: 'SolidTet4_ANP', label: 'SolidTet4_ANP (Locking-Free Averaged Nodal Pressure)' },
            { value: 'SolidTet10', label: 'SolidTet10 (10-Node Quadratic Tetrahedron)' },
            { value: 'SolidWedge6', label: 'SolidWedge6 (6-Node Pentahedral Prism / Wedge)' },
            { value: 'Shell4', label: 'Shell4 (4-Node Thin Shell / Belytschko-Tsay / MITC4)' },
            { value: 'Beam3D', label: 'Beam3D (3D Timoshenko / Hughes-Liu Beam with Bending & Torsion)' },
            { value: 'Truss1D', label: 'Truss1D (1D Axial Tension/Compression Truss Only)' }
        ];
        for (const opt of formOptions) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            secSelect.appendChild(el);
        }
        secSelect.value = part.section_type || 'SolidHex8';
        secSelect.onchange = () => {
            part.section_type = secSelect.value as FEMSectionType;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
            this.requestRender();
        };
        addRow('Formulation', secSelect);

        // CAD Color Picker
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.className = 'fem-color-picker';
        colorPicker.value = part.color;
        colorPicker.oninput = () => {
            part.color = colorPicker.value;
            this.isDirty = true;
            this.renderTabsAndList();
            this.requestRender();
        };
        addRow('Display Color', colorPicker);

        // 📦 Geometry & Spatial Placement Section
        const geoHeader = document.createElement('div');
        geoHeader.className = 'fem-subheading';
        geoHeader.textContent = '📦 Geometry & Spatial Placement';
        container.appendChild(geoHeader);

        // Shape Type Selector
        const shapeSelect = document.createElement('select');
        shapeSelect.className = 'fem-select';
        const shapeOpts = [
            { value: 'LS-DYNA File', label: 'LS-DYNA Keyword Mesh (*.k)' },
            { value: 'Box', label: 'Box / Block' },
            { value: 'Cylinder', label: 'Cylinder / Rod' },
            { value: 'Plate', label: 'Plate / Shell Surface' },
            { value: 'Beam', label: 'Beam / 1D Truss' }
        ];
        shapeOpts.forEach(so => {
            const opt = document.createElement('option');
            opt.value = so.value;
            opt.textContent = so.label;
            shapeSelect.appendChild(opt);
        });
        const currentShape = part.shape_type || (part.section_type === 'Beam3D' || part.section_type === 'Truss1D' ? 'Beam' : (part.section_type === 'Shell4' ? 'Plate' : 'Box'));
        shapeSelect.value = currentShape;
        shapeSelect.onchange = () => {
            part.shape_type = shapeSelect.value as any;
            if (part.shape_type === 'LS-DYNA File') {
                if (!part.k_file) part.k_file = 'concrete_cubicle_30mm.k';
                const meta = getLSDynaDeckMeta(part.k_file);
                if (meta) {
                    part.num_elements = meta.totalElements;
                    part.num_nodes = meta.numNodes;
                    part.bounds = meta.bounds;
                    part.size_x = meta.bounds[1] - meta.bounds[0];
                    part.size_y = meta.bounds[3] - meta.bounds[2];
                    part.size_z = meta.bounds[5] - meta.bounds[4];
                }
            } else if (part.shape_type === 'Plate' && !part.section_type?.startsWith('Shell')) {
                part.section_type = 'Shell4';
            } else if (part.shape_type === 'Beam' && part.section_type !== 'Beam3D' && part.section_type !== 'Truss1D') {
                part.section_type = 'Beam3D';
            } else if (part.shape_type === 'Box' && (part.section_type === 'Beam3D' || part.section_type === 'Truss1D' || part.section_type === 'Shell4')) {
                part.section_type = 'SolidHex8';
            }
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
            this.rebuildPreview();
        };
        addRow('Shape Type', shapeSelect);

        // LS-DYNA Keyword Deck Dedicated Inspector Card
        if (currentShape === 'LS-DYNA File') {
            const dynaCard = document.createElement('div');
            dynaCard.className = 'fem-property-card';
            dynaCard.style.padding = '10px 12px';
            dynaCard.style.marginBottom = '12px';
            dynaCard.style.background = 'rgba(15, 23, 42, 0.6)';
            dynaCard.style.border = '1px solid rgba(56, 189, 248, 0.3)';
            dynaCard.style.borderRadius = '6px';

            const activeBuf = this.findActiveFEMBuffer();
            const statusLabel = activeBuf ? '⚡ Active Simulation Mesh (Live Telemetry FEM3)' : '📁 LS-DYNA Keyword File (*.k)';
            const statusColor = activeBuf ? '#10b981' : '#38bdf8';
            const kName = part.k_file || 'concrete_cubicle_30mm.k';

            dynaCard.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-weight: 600; font-size: 11px; color: #f1f5f9;">LS-DYNA Mesh Source</span>
                    <span class="fem-badge" style="background: rgba(56, 189, 248, 0.15); color: ${statusColor}; font-size: 10px;">${statusLabel}</span>
                </div>
                <div style="font-size: 11px; color: #94a3b8; margin-bottom: 6px;">
                    <strong>Keyword Deck:</strong> <span style="color: #f1f5f9; font-family: monospace;">${kName}</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; color: #94a3b8; background: rgba(0,0,0,0.25); padding: 8px; border-radius: 4px; margin-bottom: 8px;">
                    <div>Elements: <strong style="color: #38bdf8;">${(part.num_elements || this.preview?.elements.length || 0).toLocaleString()}</strong></div>
                    <div>Nodes: <strong style="color: #38bdf8;">${(part.num_nodes || (this.preview?.nodeCoords ? Math.floor(this.preview.nodeCoords.length / 3) : 0)).toLocaleString()}</strong></div>
                    <div>Formulation: <strong style="color: #f59e0b;">${part.section_type}</strong></div>
                    <div>Span: <strong style="color: #10b981;">${(part.size_x ?? (part.bounds[1] - part.bounds[0])).toFixed(2)} × ${(part.size_y ?? (part.bounds[3] - part.bounds[2])).toFixed(2)} × ${(part.size_z ?? (part.bounds[5] - part.bounds[4])).toFixed(2)} m</strong></div>
                </div>
            `;

            const actRow = document.createElement('div');
            actRow.style.display = 'flex';
            actRow.style.gap = '6px';
            actRow.style.marginTop = '6px';

            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'fem-mini-btn';
            refreshBtn.style.flex = '1';
            refreshBtn.innerHTML = '<span>🔄</span> <span>Refresh from Solver</span>';
            refreshBtn.onclick = () => {
                this.initPreview();
                this.renderInspector();
                this.renderTabsAndList();
                this.requestRender();
            };
            actRow.appendChild(refreshBtn);
            dynaCard.appendChild(actRow);
            container.appendChild(dynaCard);

            const scaleInput = document.createElement('input');
            scaleInput.type = 'number';
            scaleInput.step = '0.001';
            scaleInput.value = String(part.scale_factor ?? 1.0);
            scaleInput.className = 'fem-num-input';
            scaleInput.onchange = () => {
                part.scale_factor = Number(scaleInput.value) || 1.0;
                this.isDirty = true;
                this.rebuildPreview();
            };
            addRow('Scale Factor', scaleInput);
        }

        // Spatial Coordinates (Position X, Y, Z)
        const posBox = document.createElement('div');
        posBox.className = 'fem-vector-box';
        const makePosInput = (val: number, key: 'pos_x' | 'pos_y' | 'pos_z', label: string) => {
            const wrap = document.createElement('div');
            wrap.className = 'fem-vec-cell';
            const l = document.createElement('span');
            l.textContent = label;
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = '0.05';
            inp.value = String(val ?? 0);
            inp.className = 'fem-num-input';
            const handlePos = () => {
                part[key] = Number(inp.value) || 0;
                this.isDirty = true;
                this.rebuildPreview();
            };
            inp.oninput = handlePos;
            inp.onchange = handlePos;
            wrap.appendChild(l);
            wrap.appendChild(inp);
            return wrap;
        };
        posBox.appendChild(makePosInput(part.pos_x ?? 0, 'pos_x', 'X (m)'));
        posBox.appendChild(makePosInput(part.pos_y ?? 0, 'pos_y', 'Y (m)'));
        posBox.appendChild(makePosInput(part.pos_z ?? 0, 'pos_z', 'Z (m)'));
        addRow('Center / Origin', posBox);

        // Shape-specific Dimensions
        if (currentShape === 'Box' || currentShape === 'Plate') {
            const sizeBox = document.createElement('div');
            sizeBox.className = 'fem-vector-box';
            const makeDimInput = (val: number, key: 'size_x' | 'size_y' | 'size_z', label: string) => {
                const wrap = document.createElement('div');
                wrap.className = 'fem-vec-cell';
                const l = document.createElement('span');
                l.textContent = label;
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.step = '0.05';
                inp.min = '0.001';
                inp.value = String(val ?? 0.1);
                inp.className = 'fem-num-input';
                const handleDim = () => {
                    part[key] = Math.max(0.0001, Number(inp.value) || 0.05);
                    this.isDirty = true;
                    this.rebuildPreview();
                };
                inp.oninput = handleDim;
                inp.onchange = handleDim;
                wrap.appendChild(l);
                wrap.appendChild(inp);
                return wrap;
            };
            sizeBox.appendChild(makeDimInput(part.size_x ?? 0.1, 'size_x', 'Lx (m)'));
            sizeBox.appendChild(makeDimInput(part.size_y ?? 0.1, 'size_y', 'Ly (m)'));
            if (currentShape === 'Box') {
                sizeBox.appendChild(makeDimInput(part.size_z ?? 0.1, 'size_z', 'Lz (m)'));
                addRow('Dimensions (m)', sizeBox);
            } else {
                addRow('Span (m)', sizeBox);
            }
        } else if (currentShape === 'Cylinder') {
            const cylBox = document.createElement('div');
            cylBox.className = 'fem-vector-box';
            const makeCylInput = (val: number, key: 'radius' | 'height', label: string) => {
                const wrap = document.createElement('div');
                wrap.className = 'fem-vec-cell';
                const l = document.createElement('span');
                l.textContent = label;
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.step = '0.01';
                inp.min = '0.001';
                inp.value = String(val ?? (key === 'radius' ? 0.05 : 0.2));
                inp.className = 'fem-num-input';
                const handleCyl = () => {
                    part[key] = Math.max(0.0001, Number(inp.value) || 0.01);
                    this.isDirty = true;
                    this.rebuildPreview();
                };
                inp.oninput = handleCyl;
                inp.onchange = handleCyl;
                wrap.appendChild(l);
                wrap.appendChild(inp);
                return wrap;
            };
            cylBox.appendChild(makeCylInput(part.radius ?? 0.05, 'radius', 'Radius (m)'));
            cylBox.appendChild(makeCylInput(part.height ?? 0.2, 'height', 'Height (m)'));
            addRow('Dimensions (m)', cylBox);
        } else if (currentShape === 'Beam') {
            const p1Box = document.createElement('div');
            p1Box.className = 'fem-vector-box';
            const n1 = part.node1 ?? [part.pos_x ?? 0, part.pos_y ?? 0, part.pos_z ?? 0];
            const n2 = part.node2 ?? [(part.pos_x ?? 0) + (part.size_x ?? 0.5), part.pos_y ?? 0, part.pos_z ?? 0];

            const makeNodeInput = (arr: [number, number, number], idx: number, label: string) => {
                const wrap = document.createElement('div');
                wrap.className = 'fem-vec-cell';
                const l = document.createElement('span');
                l.textContent = label;
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.step = '0.05';
                inp.value = String(arr[idx]);
                inp.className = 'fem-num-input';
                const handleNode = () => {
                    arr[idx] = Number(inp.value) || 0;
                    this.isDirty = true;
                    this.rebuildPreview();
                };
                inp.oninput = handleNode;
                inp.onchange = handleNode;
                wrap.appendChild(l);
                wrap.appendChild(inp);
                return wrap;
            };
            p1Box.appendChild(makeNodeInput(n1, 0, 'X1'));
            p1Box.appendChild(makeNodeInput(n1, 1, 'Y1'));
            p1Box.appendChild(makeNodeInput(n1, 2, 'Z1'));
            part.node1 = n1;
            addRow('Start Point (P1)', p1Box);

            const p2Box = document.createElement('div');
            p2Box.className = 'fem-vector-box';
            p2Box.appendChild(makeNodeInput(n2, 0, 'X2'));
            p2Box.appendChild(makeNodeInput(n2, 1, 'Y2'));
            p2Box.appendChild(makeNodeInput(n2, 2, 'Z2'));
            part.node2 = n2;
            addRow('End Point (P2)', p2Box);
        }

        // Discretization / Mesh Resolution
        const meshBox = document.createElement('div');
        meshBox.className = 'fem-vector-box';
        const makeMeshInput = (val: number, key: 'nx' | 'ny' | 'nz', label: string, maxVal: number = 100) => {
            const wrap = document.createElement('div');
            wrap.className = 'fem-vec-cell';
            const l = document.createElement('span');
            l.textContent = label;
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = '1';
            inp.min = '1';
            inp.max = String(maxVal);
            inp.value = String(val ?? 10);
            inp.className = 'fem-num-input';
            const handleMesh = () => {
                const parsedVal = Math.max(1, Math.min(maxVal, parseInt(inp.value, 10) || 1));
                part[key] = parsedVal;
                if (part.shape_type === 'Box' || !part.shape_type) {
                    part.num_elements = (part.nx ?? 10) * (part.ny ?? 10) * (part.nz ?? 10);
                    part.num_nodes = ((part.nx ?? 10) + 1) * ((part.ny ?? 10) + 1) * ((part.nz ?? 10) + 1);
                } else if (part.shape_type === 'Plate' || part.section_type === 'Shell4') {
                    part.num_elements = (part.nx ?? 10) * (part.ny ?? 10);
                    part.num_nodes = ((part.nx ?? 10) + 1) * ((part.ny ?? 10) + 1);
                }
                this.isDirty = true;
                this.rebuildPreview();
                this.renderTabsAndList();
            };
            inp.oninput = handleMesh;
            inp.onchange = handleMesh;
            wrap.appendChild(l);
            wrap.appendChild(inp);
            return wrap;
        };

        if (currentShape === 'Box') {
            meshBox.appendChild(makeMeshInput(part.nx ?? 10, 'nx', 'Nx (X)', 100));
            meshBox.appendChild(makeMeshInput(part.ny ?? 10, 'ny', 'Ny (Y)', 100));
            meshBox.appendChild(makeMeshInput(part.nz ?? 10, 'nz', 'Nz (Z)', 100));
            addRow('Mesh Discretization', meshBox);
        } else if (currentShape === 'Plate') {
            meshBox.appendChild(makeMeshInput(part.nx ?? 10, 'nx', 'Nx (X)', 100));
            meshBox.appendChild(makeMeshInput(part.ny ?? 10, 'ny', 'Ny (Y)', 100));
            addRow('Mesh Discretization', meshBox);
        } else if (currentShape === 'Cylinder') {
            meshBox.appendChild(makeMeshInput(part.nx ?? 2, 'nx', 'Nr (rad)', 16));
            meshBox.appendChild(makeMeshInput(part.ny ?? 4, 'ny', 'Nθ (circ)', 32));
            meshBox.appendChild(makeMeshInput(part.nz ?? 4, 'nz', 'Nz (ax)', 50));
            addRow('Mesh Discretization', meshBox);
        } else if (currentShape === 'Beam') {
            meshBox.appendChild(makeMeshInput(part.nz ?? 10, 'nz', 'Segments', 100));
            addRow('Mesh Discretization', meshBox);
        }

        // Section Properties Panel tailored to chosen formulation
        if (part.section_type === 'Shell4') {
            const thickInput = document.createElement('input');
            thickInput.type = 'number';
            thickInput.step = '0.001';
            thickInput.value = String(part.section_properties.thickness ?? 0.005);
            thickInput.className = 'fem-num-input';
            thickInput.onchange = () => {
                part.section_properties.thickness = Number(thickInput.value);
                this.isDirty = true;
            };
            addRow('Shell Thickness (m)', thickInput);

            const nipSelect = document.createElement('select');
            nipSelect.className = 'fem-select';
            [1, 2, 3, 5].forEach(n => {
                const o = document.createElement('option');
                o.value = String(n);
                o.textContent = `${n} Gauss points through thickness`;
                nipSelect.appendChild(o);
            });
            nipSelect.value = String(part.section_properties.integration_points ?? 3);
            nipSelect.onchange = () => {
                part.section_properties.integration_points = Number(nipSelect.value);
                this.isDirty = true;
            };
            addRow('Through-Thickness NIP', nipSelect);
        } else if (part.section_type === 'Beam3D') {
            const profileSelect = document.createElement('select');
            profileSelect.className = 'fem-select';
            const profiles: { value: string; label: string }[] = [
                { value: 'Circular_Solid', label: 'Solid Circular Rod / Rebar' },
                { value: 'Circular_Pipe', label: 'Hollow Circular Pipe' },
                { value: 'Rectangular', label: 'Rectangular Bar / Beam' }
            ];
            profiles.forEach(pr => {
                const o = document.createElement('option');
                o.value = pr.value;
                o.textContent = pr.label;
                profileSelect.appendChild(o);
            });
            profileSelect.value = part.section_properties.beam_profile || 'Circular_Solid';
            profileSelect.onchange = () => {
                part.section_properties.beam_profile = profileSelect.value as any;
                this.isDirty = true;
                this.renderInspector();
            };
            addRow('Beam Profile', profileSelect);

            const diamInput = document.createElement('input');
            diamInput.type = 'number';
            diamInput.step = '0.0005';
            diamInput.value = String(part.section_properties.diameter ?? 0.00953);
            diamInput.className = 'fem-num-input';
            diamInput.onchange = () => {
                const d = Number(diamInput.value);
                part.section_properties.diameter = d;
                part.section_properties.area = Math.PI * (d * d) * 0.25;
                part.section_properties.I2 = Math.PI * Math.pow(d, 4) / 64;
                part.section_properties.I3 = part.section_properties.I2;
                part.section_properties.J = 2 * part.section_properties.I2;
                this.isDirty = true;
                this.renderInspector();
            };
            addRow('Diameter (m)', diamInput);

            if (part.section_properties.beam_profile === 'Circular_Pipe') {
                const wallInput = document.createElement('input');
                wallInput.type = 'number';
                wallInput.step = '0.0005';
                wallInput.value = String(part.section_properties.wall_thickness ?? 0.002);
                wallInput.className = 'fem-num-input';
                wallInput.onchange = () => {
                    part.section_properties.wall_thickness = Number(wallInput.value);
                    this.isDirty = true;
                };
                addRow('Wall Thickness (m)', wallInput);
            } else if (part.section_properties.beam_profile === 'Rectangular') {
                const wInput = document.createElement('input');
                wInput.type = 'number';
                wInput.step = '0.005';
                wInput.value = String(part.section_properties.width ?? 0.05);
                wInput.className = 'fem-num-input';
                wInput.onchange = () => {
                    part.section_properties.width = Number(wInput.value);
                    this.isDirty = true;
                };
                addRow('Width b (m)', wInput);

                const hInput = document.createElement('input');
                hInput.type = 'number';
                hInput.step = '0.005';
                hInput.value = String(part.section_properties.height ?? 0.10);
                hInput.className = 'fem-num-input';
                hInput.onchange = () => {
                    part.section_properties.height = Number(hInput.value);
                    this.isDirty = true;
                };
                addRow('Height h (m)', hInput);
            }
        } else if (part.section_type === 'Truss1D') {
            const areaInput = document.createElement('input');
            areaInput.type = 'number';
            areaInput.step = '0.00001';
            const curArea = part.section_properties.area ?? (Math.PI * Math.pow(part.section_properties.diameter ?? 0.00953, 2) * 0.25);
            areaInput.value = String(curArea);
            areaInput.className = 'fem-num-input';
            areaInput.onchange = () => {
                part.section_properties.area = Number(areaInput.value);
                this.isDirty = true;
            };
            addRow('Truss Area (m²)', areaInput);
        } else {
            // Solid formulations
            const hgSelect = document.createElement('select');
            hgSelect.className = 'fem-select';
            const hgOpts = [
                { value: 'Flanagan-Belytschko', label: 'Flanagan-Belytschko Hourglass Control' },
                { value: 'BBar_SRI', label: 'B-bar Selective Reduced Integration (SRI)' },
                { value: 'Standard_Viscous', label: 'Standard Viscous Hourglass Damping' }
            ];
            hgOpts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label;
                hgSelect.appendChild(opt);
            });
            hgSelect.value = part.section_properties.hourglass_type || 'Flanagan-Belytschko';
            hgSelect.onchange = () => {
                part.section_properties.hourglass_type = hgSelect.value as any;
                this.isDirty = true;
            };
            addRow('Hourglass Scheme', hgSelect);

            const qhInput = document.createElement('input');
            qhInput.type = 'number';
            qhInput.step = '0.01';
            qhInput.value = String(part.section_properties.hourglass_coeff ?? 0.10);
            qhInput.className = 'fem-num-input';
            qhInput.onchange = () => {
                part.section_properties.hourglass_coeff = Number(qhInput.value);
                this.isDirty = true;
            };
            addRow('Hourglass Factor qh', qhInput);
        }

        // Material Assignment Dropdown
        const matSelect = document.createElement('select');
        matSelect.className = 'fem-select';

        const defaultOpt = document.createElement('option');
        defaultOpt.value = 'DEFAULT';
        defaultOpt.textContent = 'Inherit Solver Default Material';
        matSelect.appendChild(defaultOpt);

        const canvasMats = this.getCanvasMaterials();
        if (canvasMats.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = '⚡ Canvas Material Nodes';
            for (const cm of canvasMats) {
                const opt = document.createElement('option');
                opt.value = cm.id;
                opt.textContent = `${cm.name} (${cm.model_type})`;
                grp.appendChild(opt);
            }
            matSelect.appendChild(grp);
        }

        if (this.config.materials.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = '📄 Deck / Custom Materials';
            for (const dm of this.config.materials) {
                const opt = document.createElement('option');
                opt.value = `DECK_MAT_${dm.mat_id}`;
                opt.textContent = `MID ${dm.mat_id}: ${dm.name} (${dm.model_type})`;
                grp.appendChild(opt);
            }
            matSelect.appendChild(grp);
        }

        const newMatOpt = document.createElement('option');
        newMatOpt.value = '__CREATE_NEW__';
        newMatOpt.textContent = '➕ Create New Custom Material...';
        matSelect.appendChild(newMatOpt);

        let targetMatVal = part.material_assignment || 'DEFAULT';
        const deckMats = this.config.materials || [];
        if (!matSelect.querySelector(`option[value="${targetMatVal}"]`)) {
            if (targetMatVal.includes('Steel') || targetMatVal.includes('Plasticity') || part.section_type === 'Beam3D' || part.section_type === 'Truss1D') {
                const found = deckMats.find(m => m.name.includes('Steel') || m.model_type.includes('Plasticity') || m.mat_id === 2);
                if (found) targetMatVal = `DECK_MAT_${found.mat_id}`;
            } else if (targetMatVal.includes('Concrete') || (!part.section_type || part.section_type.startsWith('Solid'))) {
                const found = deckMats.find(m => m.name.includes('Concrete') || m.model_type.includes('Concrete') || m.mat_id === 1);
                if (found) targetMatVal = `DECK_MAT_${found.mat_id}`;
            }
        }
        if (!matSelect.querySelector(`option[value="${targetMatVal}"]`)) {
            if (deckMats.length > 0) {
                targetMatVal = `DECK_MAT_${deckMats[0].mat_id}`;
            } else if (canvasMats.length > 0) {
                targetMatVal = canvasMats[0].id;
            }
        }
        matSelect.value = targetMatVal;
        if (part.material_assignment !== targetMatVal && targetMatVal !== 'DEFAULT') {
            part.material_assignment = targetMatVal;
            this.config.material_assignments[part.part_id] = targetMatVal;
        }
        matSelect.onchange = () => {
            if (matSelect.value === '__CREATE_NEW__') {
                const nextId = Math.max(0, ...this.config.materials.map(m => m.mat_id)) + 1;
                const newMat: FEMMaterialDefinition = {
                    mat_id: nextId,
                    name: `${part.name}_Mat`,
                    source: 'user_custom',
                    model_type: 'PiecewiseLinearPlasticity',
                    density: 7850.0,
                    youngs_modulus: 210.0e9,
                    poissons_ratio: 0.30,
                    yield_stress: 400.0e6,
                    hardening_modulus: 1.0e9,
                    failure_strain: 0.25,
                    parameters: {}
                };
                this.config.materials.push(newMat);
                part.material_assignment = `DECK_MAT_${nextId}`;
                this.config.material_assignments[part.part_id] = part.material_assignment;
                this.isDirty = true;
                this.renderTabsAndList();
                this.renderInspector();
                return;
            }
            part.material_assignment = matSelect.value;
            this.config.material_assignments[part.part_id] = matSelect.value;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
            this.requestRender();
        };
        addRow('Material', matSelect);

        // In-Place Material Properties Tuning Card
        const matCard = this.renderInPlaceMaterialCard(part.material_assignment);
        if (matCard) container.appendChild(matCard);

        // Initial Velocity (vx, vy, vz)
        const velBox = document.createElement('div');
        velBox.className = 'fem-vector-box';
        const [vx, vy, vz] = part.initial_velocity;

        const makeVelInput = (val: number, idx: number, label: string) => {
            const wrap = document.createElement('div');
            wrap.className = 'fem-vec-cell';
            const l = document.createElement('span');
            l.textContent = label;
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = '1.0';
            inp.value = String(val);
            inp.className = 'fem-num-input';
            inp.onchange = () => {
                part.initial_velocity[idx] = Number(inp.value) || 0.0;
                this.isDirty = true;
                this.requestRender();
            };
            wrap.appendChild(l);
            wrap.appendChild(inp);
            return wrap;
        };

        velBox.appendChild(makeVelInput(vx, 0, 'Vx'));
        velBox.appendChild(makeVelInput(vy, 1, 'Vy'));
        velBox.appendChild(makeVelInput(vz, 2, 'Vz'));
        addRow('Initial Vel (m/s)', velBox);

        // Erosion / Failure Override Section
        const erosionHeader = document.createElement('div');
        erosionHeader.className = 'fem-subheading';
        erosionHeader.textContent = 'Failure & Erosion Overrides';
        container.appendChild(erosionHeader);

        const failStrainInput = document.createElement('input');
        failStrainInput.type = 'number';
        failStrainInput.step = '0.05';
        failStrainInput.placeholder = 'e.g. 0.35 (leave blank for default)';
        failStrainInput.value = part.erosion_override?.failure_strain !== undefined ? String(part.erosion_override.failure_strain) : '';
        failStrainInput.className = 'fem-num-input';
        failStrainInput.onchange = () => {
            if (!part.erosion_override) part.erosion_override = {};
            const val = failStrainInput.value.trim();
            if (val === '') {
                delete part.erosion_override.failure_strain;
            } else {
                part.erosion_override.failure_strain = Number(val);
            }
            this.isDirty = true;
        };
        addRow('Failure Strain', failStrainInput);

        const mpmConvertCheck = document.createElement('input');
        mpmConvertCheck.type = 'checkbox';
        mpmConvertCheck.className = 'fem-checkbox';
        mpmConvertCheck.checked = part.erosion_override?.convert_to_mpm === true;
        mpmConvertCheck.onchange = () => {
            if (!part.erosion_override) part.erosion_override = {};
            part.erosion_override.convert_to_mpm = mpmConvertCheck.checked;
            this.isDirty = true;
        };
        addRow('Failed Elem -> MPM Debris', mpmConvertCheck);
    }

    private renderSetInspector(container: HTMLElement): void {
        const set = this.config.sets.find(s => s.set_id === this.selectedSetId);
        if (!set) {
            container.innerHTML = `<div class="fem-empty-state">Select an entity set on the left to inspect and modify.</div>`;
            return;
        }

        const addRow = (label: string, element: HTMLElement) => {
            const row = document.createElement('div');
            row.className = 'fem-inspector-row';
            const lbl = document.createElement('label');
            lbl.className = 'fem-row-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(element);
            container.appendChild(row);
        };

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'fem-text-input';
        nameInput.value = set.name;
        nameInput.onchange = () => {
            set.name = nameInput.value.trim() || `Set_${set.set_id}`;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('Set Name', nameInput);

        const typeSelect = document.createElement('select');
        typeSelect.className = 'fem-select';
        ['NODE', 'SOLID', 'SEGMENT', 'BEAM', 'PART'].forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = `${t} Set (${set.entity_ids.length.toLocaleString()} entities)`;
            typeSelect.appendChild(opt);
        });
        typeSelect.value = set.set_type;
        typeSelect.onchange = () => {
            set.set_type = typeSelect.value as any;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
        };
        addRow('Entity Type', typeSelect);

        const sourceLabel = document.createElement('div');
        sourceLabel.className = 'fem-readonly-badge';
        sourceLabel.textContent = set.source;
        addRow('Origin', sourceLabel);

        // Group / Set Formulation Override
        const formSelect = document.createElement('select');
        formSelect.className = 'fem-select';
        const formOptions: { value: string; label: string }[] = [
            { value: '', label: 'Inherit From Assigned Part' },
            { value: 'SolidHex8', label: 'SolidHex8 (Standard Hex8)' },
            { value: 'SolidHex8_Full', label: 'SolidHex8_Full (2×2×2 Integration)' },
            { value: 'SolidTet4', label: 'SolidTet4 (Linear Tetrahedron)' },
            { value: 'SolidTet4_ANP', label: 'SolidTet4_ANP (Locking-Free Tet)' },
            { value: 'SolidTet10', label: 'SolidTet10 (Quadratic Tetrahedron)' },
            { value: 'SolidWedge6', label: 'SolidWedge6 (6-Node Wedge)' },
            { value: 'Shell4', label: 'Shell4 (Thin Shell)' },
            { value: 'Beam3D', label: 'Beam3D (Slender Beam)' },
            { value: 'Truss1D', label: 'Truss1D (Axial Truss)' }
        ];
        formOptions.forEach(fo => {
            const opt = document.createElement('option');
            opt.value = fo.value;
            opt.textContent = fo.label;
            formSelect.appendChild(opt);
        });
        formSelect.value = set.section_type || '';
        formSelect.onchange = () => {
            set.section_type = (formSelect.value || undefined) as any;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
        };
        addRow('Formulation Override', formSelect);

        // Group / Set Material Assignment
        const matSelect = document.createElement('select');
        matSelect.className = 'fem-select';
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = 'Inherit From Assigned Part';
        matSelect.appendChild(defOpt);

        const canvasMats = this.getCanvasMaterials();
        if (canvasMats.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = '⚡ Canvas Material Nodes';
            for (const cm of canvasMats) {
                const opt = document.createElement('option');
                opt.value = cm.id;
                opt.textContent = `${cm.name} (${cm.model_type})`;
                grp.appendChild(opt);
            }
            matSelect.appendChild(grp);
        }

        if (this.config.materials.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = '📄 Deck / Custom Materials';
            for (const dm of this.config.materials) {
                const opt = document.createElement('option');
                opt.value = `DECK_MAT_${dm.mat_id}`;
                opt.textContent = `MID ${dm.mat_id}: ${dm.name} (${dm.model_type})`;
                grp.appendChild(opt);
            }
            matSelect.appendChild(grp);
        }

        matSelect.value = set.material_assignment || '';
        matSelect.onchange = () => {
            set.material_assignment = matSelect.value || undefined;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('Material Override', matSelect);

        // If plane filter, allow editing plane tolerance or plane coordinate
        if (set.filter_params && set.filter_params.plane) {
            const planeInfo = document.createElement('div');
            planeInfo.className = 'fem-readonly-badge';
            planeInfo.textContent = `Plane: ${set.filter_params.plane} (Coord: ${set.filter_params.plane_coord?.toFixed(4)}, Tol: ${set.filter_params.tolerance})`;
            addRow('Filter Parameters', planeInfo);
        }

        // Action Buttons Box
        const btnBox = document.createElement('div');
        btnBox.style.display = 'flex';
        btnBox.style.flexDirection = 'column';
        btnBox.style.gap = '8px';
        btnBox.style.marginTop = '16px';

        // Convert to Independent Part
        const convertBtn = document.createElement('button');
        convertBtn.className = 'fem-btn fem-btn-primary';
        convertBtn.innerHTML = '<span>🚀</span> <span>Convert Set to Independent Component / Part</span>';
        convertBtn.title = 'Convert this group/set of elements into an independent Part with its own section, color, and material';
        convertBtn.onclick = () => this.convertSetToPart(set);
        btnBox.appendChild(convertBtn);

        // Add fixity / BC to this set
        const createBcBtn = document.createElement('button');
        createBcBtn.className = 'fem-btn fem-btn-secondary';
        createBcBtn.innerHTML = '<span>⚓</span> <span>Add Fixity / BC to This Set...</span>';
        createBcBtn.onclick = () => {
            this.activeTab = 'bcs';
            this.openCreateBCWizard(set.set_id);
        };
        btnBox.appendChild(createBcBtn);

        container.appendChild(btnBox);
    }

    private renderMaterialInspector(container: HTMLElement): void {
        const mat = this.config.materials.find(m => m.mat_id === this.selectedMatId);
        if (!mat) {
            container.innerHTML = `<div class="fem-empty-state">Select a material on the left to inspect and modify its constitutive properties, or click "+ Add New Material".</div>`;
            return;
        }

        const addRow = (label: string, element: HTMLElement) => {
            const row = document.createElement('div');
            row.className = 'fem-inspector-row';
            const lbl = document.createElement('label');
            lbl.className = 'fem-row-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(element);
            container.appendChild(row);
        };

        // Material Name
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'fem-text-input';
        nameInput.value = mat.name;
        nameInput.onchange = () => {
            mat.name = nameInput.value.trim() || `Material_${mat.mat_id}`;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('Material Name', nameInput);

        // Constitutive Model Dropdown
        const modelSelect = document.createElement('select');
        modelSelect.className = 'fem-select';
        const models: { value: string; label: string }[] = [
            { value: 'LinearElastic', label: 'Elastic (*MAT_001 / *MAT_ELASTIC)' },
            { value: 'PiecewiseLinearPlasticity', label: 'Piecewise Linear Plasticity (*MAT_024 / von Mises)' },
            { value: 'JohnsonCook', label: 'Johnson-Cook Viscoplasticity (*MAT_015)' },
            { value: 'ConcreteRHT', label: 'Concrete Damage Plasticity (*MAT_CDP / RHT)' },
            { value: 'Hyperelastic', label: 'Hyperelastic (Yeoh / Mooney-Rivlin)' },
            { value: 'RigidBody', label: 'Rigid Body (*MAT_020 / *MAT_RIGID)' }
        ];
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = m.label;
            modelSelect.appendChild(opt);
        });
        modelSelect.value = mat.model_type || 'LinearElastic';
        modelSelect.onchange = () => {
            mat.model_type = modelSelect.value;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
        };
        addRow('Constitutive Model', modelSelect);

        // Mass Density (kg/m³)
        const rhoInput = document.createElement('input');
        rhoInput.type = 'number';
        rhoInput.step = '10';
        rhoInput.value = String(mat.density);
        rhoInput.className = 'fem-num-input';
        rhoInput.onchange = () => {
            mat.density = Number(rhoInput.value) || 7850.0;
            this.isDirty = true;
        };
        addRow('Density (kg/m³)', rhoInput);

        // Young's Modulus (GPa)
        const eInput = document.createElement('input');
        eInput.type = 'number';
        eInput.step = '1.0';
        eInput.value = String((mat.youngs_modulus / 1e9).toFixed(2));
        eInput.className = 'fem-num-input';
        eInput.onchange = () => {
            mat.youngs_modulus = (Number(eInput.value) || 210.0) * 1e9;
            this.isDirty = true;
        };
        addRow('Young\'s Modulus (GPa)', eInput);

        // Poisson's Ratio
        const nuInput = document.createElement('input');
        nuInput.type = 'number';
        nuInput.step = '0.01';
        nuInput.value = String(mat.poissons_ratio.toFixed(3));
        nuInput.className = 'fem-num-input';
        nuInput.onchange = () => {
            mat.poissons_ratio = Number(nuInput.value) || 0.30;
            this.isDirty = true;
        };
        addRow('Poisson\'s Ratio', nuInput);

        // Yield Stress (MPa)
        const sigyInput = document.createElement('input');
        sigyInput.type = 'number';
        sigyInput.step = '10';
        sigyInput.value = String(((mat.yield_stress ?? 400e6) / 1e6).toFixed(1));
        sigyInput.className = 'fem-num-input';
        sigyInput.onchange = () => {
            mat.yield_stress = (Number(sigyInput.value) || 400.0) * 1e6;
            this.isDirty = true;
        };
        addRow('Yield Stress (MPa)', sigyInput);

        // Hardening Modulus (GPa)
        const etanInput = document.createElement('input');
        etanInput.type = 'number';
        etanInput.step = '0.1';
        etanInput.value = String(((mat.hardening_modulus ?? 1.0e9) / 1e9).toFixed(2));
        etanInput.className = 'fem-num-input';
        etanInput.onchange = () => {
            mat.hardening_modulus = (Number(etanInput.value) || 1.0) * 1e9;
            this.isDirty = true;
        };
        addRow('Hardening Modulus (GPa)', etanInput);

        // Failure Plastic Strain
        const failInput = document.createElement('input');
        failInput.type = 'number';
        failInput.step = '0.01';
        failInput.value = String((mat.failure_strain ?? 0.25).toFixed(2));
        failInput.className = 'fem-num-input';
        failInput.onchange = () => {
            mat.failure_strain = Number(failInput.value) || 0.25;
            this.isDirty = true;
        };
        addRow('Plastic Failure Strain', failInput);

        // Action buttons
        const actionBox = document.createElement('div');
        actionBox.style.display = 'flex';
        actionBox.style.gap = '8px';
        actionBox.style.marginTop = '16px';

        const assignBtn = document.createElement('button');
        assignBtn.className = 'fem-btn fem-btn-primary';
        assignBtn.style.flex = '1';
        assignBtn.textContent = 'Assign Material to Parts...';
        assignBtn.onclick = () => {
            this.openAssignMaterialDialog(`DECK_MAT_${mat.mat_id}`, mat.name);
        };
        actionBox.appendChild(assignBtn);

        const dupBtn = document.createElement('button');
        dupBtn.className = 'fem-btn fem-btn-secondary';
        dupBtn.textContent = '📋 Duplicate';
        dupBtn.title = 'Create a copy of this material';
        dupBtn.onclick = () => {
            this.duplicateMaterial(mat);
        };
        actionBox.appendChild(dupBtn);

        container.appendChild(actionBox);
    }

    private renderBCInspector(container: HTMLElement): void {
        const bc = this.config.boundary_conditions.find(b => b.id === this.selectedBCId);
        if (!bc) {
            container.innerHTML = `<div class="fem-empty-state">Select a boundary condition on the left to configure fixity DOFs or velocity constraints.</div>`;
            return;
        }

        const addRow = (label: string, element: HTMLElement) => {
            const row = document.createElement('div');
            row.className = 'fem-inspector-row';
            const lbl = document.createElement('label');
            lbl.className = 'fem-row-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(element);
            container.appendChild(row);
        };

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'fem-text-input';
        nameInput.value = bc.name;
        nameInput.onchange = () => {
            bc.name = nameInput.value.trim() || bc.id;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('BC Name', nameInput);

        const typeSelect = document.createElement('select');
        typeSelect.className = 'fem-select';
        typeSelect.innerHTML = `
            <option value="SPC">Single Point Constraint (SPC Fixity)</option>
            <option value="PRESCRIBED_VELOCITY">Prescribed Velocity</option>
            <option value="NON_REFLECTING">Non-Reflecting Absorbing Boundary</option>
        `;
        typeSelect.value = bc.bc_type;
        typeSelect.onchange = () => {
            bc.bc_type = typeSelect.value as any;
            this.isDirty = true;
            this.renderTabsAndList();
            this.renderInspector();
            this.requestRender();
        };
        addRow('Constraint Type', typeSelect);

        // DOFs matrix buttons
        const dofContainer = document.createElement('div');
        dofContainer.className = 'fem-dof-btn-grid';

        const dofLabels = ['Tx (Ux = 0)', 'Ty (Uy = 0)', 'Tz (Uz = 0)', 'Rx (RotX = 0)', 'Ry (RotY = 0)', 'Rz (RotZ = 0)'];
        dofLabels.forEach((label, idx) => {
            const btn = document.createElement('button');
            btn.className = `fem-dof-toggle-btn ${bc.dofs[idx] ? 'active' : ''}`;
            btn.textContent = label;
            btn.onclick = () => {
                bc.dofs[idx] = !bc.dofs[idx];
                btn.className = `fem-dof-toggle-btn ${bc.dofs[idx] ? 'active' : ''}`;
                this.isDirty = true;
                this.renderTabsAndList();
                this.requestRender();
            };
            dofContainer.appendChild(btn);
        });
        addRow('Constrained DOFs', dofContainer);

        // Quick Presets Bar
        const presetBar = document.createElement('div');
        presetBar.className = 'fem-btn-group';
        presetBar.style.marginTop = '8px';

        const addPreset = (title: string, dofs: [boolean, boolean, boolean, boolean, boolean, boolean]) => {
            const pBtn = document.createElement('button');
            pBtn.className = 'fem-mini-btn';
            pBtn.textContent = title;
            pBtn.onclick = () => {
                bc.dofs = [...dofs];
                this.isDirty = true;
                this.renderTabsAndList();
                this.renderInspector();
                this.requestRender();
            };
            presetBar.appendChild(pBtn);
        };

        addPreset('Clamped (All)', [true, true, true, true, true, true]);
        addPreset('Pinned', [true, true, true, false, false, false]);
        addPreset('Roller Z', [false, false, true, false, false, false]);
        addPreset('Symm X', [true, false, false, false, true, true]);
        addPreset('Symm Y', [false, true, false, true, false, true]);
        container.appendChild(presetBar);

        // If Prescribed Velocity
        if (bc.bc_type === 'PRESCRIBED_VELOCITY') {
            const velBox = document.createElement('div');
            velBox.className = 'fem-vector-box';
            if (!bc.velocity) bc.velocity = [0, 0, 0];

            const makeVelInput = (val: number, idx: number, label: string) => {
                const wrap = document.createElement('div');
                wrap.className = 'fem-vec-cell';
                const l = document.createElement('span');
                l.textContent = label;
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.step = '1.0';
                inp.value = String(val);
                inp.className = 'fem-num-input';
                inp.onchange = () => {
                    if (bc.velocity) bc.velocity[idx] = Number(inp.value) || 0.0;
                    this.isDirty = true;
                    this.requestRender();
                };
                wrap.appendChild(l);
                wrap.appendChild(inp);
                return wrap;
            };

            velBox.appendChild(makeVelInput(bc.velocity[0], 0, 'Vx'));
            velBox.appendChild(makeVelInput(bc.velocity[1], 1, 'Vy'));
            velBox.appendChild(makeVelInput(bc.velocity[2], 2, 'Vz'));
            addRow('Prescribed Vel (m/s)', velBox);
        }
    }

    private renderContactInspector(container: HTMLElement): void {
        const contact = this.config.contacts.find(c => c.id === this.selectedContactId);
        if (!contact) {
            container.innerHTML = `<div class="fem-empty-state">Select a contact definition to configure penalty stiffness and friction coefficients.</div>`;
            return;
        }

        const addRow = (label: string, element: HTMLElement) => {
            const row = document.createElement('div');
            row.className = 'fem-inspector-row';
            const lbl = document.createElement('label');
            lbl.className = 'fem-row-label';
            lbl.textContent = label;
            row.appendChild(lbl);
            row.appendChild(element);
            container.appendChild(row);
        };

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'fem-text-input';
        nameInput.value = contact.name;
        nameInput.onchange = () => {
            contact.name = nameInput.value.trim() || contact.id;
            this.isDirty = true;
            this.renderTabsAndList();
        };
        addRow('Contact Name', nameInput);

        const penaltyInput = document.createElement('input');
        penaltyInput.type = 'number';
        penaltyInput.step = '0.05';
        penaltyInput.value = String(contact.penalty_scale);
        penaltyInput.className = 'fem-num-input';
        penaltyInput.onchange = () => {
            contact.penalty_scale = Math.max(0.01, Number(penaltyInput.value));
            this.isDirty = true;
        };
        addRow('Penalty Scale', penaltyInput);

        const fricStaticInput = document.createElement('input');
        fricStaticInput.type = 'number';
        fricStaticInput.step = '0.05';
        fricStaticInput.value = String(contact.friction_static);
        fricStaticInput.className = 'fem-num-input';
        fricStaticInput.onchange = () => {
            contact.friction_static = Math.max(0.0, Number(fricStaticInput.value));
            this.isDirty = true;
        };
        addRow('Static Friction (mu_s)', fricStaticInput);

        const fricKinInput = document.createElement('input');
        fricKinInput.type = 'number';
        fricKinInput.step = '0.05';
        fricKinInput.value = String(contact.friction_kinetic);
        fricKinInput.className = 'fem-num-input';
        fricKinInput.onchange = () => {
            contact.friction_kinetic = Math.max(0.0, Number(fricKinInput.value));
            this.isDirty = true;
        };
        addRow('Kinetic Friction (mu_k)', fricKinInput);
    }

    // ========================================================================
    // Interactive 3D Canvas Rendering Engine
    // Zero-dependency projection with exploded view and BC glyphs
    // ========================================================================
    private setupCanvasAndAnimation(): void {
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');

        const resize = () => {
            if (!this.canvas) return;
            const rect = this.canvas.getBoundingClientRect();
            this.canvas.width = Math.max(100, Math.floor(rect.width * window.devicePixelRatio));
            this.canvas.height = Math.max(100, Math.floor(rect.height * window.devicePixelRatio));
            this.requestRender();
        };

        window.addEventListener('resize', resize);
        resize();

        // Mouse Drag / Orbit / Pan / Zoom Listeners
        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.isPanning = (e.button === 2 || e.shiftKey);
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            if (this.isPanning) {
                const dpr = window.devicePixelRatio || 1.0;
                this.panOffset[0] += dx * dpr;
                this.panOffset[1] += dy * dpr;
            } else {
                this.cameraTheta -= dx * 0.008;
                this.cameraPhi = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.cameraPhi + dy * 0.008));
            }
            this.requestRender();
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
            this.isPanning = false;
            this.requestRender();
        });


        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
            this.cameraDistance = Math.max(0.01, Math.min(1000.0, this.cameraDistance * zoomFactor));
            this.requestRender();
        }, { passive: false });

        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.requestRender();
    }

    private requestRender(): void {
        if (this.animFrameId !== null) return;
        this.animFrameId = requestAnimationFrame(() => {
            this.animFrameId = null;
            this.renderScene();
        });
    }

    private renderScene(): void {
        if (!this.canvas || !this.ctx || !this.preview) return;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Background Gradient
        const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, 50, w * 0.5, h * 0.5, Math.max(w, h));
        grad.addColorStop(0, '#1a1d26');
        grad.addColorStop(1, '#0c0e14');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Camera Math
        const cosT = Math.cos(this.cameraTheta);
        const sinT = Math.sin(this.cameraTheta);
        const cosP = Math.cos(this.cameraPhi);
        const sinP = Math.sin(this.cameraPhi);

        const eyeX = this.cameraTarget[0] + this.cameraDistance * cosP * sinT;
        const eyeY = this.cameraTarget[1] + this.cameraDistance * cosP * cosT;
        const eyeZ = this.cameraTarget[2] + this.cameraDistance * sinP;

        // View Matrix Vectors (Forward, Right, Up)
        const fx = this.cameraTarget[0] - eyeX;
        const fy = this.cameraTarget[1] - eyeY;
        const fz = this.cameraTarget[2] - eyeZ;
        const flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1.0;
        const nfx = fx / flen;
        const nfy = fy / flen;
        const nfz = fz / flen;

        // Right = Forward x WorldUp (0, 0, 1)
        const rx = nfy;
        const ry = -nfx;
        const rz = 0.0;
        const rlen = Math.sqrt(rx * rx + ry * ry) || 1.0;
        const nrx = rx / rlen;
        const nry = ry / rlen;
        const nrz = 0.0;

        // Up = Right x Forward
        const nux = nry * nfz - nrz * nfy;
        const nuy = nrz * nfx - nrx * nfz;
        const nuz = nrx * nfy - nry * nfx;

        // Projection helper
        const fovScale = (h * 0.5) / Math.tan(Math.PI / 8);
        const project = (x: number, y: number, z: number): [number, number, number] | null => {
            const vx = x - eyeX;
            const vy = y - eyeY;
            const vz = z - eyeZ;

            const depth = vx * nfx + vy * nfy + vz * nfz;
            if (depth <= 0.01) return null;

            const cx = vx * nrx + vy * nry + vz * nrz;
            const cy = vx * nux + vy * nuy + vz * nuz;
            const sx = w * 0.5 + (cx / depth) * fovScale + this.panOffset[0];
            const sy = h * 0.5 - (cy / depth) * fovScale + this.panOffset[1];
            return [sx, sy, depth];
        };

        // Exploded View Offsets per Part
        const partOffsets = new Map<number, [number, number, number]>();
        if (this.explodedFactor > 0.0) {
            const globalCenter = this.cameraTarget;
            const span = this.cameraDistance * 0.45;
            const numParts = Math.max(1, this.config.parts.length);
            for (let pIdx = 0; pIdx < this.config.parts.length; pIdx++) {
                const part = this.config.parts[pIdx];
                const b = part.bounds;
                const partCenter: [number, number, number] = [
                    (b[0] + b[1]) * 0.5,
                    (b[2] + b[3]) * 0.5,
                    (b[4] + b[5]) * 0.5
                ];
                let dx = partCenter[0] - globalCenter[0];
                let dy = partCenter[1] - globalCenter[1];
                let dz = partCenter[2] - globalCenter[2];
                let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const explodeDistance = span * this.explodedFactor;

                const charSize = Math.max(0.01, b[1] - b[0], b[3] - b[2], b[5] - b[4]);
                if (dist < 0.05 * charSize) {
                    const angle = (pIdx / numParts) * Math.PI * 2 + Math.PI / 4;
                    const zStagger = (pIdx % 2 === 0 ? 0.35 : -0.35);
                    partOffsets.set(part.part_id, [
                        Math.cos(angle) * explodeDistance,
                        Math.sin(angle) * explodeDistance,
                        zStagger * explodeDistance
                    ]);
                } else {
                    partOffsets.set(part.part_id, [
                        (dx / dist) * explodeDistance,
                        (dy / dist) * explodeDistance,
                        (dz / dist) * explodeDistance
                    ]);
                }
            }
        }

        // Draw Reference Grid at ground level (minZ)
        this.renderGroundGrid(ctx, project);

        // Gather all element faces / lines for depth sorting
        const nodeCoords = this.preview.nodeCoords;
        const numNodes = (nodeCoords.length / 3) | 0;
        this.ensureNodeCapacity(numNodes);
        this.projStatus.fill(0, 0, numNodes);

        const halfW = w * 0.5;
        const halfH = h * 0.5;
        const panX = this.panOffset[0];
        const panY = this.panOffset[1];

        const projectNodeFast = (nIdx: number): boolean => {
            const st = this.projStatus[nIdx];
            if (st === 1) return true;
            if (st === 2) return false;

            const vx = nodeCoords[nIdx * 3 + 0] - eyeX;
            const vy = nodeCoords[nIdx * 3 + 1] - eyeY;
            const vz = nodeCoords[nIdx * 3 + 2] - eyeZ;

            const depth = vx * nfx + vy * nfy + vz * nfz;
            if (depth <= 0.01) {
                this.projStatus[nIdx] = 2;
                return false;
            }

            const cx = vx * nrx + vy * nry + vz * nrz;
            const cy = vx * nux + vy * nuy + vz * nuz;

            this.projX[nIdx] = halfW + (cx / depth) * fovScale + panX;
            this.projY[nIdx] = halfH - (cy / depth) * fovScale + panY;
            this.projDepth[nIdx] = depth;
            this.projStatus[nIdx] = 1;
            return true;
        };

        const projectNodeWithOffset = (nIdx: number, ox: number, oy: number, oz: number): [number, number, number] | null => {
            const vx = nodeCoords[nIdx * 3 + 0] + ox - eyeX;
            const vy = nodeCoords[nIdx * 3 + 1] + oy - eyeY;
            const vz = nodeCoords[nIdx * 3 + 2] + oz - eyeZ;
            const depth = vx * nfx + vy * nfy + vz * nfz;
            if (depth <= 0.01) return null;
            const cx = vx * nrx + vy * nry + vz * nrz;
            const cy = vx * nux + vy * nuy + vz * nuz;
            return [halfW + (cx / depth) * fovScale + panX, halfH - (cy / depth) * fovScale + panY, depth];
        };

        // Studio 3-Point Lighting Vectors (Key, Fill) in World Coordinates
        let L1x = nrx * 0.40 + nux * 0.65 + (-nfx) * 0.65;
        let L1y = nry * 0.40 + nuy * 0.65 + (-nfy) * 0.65;
        let L1z = nrz * 0.40 + nuz * 0.65 + (-nfz) * 0.65;
        const L1_len = Math.sqrt(L1x * L1x + L1y * L1y + L1z * L1z) || 1.0;
        L1x /= L1_len; L1y /= L1_len; L1z /= L1_len;

        let L2x = -nrx * 0.45 - nux * 0.25 + (-nfx) * 0.45;
        let L2y = -nry * 0.45 - nuy * 0.25 + (-nfy) * 0.45;
        let L2z = -nrz * 0.45 - nuz * 0.25 + (-nfz) * 0.45;
        const L2_len = Math.sqrt(L2x * L2x + L2y * L2y + L2z * L2z) || 1.0;
        L2x /= L2_len; L2y /= L2_len; L2z /= L2_len;

        const parseHexColor = (hex: string): [number, number, number] => {
            if (!hex) return [56, 189, 248];
            if (hex.startsWith('#')) {
                if (hex.length === 7) {
                    const num = parseInt(hex.slice(1), 16);
                    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
                }
                if (hex.length === 4) {
                    const r = parseInt(hex[1] + hex[1], 16);
                    const g = parseInt(hex[2] + hex[2], 16);
                    const b = parseInt(hex[3] + hex[3], 16);
                    return [r, g, b];
                }
            }
            return [56, 189, 248];
        };

        interface PartStyle {
            visible: boolean;
            isSuppressed: boolean;
            isSelected: boolean;
            isWire: boolean;
            baseR: number;
            baseG: number;
            baseB: number;
            strokeColor: string;
            wireWidth: number;
            lineColor: string;
            lineWidth: number;
            offsetX: number;
            offsetY: number;
            offsetZ: number;
            isSolid: boolean;
        }
        const partStyles = new Map<number, PartStyle>();
        for (const p of this.config.parts) {
            const isSelected = this.selectedPartId === p.part_id;
            const isSuppressed = p.suppressed;
            const off = partOffsets.get(p.part_id) || [0, 0, 0];
            const rgb = parseHexColor(p.color);
            const isSolid = !p.section_type || p.section_type.startsWith('Solid') || p.section_type.includes('Hex') || p.section_type.includes('Tet');
            const isBeam = p.section_type === 'Beam3D' || p.section_type === 'Truss1D';

            // Distinct beam/rebar selection styling: retain vibrant steel amber/gold highlight
            let beamLineColor = p.color || '#f59e0b';
            let beamLineWidth = 1.2;
            if (isSuppressed) {
                beamLineColor = '#64748b';
            } else if (isSelected) {
                beamLineColor = '#fbbf24'; // Vivid luminous gold selection highlight
                beamLineWidth = 2.2;
            }

            partStyles.set(p.part_id, {
                visible: p.visible,
                isSuppressed,
                isSelected,
                isWire: this.showWireframe,
                baseR: rgb[0],
                baseG: rgb[1],
                baseB: rgb[2],
                strokeColor: isSelected ? 'rgba(56, 189, 248, 0.85)' : (isSuppressed ? 'rgba(148, 163, 184, 0.25)' : 'rgba(15, 23, 42, 0.40)'),
                wireWidth: isSelected ? 1.0 : 0.65,
                lineColor: isBeam ? beamLineColor : (isSuppressed ? '#64748b' : (isSelected ? '#38bdf8' : p.color)),
                lineWidth: isBeam ? beamLineWidth : (isSelected ? 1.6 : 1.1),
                offsetX: off[0],
                offsetY: off[1],
                offsetZ: off[2],
                isSolid
            });
        }

        const rm = this.preview.renderMesh;
        let renderItemCount = 0;
        const isInteracting = this.isDragging || this.isPanning;

        if (rm) {
            const totalFacets = rm.facetCount;
            const totalLines = rm.lineCount;
            this.ensureItemCapacity(totalFacets + totalLines);

            // Dynamic adaptive LOD stride: downsample during mouse drag/orbit if model is massive
            const maxInteractiveFacets = 20000;
            const maxRestFacets = 60000;
            const facetStride = isInteracting
                ? (totalFacets > maxInteractiveFacets ? Math.ceil(totalFacets / maxInteractiveFacets) : 1)
                : (totalFacets > maxRestFacets ? Math.ceil(totalFacets / maxRestFacets) : 1);

            const maxInteractiveLines = 15000;
            const maxRestLines = 40000;
            const lineStride = isInteracting
                ? (totalLines > maxInteractiveLines ? Math.ceil(totalLines / maxInteractiveLines) : 1)
                : (totalLines > maxRestLines ? Math.ceil(totalLines / maxRestLines) : 1);

            this.lastLODActive = (facetStride > 1 || lineStride > 1);

            const fn = rm.facetNodeIndices;
            const fp = rm.facetPartIds;

            for (let f = 0; f < totalFacets; f += facetStride) {
                const pid = fp[f];
                const style = partStyles.get(pid);
                if (!style || !style.visible) continue;
                if (style.isSuppressed && !this.showGhostSuppressed) continue;

                const f4 = f * 4;
                const n0 = fn[f4 + 0];
                const n1 = fn[f4 + 1];
                const n2 = fn[f4 + 2];
                const n3 = fn[f4 + 3];

                const ox = style.offsetX, oy = style.offsetY, oz = style.offsetZ;
                let x0 = 0, y0 = 0, z0 = 0;
                let x1 = 0, y1 = 0, z1 = 0;
                let x2 = 0, y2 = 0, z2 = 0;
                let x3 = 0, y3 = 0, z3 = 0;

                if (ox === 0 && oy === 0 && oz === 0) {
                    if (!projectNodeFast(n0) || !projectNodeFast(n1) || !projectNodeFast(n2)) continue;
                    x0 = this.projX[n0]; y0 = this.projY[n0]; z0 = this.projDepth[n0];
                    x1 = this.projX[n1]; y1 = this.projY[n1]; z1 = this.projDepth[n1];
                    x2 = this.projX[n2]; y2 = this.projY[n2]; z2 = this.projDepth[n2];
                    if (n3 >= 0) {
                        if (!projectNodeFast(n3)) continue;
                        x3 = this.projX[n3]; y3 = this.projY[n3]; z3 = this.projDepth[n3];
                    }
                } else {
                    const p0 = projectNodeWithOffset(n0, ox, oy, oz);
                    const p1 = projectNodeWithOffset(n1, ox, oy, oz);
                    const p2 = projectNodeWithOffset(n2, ox, oy, oz);
                    if (!p0 || !p1 || !p2) continue;
                    x0 = p0[0]; y0 = p0[1]; z0 = p0[2];
                    x1 = p1[0]; y1 = p1[1]; z1 = p1[2];
                    x2 = p2[0]; y2 = p2[1]; z2 = p2[2];
                    if (n3 >= 0) {
                        const p3 = projectNodeWithOffset(n3, ox, oy, oz);
                        if (!p3) continue;
                        x3 = p3[0]; y3 = p3[1]; z3 = p3[2];
                    }
                }

                // Compute true 3D surface normal in world coordinates
                const w0x = nodeCoords[n0 * 3 + 0] + ox;
                const w0y = nodeCoords[n0 * 3 + 1] + oy;
                const w0z = nodeCoords[n0 * 3 + 2] + oz;
                const w1x = nodeCoords[n1 * 3 + 0] + ox;
                const w1y = nodeCoords[n1 * 3 + 1] + oy;
                const w1z = nodeCoords[n1 * 3 + 2] + oz;
                const w2x = nodeCoords[n2 * 3 + 0] + ox;
                const w2y = nodeCoords[n2 * 3 + 1] + oy;
                const w2z = nodeCoords[n2 * 3 + 2] + oz;

                let nx = 0, ny = 0, nz = 0;
                let cx = 0, cy = 0, cz = 0;
                if (n3 >= 0) {
                    const w3x = nodeCoords[n3 * 3 + 0] + ox;
                    const w3y = nodeCoords[n3 * 3 + 1] + oy;
                    const w3z = nodeCoords[n3 * 3 + 2] + oz;
                    const d1x = w2x - w0x, d1y = w2y - w0y, d1z = w2z - w0z;
                    const d2x = w3x - w1x, d2y = w3y - w1y, d2z = w3z - w1z;
                    nx = d1y * d2z - d1z * d2y;
                    ny = d1z * d2x - d1x * d2z;
                    nz = d1x * d2y - d1y * d2x;
                    cx = (w0x + w1x + w2x + w3x) * 0.25;
                    cy = (w0y + w1y + w2y + w3y) * 0.25;
                    cz = (w0z + w1z + w2z + w3z) * 0.25;
                } else {
                    const u1x = w1x - w0x, u1y = w1y - w0y, u1z = w1z - w0z;
                    const u2x = w2x - w0x, u2y = w2y - w0y, u2z = w2z - w0z;
                    nx = u1y * u2z - u1z * u2y;
                    ny = u1z * u2x - u1x * u2z;
                    nz = u1x * u2y - u1y * u2x;
                    cx = (w0x + w1x + w2x) * 0.3333333;
                    cy = (w0y + w1y + w2y) * 0.3333333;
                    cz = (w0z + w1z + w2z) * 0.3333333;
                }

                let nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nlen < 1e-7) continue;
                nx /= nlen; ny /= nlen; nz /= nlen;

                // View direction from eye to face centroid
                const vx = cx - eyeX, vy = cy - eyeY, vz = cz - eyeZ;
                const vdist = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1.0;
                const vdirX = vx / vdist, vdirY = vy / vdist, vdirZ = vz / vdist;

                let dotView = nx * vdirX + ny * vdirY + nz * vdirZ;
                if (style.isSolid) {
                    if (dotView >= 0.0) continue; // Reliable outward-facing surface backface culling
                } else {
                    if (dotView > 0.0) {
                        nx = -nx; ny = -ny; nz = -nz;
                        dotView = -dotView;
                    }
                }

                // Studio 3-Point Lighting (Key, Fill, Ambient, Specular)
                const diff1 = Math.max(0.0, nx * L1x + ny * L1y + nz * L1z);
                const diff2 = Math.max(0.0, nx * L2x + ny * L2y + nz * L2z) * 0.32;
                const ambient = 0.28;
                const diffuse = Math.min(1.0, ambient + diff1 * 0.65 + diff2);

                const hx = L1x - vdirX;
                const hy = L1y - vdirY;
                const hz = L1z - vdirZ;
                const hlen = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1.0;
                const nDotH = Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hlen);
                const spec = Math.pow(nDotH, 20) * 0.30;

                const r0 = style.isSelected ? Math.min(255, style.baseR + 22) : (style.isSuppressed ? 100 : style.baseR);
                const g0 = style.isSelected ? Math.min(255, style.baseG + 28) : (style.isSuppressed ? 116 : style.baseG);
                const b0 = style.isSelected ? Math.min(255, style.baseB + 45) : (style.isSuppressed ? 139 : style.baseB);

                const litR = Math.min(255, Math.floor(r0 * diffuse + 255 * spec));
                const litG = Math.min(255, Math.floor(g0 * diffuse + 255 * spec));
                const litB = Math.min(255, Math.floor(b0 * diffuse + 255 * spec));

                const depth = vx * nfx + vy * nfy + vz * nfz;
                const idx = renderItemCount++;
                this.itemIndices[idx] = idx;
                this.itemDepths[idx] = depth;
                this.itemTypes[idx] = n3 >= 0 ? 0 : 1;
                this.itemPartIds[idx] = pid;
                this.itemX0[idx] = x0; this.itemY0[idx] = y0;
                this.itemX1[idx] = x1; this.itemY1[idx] = y1;
                this.itemX2[idx] = x2; this.itemY2[idx] = y2;
                this.itemX3[idx] = n3 >= 0 ? x3 : 0; this.itemY3[idx] = n3 >= 0 ? y3 : 0;
                this.itemR[idx] = litR;
                this.itemG[idx] = litG;
                this.itemB[idx] = litB;
            }

            const ln = rm.lineNodeIndices;
            const lp = rm.linePartIds;

            for (let l = 0; l < totalLines; l += lineStride) {
                const pid = lp[l];
                const style = partStyles.get(pid);
                if (!style || !style.visible) continue;
                if (style.isSuppressed && !this.showGhostSuppressed) continue;

                const l2 = l * 2;
                const n0 = ln[l2 + 0];
                const n1 = ln[l2 + 1];

                const ox = style.offsetX, oy = style.offsetY, oz = style.offsetZ;
                let x0 = 0, y0 = 0, z0 = 0;
                let x1 = 0, y1 = 0, z1 = 0;

                if (ox === 0 && oy === 0 && oz === 0) {
                    if (!projectNodeFast(n0) || !projectNodeFast(n1)) continue;
                    x0 = this.projX[n0]; y0 = this.projY[n0]; z0 = this.projDepth[n0];
                    x1 = this.projX[n1]; y1 = this.projY[n1]; z1 = this.projDepth[n1];
                } else {
                    const p0 = projectNodeWithOffset(n0, ox, oy, oz);
                    const p1 = projectNodeWithOffset(n1, ox, oy, oz);
                    if (!p0 || !p1) continue;
                    x0 = p0[0]; y0 = p0[1]; z0 = p0[2];
                    x1 = p1[0]; y1 = p1[1]; z1 = p1[2];
                }

                const depth = (z0 + z1) * 0.5;
                const idx = renderItemCount++;
                this.itemIndices[idx] = idx;
                this.itemDepths[idx] = depth;
                this.itemTypes[idx] = 2; // Line
                this.itemPartIds[idx] = pid;
                this.itemX0[idx] = x0; this.itemY0[idx] = y0;
                this.itemX1[idx] = x1; this.itemY1[idx] = y1;
                this.itemX2[idx] = 0;  this.itemY2[idx] = 0;
                this.itemX3[idx] = 0;  this.itemY3[idx] = 0;
            }
        } else {
            // Fallback for legacy parsed elements
            const totalElements = this.preview.elements.length;
            this.ensureItemCapacity(totalElements * 2);
            const maxFallbackItems = isInteracting ? 20000 : 50000;
            const elemStride = totalElements > maxFallbackItems ? Math.ceil(totalElements / maxFallbackItems) : 1;
            this.lastLODActive = elemStride > 1;

            for (let i = 0; i < totalElements; i += elemStride) {
                const elem = this.preview.elements[i];
                const style = partStyles.get(elem.partId);
                if (!style || !style.visible) continue;
                if (style.isSuppressed && !this.showGhostSuppressed) continue;

                if (elem.type === 'Beam3D' || elem.type === 'Truss1D') {
                    if (elem.nodeIndices.length >= 2) {
                        const n0 = elem.nodeIndices[0];
                        const n1 = elem.nodeIndices[1];
                        if (!projectNodeFast(n0) || !projectNodeFast(n1)) continue;
                        const depth = (this.projDepth[n0] + this.projDepth[n1]) * 0.5;
                        const idx = renderItemCount++;
                        this.itemIndices[idx] = idx;
                        this.itemDepths[idx] = depth;
                        this.itemTypes[idx] = 2;
                        this.itemPartIds[idx] = elem.partId;
                        this.itemX0[idx] = this.projX[n0]; this.itemY0[idx] = this.projY[n0];
                        this.itemX1[idx] = this.projX[n1]; this.itemY1[idx] = this.projY[n1];
                    }
                } else if (elem.nodeIndices.length >= 3) {
                    const n0 = elem.nodeIndices[0];
                    const n1 = elem.nodeIndices[1];
                    const n2 = elem.nodeIndices[2];
                    const isQuad = elem.nodeIndices.length >= 4;
                    const n3 = isQuad ? elem.nodeIndices[3] : -1;

                    if (!projectNodeFast(n0) || !projectNodeFast(n1) || !projectNodeFast(n2)) continue;
                    if (isQuad && !projectNodeFast(n3)) continue;

                    const w0x = nodeCoords[n0 * 3 + 0];
                    const w0y = nodeCoords[n0 * 3 + 1];
                    const w0z = nodeCoords[n0 * 3 + 2];
                    const w1x = nodeCoords[n1 * 3 + 0];
                    const w1y = nodeCoords[n1 * 3 + 1];
                    const w1z = nodeCoords[n1 * 3 + 2];
                    const w2x = nodeCoords[n2 * 3 + 0];
                    const w2y = nodeCoords[n2 * 3 + 1];
                    const w2z = nodeCoords[n2 * 3 + 2];

                    let nx = 0, ny = 0, nz = 0;
                    let cx = 0, cy = 0, cz = 0;
                    if (isQuad) {
                        const w3x = nodeCoords[n3 * 3 + 0];
                        const w3y = nodeCoords[n3 * 3 + 1];
                        const w3z = nodeCoords[n3 * 3 + 2];
                        const d1x = w2x - w0x, d1y = w2y - w0y, d1z = w2z - w0z;
                        const d2x = w3x - w1x, d2y = w3y - w1y, d2z = w3z - w1z;
                        nx = d1y * d2z - d1z * d2y;
                        ny = d1z * d2x - d1x * d2z;
                        nz = d1x * d2y - d1y * d2x;
                        cx = (w0x + w1x + w2x + w3x) * 0.25;
                        cy = (w0y + w1y + w2y + w3y) * 0.25;
                        cz = (w0z + w1z + w2z + w3z) * 0.25;
                    } else {
                        const u1x = w1x - w0x, u1y = w1y - w0y, u1z = w1z - w0z;
                        const u2x = w2x - w0x, u2y = w2y - w0y, u2z = w2z - w0z;
                        nx = u1y * u2z - u1z * u2y;
                        ny = u1z * u2x - u1x * u2z;
                        nz = u1x * u2y - u1y * u2x;
                        cx = (w0x + w1x + w2x) * 0.3333333;
                        cy = (w0y + w1y + w2y) * 0.3333333;
                        cz = (w0z + w1z + w2z) * 0.3333333;
                    }

                    let nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (nlen < 1e-7) continue;
                    nx /= nlen; ny /= nlen; nz /= nlen;

                    const vx = cx - eyeX, vy = cy - eyeY, vz = cz - eyeZ;
                    const vdist = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1.0;
                    const vdirX = vx / vdist, vdirY = vy / vdist, vdirZ = vz / vdist;

                    let dotView = nx * vdirX + ny * vdirY + nz * vdirZ;
                    if (style.isSolid) {
                        if (dotView >= 0.0) continue;
                    } else {
                        if (dotView > 0.0) {
                            nx = -nx; ny = -ny; nz = -nz;
                            dotView = -dotView;
                        }
                    }

                    const diff1 = Math.max(0.0, nx * L1x + ny * L1y + nz * L1z);
                    const diff2 = Math.max(0.0, nx * L2x + ny * L2y + nz * L2z) * 0.32;
                    const ambient = 0.28;
                    const diffuse = Math.min(1.0, ambient + diff1 * 0.65 + diff2);

                    const hx = L1x - vdirX;
                    const hy = L1y - vdirY;
                    const hz = L1z - vdirZ;
                    const hlen = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1.0;
                    const nDotH = Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hlen);
                    const spec = Math.pow(nDotH, 20) * 0.30;

                    const r0 = style.isSelected ? Math.min(255, style.baseR + 22) : (style.isSuppressed ? 100 : style.baseR);
                    const g0 = style.isSelected ? Math.min(255, style.baseG + 28) : (style.isSuppressed ? 116 : style.baseG);
                    const b0 = style.isSelected ? Math.min(255, style.baseB + 45) : (style.isSuppressed ? 139 : style.baseB);

                    const litR = Math.min(255, Math.floor(r0 * diffuse + 255 * spec));
                    const litG = Math.min(255, Math.floor(g0 * diffuse + 255 * spec));
                    const litB = Math.min(255, Math.floor(b0 * diffuse + 255 * spec));

                    const depth = vx * nfx + vy * nfy + vz * nfz;
                    const idx = renderItemCount++;
                    this.itemIndices[idx] = idx;
                    this.itemDepths[idx] = depth;
                    this.itemTypes[idx] = isQuad ? 0 : 1;
                    this.itemPartIds[idx] = elem.partId;
                    this.itemX0[idx] = this.projX[n0]; this.itemY0[idx] = this.projY[n0];
                    this.itemX1[idx] = this.projX[n1]; this.itemY1[idx] = this.projY[n1];
                    this.itemX2[idx] = this.projX[n2]; this.itemY2[idx] = this.projY[n2];
                    this.itemX3[idx] = isQuad ? this.projX[n3] : 0; this.itemY3[idx] = isQuad ? this.projY[n3] : 0;
                    this.itemR[idx] = litR;
                    this.itemG[idx] = litG;
                    this.itemB[idx] = litB;
                }
            }
        }

        this.lastRenderedCount = renderItemCount;

        // Sort items back-to-front (Painter's Algorithm) using native typed array sort
        const visibleIndices = this.itemIndices.subarray(0, renderItemCount);
        const depths = this.itemDepths;
        visibleIndices.sort((a, b) => depths[b] - depths[a]);

        // Direct rasterization from typed arrays with batched lines
        let currentLineColor = '';
        let currentLineWidth = 0;
        let lineBatchActive = false;

        for (let i = 0; i < renderItemCount; i++) {
            const idx = visibleIndices[i];
            const type = this.itemTypes[idx];
            const pid = this.itemPartIds[idx];
            const style = partStyles.get(pid);
            if (!style) continue;

            const x0 = this.itemX0[idx];
            const y0 = this.itemY0[idx];
            const x1 = this.itemX1[idx];
            const y1 = this.itemY1[idx];

            if (type === 2) {
                // Batched Line (Beam / Rebar / Truss)
                const lw = style.lineWidth;
                if (!lineBatchActive || currentLineColor !== style.lineColor || currentLineWidth !== lw) {
                    if (lineBatchActive) ctx.stroke();
                    ctx.beginPath();
                    ctx.strokeStyle = style.lineColor;
                    ctx.lineWidth = lw;
                    currentLineColor = style.lineColor;
                    currentLineWidth = lw;
                    lineBatchActive = true;
                }
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
            } else {
                // Face (Quad or Triangle)
                if (lineBatchActive) {
                    ctx.stroke();
                    lineBatchActive = false;
                }
                const x2 = this.itemX2[idx];
                const y2 = this.itemY2[idx];

                ctx.beginPath();
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                ctx.lineTo(x2, y2);
                if (type === 0) {
                    ctx.lineTo(this.itemX3[idx], this.itemY3[idx]);
                }
                ctx.closePath();

                if (this.showShaded) {
                    const r = this.itemR[idx];
                    const g = this.itemG[idx];
                    const b = this.itemB[idx];
                    if (this.showXRay && !style.isSuppressed) {
                        ctx.fillStyle = `rgba(${r},${g},${b},0.42)`;
                    } else if (style.isSuppressed) {
                        ctx.fillStyle = `rgba(${r},${g},${b},0.25)`;
                    } else {
                        ctx.fillStyle = `rgb(${r},${g},${b})`;
                    }
                    ctx.fill();
                }

                if (this.showWireframe) {
                    ctx.strokeStyle = style.strokeColor;
                    ctx.lineWidth = style.wireWidth;
                    ctx.stroke();
                }
            }
        }
        if (lineBatchActive) {
            ctx.stroke();
        }

        // Render 3D Boundary Condition Glyphs (Pyramids / Arrows)
        if (this.showBCGlyphs) {
            this.renderBoundaryConditionGlyphs(ctx, project);
        }

        // Render 3D Trihedron Orientation Gizmo in bottom-left corner
        this.renderTrihedron(ctx, cosT, sinT, cosP, sinP);

        // Update Viewport HUD Readout
        this.updateViewportReadout();
    }

    private renderGroundGrid(ctx: CanvasRenderingContext2D, project: (x: number, y: number, z: number) => [number, number, number] | null): void {
        const span = this.cameraDistance * 0.6;
        const step = span * 0.2;
        const cx = this.cameraTarget[0];
        const cy = this.cameraTarget[1];
        const floorZ = this.preview?.globalBounds ? this.preview.globalBounds[4] : 0;

        ctx.strokeStyle = 'rgba(51, 65, 85, 0.25)';
        ctx.lineWidth = 1;

        for (let x = cx - span; x <= cx + span + 0.001; x += step) {
            const p0 = project(x, cy - span, floorZ);
            const p1 = project(x, cy + span, floorZ);
            if (p0 && p1) {
                ctx.beginPath();
                ctx.moveTo(p0[0], p0[1]);
                ctx.lineTo(p1[0], p1[1]);
                ctx.stroke();
            }
        }

        for (let y = cy - span; y <= cy + span + 0.001; y += step) {
            const p0 = project(cx - span, y, floorZ);
            const p1 = project(cx + span, y, floorZ);
            if (p0 && p1) {
                ctx.beginPath();
                ctx.moveTo(p0[0], p0[1]);
                ctx.lineTo(p1[0], p1[1]);
                ctx.stroke();
            }
        }
    }

    private renderBoundaryConditionGlyphs(ctx: CanvasRenderingContext2D, project: (x: number, y: number, z: number) => [number, number, number] | null): void {
        if (!this.preview) return;
        const nodeCoords = this.preview.nodeCoords;
        const nodeIdToIndex = this.preview.nodeIdToIndex;

        for (const bc of this.config.boundary_conditions) {
            if (!bc.active) continue;

            // Determine target nodes
            const targetNodeIndices: number[] = [];
            if (bc.target_type === 'NODE_SET') {
                const targetSet = this.config.sets.find(s => s.set_id === Number(bc.target_id) || s.name === String(bc.target_id));
                if (targetSet) {
                    for (const nid of targetSet.entity_ids) {
                        const idx = nodeIdToIndex.get(nid);
                        if (idx !== undefined) targetNodeIndices.push(idx);
                    }
                }
            } else if (bc.target_type === 'PART') {
                const targetPid = Number(bc.target_id);
                if (this.preview.renderMesh) {
                    const rm = this.preview.renderMesh;
                    const fn = rm.facetNodeIndices;
                    const fp = rm.facetPartIds;
                    for (let f = 0; f < rm.facetCount; f++) {
                        if (fp[f] === targetPid) {
                            const f4 = f * 4;
                            targetNodeIndices.push(fn[f4], fn[f4 + 1], fn[f4 + 2]);
                            if (fn[f4 + 3] >= 0) targetNodeIndices.push(fn[f4 + 3]);
                        }
                    }
                    const ln = rm.lineNodeIndices;
                    const lp = rm.linePartIds;
                    for (let l = 0; l < rm.lineCount; l++) {
                        if (lp[l] === targetPid) {
                            targetNodeIndices.push(ln[l * 2], ln[l * 2 + 1]);
                        }
                    }
                } else {
                    for (const elem of this.preview.elements) {
                        if (elem.partId === targetPid) {
                            for (const n of elem.nodeIndices) targetNodeIndices.push(n);
                        }
                    }
                }
            }


            // Downsample glyph rendering if there are thousands of constrained nodes
            const stride = Math.max(1, Math.floor(targetNodeIndices.length / 150));

            for (let i = 0; i < targetNodeIndices.length; i += stride) {
                const nIdx = targetNodeIndices[i];
                const x = nodeCoords[nIdx * 3];
                const y = nodeCoords[nIdx * 3 + 1];
                const z = nodeCoords[nIdx * 3 + 2];

                const p = project(x, y, z);
                if (!p) continue;

                if (bc.bc_type === 'SPC') {
                    // Draw Fixed Constraint Anchor Glyph (Cyan/Green Pyramid)
                    const size = 6;
                    ctx.fillStyle = '#10b981';
                    ctx.strokeStyle = '#047857';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(p[0], p[1]);
                    ctx.lineTo(p[0] - size, p[1] + size * 1.5);
                    ctx.lineTo(p[0] + size, p[1] + size * 1.5);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();

                    // Fixed base bar
                    ctx.beginPath();
                    ctx.moveTo(p[0] - size * 1.3, p[1] + size * 1.5);
                    ctx.lineTo(p[0] + size * 1.3, p[1] + size * 1.5);
                    ctx.stroke();
                } else if (bc.bc_type === 'PRESCRIBED_VELOCITY' && bc.velocity) {
                    // Draw Directional Velocity Arrow
                    const [vx, vy, vz] = bc.velocity;
                    const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1.0;
                    const arrowScale = this.cameraDistance * 0.08;
                    const tip = project(x + (vx / vlen) * arrowScale, y + (vy / vlen) * arrowScale, z + (vz / vlen) * arrowScale);
                    if (tip) {
                        ctx.strokeStyle = '#f59e0b';
                        ctx.fillStyle = '#f59e0b';
                        ctx.lineWidth = 2.5;
                        ctx.beginPath();
                        ctx.moveTo(p[0], p[1]);
                        ctx.lineTo(tip[0], tip[1]);
                        ctx.stroke();

                        // Arrowhead
                        ctx.beginPath();
                        ctx.arc(tip[0], tip[1], 3.5, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }
    }

    private renderTrihedron(ctx: CanvasRenderingContext2D, cosT: number, sinT: number, cosP: number, sinP: number): void {
        const ox = 48;
        const oy = this.canvas!.height - 48;
        const len = 32;

        const drawAxis = (dx: number, dy: number, dz: number, color: string, label: string) => {
            const rx = (dy * cosT - dx * sinT);
            const ry = (dx * cosT + dy * sinT) * sinP - dz * cosP;
            const tx = ox + rx * len;
            const ty = oy + ry * len;

            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 2.5;

            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(tx, ty);
            ctx.stroke();

            ctx.font = 'bold 10px sans-serif';
            ctx.fillText(label, tx + 3, ty + 3);
        };

        drawAxis(1, 0, 0, '#ef4444', 'X');
        drawAxis(0, 1, 0, '#10b981', 'Y');
        drawAxis(0, 0, 1, '#3b82f6', 'Z');
    }

    // ========================================================================
    // Camera Presets & Navigation
    // ========================================================================
    private setCameraPreset(theta: number, phi: number): void {
        this.cameraTheta = theta;
        this.cameraPhi = phi;
        this.panOffset = [0, 0];
        this.requestRender();
    }

    private focusOnPart(part: FEMPartConfig): void {
        const b = part.bounds;
        this.cameraTarget = [(b[0] + b[1]) * 0.5, (b[2] + b[3]) * 0.5, (b[4] + b[5]) * 0.5];
        const span = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 0.01);
        this.cameraDistance = span * 2.5;
        this.panOffset = [0, 0];
        this.requestRender();
    }

    // ========================================================================
    // Wizards & Dialogs (Create Set, Create BC, Assign Material)
    // ========================================================================
    private openCreateSetWizard(): void {
        const plane = prompt('Enter boundary plane to select nodes on (e.g. z_min, z_max, x_min, x_max, y_min, y_max):', 'z_min');
        if (!plane) return;

        if (!this.preview) return;
        const b = this.preview.globalBounds;
        let coord = 0;
        if (plane === 'z_min') coord = b[4];
        else if (plane === 'z_max') coord = b[5];
        else if (plane === 'x_min') coord = b[0];
        else if (plane === 'x_max') coord = b[1];
        else if (plane === 'y_min') coord = b[2];
        else if (plane === 'y_max') coord = b[3];

        const nodeCoords = this.preview.nodeCoords;
        const nodeIndexToId = this.preview.nodeIndexToId;
        const tol = Math.max(1e-5, (b[1] - b[0]) * 0.01);
        const matchingIds: number[] = [];

        for (let i = 0; i < nodeCoords.length; i += 3) {
            const x = nodeCoords[i];
            const y = nodeCoords[i + 1];
            const z = nodeCoords[i + 2];

            let dist = 0;
            if (plane.startsWith('x')) dist = Math.abs(x - coord);
            else if (plane.startsWith('y')) dist = Math.abs(y - coord);
            else dist = Math.abs(z - coord);

            if (dist <= tol) {
                const nid = nodeIndexToId[i / 3];
                if (nid !== undefined) matchingIds.push(nid);
            }
        }

        const newSetId = Math.max(1, ...this.config.sets.map(s => s.set_id), 0) + 1;
        const newSet: FEMEntitySet = {
            set_id: newSetId,
            name: `Set_${plane.toUpperCase()}_Boundary`,
            set_type: 'NODE',
            entity_ids: matchingIds,
            source: 'user_plane',
            filter_params: { plane: plane as any, plane_coord: coord, tolerance: tol }
        };

        this.config.sets.push(newSet);
        this.selectedSetId = newSetId;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
        this.requestRender();
    }

    private openCreateBCWizard(presetSetId?: number): void {
        const targetSetId = presetSetId ?? (this.config.sets.length > 0 ? this.config.sets[0].set_id : 1);
        const newBcId = `bc_${Date.now()}`;
        const newBC: FEMBoundaryCondition = {
            id: newBcId,
            name: `Fixity_Constraint_${this.config.boundary_conditions.length + 1}`,
            bc_type: 'SPC',
            target_type: 'NODE_SET',
            target_id: targetSetId,
            dofs: [true, true, true, true, true, true],
            active: true
        };

        this.config.boundary_conditions.push(newBC);
        this.selectedBCId = newBcId;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
        this.requestRender();
    }

    private openCreateContactWizard(): void {
        const newContact: FEMContactConfig = {
            id: `contact_${Date.now()}`,
            name: `Contact_Pair_${this.config.contacts.length + 1}`,
            contact_type: 'AUTOMATIC_SINGLE_SURFACE',
            friction_static: 0.30,
            friction_kinetic: 0.20,
            penalty_scale: 0.10
        };
        this.config.contacts.push(newContact);
        this.selectedContactId = newContact.id;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
    }

    private openAssignMaterialDialog(matKey: string, matName: string): void {
        const choice = prompt(`Assign material "${matName}" to which parts? (Enter comma-separated Part IDs, or "all" to assign to all components):`, 'all');
        if (!choice) return;

        if (choice.trim().toLowerCase() === 'all') {
            for (const p of this.config.parts) {
                p.material_assignment = matKey;
                this.config.material_assignments[p.part_id] = matKey;
            }
        } else {
            const pids = choice.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
            for (const p of this.config.parts) {
                if (pids.includes(p.part_id)) {
                    p.material_assignment = matKey;
                    this.config.material_assignments[p.part_id] = matKey;
                }
            }
        }

        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
        this.requestRender();
    }

    // ========================================================================
    // File Import / Export
    // ========================================================================
    private triggerFileImport(): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.k,.key,.dyn,.txt';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                this.preview = FEMDeckParser.parse(text);

                // Only store deck content on node parameters if small (< 2MB) to prevent freezing stateManager & localStorage
                if (text.length < 2 * 1024 * 1024) {
                    this.femNode.parameters.deck_content = text;
                } else {
                    delete this.femNode.parameters.deck_content;
                }
                this.femNode.parameters.k_file = file.name;

                // Sync config
                this.config = JSON.parse(JSON.stringify(this.preview.config));
                this.selectedPartId = this.config.parts.length > 0 ? this.config.parts[0].part_id : null;
                this.calculateModelBounds();
                this.isDirty = true;

                this.renderTabsAndList();
                this.renderInspector();
                this.requestRender();

                alert(`Successfully parsed LS-DYNA Keyword Deck "${file.name}":\n` +
                      `• ${this.config.parts.length} Parts\n` +
                      `• ${this.config.sets.length} Sets\n` +
                      `• ${this.preview.elements.length.toLocaleString()} Solid/Shell/Beam Elements\n` +
                      `• ${this.preview.nodeIndexToId.length.toLocaleString()} Nodes`);
            } catch (err: any) {
                alert(`Failed to parse keyword deck: ${err.message}`);
            }
        };
        input.click();
    }

    private exportSetupJSON(): void {
        const jsonStr = JSON.stringify(this.config, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.femNode.parameters.name || 'fem_assembly'}_setup.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ========================================================================
    // Save, Invalidation & Close
    // ========================================================================
    public saveAndApply(): void {
        // 1. Write back geometry, kinematics, discretization, and constitutive assignments to actual canvas nodes
        for (const part of this.config.parts) {
            const targetNode = (part.node_id ? this.model.nodes.find(n => n.id === part.node_id) : null)
                || this.model.nodes.find(n => n.id === (part as any).id || String(part.part_id) === n.id || n.parameters?.name === part.name)
                || (this.config.parts.length === 1 && (this.femNode.type === 'FEMObject3D' || this.femNode.type === 'LSDynaImporter3D' || this.femNode.type === 'FEMBeam3D' || this.femNode.type === 'FEMRebar3D') ? this.femNode : null);
            if (targetNode) {
                part.node_id = targetNode.id;
                const isLSDyna = part.shape_type === 'LS-DYNA File' || targetNode.type === 'LSDynaImporter3D' || !!part.k_file;
                    const updates: Record<string, any> = {
                        name: part.name,
                        color: part.color,
                        visible: part.visible,
                        section_type: part.section_type,
                        pos_x: Number(part.pos_x ?? 0),
                        pos_y: Number(part.pos_y ?? 0),
                        pos_z: Number(part.pos_z ?? 0),
                        size_x: Number(part.size_x ?? targetNode.parameters?.size_x ?? (isLSDyna ? 3.68 : 1.0)),
                        size_y: Number(part.size_y ?? targetNode.parameters?.size_y ?? (isLSDyna ? 3.68 : 1.0)),
                        size_z: Number(part.size_z ?? targetNode.parameters?.size_z ?? (isLSDyna ? 2.68 : 1.0)),
                        radius: Number(part.radius ?? targetNode.parameters?.radius ?? 0.05),
                        inner_radius: Number(part.inner_radius ?? targetNode.parameters?.inner_radius ?? 0.0),
                        height: Number(part.height ?? targetNode.parameters?.height ?? 0.2),
                        vel_x: Number(part.initial_velocity[0] ?? 0),
                        vel_y: Number(part.initial_velocity[1] ?? 0),
                        vel_z: Number(part.initial_velocity[2] ?? 0)
                    };

                    if (isLSDyna) {
                        updates.shape_type = 'LS-DYNA File';
                        updates.mesh_source = 'LS-DYNA Keyword File';
                        if (part.k_file) updates.k_file = part.k_file;
                        if (part.scale_factor !== undefined) updates.scale_factor = part.scale_factor;
                    } else {
                        updates.nx = Number(part.nx ?? 10);
                        updates.ny = Number(part.ny ?? 10);
                        updates.nz = Number(part.nz ?? 10);
                        if (part.origin_mode) updates.origin_mode = part.origin_mode;
                        const sType = part.shape_type || (part.section_type === 'Beam3D' ? 'Beam' : (part.section_type === 'Shell4' ? 'Plate' : 'Box'));
                        updates.shape_type = sType;
                        if (sType === 'Cylinder') {
                            updates.mesh_source = 'Cylinder Generator';
                        } else if (sType === 'Plate') {
                            updates.mesh_source = 'Plate Generator';
                        } else {
                            updates.mesh_source = 'Box Generator';
                        }
                    }

                    if (part.node1) {
                        updates.node1_x = part.node1[0];
                        updates.node1_y = part.node1[1];
                        updates.node1_z = part.node1[2];
                    }
                    if (part.node2) {
                        updates.node2_x = part.node2[0];
                        updates.node2_y = part.node2[1];
                        updates.node2_z = part.node2[2];
                    }
                    if (part.section_properties) {
                        if (part.section_properties.thickness !== undefined) updates.thickness = part.section_properties.thickness;
                        if (part.section_properties.diameter !== undefined) updates.diameter = part.section_properties.diameter;
                        if (part.section_properties.hourglass_type !== undefined) updates.hourglass_model = part.section_properties.hourglass_type;
                        if (part.section_properties.hourglass_coeff !== undefined) updates.hourglass_coeff = part.section_properties.hourglass_coeff;
                    }
                    if (part.material_assignment && part.material_assignment !== 'DEFAULT') {
                        updates.material = part.material_assignment;
                    }
                    if (part.erosion_override?.failure_strain !== undefined) {
                        updates.failure_strain = part.erosion_override.failure_strain;
                    }

                    this.stateManager.updateNodeParameters(targetNode.id, updates);
                }
        }

        // 2. Synchronize modified materials back to canvas Material nodes
        for (const mat of this.config.materials) {
            const canvasMatNode = this.model.nodes.find(n =>
                n.id === (mat.parameters as any)?.node_id ||
                n.parameters.name === mat.name ||
                n.parameters.material_name === mat.name
            );
            if (canvasMatNode) {
                const matUpdates: Record<string, any> = {};
                if (mat.density !== undefined) matUpdates.density = mat.density;
                if (mat.youngs_modulus !== undefined) {
                    matUpdates.youngs_modulus = mat.youngs_modulus;
                    matUpdates.e = mat.youngs_modulus;
                }
                if (mat.poissons_ratio !== undefined) {
                    matUpdates.poissons_ratio = mat.poissons_ratio;
                    matUpdates.nu = mat.poissons_ratio;
                }
                if (mat.yield_stress !== undefined) matUpdates.yield_stress = mat.yield_stress;
                if (mat.hardening_modulus !== undefined) matUpdates.hardening_modulus = mat.hardening_modulus;
                if (mat.failure_strain !== undefined) matUpdates.failure_strain = mat.failure_strain;

                this.stateManager.updateNodeParameters(canvasMatNode.id, matUpdates);
            }
        }

        // 3. Persist the unified fem_setup configuration on the active FEM node and domain/coupler nodes
        this.femNode.parameters.fem_setup = JSON.parse(JSON.stringify(this.config));
        this.stateManager.updateNodeParameters(this.femNode.id, {
            fem_setup: this.config,
            _assembly_ts: Date.now()
        });

        const allDomainsAndCouplers = (this.stateManager.getModelForNode(this.femNode.id)?.nodes || this.model.nodes).filter(n =>
            (n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D') && n.id !== this.femNode.id
        );
        for (const domainOrCoupler of allDomainsAndCouplers) {
            this.stateManager.updateNodeParameters(domainOrCoupler.id, {
                fem_setup: this.config,
                _assembly_ts: Date.now()
            });
        }

        // 4. Synchronize display parameters to active View3D node
        const vpNode = this.model.nodes.find(n => n.type === 'Telemetry3DViewport' || (n.type as string) === 'View3D');
        if (vpNode) {
            this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                femWireframe: this.showWireframe,
                showFEMMesh: true,
                femSolid: this.showShaded
            });
        }

        // 5. Mandate physical model state invalidation (Directive 12)
        this.stateManager.setModelStatus(this.model.id, 'UNINITIALIZED');

        this.isDirty = false;
        this.close();
    }

    public close(): void {
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        if (this.onCloseCallback) {
            this.onCloseCallback();
        }
    }

    // ========================================================================
    // Part, Set & Material Interactive Actions
    // ========================================================================
    private renderInPlaceMaterialCard(matAssignment?: string): HTMLElement | null {
        if (!matAssignment || matAssignment === 'DEFAULT') {
            const infoCard = document.createElement('div');
            infoCard.className = 'fem-subcard';
            infoCard.style.marginTop = '10px';
            infoCard.style.padding = '10px 12px';
            infoCard.style.background = 'rgba(255, 255, 255, 0.03)';
            infoCard.style.borderRadius = '6px';
            infoCard.style.border = '1px solid rgba(255, 255, 255, 0.08)';
            infoCard.innerHTML = `
                <div style="font-size: 11px; color: var(--text-muted, #888); display: flex; align-items: center; gap: 6px;">
                    <span>ℹ️</span> <span>Inheriting global default material. Select or create a custom material above to tune constitutive parameters.</span>
                </div>
            `;
            return infoCard;
        }

        if (matAssignment.startsWith('DECK_MAT_')) {
            const matId = parseInt(matAssignment.replace('DECK_MAT_', ''), 10);
            const mat = this.config.materials.find(m => m.mat_id === matId);
            if (!mat) return null;

            const card = document.createElement('div');
            card.className = 'fem-subcard';
            card.style.marginTop = '10px';
            card.style.padding = '12px';
            card.style.background = 'rgba(0, 180, 255, 0.04)';
            card.style.borderRadius = '6px';
            card.style.border = '1px solid rgba(0, 180, 255, 0.2)';

            const header = document.createElement('div');
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';
            header.style.marginBottom = '8px';
            header.innerHTML = `
                <span style="font-size: 12px; font-weight: 600; color: #40c4ff;">🧪 In-Place Material Tuning: ${mat.name}</span>
                <span style="font-size: 10px; padding: 2px 6px; background: rgba(0,180,255,0.15); border-radius: 4px; color: #80d8ff;">${mat.model_type}</span>
            `;
            card.appendChild(header);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr';
            grid.style.gap = '8px';

            const addField = (label: string, value: string, step: string, unit: string, onChange: (val: number) => void) => {
                const field = document.createElement('div');
                field.style.display = 'flex';
                field.style.flexDirection = 'column';
                field.style.gap = '2px';
                const lbl = document.createElement('span');
                lbl.style.fontSize = '10px';
                lbl.style.color = 'var(--text-muted, #999)';
                lbl.textContent = `${label} (${unit})`;
                const input = document.createElement('input');
                input.type = 'number';
                input.step = step;
                input.value = value;
                input.className = 'fem-num-input';
                input.style.width = '100%';
                input.onchange = () => {
                    const num = Number(input.value);
                    onChange(num);
                    this.isDirty = true;
                };
                field.appendChild(lbl);
                field.appendChild(input);
                grid.appendChild(field);
            };

            addField('Density', String(mat.density), '10', 'kg/m³', (v) => { mat.density = v || 7850; });
            addField('Young\'s E', String((mat.youngs_modulus / 1e9).toFixed(1)), '1', 'GPa', (v) => { mat.youngs_modulus = (v || 210) * 1e9; });
            addField('Poisson ν', String(mat.poissons_ratio.toFixed(2)), '0.01', '–', (v) => { mat.poissons_ratio = v || 0.3; });
            addField('Yield σy', String(((mat.yield_stress ?? 400e6) / 1e6).toFixed(1)), '10', 'MPa', (v) => { mat.yield_stress = (v || 400) * 1e6; });
            addField('Hardening Etan', String(((mat.hardening_modulus ?? 1e9) / 1e9).toFixed(2)), '0.1', 'GPa', (v) => { mat.hardening_modulus = (v || 1) * 1e9; });
            addField('Fail Strain', String((mat.failure_strain ?? 0.25).toFixed(2)), '0.05', '–', (v) => { mat.failure_strain = v || 0.25; });

            card.appendChild(grid);
            return card;
        }

        const canvasMats = this.getCanvasMaterials();
        const cMat = canvasMats.find(m => m.id === matAssignment);
        if (cMat) {
            const card = document.createElement('div');
            card.className = 'fem-subcard';
            card.style.marginTop = '10px';
            card.style.padding = '10px 12px';
            card.style.background = 'rgba(255, 180, 0, 0.04)';
            card.style.borderRadius = '6px';
            card.style.border = '1px solid rgba(255, 180, 0, 0.2)';
            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span style="font-size: 12px; font-weight: 600; color: #ffb74d;">⚡ Linked Canvas Node: ${cMat.name}</span>
                    <span style="font-size: 10px; padding: 2px 6px; background: rgba(255,180,0,0.15); border-radius: 4px; color: #ffe082;">${cMat.model_type}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted, #aaa);">
                    ${cMat.youngs_modulus !== undefined ? `E: ${(cMat.youngs_modulus / 1e9).toFixed(1)} GPa · ` : ''}${cMat.poissons_ratio !== undefined ? `ν: ${cMat.poissons_ratio.toFixed(2)} · ` : ''}${cMat.density !== undefined ? `ρ: ${cMat.density.toFixed(0)} kg/m³` : 'Configured via Canvas Node'}
                </div>
            `;
            return card;
        }

        return null;
    }

    private duplicateMaterial(mat: FEMMaterialDefinition): void {
        const nextId = Math.max(0, ...this.config.materials.map(m => m.mat_id)) + 1;
        const copy: FEMMaterialDefinition = {
            mat_id: nextId,
            name: `${mat.name}_Copy`,
            source: 'user_custom',
            model_type: mat.model_type,
            density: mat.density,
            youngs_modulus: mat.youngs_modulus,
            poissons_ratio: mat.poissons_ratio,
            yield_stress: mat.yield_stress,
            hardening_modulus: mat.hardening_modulus,
            failure_strain: mat.failure_strain,
            parameters: { ...(mat.parameters || {}) }
        };
        this.config.materials.push(copy);
        this.selectedMatId = nextId;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
    }

    private createNewMaterial(): void {
        const nextId = Math.max(0, ...this.config.materials.map(m => m.mat_id)) + 1;
        const newMat: FEMMaterialDefinition = {
            mat_id: nextId,
            name: `Material_${nextId}`,
            source: 'user_custom',
            model_type: 'PiecewiseLinearPlasticity',
            density: 7850.0,
            youngs_modulus: 210.0e9,
            poissons_ratio: 0.30,
            yield_stress: 400.0e6,
            hardening_modulus: 1.0e9,
            failure_strain: 0.25,
            parameters: {}
        };
        this.config.materials.push(newMat);
        this.activeTab = 'materials';
        this.selectedMatId = nextId;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
    }

    private convertSetToPart(set: FEMEntitySet): void {
        const nextId = Math.max(0, ...this.config.parts.map(p => p.part_id)) + 1;
        const colors = ['#00e5ff', '#ff9100', '#76ff03', '#e040fb', '#ffd600', '#ff5252', '#40c4ff'];
        const color = colors[nextId % colors.length];

        let secType = set.section_type || (set.set_type === 'BEAM' ? 'Beam3D' : (set.set_type === 'SEGMENT' ? 'Shell4' : 'SolidHex8'));

        const newPart: FEMPartConfig = {
            part_id: nextId,
            name: `Part_${set.name || ('Set_' + set.set_id)}`,
            section_type: secType,
            section_properties: set.section_properties ? { ...set.section_properties } : {
                thickness: 0.005,
                integration_points: 5,
                hourglass_type: 'Flanagan-Belytschko',
                hourglass_coeff: 0.10
            },
            material_assignment: set.material_assignment || 'DEFAULT',
            visible: true,
            suppressed: false,
            color: color,
            num_elements: set.entity_ids.length,
            num_nodes: Math.round(set.entity_ids.length * (secType.includes('Tet') ? 4 : 8)),
            initial_velocity: [0, 0, 0],
            bounds: [0, 1, 0, 1, 0, 1]
        };

        this.config.parts.push(newPart);
        this.activeTab = 'parts';
        this.selectedPartId = nextId;
        this.isDirty = true;
        this.renderTabsAndList();
        this.renderInspector();
        this.requestRender();
    }

    private createNewCustomPart(): void {
        const nextId = Math.max(0, ...this.config.parts.map(p => p.part_id)) + 1;
        const colors = ['#00e5ff', '#ff9100', '#76ff03', '#e040fb', '#ffd600', '#ff5252', '#40c4ff'];
        const color = colors[nextId % colors.length];

        const newPart: FEMPartConfig = {
            part_id: nextId,
            name: `Part_${nextId}`,
            section_type: 'SolidHex8',
            section_properties: {
                hourglass_type: 'Flanagan-Belytschko',
                hourglass_coeff: 0.10,
                thickness: 0.005,
                integration_points: 5
            },
            material_assignment: 'DEFAULT',
            visible: true,
            suppressed: false,
            color: color,
            num_elements: 0,
            num_nodes: 0,
            initial_velocity: [0, 0, 0],
            bounds: [-0.5, 0.5, -0.5, 0.5, -0.5, 0.5],
            shape_type: 'Box',
            origin_mode: 'Center',
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            size_x: 1.0,
            size_y: 1.0,
            size_z: 1.0,
            radius: 0.1,
            height: 0.2,
            nx: 10,
            ny: 10,
            nz: 10
        };

        this.config.parts.push(newPart);
        this.activeTab = 'parts';
        this.selectedPartId = nextId;
        this.isDirty = true;
        this.rebuildPreview();
        this.renderTabsAndList();
        this.renderInspector();
    }

    // ========================================================================
    // Formatting & Utility Helpers
    // ========================================================================
    private updateViewportReadout(): void {
        const el = this.overlay?.querySelector('#fem-viewport-readout');
        const totalConfigElems = this.getTotalElements();
        const totalElems = totalConfigElems > 0 
            ? totalConfigElems 
            : (this.preview?.renderMesh ? (this.preview.renderMesh.facetCount + this.preview.renderMesh.lineCount) : (this.preview?.elements.length || 0));
        const totalConfigNodes = this.getTotalNodes();
        const totalNodes = totalConfigNodes > 0
            ? totalConfigNodes
            : (this.preview?.nodeCoords ? Math.floor(this.preview.nodeCoords.length / 3) : 0);
        const activeBuf = this.findActiveFEMBuffer();
        const srcTag = activeBuf ? `<span class="fem-badge" style="background: rgba(16, 185, 129, 0.2); color: #10b981; font-size: 9px; margin-left: 6px;">Live Telemetry</span>` : '';
        const lodTag = this.lastLODActive 
            ? `<span class="fem-badge" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; font-size: 9px; margin-left: 6px;">⚡ Adaptive LOD</span>` 
            : `<span class="fem-badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; font-size: 9px; margin-left: 6px;">60 FPS (Full Res)</span>`;
        if (el) {
            el.innerHTML = `
                <div><strong>Parts:</strong> ${this.config.parts.length} | <strong>Sets:</strong> ${this.config.sets.length} ${srcTag} ${lodTag}</div>
                <div><strong>Total Model:</strong> ${totalElems.toLocaleString()} Elements | <strong>Nodes:</strong> ${totalNodes.toLocaleString()}</div>
                <div><strong>Rendered:</strong> ${this.lastRenderedCount.toLocaleString()} surface facets/lines</div>
                <div style="font-size: 10px; color: #64748b; margin-top: 4px;">Left Drag: Orbit | Right/Shift Drag: Pan | Scroll: Zoom</div>
            `;
        }
        if (this.footerStatusEl) {
            this.footerStatusEl.innerHTML = `<span>Assembly: <strong>${this.config.parts.filter(p => !p.suppressed).length}</strong> active parts, <strong>${this.config.boundary_conditions.filter(b => b.active).length}</strong> active BCs · <strong>${totalElems.toLocaleString()}</strong> elements · <strong>${this.lastRenderedCount.toLocaleString()}</strong> rendered</span>`;
        }
    }


    private getTotalElements(): number {
        return this.config.parts.reduce((sum, p) => sum + p.num_elements, 0);
    }

    private getTotalNodes(): number {
        if (this.config.parts.length >= 2 &&
            this.config.parts[0].num_nodes === this.config.parts[1].num_nodes &&
            this.config.parts[0].num_nodes > 10000) {
            return this.config.parts[0].num_nodes;
        }
        return this.config.parts.reduce((sum, p) => sum + p.num_nodes, 0);
    }

    private formatMaterialLabel(matKey?: string): string {
        if (!matKey || matKey === 'DEFAULT') return 'Default Mat';
        if (matKey.startsWith('DECK_MAT_')) {
            const id = parseInt(matKey.replace('DECK_MAT_', ''), 10);
            const dMat = this.config.materials.find(m => m.mat_id === id);
            return dMat ? dMat.name : `Deck Mat ${id}`;
        }
        if (matKey.includes('Steel') || matKey.includes('Plasticity')) {
            return 'Steel_MAT024';
        }
        if (matKey.includes('Concrete')) {
            return 'Concrete_MAT072R3';
        }
        const cMat = this.getCanvasMaterials().find(m => m.id === matKey);
        return cMat ? cMat.name : matKey;
    }
}
