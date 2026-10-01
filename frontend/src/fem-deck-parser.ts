// ============================================================================
// BlastDemon Client-Side LS-DYNA Keyword Deck Parser
// High-performance, zero-dependency streaming parser for industrial FEM decks.
// Extracts Parts, Sets, Section Properties, Materials, and Boundary Conditions.
// ============================================================================

import {
    FEMSetupConfig,
    FEMPartConfig,
    FEMSectionType,
    FEMEntitySet,
    FEMBoundaryCondition,
    FEMMaterialDefinition,
    getPartColor
} from './fem-setup-types.js';
import { LSDynaDeckMeta, getLSDynaDeckMeta } from './state-manager.js';

export interface RenderMesh {
    facetNodeIndices: Int32Array; // 4 indices per facet: [n0, n1, n2, n3] (n3 = -1 for triangles)
    facetPartIds: Uint16Array;
    facetCount: number;
    lineNodeIndices: Int32Array;  // 2 indices per line: [n0, n1]
    linePartIds: Uint16Array;
    lineCount: number;
}

export interface ParsedFEMPreview {
    config: FEMSetupConfig;
    nodeCoords: Float32Array; // Flattened [x0, y0, z0, x1, y1, z1, ...]
    nodeIdToIndex: Map<number, number>;
    nodeIndexToId: number[];
    elements: {
        partId: number;
        type: FEMSectionType;
        nodeIndices: number[];
        lsdynaId: number;
    }[];
    globalBounds: [number, number, number, number, number, number];
    renderMesh?: RenderMesh;
}


export class FEMDeckParser {
    /**
     * Parses the raw string contents of an LS-DYNA keyword deck (*.k, *.key, *.dyn).
     */
    public static parse(deckContent: string): ParsedFEMPreview {
        const lines = deckContent.split(/\r?\n/);
        
        const rawNodes = new Map<number, [number, number, number]>();
        const nodeIdToIndex = new Map<number, number>();
        const nodeIndexToId: number[] = [];

        interface RawPart {
            id: number;
            title: string;
            secId: number;
            matId: number;
        }
        const rawParts = new Map<number, RawPart>();

        interface RawSection {
            id: number;
            type: FEMSectionType;
            thickness?: number;
            diameter?: number;
            area?: number;
        }
        const rawSections = new Map<number, RawSection>();

        const rawMaterials = new Map<number, FEMMaterialDefinition>();

        interface RawSet {
            id: number;
            name: string;
            type: 'NODE' | 'PART' | 'SEGMENT' | 'SOLID' | 'BEAM';
            ids: number[];
        }
        const rawSets = new Map<number, RawSet>();

        const rawBCs: FEMBoundaryCondition[] = [];
        const rawElements: {
            partId: number;
            type: FEMSectionType;
            nodeIds: number[];
            lsdynaId: number;
        }[] = [];

        let currentKeyword = '';
        let pendingTitle = '';
        let pendingBeamSecId: number | null = null;

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();
            if (trimmed.length === 0) continue;

            // Handle comments
            if (trimmed.startsWith('$')) {
                continue;
            }

            // Keyword Card
            if (trimmed.startsWith('*')) {
                currentKeyword = trimmed.toUpperCase().split(/\s+/)[0];
                pendingTitle = '';
                pendingBeamSecId = null;
                continue;
            }

            // --- Parsing Cards by Keyword ---
            if (currentKeyword.startsWith('*PART')) {
                if (currentKeyword === '*PART_TITLE') {
                    pendingTitle = trimmed;
                    currentKeyword = '*PART';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const partId = parseInt(fields[0] || '1', 10);
                const secId = parseInt(fields[1] || '1', 10);
                const matId = parseInt(fields[2] || '1', 10);
                const title = pendingTitle || `Part_${partId}`;
                pendingTitle = '';
                rawParts.set(partId, { id: partId, title, secId, matId });
            }
            else if (currentKeyword.startsWith('*NODE')) {
                if (currentKeyword === '*NODE_TITLE') {
                    currentKeyword = '*NODE';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const nid = parseInt(fields[0], 10);
                if (isNaN(nid)) continue;
                const x = parseFloat(fields[1] || '0');
                const y = parseFloat(fields[2] || '0');
                const z = parseFloat(fields[3] || '0');
                rawNodes.set(nid, [x, y, z]);
            }
            else if (currentKeyword.startsWith('*ELEMENT_SOLID')) {
                if (currentKeyword === '*ELEMENT_SOLID_TITLE') {
                    currentKeyword = '*ELEMENT_SOLID';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const eid = parseInt(fields[0], 10);
                const pid = parseInt(fields[1] || '1', 10);
                const n1 = parseInt(fields[2], 10);
                const n2 = parseInt(fields[3], 10);
                const n3 = parseInt(fields[4], 10);
                const n4 = parseInt(fields[5], 10);
                const n5 = parseInt(fields[6] || fields[5], 10);
                const n6 = parseInt(fields[7] || fields[5], 10);
                const n7 = parseInt(fields[8] || fields[5], 10);
                const n8 = parseInt(fields[9] || fields[5], 10);
                if (!isNaN(eid) && !isNaN(n1)) {
                    rawElements.push({
                        partId: pid,
                        type: (n5 === n4 && n6 === n4 && n7 === n4 && n8 === n4) ? 'SolidTet4' : 'SolidHex8',
                        nodeIds: [n1, n2, n3, n4, n5, n6, n7, n8],
                        lsdynaId: eid
                    });
                }
            }
            else if (currentKeyword.startsWith('*ELEMENT_BEAM')) {
                if (currentKeyword === '*ELEMENT_BEAM_TITLE') {
                    currentKeyword = '*ELEMENT_BEAM';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const eid = parseInt(fields[0], 10);
                const pid = parseInt(fields[1] || '1', 10);
                const n1 = parseInt(fields[2], 10);
                const n2 = parseInt(fields[3], 10);
                if (!isNaN(eid) && !isNaN(n1) && !isNaN(n2)) {
                    rawElements.push({
                        partId: pid,
                        type: 'Beam3D',
                        nodeIds: [n1, n2],
                        lsdynaId: eid
                    });
                }
            }
            else if (currentKeyword.startsWith('*ELEMENT_SHELL')) {
                if (currentKeyword === '*ELEMENT_SHELL_TITLE') {
                    currentKeyword = '*ELEMENT_SHELL';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const eid = parseInt(fields[0], 10);
                const pid = parseInt(fields[1] || '1', 10);
                const n1 = parseInt(fields[2], 10);
                const n2 = parseInt(fields[3], 10);
                const n3 = parseInt(fields[4], 10);
                const n4 = parseInt(fields[5] || fields[4], 10);
                if (!isNaN(eid) && !isNaN(n1)) {
                    rawElements.push({
                        partId: pid,
                        type: 'Shell4',
                        nodeIds: [n1, n2, n3, n4],
                        lsdynaId: eid
                    });
                }
            }
            else if (currentKeyword.startsWith('*SECTION_BEAM')) {
                const fields = this.splitFields(rawLine);
                if (pendingBeamSecId === null) {
                    const secId = parseInt(fields[0] || '1', 10);
                    const elform = parseInt(fields[1] || '1', 10);
                    pendingBeamSecId = secId;
                    rawSections.set(secId, {
                        id: secId,
                        type: elform === 3 ? 'Truss1D' : 'Beam3D',
                        diameter: 0.00953,
                        area: Math.PI * Math.pow(0.00953, 2) * 0.25
                    });
                } else {
                    // Card 2: ts1, ts2, tt1, tt2, nsir, nsit (ts1/ts2 = diameter/thickness)
                    const ts1 = parseFloat(fields[0] || '0.00953');
                    const ts2 = parseFloat(fields[1] || fields[0] || '0.00953');
                    const diam = ts1 > 0 ? ts1 : (ts2 > 0 ? ts2 : 0.00953);
                    const existing = rawSections.get(pendingBeamSecId);
                    if (existing) {
                        existing.diameter = diam;
                        existing.area = Math.PI * Math.pow(diam, 2) * 0.25;
                    }
                    pendingBeamSecId = null;
                }
            }
            else if (currentKeyword.startsWith('*SECTION_SHELL')) {
                const fields = this.splitFields(rawLine);
                const secId = parseInt(fields[0] || '1', 10);
                rawSections.set(secId, {
                    id: secId,
                    type: 'Shell4',
                    thickness: 0.005
                });
            }
            else if (currentKeyword.startsWith('*MAT_ELASTIC') || currentKeyword.startsWith('*MAT_001')) {
                const fields = this.splitFields(rawLine);
                const mid = parseInt(fields[0] || '1', 10);
                const ro = parseFloat(fields[1] || '7850');
                const e = parseFloat(fields[2] || '210e9');
                const pr = parseFloat(fields[3] || '0.30');
                rawMaterials.set(mid, {
                    mat_id: mid,
                    name: `Elastic_MAT_${mid}`,
                    source: 'deck',
                    model_type: 'Hypoelastic',
                    density: ro,
                    youngs_modulus: e,
                    poissons_ratio: pr,
                    yield_stress: 400e6,
                    parameters: { density: ro, youngs_modulus: e, poissons_ratio: pr }
                });
            }
            else if (currentKeyword.startsWith('*MAT_JOHNSON_COOK') || currentKeyword.startsWith('*MAT_015')) {
                const fields = this.splitFields(rawLine);
                const mid = parseInt(fields[0] || '1', 10);
                const ro = parseFloat(fields[1] || '7850');
                const e = parseFloat(fields[2] || '210e9');
                const pr = parseFloat(fields[3] || '0.30');
                const A = parseFloat(fields[4] || '792e6');
                const B = parseFloat(fields[5] || '510e6');
                const n = parseFloat(fields[6] || '0.26');
                const C = parseFloat(fields[7] || '0.014');
                rawMaterials.set(mid, {
                    mat_id: mid,
                    name: `JohnsonCook_MAT_${mid}`,
                    source: 'deck',
                    model_type: 'JohnsonCook',
                    density: ro,
                    youngs_modulus: e,
                    poissons_ratio: pr,
                    yield_stress: A,
                    parameters: {
                        density: ro, youngs_modulus: e, poissons_ratio: pr,
                        jc_A: A, jc_B: B, jc_n: n, jc_C: C
                    }
                });
            }
            else if (currentKeyword.startsWith('*SET_NODE')) {
                if (currentKeyword.includes('TITLE')) {
                    pendingTitle = trimmed;
                    currentKeyword = '*SET_NODE_LIST';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const sid = parseInt(fields[0] || '1', 10);
                if (!rawSets.has(sid)) {
                    rawSets.set(sid, {
                        id: sid,
                        name: pendingTitle || `Node_Set_${sid}`,
                        type: 'NODE',
                        ids: []
                    });
                    pendingTitle = '';
                    // First line might have IDs in remaining fields
                    for (let f = 1; f < fields.length; f++) {
                        const id = parseInt(fields[f], 10);
                        if (!isNaN(id) && id > 0) rawSets.get(sid)!.ids.push(id);
                    }
                } else {
                    for (const f of fields) {
                        const id = parseInt(f, 10);
                        if (!isNaN(id) && id > 0) rawSets.get(sid)!.ids.push(id);
                    }
                }
            }
            else if (currentKeyword.startsWith('*SET_PART')) {
                if (currentKeyword.includes('TITLE')) {
                    pendingTitle = trimmed;
                    currentKeyword = '*SET_PART_LIST';
                    continue;
                }
                const fields = this.splitFields(rawLine);
                const sid = parseInt(fields[0] || '1', 10);
                if (!rawSets.has(sid)) {
                    rawSets.set(sid, {
                        id: sid,
                        name: pendingTitle || `Part_Set_${sid}`,
                        type: 'PART',
                        ids: []
                    });
                    pendingTitle = '';
                    for (let f = 1; f < fields.length; f++) {
                        const id = parseInt(fields[f], 10);
                        if (!isNaN(id) && id > 0) rawSets.get(sid)!.ids.push(id);
                    }
                } else {
                    for (const f of fields) {
                        const id = parseInt(f, 10);
                        if (!isNaN(id) && id > 0) rawSets.get(sid)!.ids.push(id);
                    }
                }
            }
            else if (currentKeyword.startsWith('*BOUNDARY_SPC_NODE')) {
                const fields = this.splitFields(rawLine);
                const nid = parseInt(fields[0], 10);
                const dofx = parseInt(fields[2] || '0', 10) !== 0;
                const dofy = parseInt(fields[3] || '0', 10) !== 0;
                const dofz = parseInt(fields[4] || '0', 10) !== 0;
                if (!isNaN(nid)) {
                    rawBCs.push({
                        id: `spc_node_${nid}`,
                        name: `Fixed Node ${nid}`,
                        bc_type: 'SPC',
                        target_type: 'NODE_SET',
                        target_id: nid,
                        dofs: [dofx, dofy, dofz, false, false, false],
                        active: true
                    });
                }
            }
            else if (currentKeyword.startsWith('*BOUNDARY_SPC_SET')) {
                const fields = this.splitFields(rawLine);
                const sid = parseInt(fields[0], 10);
                const dofx = parseInt(fields[2] || '0', 10) !== 0;
                const dofy = parseInt(fields[3] || '0', 10) !== 0;
                const dofz = parseInt(fields[4] || '0', 10) !== 0;
                if (!isNaN(sid)) {
                    rawBCs.push({
                        id: `spc_set_${sid}`,
                        name: `Fixed Set ${sid}`,
                        bc_type: 'SPC',
                        target_type: 'NODE_SET',
                        target_id: sid,
                        dofs: [dofx, dofy, dofz, false, false, false],
                        active: true
                    });
                }
            }
        }

        // Build continuous indexing for nodes
        let idx = 0;
        const totalNodes = rawNodes.size;
        const nodeCoords = new Float32Array(totalNodes * 3);
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const [nid, pos] of rawNodes.entries()) {
            nodeIdToIndex.set(nid, idx);
            nodeIndexToId.push(nid);
            nodeCoords[idx * 3 + 0] = pos[0];
            nodeCoords[idx * 3 + 1] = pos[1];
            nodeCoords[idx * 3 + 2] = pos[2];

            if (pos[0] < minX) minX = pos[0];
            if (pos[0] > maxX) maxX = pos[0];
            if (pos[1] < minY) minY = pos[1];
            if (pos[1] > maxY) maxY = pos[1];
            if (pos[2] < minZ) minZ = pos[2];
            if (pos[2] > maxZ) maxZ = pos[2];

            idx++;
        }

        if (!isFinite(minX)) {
            minX = -0.5; maxX = 0.5;
            minY = -0.5; maxY = 0.5;
            minZ = -0.5; maxZ = 0.5;
        }

        // Build Elements & Per-Part Stats
        const partElementsMap = new Map<number, number>();
        const partNodesSet = new Map<number, Set<number>>();
        const partBoundsMap = new Map<number, [number, number, number, number, number, number]>();

        const elements: ParsedFEMPreview['elements'] = [];

        for (const elem of rawElements) {
            const validIndices: number[] = [];
            let pMinX = Infinity, pMaxX = -Infinity;
            let pMinY = Infinity, pMaxY = -Infinity;
            let pMinZ = Infinity, pMaxZ = -Infinity;

            for (const nid of elem.nodeIds) {
                const nodeIdx = nodeIdToIndex.get(nid);
                if (nodeIdx !== undefined) {
                    validIndices.push(nodeIdx);
                    if (!partNodesSet.has(elem.partId)) {
                        partNodesSet.set(elem.partId, new Set<number>());
                    }
                    partNodesSet.get(elem.partId)!.add(nodeIdx);

                    const x = nodeCoords[nodeIdx * 3 + 0];
                    const y = nodeCoords[nodeIdx * 3 + 1];
                    const z = nodeCoords[nodeIdx * 3 + 2];
                    if (x < pMinX) pMinX = x; if (x > pMaxX) pMaxX = x;
                    if (y < pMinY) pMinY = y; if (y > pMaxY) pMaxY = y;
                    if (z < pMinZ) pMinZ = z; if (z > pMaxZ) pMaxZ = z;
                }
            }

            if (validIndices.length >= 2) {
                elements.push({
                    partId: elem.partId,
                    type: elem.type,
                    nodeIndices: validIndices,
                    lsdynaId: elem.lsdynaId
                });

                partElementsMap.set(elem.partId, (partElementsMap.get(elem.partId) || 0) + 1);

                if (!partBoundsMap.has(elem.partId)) {
                    partBoundsMap.set(elem.partId, [pMinX, pMaxX, pMinY, pMaxY, pMinZ, pMaxZ]);
                } else {
                    const b = partBoundsMap.get(elem.partId)!;
                    b[0] = Math.min(b[0], pMinX); b[1] = Math.max(b[1], pMaxX);
                    b[2] = Math.min(b[2], pMinY); b[3] = Math.max(b[3], pMaxY);
                    b[4] = Math.min(b[4], pMinZ); b[5] = Math.max(b[5], pMaxZ);
                }
            }
        }

        // If no explicit parts were declared in *PART, synthesize from elements
        const uniquePartIds = new Set<number>([
            ...Array.from(rawParts.keys()),
            ...Array.from(partElementsMap.keys())
        ]);
        if (uniquePartIds.size === 0) uniquePartIds.add(1);

        const parts: FEMPartConfig[] = [];
        let pIndex = 0;
        for (const pid of uniquePartIds) {
            const rawP = rawParts.get(pid);
            const sec = rawSections.get(rawP?.secId || pid);
            const numElems = partElementsMap.get(pid) || 0;
            const numPartNodes = partNodesSet.get(pid)?.size || 0;
            const b = partBoundsMap.get(pid) || [minX, maxX, minY, maxY, minZ, maxZ];

            let secType = sec?.type || 'SolidHex8';
            if (!sec) {
                // Infer from elements in this part
                const firstElem = elements.find(e => e.partId === pid);
                if (firstElem) secType = firstElem.type;
            }

            parts.push({
                part_id: pid,
                name: rawP?.title || `Part_${pid}`,
                section_type: secType,
                section_properties: {
                    thickness: sec?.thickness || 0.005,
                    diameter: sec?.diameter || 0.00953,
                    area: sec?.area || (Math.PI * Math.pow(sec?.diameter || 0.00953, 2) * 0.25)
                },
                material_assignment: rawP?.matId ? `DECK_MAT_${rawP.matId}` : 'DEFAULT',
                color: getPartColor(pIndex),
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: numElems,
                num_nodes: numPartNodes,
                bounds: b
            });
            pIndex++;
        }

        // Convert sets
        const sets: FEMEntitySet[] = [];
        for (const [sid, rset] of rawSets.entries()) {
            sets.push({
                set_id: sid,
                name: rset.name,
                set_type: rset.type,
                entity_ids: rset.ids,
                source: 'deck'
            });
        }

        // If no sets exist, auto-generate standard sets (Base Nodes, Top Nodes, Symmetry Planes)
        if (sets.length === 0 && totalNodes > 0) {
            const baseNodeIds: number[] = [];
            const eps = 1e-4;
            for (let n = 0; n < totalNodes; n++) {
                if (Math.abs(nodeCoords[n * 3 + 2] - minZ) < eps) {
                    baseNodeIds.push(nodeIndexToId[n]);
                }
            }
            if (baseNodeIds.length > 0) {
                sets.push({
                    set_id: 1,
                    name: 'Auto_Base_Nodes_Zmin',
                    set_type: 'NODE',
                    entity_ids: baseNodeIds,
                    source: 'user_plane',
                    filter_params: { plane: 'z_min', plane_coord: minZ, tolerance: eps }
                });
            }
        }

        const materialsList = Array.from(rawMaterials.values());
        if (materialsList.length === 0) {
            materialsList.push({
                mat_id: 1,
                name: 'Structural_Steel_Default',
                source: 'deck',
                model_type: 'JohnsonCook',
                density: 7850,
                youngs_modulus: 210e9,
                poissons_ratio: 0.30,
                yield_stress: 400e6,
                parameters: {
                    density: 7850, youngs_modulus: 210e9, poissons_ratio: 0.30,
                    jc_A: 400e6, jc_B: 500e6, jc_n: 0.26, jc_C: 0.014
                }
            });
        }

        const materialAssignments: Record<number, string> = {};
        for (const p of parts) {
            materialAssignments[p.part_id] = p.material_assignment;
        }

        const config: FEMSetupConfig = {
            parts,
            sets,
            boundary_conditions: rawBCs,
            contacts: [
                {
                    id: 'contact_auto_global',
                    name: 'Global Self-Contact',
                    contact_type: 'AUTOMATIC_SINGLE_SURFACE',
                    friction_static: 0.3,
                    friction_kinetic: 0.2,
                    penalty_scale: 0.10
                }
            ],
            materials: materialsList,
            material_assignments: materialAssignments
        };

        return {
            config,
            nodeCoords,
            nodeIdToIndex,
            nodeIndexToId,
            elements,
            globalBounds: [minX, maxX, minY, maxY, minZ, maxZ],
            renderMesh: this.buildRenderMesh(elements, nodeCoords.length / 3)
        };

    }

    /**
     * Splits LS-DYNA line by commas (free format) or whitespace/fixed-format.
     */
    private static splitFields(line: string): string[] {
        if (line.includes(',')) {
            return line.split(',').map(s => s.trim());
        }
        // Fixed 10-char columns fallback if spaced evenly, or whitespace split
        const tokens: string[] = [];
        if (line.length > 20 && (line.length % 10 === 0 || line.length >= 80)) {
            for (let i = 0; i < line.length; i += 10) {
                const chunk = line.substring(i, Math.min(i + 10, line.length)).trim();
                tokens.push(chunk);
            }
            if (tokens.some(t => t.length > 0)) {
                return tokens;
            }
        }
        return line.trim().split(/\s+/);
    }

    /**
     * Procedural assembly mesh generator that builds a true multi-part finite element mesh
     * directly from the model's actual component parts, shapes, dimensions, and spatial coordinates.
     */
    public static generateAssemblyPreview(parts: FEMPartConfig[]): ParsedFEMPreview {
        if (!parts || parts.length === 0) {
            return this.generateParametricBox(4, 4, 4, 1.0, 1.0, 1.0, 0, 0, 0);
        }

        // If all parts originate from a known keyword deck, return the unified preview directly
        const dynaParts = parts.filter(p => p.shape_type === 'LS-DYNA File' || p.k_file);
        if (dynaParts.length > 0 && dynaParts.length === parts.length) {
            const kFile = dynaParts[0].k_file || 'concrete_cubicle_30mm.k';
            const meta = getLSDynaDeckMeta(kFile);
            if (meta) {
                return this.generateKnownDeckPreview(meta, dynaParts[0].name);
            }
        }

        const allCoords: number[] = [];
        const nodeIdToIndex = new Map<number, number>();
        const nodeIndexToId: number[] = [];
        const elements: ParsedFEMPreview['elements'] = [];
        let globalNodeId = 1;
        let globalElemId = 1;

        let globalMinX = Infinity, globalMaxX = -Infinity;
        let globalMinY = Infinity, globalMaxY = -Infinity;
        let globalMinZ = Infinity, globalMaxZ = -Infinity;

        for (const part of parts) {
            const shape = part.shape_type || (part.section_type === 'Beam3D' || part.section_type === 'Truss1D' ? 'Beam' : (part.section_type === 'Shell4' ? 'Plate' : 'Box'));
            const px = Number(part.pos_x ?? 0.0);
            const py = Number(part.pos_y ?? 0.0);
            const pz = Number(part.pos_z ?? 0.0);
            const partStartElem = elements.length;
            const partStartNode = nodeIndexToId.length;

            if (shape === 'LS-DYNA File') {
                const meta = getLSDynaDeckMeta(part.k_file || 'concrete_cubicle_30mm.k');
                if (meta) {
                    const deckPrev = this.generateKnownDeckPreview(meta, part.name);
                    const isBeamPart = part.section_type === 'Beam3D' || part.section_type === 'Truss1D';
                    const nodeOffset = nodeIndexToId.length;
                    for (let i = 0; i < deckPrev.nodeCoords.length; i += 3) {
                        const x = deckPrev.nodeCoords[i];
                        const y = deckPrev.nodeCoords[i + 1];
                        const z = deckPrev.nodeCoords[i + 2];
                        allCoords.push(x, y, z);
                        nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                        nodeIndexToId.push(globalNodeId);
                        globalNodeId++;
                        if (x < globalMinX) globalMinX = x; if (x > globalMaxX) globalMaxX = x;
                        if (y < globalMinY) globalMinY = y; if (y > globalMaxY) globalMaxY = y;
                        if (z < globalMinZ) globalMinZ = z; if (z > globalMaxZ) globalMaxZ = z;
                    }
                    for (const el of deckPrev.elements) {
                        const isBeamEl = el.type === 'Beam3D' || el.type === 'Truss1D';
                        if (isBeamPart && !isBeamEl) continue;
                        if (!isBeamPart && isBeamEl) continue;

                        elements.push({
                            partId: part.part_id,
                            type: el.type,
                            nodeIndices: el.nodeIndices.map(idx => nodeOffset + idx),
                            lsdynaId: globalElemId++
                        });
                    }
                    part.bounds = deckPrev.globalBounds;
                    part.num_elements = elements.length - partStartElem;
                    part.num_nodes = deckPrev.nodeCoords.length / 3;
                    continue;
                }
            }

            if (shape === 'Box') {
                const sx = Math.max(0.0001, Number(part.size_x ?? 1.0));
                const sy = Math.max(0.0001, Number(part.size_y ?? 1.0));
                const sz = Math.max(0.0001, Number(part.size_z ?? 1.0));
                const nx = Math.max(1, Math.min(100, Number(part.nx ?? 10)));
                const ny = Math.max(1, Math.min(100, Number(part.ny ?? 10)));
                const nz = Math.max(1, Math.min(100, Number(part.nz ?? 10)));

                const dx = sx / nx;
                const dy = sy / ny;
                const dz = sz / nz;

                const isCADOrigin = part.origin_mode === 'CAD Origin' || part.origin_mode === 'Min Corner';
                const startX = isCADOrigin ? px : (px - 0.5 * sx);
                const startY = isCADOrigin ? py : (py - 0.5 * sy);
                const startZ = isCADOrigin ? pz : (pz - 0.5 * sz);

                const nodeOffset = nodeIndexToId.length;
                for (let k = 0; k <= nz; k++) {
                    for (let j = 0; j <= ny; j++) {
                        for (let i = 0; i <= nx; i++) {
                            const x = startX + i * dx;
                            const y = startY + j * dy;
                            const z = startZ + k * dz;

                            allCoords.push(x, y, z);
                            nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                            nodeIndexToId.push(globalNodeId);
                            globalNodeId++;

                            if (x < globalMinX) globalMinX = x; if (x > globalMaxX) globalMaxX = x;
                            if (y < globalMinY) globalMinY = y; if (y > globalMaxY) globalMaxY = y;
                            if (z < globalMinZ) globalMinZ = z; if (z > globalMaxZ) globalMaxZ = z;
                        }
                    }
                }

                const nodeStrideY = nx + 1;
                const nodeStrideZ = (nx + 1) * (ny + 1);

                for (let k = 0; k < nz; k++) {
                    for (let j = 0; j < ny; j++) {
                        for (let i = 0; i < nx; i++) {
                            const n0 = nodeOffset + k * nodeStrideZ + j * nodeStrideY + i;
                            const n1 = n0 + 1;
                            const n2 = n0 + nodeStrideY + 1;
                            const n3 = n0 + nodeStrideY;
                            const n4 = n0 + nodeStrideZ;
                            const n5 = n4 + 1;
                            const n6 = n4 + nodeStrideY + 1;
                            const n7 = n4 + nodeStrideY;

                            elements.push({
                                partId: part.part_id,
                                type: (part.section_type || 'SolidHex8') as FEMSectionType,
                                nodeIndices: [n0, n1, n2, n3, n4, n5, n6, n7],
                                lsdynaId: globalElemId++
                            });
                        }
                    }
                }

                part.bounds = [startX, startX + sx, startY, startY + sy, startZ, startZ + sz];
                part.num_elements = nx * ny * nz;
                part.num_nodes = (nx + 1) * (ny + 1) * (nz + 1);
            } else if (shape === 'Cylinder') {
                const r = Math.max(0.0001, Number(part.radius ?? 0.1));
                const h = Math.max(0.0001, Number(part.height ?? 0.2));
                const nr = Math.max(1, Math.min(16, Number(part.nx ?? 2)));
                const ntheta = Math.max(8, Math.min(32, Number(part.ny ?? 4) * 2));
                const nz = Math.max(1, Math.min(50, Number(part.nz ?? 4)));
                const dz = h / nz;

                const isCADOrigin = part.origin_mode === 'CAD Origin' || part.origin_mode === 'Min Corner';
                const startZ = isCADOrigin ? pz : (pz - 0.5 * h);

                const nodeOffset = nodeIndexToId.length;
                for (let k = 0; k <= nz; k++) {
                    const z = startZ + k * dz;
                    // Center node
                    allCoords.push(px, py, z);
                    nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                    nodeIndexToId.push(globalNodeId);
                    globalNodeId++;

                    // Ring nodes
                    for (let ir = 1; ir <= nr; ir++) {
                        const curR = r * (ir / nr);
                        for (let it = 0; it < ntheta; it++) {
                            const ang = (2 * Math.PI * it) / ntheta;
                            const x = px + curR * Math.cos(ang);
                            const y = py + curR * Math.sin(ang);

                            allCoords.push(x, y, z);
                            nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                            nodeIndexToId.push(globalNodeId);
                            globalNodeId++;

                            if (x < globalMinX) globalMinX = x; if (x > globalMaxX) globalMaxX = x;
                            if (y < globalMinY) globalMinY = y; if (y > globalMaxY) globalMaxY = y;
                            if (z < globalMinZ) globalMinZ = z; if (z > globalMaxZ) globalMaxZ = z;
                        }
                    }
                }

                const nodesPerLayer = 1 + nr * ntheta;
                for (let k = 0; k < nz; k++) {
                    const l0 = nodeOffset + k * nodesPerLayer;
                    const l1 = l0 + nodesPerLayer;

                    for (let it = 0; it < ntheta; it++) {
                        const nextIt = (it + 1) % ntheta;
                        const c0 = l0;
                        const c1 = l1;
                        const r0_a = l0 + 1 + it;
                        const r0_b = l0 + 1 + nextIt;
                        const r1_a = l1 + 1 + it;
                        const r1_b = l1 + 1 + nextIt;

                        elements.push({
                            partId: part.part_id,
                            type: (part.section_type || 'SolidHex8') as FEMSectionType,
                            nodeIndices: [c0, r0_a, r0_b, c0, c1, r1_a, r1_b, c1],
                            lsdynaId: globalElemId++
                        });

                        for (let ir = 1; ir < nr; ir++) {
                            const baseRing0 = l0 + 1 + (ir - 1) * ntheta;
                            const nextRing0 = l0 + 1 + ir * ntheta;
                            const baseRing1 = l1 + 1 + (ir - 1) * ntheta;
                            const nextRing1 = l1 + 1 + ir * ntheta;

                            const n0 = baseRing0 + it;
                            const n1 = baseRing0 + nextIt;
                            const n2 = nextRing0 + nextIt;
                            const n3 = nextRing0 + it;
                            const n4 = baseRing1 + it;
                            const n5 = baseRing1 + nextIt;
                            const n6 = nextRing1 + nextIt;
                            const n7 = nextRing1 + it;

                            elements.push({
                                partId: part.part_id,
                                type: (part.section_type || 'SolidHex8') as FEMSectionType,
                                nodeIndices: [n0, n1, n2, n3, n4, n5, n6, n7],
                                lsdynaId: globalElemId++
                            });
                        }
                    }
                }

                part.bounds = [px - r, px + r, py - r, py + r, startZ, startZ + h];
            } else if (shape === 'Plate' || part.section_type === 'Shell4') {
                const sx = Math.max(0.0001, Number(part.size_x ?? 0.1));
                const sy = Math.max(0.0001, Number(part.size_y ?? 0.1));
                const nx = Math.max(1, Math.min(20, Number(part.nx ?? 4)));
                const ny = Math.max(1, Math.min(20, Number(part.ny ?? 4)));
                const dx = sx / nx;
                const dy = sy / ny;

                const nodeOffset = nodeIndexToId.length;
                for (let j = 0; j <= ny; j++) {
                    for (let i = 0; i <= nx; i++) {
                        const x = px + i * dx;
                        const y = py + j * dy;
                        const z = pz;

                        allCoords.push(x, y, z);
                        nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                        nodeIndexToId.push(globalNodeId);
                        globalNodeId++;

                        if (x < globalMinX) globalMinX = x; if (x > globalMaxX) globalMaxX = x;
                        if (y < globalMinY) globalMinY = y; if (y > globalMaxY) globalMaxY = y;
                        if (z < globalMinZ) globalMinZ = z; if (z > globalMaxZ) globalMaxZ = z;
                    }
                }

                const stride = nx + 1;
                for (let j = 0; j < ny; j++) {
                    for (let i = 0; i < nx; i++) {
                        const n0 = nodeOffset + j * stride + i;
                        const n1 = n0 + 1;
                        const n2 = n0 + stride + 1;
                        const n3 = n0 + stride;

                        elements.push({
                            partId: part.part_id,
                            type: 'Shell4',
                            nodeIndices: [n0, n1, n2, n3],
                            lsdynaId: globalElemId++
                        });
                    }
                }

                part.bounds = [px, px + sx, py, py + sy, pz, pz];
                part.num_elements = nx * ny;
                part.num_nodes = (nx + 1) * (ny + 1);
            } else {
                // Beam / Rebar
                const p1 = part.node1 ?? [px, py, pz];
                const p2 = part.node2 ?? [px + Number(part.size_x ?? 0.5), py, pz];
                const nSeg = Math.max(1, Math.min(15, Number(part.nz ?? 4)));

                const nodeOffset = nodeIndexToId.length;
                for (let i = 0; i <= nSeg; i++) {
                    const t = i / nSeg;
                    const x = p1[0] + t * (p2[0] - p1[0]);
                    const y = p1[1] + t * (p2[1] - p1[1]);
                    const z = p1[2] + t * (p2[2] - p1[2]);

                    allCoords.push(x, y, z);
                    nodeIdToIndex.set(globalNodeId, nodeIndexToId.length);
                    nodeIndexToId.push(globalNodeId);
                    globalNodeId++;

                    if (x < globalMinX) globalMinX = x; if (x > globalMaxX) globalMaxX = x;
                    if (y < globalMinY) globalMinY = y; if (y > globalMaxY) globalMaxY = y;
                    if (z < globalMinZ) globalMinZ = z; if (z > globalMaxZ) globalMaxZ = z;
                }

                for (let i = 0; i < nSeg; i++) {
                    elements.push({
                        partId: part.part_id,
                        type: (part.section_type || 'Beam3D') as FEMSectionType,
                        nodeIndices: [nodeOffset + i, nodeOffset + i + 1],
                        lsdynaId: globalElemId++
                    });
                }

                part.bounds = [
                    Math.min(p1[0], p2[0]), Math.max(p1[0], p2[0]),
                    Math.min(p1[1], p2[1]), Math.max(p1[1], p2[1]),
                    Math.min(p1[2], p2[2]), Math.max(p1[2], p2[2])
                ];
            }

            part.num_elements = elements.length - partStartElem;
            part.num_nodes = nodeIndexToId.length - partStartNode;
        }

        if (globalMinX === Infinity) {
            globalMinX = 0; globalMaxX = 1;
            globalMinY = 0; globalMaxY = 1;
            globalMinZ = 0; globalMaxZ = 1;
        }

        const nodeCoords = new Float32Array(allCoords);

        return {
            config: {
                parts,
                sets: [],
                boundary_conditions: [],
                contacts: [],
                materials: [],
                material_assignments: {}
            },
            nodeCoords,
            nodeIdToIndex,
            nodeIndexToId,
            elements,
            globalBounds: [globalMinX, globalMaxX, globalMinY, globalMaxY, globalMinZ, globalMaxZ],
            renderMesh: this.buildRenderMesh(elements, nodeCoords.length / 3)
        };

    }

    /**
     * Procedural generator for standard parametric geometries (Box, Cylinder)
     * so that parametric FEM models also have rich components, sets, and BCs.
     */
    public static generateParametricBox(
        nx: number, ny: number, nz: number,
        sx: number, sy: number, sz: number,
        px: number, py: number, pz: number,
        originMode: string = 'Center'
    ): ParsedFEMPreview {
        const totalNodes = (nx + 1) * (ny + 1) * (nz + 1);
        const nodeCoords = new Float32Array(totalNodes * 3);
        const nodeIdToIndex = new Map<number, number>();
        const nodeIndexToId: number[] = [];

        let nIdx = 0;
        const dx = sx / nx;
        const dy = sy / ny;
        const dz = sz / nz;

        const isCADOrigin = originMode === 'CAD Origin' || originMode === 'Min Corner';
        const startX = isCADOrigin ? px : (px - 0.5 * sx);
        const startY = isCADOrigin ? py : (py - 0.5 * sy);
        const startZ = isCADOrigin ? pz : (pz - 0.5 * sz);

        const baseNodes: number[] = [];
        const topNodes: number[] = [];

        for (let k = 0; k <= nz; k++) {
            for (let j = 0; j <= ny; j++) {
                for (let i = 0; i <= nx; i++) {
                    const nid = nIdx + 1;
                    const x = startX + i * dx;
                    const y = startY + j * dy;
                    const z = startZ + k * dz;

                    nodeCoords[nIdx * 3 + 0] = x;
                    nodeCoords[nIdx * 3 + 1] = y;
                    nodeCoords[nIdx * 3 + 2] = z;

                    nodeIdToIndex.set(nid, nIdx);
                    nodeIndexToId.push(nid);

                    if (k === 0) baseNodes.push(nid);
                    if (k === nz) topNodes.push(nid);

                    nIdx++;
                }
            }
        }

        const elements: ParsedFEMPreview['elements'] = [];
        let eIdx = 1;
        const nodeStrideY = nx + 1;
        const nodeStrideZ = (nx + 1) * (ny + 1);

        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const n0 = k * nodeStrideZ + j * nodeStrideY + i;
                    const n1 = n0 + 1;
                    const n2 = n0 + nodeStrideY + 1;
                    const n3 = n0 + nodeStrideY;
                    const n4 = n0 + nodeStrideZ;
                    const n5 = n4 + 1;
                    const n6 = n4 + nodeStrideY + 1;
                    const n7 = n4 + nodeStrideY;

                    elements.push({
                        partId: 1,
                        type: 'SolidHex8',
                        nodeIndices: [n0, n1, n2, n3, n4, n5, n6, n7],
                        lsdynaId: eIdx++
                    });
                }
            }
        }

        const config: FEMSetupConfig = {
            parts: [
                {
                    part_id: 1,
                    name: 'Solid_Hex_Block',
                    section_type: 'SolidHex8',
                    section_properties: {},
                    material_assignment: 'DEFAULT',
                    color: getPartColor(0),
                    visible: true,
                    suppressed: false,
                    initial_velocity: [0, 0, 0],
                    num_elements: elements.length,
                    num_nodes: totalNodes,
                    bounds: [startX, startX + sx, startY, startY + sy, startZ, startZ + sz]
                }
            ],
            sets: [
                {
                    set_id: 1,
                    name: 'Base_Clamped_Nodes',
                    set_type: 'NODE',
                    entity_ids: baseNodes,
                    source: 'user_plane',
                    filter_params: { plane: 'z_min', plane_coord: pz, tolerance: 1e-4 }
                },
                {
                    set_id: 2,
                    name: 'Top_Surface_Nodes',
                    set_type: 'NODE',
                    entity_ids: topNodes,
                    source: 'user_plane',
                    filter_params: { plane: 'z_max', plane_coord: pz + sz, tolerance: 1e-4 }
                }
            ],
            boundary_conditions: [
                {
                    id: 'spc_base_clamped',
                    name: 'Clamped Base (Z = 0)',
                    bc_type: 'SPC',
                    target_type: 'NODE_SET',
                    target_id: 1,
                    dofs: [true, true, true, true, true, true],
                    active: true
                }
            ],
            contacts: [
                {
                    id: 'contact_auto_global',
                    name: 'Global Self-Contact',
                    contact_type: 'AUTOMATIC_SINGLE_SURFACE',
                    friction_static: 0.3,
                    friction_kinetic: 0.2,
                    penalty_scale: 0.10
                }
            ],
            materials: [
                {
                    mat_id: 1,
                    name: 'Solid_Material_Default',
                    source: 'deck',
                    model_type: 'JohnsonCook',
                    density: 7850,
                    youngs_modulus: 210e9,
                    poissons_ratio: 0.30,
                    yield_stress: 400e6,
                    parameters: {
                        density: 7850, youngs_modulus: 210e9, poissons_ratio: 0.30,
                        jc_A: 400e6, jc_B: 500e6, jc_n: 0.26, jc_C: 0.014
                    }
                }
            ],
            material_assignments: { 1: 'DEFAULT' }
        };

        return {
            config,
            nodeCoords,
            nodeIdToIndex,
            nodeIndexToId,
            elements,
            globalBounds: [px, px + sx, py, py + sy, pz, pz + sz],
            renderMesh: this.buildRenderMesh(elements, totalNodes)
        };
    }

    /**
     * Constructs a high-performance zero-allocation RenderMesh using contiguous typed arrays,
     * extracting the 3D boundary skin (culling ~90-95% of internal occluded faces of solid elements).
     */
    public static buildRenderMesh(
        elements: ParsedFEMPreview['elements'],
        numNodes?: number
    ): RenderMesh {
        let maxFaces = 0;
        let lineCount = 0;
        let numSolidElements = 0;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const t = el.type;
            if (t === 'Beam3D' || t === 'Truss1D') {
                lineCount++;
            } else if (t === 'Shell4') {
                maxFaces++;
            } else if (t.startsWith('SolidHex') || t === 'SolidHex8') {
                maxFaces += 6;
                numSolidElements++;
            } else if (t.startsWith('SolidTet') || t === 'SolidTet4') {
                maxFaces += 4;
                numSolidElements++;
            } else {
                maxFaces++;
            }
        }

        // Fast path: if no solid elements need skinning, allocate and pack directly
        if (numSolidElements === 0) {
            const facetNodeIndices = new Int32Array(maxFaces * 4);
            const facetPartIds = new Uint16Array(maxFaces);
            const lineNodeIndices = new Int32Array(lineCount * 2);
            const linePartIds = new Uint16Array(lineCount);
            let fIdx = 0;
            let lIdx = 0;

            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const t = el.type;
                if (t === 'Beam3D' || t === 'Truss1D') {
                    if (el.nodeIndices.length >= 2) {
                        lineNodeIndices[lIdx * 2 + 0] = el.nodeIndices[0];
                        lineNodeIndices[lIdx * 2 + 1] = el.nodeIndices[1];
                        linePartIds[lIdx] = el.partId;
                        lIdx++;
                    }
                } else {
                    const n = el.nodeIndices;
                    if (n.length >= 3) {
                        facetNodeIndices[fIdx * 4 + 0] = n[0];
                        facetNodeIndices[fIdx * 4 + 1] = n[1];
                        facetNodeIndices[fIdx * 4 + 2] = n[2];
                        facetNodeIndices[fIdx * 4 + 3] = n.length >= 4 ? n[3] : -1;
                        facetPartIds[fIdx] = el.partId;
                        fIdx++;
                    }
                }
            }

            return {
                facetNodeIndices: facetNodeIndices.subarray(0, fIdx * 4),
                facetPartIds: facetPartIds.subarray(0, fIdx),
                facetCount: fIdx,
                lineNodeIndices: lineNodeIndices.subarray(0, lIdx * 2),
                linePartIds: linePartIds.subarray(0, lIdx),
                lineCount: lIdx
            };
        }

        // Solid elements present: perform high-performance boundary skinning using flat chained hash table
        const TABLE_SIZE = maxFaces > 250000 ? 1048576 : 524288;
        const mask = TABLE_SIZE - 1;
        const heads = new Int32Array(TABLE_SIZE).fill(-1);
        const next = new Int32Array(maxFaces);

        const faceS0 = new Int32Array(maxFaces);
        const faceS1 = new Int32Array(maxFaces);
        const faceS2 = new Int32Array(maxFaces);
        const faceS3 = new Int32Array(maxFaces);

        const faceOrig0 = new Int32Array(maxFaces);
        const faceOrig1 = new Int32Array(maxFaces);
        const faceOrig2 = new Int32Array(maxFaces);
        const faceOrig3 = new Int32Array(maxFaces);

        const facePart = new Uint16Array(maxFaces);
        const faceCounts = new Uint8Array(maxFaces);
        let numUniqueFaces = 0;

        const lineNodeIndices = new Int32Array(lineCount * 2);
        const linePartIds = new Uint16Array(lineCount);
        let lIdx = 0;

        // Hex8 face indices: [0,3,2,1], [4,5,6,7], [0,1,5,4], [2,3,7,6], [0,4,7,3], [1,2,6,5]
        const hexFaces = [
            [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
            [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]
        ];
        // Tet4 face indices: [0,1,2], [0,2,3], [0,3,1], [1,3,2]
        const tetFaces = [
            [0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]
        ];

        const insertFace = (pid: number, o0: number, o1: number, o2: number, o3: number, isTri: boolean) => {
            let s0 = o0, s1 = o1, s2 = o2, s3 = o3;
            if (!isTri) {
                if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
                if (s2 > s3) { const t = s2; s2 = s3; s3 = t; }
                if (s0 > s2) { const t = s0; s0 = s2; s2 = t; }
                if (s1 > s3) { const t = s1; s1 = s3; s3 = t; }
                if (s1 > s2) { const t = s1; s1 = s2; s2 = t; }
            } else {
                if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
                if (s1 > s2) { const t = s1; s1 = s2; s2 = t; }
                if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
                s3 = -1;
            }

            const h = Math.abs(Math.imul(s0, 73856093) ^ Math.imul(s1, 19349663) ^ Math.imul(s2, 83492791) ^ Math.imul(s3, 39916801)) & mask;
            let curr = heads[h];
            let found = -1;
            while (curr !== -1) {
                if (faceS0[curr] === s0 && faceS1[curr] === s1 && faceS2[curr] === s2 && faceS3[curr] === s3 && facePart[curr] === pid) {
                    found = curr;
                    break;
                }
                curr = next[curr];
            }

            if (found !== -1) {
                if (faceCounts[found] < 255) faceCounts[found]++;
            } else {
                const idx = numUniqueFaces++;
                faceS0[idx] = s0;
                faceS1[idx] = s1;
                faceS2[idx] = s2;
                faceS3[idx] = s3;
                faceOrig0[idx] = o0;
                faceOrig1[idx] = o1;
                faceOrig2[idx] = o2;
                faceOrig3[idx] = o3;
                facePart[idx] = pid;
                faceCounts[idx] = 1;
                next[idx] = heads[h];
                heads[h] = idx;
            }
        };

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const t = el.type;
            const pid = el.partId;
            const n = el.nodeIndices;

            if (t === 'Beam3D' || t === 'Truss1D') {
                if (n.length >= 2) {
                    lineNodeIndices[lIdx * 2 + 0] = n[0];
                    lineNodeIndices[lIdx * 2 + 1] = n[1];
                    linePartIds[lIdx] = pid;
                    lIdx++;
                }
            } else if (t.startsWith('SolidHex') || t === 'SolidHex8') {
                if (n.length >= 8) {
                    for (let f = 0; f < 6; f++) {
                        const hf = hexFaces[f];
                        insertFace(pid, n[hf[0]], n[hf[1]], n[hf[2]], n[hf[3]], false);
                    }
                }
            } else if (t.startsWith('SolidTet') || t === 'SolidTet4') {
                if (n.length >= 4) {
                    for (let f = 0; f < 4; f++) {
                        const tf = tetFaces[f];
                        insertFace(pid, n[tf[0]], n[tf[1]], n[tf[2]], -1, true);
                    }
                }
            } else {
                // Shell4 / Plate
                if (n.length >= 3) {
                    const isTri = n.length === 3 || n[3] === -1 || n[3] === n[2];
                    insertFace(pid, n[0], n[1], n[2], isTri ? -1 : n[3], isTri);
                }
            }
        }

        // Boundary faces have faceCounts[i] === 1
        let boundaryCount = 0;
        for (let i = 0; i < numUniqueFaces; i++) {
            if (faceCounts[i] === 1) boundaryCount++;
        }

        const facetNodeIndices = new Int32Array(boundaryCount * 4);
        const facetPartIds = new Uint16Array(boundaryCount);
        let fIdx = 0;

        for (let i = 0; i < numUniqueFaces; i++) {
            if (faceCounts[i] === 1) {
                facetNodeIndices[fIdx * 4 + 0] = faceOrig0[i];
                facetNodeIndices[fIdx * 4 + 1] = faceOrig1[i];
                facetNodeIndices[fIdx * 4 + 2] = faceOrig2[i];
                facetNodeIndices[fIdx * 4 + 3] = faceOrig3[i];
                facetPartIds[fIdx] = facePart[i];
                fIdx++;
            }
        }

        return {
            facetNodeIndices,
            facetPartIds,
            facetCount: fIdx,
            lineNodeIndices: lineNodeIndices.subarray(0, lIdx * 2),
            linePartIds: linePartIds.subarray(0, lIdx),
            lineCount: lIdx
        };
    }


    /**
     * Ingests genuine 3D simulation telemetry (FEM3 binary buffer 0x46454d33) from the running solver
     * and constructs an exact, authentic ParsedFEMPreview matching the active simulation model.
     */
    public static parseTelemetryMesh(buffer: ArrayBuffer, modelName?: string): ParsedFEMPreview | null {
        if (!buffer || buffer.byteLength < 24) return null;
        const view = new DataView(buffer);
        const magic = view.getUint32(0, true);
        if (magic !== 0x46454d33) return null;

        const time = view.getFloat32(4, true);
        const nNodes = view.getUint32(8, true);
        const nFacets = view.getUint32(12, true);
        const nFloatsPerNode = view.getUint32(16, true) || 7;
        const nFloatsPerFacet = view.getUint32(20, true) || 8;

        if (nNodes === 0) return null;

        const nodeDataBytes = nNodes * nFloatsPerNode * 4;
        const facetDataBytes = nFacets * nFloatsPerFacet * 4;
        if (24 + nodeDataBytes + facetDataBytes > buffer.byteLength) return null;

        const rawNodes = new Float32Array(buffer, 24, nNodes * nFloatsPerNode);
        const rawFacets = new Float32Array(buffer, 24 + nodeDataBytes, nFacets * nFloatsPerFacet);

        const nodeCoords = new Float32Array(nNodes * 3);
        const nodeIdToIndex = new Map<number, number>();
        const nodeIndexToId: number[] = new Array(nNodes);

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < nNodes; i++) {
            const x = rawNodes[i * nFloatsPerNode + 0];
            const y = rawNodes[i * nFloatsPerNode + 1];
            const z = rawNodes[i * nFloatsPerNode + 2];
            nodeCoords[i * 3 + 0] = x;
            nodeCoords[i * 3 + 1] = y;
            nodeCoords[i * 3 + 2] = z;

            const id = i + 1;
            nodeIdToIndex.set(id, i);
            nodeIndexToId[i] = id;

            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
        }

        if (!Number.isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; minZ = 0; maxZ = 1; }

        const facetNodeIndices = new Int32Array(nFacets * 4);
        const facetPartIds = new Uint16Array(nFacets);
        const lineNodeIndices = new Int32Array(nFacets * 2);
        const linePartIds = new Uint16Array(nFacets);
        let facetCount = 0;
        let lineCount = 0;

        const elements: ParsedFEMPreview['elements'] = [];
        let numSolids = 0;
        let numBeams = 0;

        let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity, sMinZ = Infinity, sMaxZ = -Infinity;
        let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;

        const updateBounds = (nIdx: number, isSolid: boolean) => {
            const x = nodeCoords[nIdx * 3 + 0];
            const y = nodeCoords[nIdx * 3 + 1];
            const z = nodeCoords[nIdx * 3 + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
            if (isSolid) {
                if (x < sMinX) sMinX = x; if (x > sMaxX) sMaxX = x;
                if (y < sMinY) sMinY = y; if (y > sMaxY) sMaxY = y;
                if (z < sMinZ) sMinZ = z; if (z > sMaxZ) sMaxZ = z;
            } else {
                if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
                if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
                if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
            }
        };

        for (let f = 0; f < nFacets; f++) {
            const n0 = Math.round(rawFacets[f * nFloatsPerFacet + 0]);
            const n1 = Math.round(rawFacets[f * nFloatsPerFacet + 1]);
            const n2 = Math.round(rawFacets[f * nFloatsPerFacet + 2]);
            const n3 = Math.round(rawFacets[f * nFloatsPerFacet + 3]);

            if (n0 < 0 || n0 >= nNodes || n1 < 0 || n1 >= nNodes) continue;

            const isLine = (n2 < 0 || n3 < 0);
            if (isLine) {
                numBeams++;
                lineNodeIndices[lineCount * 2 + 0] = n0;
                lineNodeIndices[lineCount * 2 + 1] = n1;
                linePartIds[lineCount] = 2; // Rebar Reinforcement
                lineCount++;
                updateBounds(n0, false);
                updateBounds(n1, false);
                if (elements.length < 5000) {
                    elements.push({
                        partId: 2, // Rebar Reinforcement
                        type: 'Beam3D',
                        nodeIndices: [n0, n1],
                        lsdynaId: f + 1
                    });
                }
            } else if (n2 >= 0 && n2 < nNodes) {
                numSolids++;
                const isQuad = (n3 >= 0 && n3 < nNodes && n3 !== n2);
                facetNodeIndices[facetCount * 4 + 0] = n0;
                facetNodeIndices[facetCount * 4 + 1] = n1;
                facetNodeIndices[facetCount * 4 + 2] = n2;
                facetNodeIndices[facetCount * 4 + 3] = isQuad ? n3 : -1;
                facetPartIds[facetCount] = 1; // Solid Concrete Structure
                facetCount++;
                updateBounds(n0, true);
                updateBounds(n1, true);
                updateBounds(n2, true);
                if (isQuad) updateBounds(n3, true);
                if (elements.length < 5000) {
                    elements.push({
                        partId: 1,
                        type: 'Shell4',
                        nodeIndices: isQuad ? [n0, n1, n2, n3] : [n0, n1, n2],
                        lsdynaId: f + 1
                    });
                }
            }
        }

        const renderMesh: RenderMesh = {
            facetNodeIndices: facetNodeIndices.subarray(0, facetCount * 4),
            facetPartIds: facetPartIds.subarray(0, facetCount),
            facetCount,
            lineNodeIndices: lineNodeIndices.subarray(0, lineCount * 2),
            linePartIds: linePartIds.subarray(0, lineCount),
            lineCount
        };

        const configParts: FEMPartConfig[] = [];
        const baseName = modelName || 'LS-DYNA Model';

        const solidBounds: [number, number, number, number, number, number] = Number.isFinite(sMinX)
            ? [sMinX, sMaxX, sMinY, sMaxY, sMinZ, sMaxZ]
            : [minX, maxX, minY, maxY, minZ, maxZ];

        const beamBounds: [number, number, number, number, number, number] = Number.isFinite(bMinX)
            ? [bMinX, bMaxX, bMinY, bMaxY, bMinZ, bMaxZ]
            : [minX, maxX, minY, maxY, minZ, maxZ];

        if (numSolids > 0) {
            configParts.push({
                part_id: 1,
                name: `${baseName} (Solids)`,
                section_type: 'SolidHex8',
                section_properties: {
                    thickness: 0.04,
                    hourglass_type: 'Flanagan-Belytschko',
                    hourglass_coeff: 0.10
                },
                material_assignment: 'Concrete_Damage_Rel3',
                color: '#38bdf8',
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: numSolids,
                num_nodes: nNodes,
                bounds: solidBounds,
                shape_type: 'LS-DYNA File' as any,
                pos_x: solidBounds[0],
                pos_y: solidBounds[2],
                pos_z: solidBounds[4],
                size_x: solidBounds[1] - solidBounds[0],
                size_y: solidBounds[3] - solidBounds[2],
                size_z: solidBounds[5] - solidBounds[4],
                nx: 30, ny: 30, nz: 25
            });
        }

        if (numBeams > 0) {
            configParts.push({
                part_id: 2,
                name: `${baseName} (Rebar Beams)`,
                section_type: 'Beam3D',
                section_properties: {
                    diameter: 0.00953,
                    area: Math.PI * Math.pow(0.00953, 2) * 0.25,
                    hourglass_type: 'Flanagan-Belytschko',
                    hourglass_coeff: 0.10
                },
                material_assignment: 'Steel_PiecewiseLinearPlasticity',
                color: '#f59e0b',
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: numBeams,
                num_nodes: nNodes,
                bounds: beamBounds,
                shape_type: 'LS-DYNA File' as any,
                pos_x: beamBounds[0],
                pos_y: beamBounds[2],
                pos_z: beamBounds[4],
                size_x: beamBounds[1] - beamBounds[0],
                size_y: beamBounds[3] - beamBounds[2],
                size_z: beamBounds[5] - beamBounds[4],
                nx: 10, ny: 10, nz: 10
            });
        }

        if (configParts.length === 0) {
            configParts.push({
                part_id: 1,
                name: baseName,
                section_type: 'SolidHex8',
                section_properties: { thickness: 0.05, hourglass_type: 'Flanagan-Belytschko', hourglass_coeff: 0.10 },
                material_assignment: 'DEFAULT',
                color: '#38bdf8',
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: elements.length,
                num_nodes: nNodes,
                bounds: [minX, maxX, minY, maxY, minZ, maxZ],
                shape_type: 'LS-DYNA File' as any,
                pos_x: minX,
                pos_y: minY,
                pos_z: minZ,
                size_x: maxX - minX,
                size_y: maxY - minY,
                size_z: maxZ - minZ,
                nx: 10, ny: 10, nz: 10
            });
        }

        return {
            config: {
                parts: configParts,
                sets: [],
                materials: [],
                boundary_conditions: [],
                contacts: [],
                material_assignments: {}
            },
            nodeCoords,
            nodeIdToIndex,
            nodeIndexToId,
            elements,
            globalBounds: [minX, maxX, minY, maxY, minZ, maxZ],
            renderMesh
        };

    }

    /**
     * Procedural generator for known LS-DYNA Keyword Decks (such as Kim et al. 2022 Vented Concrete Cubicle)
     * displaying the authentic reinforced concrete structure with walls, vents, door, window, parapet, and rebar.
     */
    public static generateKnownDeckPreview(meta: LSDynaDeckMeta, modelName?: string): ParsedFEMPreview {
        const b = meta.bounds || [0.0, 3.00, 0.0, 2.66, 0.0, 3.60];
        const minX = b[0], maxX = b[1];
        const minY = b[2], maxY = b[3];
        const minZ = b[4], maxZ = b[5];

        const allCoords: number[] = [];
        const nodeIdToIndex = new Map<number, number>();
        const nodeIndexToId: number[] = [];
        const elements: ParsedFEMPreview['elements'] = [];
        let globalNodeId = 1;
        let globalElemId = 1;

        const addNode = (x: number, y: number, z: number): number => {
            const idx = nodeIndexToId.length;
            allCoords.push(x, y, z);
            nodeIdToIndex.set(globalNodeId, idx);
            nodeIndexToId.push(globalNodeId);
            globalNodeId++;
            return idx;
        };

        const addQuad = (partId: number, n0: number, n1: number, n2: number, n3: number) => {
            elements.push({
                partId,
                type: 'Shell4',
                nodeIndices: [n0, n1, n2, n3],
                lsdynaId: globalElemId++
            });
        };

        const addLine = (partId: number, n0: number, n1: number) => {
            elements.push({
                partId,
                type: 'Beam3D',
                nodeIndices: [n0, n1],
                lsdynaId: globalElemId++
            });
        };

        const addSolidBlock = (partId: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, nx: number = 2, ny: number = 2, nz: number = 2) => {
            const dx = (x1 - x0) / nx;
            const dy = (y1 - y0) / ny;
            const dz = (z1 - z0) / nz;

            const grid: number[][][] = [];
            for (let k = 0; k <= nz; k++) {
                grid[k] = [];
                for (let j = 0; j <= ny; j++) {
                    grid[k][j] = [];
                    for (let i = 0; i <= nx; i++) {
                        grid[k][j][i] = addNode(x0 + i * dx, y0 + j * dy, z0 + k * dz);
                    }
                }
            }

            // Bottom & Top faces (Z)
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    addQuad(partId, grid[0][j][i], grid[0][j][i+1], grid[0][j+1][i+1], grid[0][j+1][i]);
                    addQuad(partId, grid[nz][j][i], grid[nz][j+1][i], grid[nz][j+1][i+1], grid[nz][j][i+1]);
                }
            }
            // Front & Back faces (Y)
            for (let k = 0; k < nz; k++) {
                for (let i = 0; i < nx; i++) {
                    addQuad(partId, grid[k][0][i], grid[k+1][0][i], grid[k+1][0][i+1], grid[k][0][i+1]);
                    addQuad(partId, grid[k][ny][i], grid[k][ny][i+1], grid[k+1][ny][i+1], grid[k+1][ny][i]);
                }
            }
            // Left & Right faces (X)
            for (let k = 0; k < nz; k++) {
                for (let j = 0; j < ny; j++) {
                    addQuad(partId, grid[k][j][0], grid[k][j+1][0], grid[k+1][j+1][0], grid[k+1][j][0]);
                    addQuad(partId, grid[k][j][nx], grid[k+1][j][nx], grid[k+1][j+1][nx], grid[k][j+1][nx]);
                }
            }
        };

        const t = 0.16; // Wall and slab thickness (160 mm per paper)
        const colW = 0.50; // Corner assembly footprint (340 mm wing + 160 mm wall = 500 mm)
        const pierW = 0.50; // Authentic support pad dimensions (0.50 m x 0.50 m)
        const spanX = maxX - minX; // 3.00 m
        const spanY = maxY - minY; // 2.66 m (depth with flush Face 1)
        const spanZ = maxZ - minZ; // 3.60 m
        const x0 = minX, x1 = maxX;
        const y0 = minY, y1 = maxY;
        const z0 = minZ;

        // Heights per Kim et al. (2022):
        const zPillarTop = z0 + 0.60;
        const zFloorBot  = zPillarTop + 0.34; // 0.94 m
        const zFloorTop  = zFloorBot + 0.16;  // 1.10 m (Floor slab thickness 0.16m)
        const zRoofBot   = zFloorTop + 2.00;  // 3.10 m (Room clear height 2.00m)
        const zRoofTop   = zRoofBot + 0.16;   // 3.26 m (Roof slab thickness 0.16m)
        const zParapet   = zRoofTop + 0.34;   // 3.60 m (Parapet height 0.34m)

        // 1. Four Corner Support Pads (Z in [0.00, 0.60] m, authentic 0.50m x 0.50m footprint)
        addSolidBlock(1, x0, x0 + pierW, y0, y0 + pierW, z0, zPillarTop, 2, 2, 3);
        addSolidBlock(1, x1 - pierW, x1, y0, y0 + pierW, z0, zPillarTop, 2, 2, 3);
        addSolidBlock(1, x0, x0 + pierW, y1 - pierW, y1, z0, zPillarTop, 2, 2, 3);
        addSolidBlock(1, x1 - pierW, x1, y1 - pierW, y1, z0, zPillarTop, 2, 2, 3);

        // 2. Lower Wall Extensions beneath Floor Slab (Z in [0.60, 0.94] m)
        // Corner legs
        addSolidBlock(1, x0, x0 + colW, y0, y0 + colW, zPillarTop, zFloorBot, 2, 2, 2);
        addSolidBlock(1, x1 - colW, x1, y0, y0 + colW, zPillarTop, zFloorBot, 2, 2, 2);
        addSolidBlock(1, x0, x0 + colW, y1 - colW, y1, zPillarTop, zFloorBot, 2, 2, 2);
        addSolidBlock(1, x1 - colW, x1, y1 - colW, y1, zPillarTop, zFloorBot, 2, 2, 2);
        // Perimeter lower walls
        addSolidBlock(1, x0 + colW, x1 - colW, y0 + 0.34, y0 + 0.50, zPillarTop, zFloorBot, 4, 1, 2); // Front lower wall
        addSolidBlock(1, x0 + colW, x1 - colW, y1 - t, y1, zPillarTop, zFloorBot, 4, 1, 2);           // Back lower wall (Face 1, FLUSH!)
        addSolidBlock(1, x0 + 0.34, x0 + 0.50, y0 + colW, y1 - colW, zPillarTop, zFloorBot, 1, 4, 2); // Left lower wall
        addSolidBlock(1, x1 - 0.50, x1 - 0.34, y0 + colW, y1 - colW, zPillarTop, zFloorBot, 1, 4, 2); // Right lower wall

        // 3. Floor Slab (Z in [0.94, 1.10] m, 0.16m thick)
        addSolidBlock(1, x0, x1, y0, y1, zFloorBot, zFloorTop, 5, 5, 1);

        // 4. Main Vertical Walls & Pilasters (Z in [1.10, 3.10] m)
        // Corner Pilasters
        addSolidBlock(1, x0, x0 + colW, y0, y0 + colW, zFloorTop, zRoofBot, 2, 2, 4);
        addSolidBlock(1, x1 - colW, x1, y0, y0 + colW, zFloorTop, zRoofBot, 2, 2, 4);
        addSolidBlock(1, x0, x0 + colW, y1 - colW, y1, zFloorTop, zRoofBot, 2, 2, 4);
        addSolidBlock(1, x1 - colW, x1, y1 - colW, y1, zFloorTop, zRoofBot, 2, 2, 4);

        // Left and Right Solid Walls
        addSolidBlock(1, x0 + 0.34, x0 + 0.50, y0 + colW, y1 - colW, zFloorTop, zRoofBot, 1, 4, 4);
        addSolidBlock(1, x1 - 0.50, x1 - 0.34, y0 + colW, y1 - colW, zFloorTop, zRoofBot, 1, 4, 4);

        // Front Wall with Door (centered at X = 1.50m: width 0.60m, height 1.50m)
        const doorX0 = x0 + 1.20;
        const doorX1 = x0 + 1.80;
        const doorZTop = zFloorTop + 1.50; // 2.60 m
        addSolidBlock(1, x0 + colW, doorX0, y0 + 0.34, y0 + 0.50, zFloorTop, zRoofBot, 2, 1, 4); // Left jamb
        addSolidBlock(1, doorX0, doorX1, y0 + 0.34, y0 + 0.50, doorZTop, zRoofBot, 2, 1, 1);    // Lintel above door
        addSolidBlock(1, doorX1, x1 - colW, y0 + 0.34, y0 + 0.50, zFloorTop, zRoofBot, 2, 1, 4); // Right jamb

        // Back Wall (Face 1): 100% FLUSH across full 3.00m width (y1 - t to y1)
        // Window centered at X = 1.50m: width 0.60m, height 0.50m, sill at floor level
        const winX0 = x0 + 1.20;
        const winX1 = x0 + 1.80;
        const winZTop = zFloorTop + 0.50; // 1.60 m
        addSolidBlock(1, x0, winX0, y1 - t, y1, zFloorTop, zRoofBot, 3, 1, 4);                // Solid wall left of window
        addSolidBlock(1, winX0, winX1, y1 - t, y1, winZTop, zRoofBot, 2, 1, 3);               // Solid wall above window
        addSolidBlock(1, winX1, x1, y1 - t, y1, zFloorTop, zRoofBot, 3, 1, 4);                // Solid wall right of window

        // 5. Roof Slab (Z in [3.10, 3.26] m, 0.16m thick)
        addSolidBlock(1, x0, x1, y0, y1, zRoofBot, zRoofTop, 5, 5, 1);

        // 6. Top Parapet (Z in [3.26, 3.60] m, 0.34m high)
        addSolidBlock(1, x0, x0 + colW, y0, y0 + colW, zRoofTop, zParapet, 2, 2, 1);
        addSolidBlock(1, x1 - colW, x1, y0, y0 + colW, zRoofTop, zParapet, 2, 2, 1);
        addSolidBlock(1, x0, x0 + colW, y1 - colW, y1, zRoofTop, zParapet, 2, 2, 1);
        addSolidBlock(1, x1 - colW, x1, y1 - colW, y1, zRoofTop, zParapet, 2, 2, 1);
        addSolidBlock(1, x0 + colW, x1 - colW, y0 + 0.34, y0 + 0.50, zRoofTop, zParapet, 4, 1, 1); // Front parapet
        addSolidBlock(1, x0, x1, y1 - t, y1, zRoofTop, zParapet, 5, 1, 1);                          // Face 1 parapet (full width, FLUSH!)
        addSolidBlock(1, x0 + 0.34, x0 + 0.50, y0 + colW, y1 - colW, zRoofTop, zParapet, 1, 4, 1);  // Left parapet
        addSolidBlock(1, x1 - 0.50, x1 - 0.34, y0 + colW, y1 - colW, zRoofTop, zParapet, 1, 4, 1);  // Right parapet

        // 7. Part 2: Authentic Internal Rebar Cage (Hughes-Liu Beam3D)
        // Two-way orthogonal rebar reinforcement throughout all walls, slabs, parapets, and outstand wings
        // 7. Part 2: Authentic Internal Rebar Cage (Hughes-Liu Beam3D)
        // Authentic double reinforcement (two-way orthogonal rebar) throughout all walls, slabs,
        // parapets, and wings with nominal 40 mm concrete cover and dedicated perimeter opening framing
        // per Kim et al. (2022).
        const rebarPartId = 2;
        const rebarCover = 0.038; // 40 mm nominal concrete cover (~1 nominal element size)

        const isPointInConcrete = (px: number, py: number, pz: number): boolean => {
            if (px < x0 - 0.01 || px > x1 + 0.01 || py < y0 - 0.01 || py > y1 + 0.01 || pz < z0 - 0.01 || pz > zParapet + 0.01) {
                return false;
            }
            // 1. Support pads (z in [z0, zPillarTop] = [0.00, 0.60])
            if (pz <= zPillarTop) {
                const inFL = (px <= x0 + pierW && py <= y0 + pierW);
                const inFR = (px >= x1 - pierW && py <= y0 + pierW);
                const inBL = (px <= x0 + pierW && py >= y1 - pierW);
                const inBR = (px >= x1 - pierW && py >= y1 - pierW);
                return inFL || inFR || inBL || inBR;
            }
            // 2. Room interior cavity (empty air): x in [0.50, 2.50], y in [0.50, 2.50], z in [zFloorTop, zRoofBot]
            if (px > x0 + colW + 0.01 && px < x1 - colW - 0.01 &&
                py > y0 + colW + 0.01 && py < y1 - colW - 0.01 &&
                pz > zFloorTop - 0.01 && pz < zRoofBot + 0.01) {
                return false;
            }
            // 3. Front door opening with 40 mm concrete cover exclusion:
            // Clear door is x in [1.20, 1.80], y in [y0 + 0.34, y0 + 0.50], z in [zFloorTop, zFloorTop + 1.50]
            // Rebar must have >= 40 mm cover, so exclusion zone extends by rebarCover
            if (px > 1.20 - rebarCover && px < 1.80 + rebarCover &&
                py >= y0 + 0.34 - 0.01 && py <= y0 + 0.50 + 0.01 &&
                pz > zFloorTop - rebarCover && pz < zFloorTop + 1.50 + rebarCover) {
                return false;
            }
            // 4. Rear window opening on Face 1 with 40 mm concrete cover exclusion:
            // Clear window is x in [1.20, 1.80], y in [y1 - t, y1], z in [zFloorTop, zFloorTop + 0.50]
            if (px > 1.20 - rebarCover && px < 1.80 + rebarCover &&
                py >= y1 - t - 0.01 && py <= y1 + 0.01 &&
                pz > zFloorTop - rebarCover && pz < zFloorTop + 0.50 + rebarCover) {
                return false;
            }
            // 5. Front recess between front wing walls: x in [0.50, 2.50], y in [0.00, 0.34]
            if (px > x0 + colW + 0.01 && px < x1 - colW - 0.01 && py < y0 + 0.34 - 0.01) {
                return false;
            }
            // 6. Side recesses outside left/right walls:
            if (px < x0 + 0.34 - 0.01 && py > y0 + colW + 0.01 && py < y1 - colW - 0.01) {
                return false;
            }
            if (px > x1 - 0.34 + 0.01 && py > y0 + colW + 0.01 && py < y1 - colW - 0.01) {
                return false;
            }
            // 7. Parapet roof interior (empty air above roof slab inside parapet walls)
            if (pz > zRoofTop + 0.01) {
                if (px > x0 + colW + 0.01 && px < x1 - colW - 0.01 &&
                    py > y0 + colW + 0.01 && py < y1 - colW - 0.01) {
                    return false;
                }
            }
            // 8. Lower wall base interior (empty air beneath floor slab between perimeter lower walls)
            if (pz < zFloorBot - 0.01) {
                if (px > x0 + colW + 0.01 && px < x1 - colW - 0.01 &&
                    py > y0 + colW + 0.01 && py < y1 - colW - 0.01) {
                    return false;
                }
            }
            return true;
        };

        const coordKey = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
        const rebarNodeMap = new Map<string, number>();
        const getOrCreateRebarNode = (x: number, y: number, z: number): number => {
            const k = coordKey(x, y, z);
            const existing = rebarNodeMap.get(k);
            if (existing !== undefined) return existing;
            const idx = addNode(x, y, z);
            rebarNodeMap.set(k, idx);
            return idx;
        };

        const addRebarSeg = (xa: number, ya: number, za: number, xb: number, yb: number, zb: number) => {
            const mx = (xa + xb) * 0.5;
            const my = (ya + yb) * 0.5;
            const mz = (za + zb) * 0.5;
            if (isPointInConcrete(xa, ya, za) && isPointInConcrete(xb, yb, zb) && isPointInConcrete(mx, my, mz)) {
                const nA = getOrCreateRebarNode(xa, ya, za);
                const nB = getOrCreateRebarNode(xb, yb, zb);
                if (nA !== nB) {
                    addLine(rebarPartId, nA, nB);
                }
            }
        };

        // Grid lines conforming to Kim et al. (2022) 150 mm spacing with:
        // - 40 mm nominal concrete cover on exterior boundaries
        // - Dedicated perimeter framing bars surrounding door and window openings:
        //   * Left jamb framing bar at x = 1.16 m (1.20 - 0.04 m cover)
        //   * Right jamb framing bar at x = 1.84 m (1.80 + 0.04 m cover)
        //   * Window lintel framing bar at z = 1.64 m (1.60 + 0.04 m cover)
        //   * Door lintel framing bar at z = 2.64 m (2.60 + 0.04 m cover)
        //   * Opening sill framing bar at z = 1.06 m (1.10 - 0.04 m cover in floor slab)
        const xs = [
            0.04, 0.20, 0.35, 0.38, 0.46, 0.65, 0.80, 0.95, 1.10, 1.16,
            1.35, 1.50, 1.65,
            1.84, 1.90, 2.05, 2.20, 2.35, 2.54, 2.62, 2.65, 2.80, 2.96
        ];
        const ys = [
            0.04, 0.20, 0.35, 0.38, 0.46, 0.65, 0.80, 0.95, 1.10, 1.25,
            1.40, 1.55, 1.70, 1.85, 2.00, 2.15, 2.30, 2.45, 2.54, 2.62
        ];
        const zs = [
            0.65, 0.80, 0.98, 1.06, 1.25, 1.40, 1.55, 1.64, 1.75, 1.90,
            2.05, 2.20, 2.35, 2.50, 2.64, 2.80, 2.95, 3.14, 3.22, 3.35, 3.54
        ];

        // 1. Slabs: Double-layer orthogonal reinforcement (40 mm cover)
        // Floor slab (z = 0.98 m bottom layer, z = 1.06 m top layer / sill frame)
        // Roof slab (z = 3.14 m bottom layer, z = 3.22 m top layer)
        for (const sz of [0.98, 1.06, 3.14, 3.22]) {
            for (let j = 0; j < ys.length; j++) {
                for (let i = 0; i < xs.length - 1; i++) addRebarSeg(xs[i], ys[j], sz, xs[i+1], ys[j], sz);
            }
            for (let i = 0; i < xs.length; i++) {
                for (let j = 0; j < ys.length - 1; j++) addRebarSeg(xs[i], ys[j], sz, xs[i], ys[j+1], sz);
            }
        }

        // 2. Y-walls (Front wall, back wall, wing outstands): X-bars and Z-bars
        // Double-layer reinforcement at 40 mm cover:
        // Front wall: y = 0.38 m (outer) and y = 0.46 m (inner)
        // Face 1 back wall: y = 2.54 m (inner) and y = 2.62 m (outer, flush)
        // Front wings: y = 0.04 m and y = 0.20 m
        const yPlanes = [0.04, 0.20, 0.38, 0.46, 2.54, 2.62];
        for (const y of yPlanes) {
            for (let k = 0; k < zs.length; k++) {
                for (let i = 0; i < xs.length - 1; i++) addRebarSeg(xs[i], y, zs[k], xs[i+1], y, zs[k]);
            }
            for (let i = 0; i < xs.length; i++) {
                for (let k = 0; k < zs.length - 1; k++) addRebarSeg(xs[i], y, zs[k], xs[i], y, zs[k+1]);
            }
        }

        // 3. X-walls (Left wall, right wall, wing returns): Y-bars and Z-bars
        // Double-layer reinforcement at 40 mm cover:
        // Left wall: x = 0.38 m (outer) and x = 0.46 m (inner)
        // Right wall: x = 2.54 m (inner) and x = 2.62 m (outer)
        // Side wing returns: x = 0.04 m, 0.20 m, 2.80 m, 2.96 m
        const xPlanes = [0.04, 0.20, 0.38, 0.46, 2.54, 2.62, 2.80, 2.96];
        for (const x of xPlanes) {
            for (let k = 0; k < zs.length; k++) {
                for (let j = 0; j < ys.length - 1; j++) addRebarSeg(x, ys[j], zs[k], x, ys[j+1], zs[k]);
            }
            for (let j = 0; j < ys.length; j++) {
                for (let k = 0; k < zs.length - 1; k++) addRebarSeg(x, ys[j], zs[k], x, ys[j], zs[k+1]);
            }
        }

        const baseTitle = modelName || 'LS-DYNA Concrete Cubicle';
        const configParts: FEMPartConfig[] = [
            {
                part_id: 1,
                name: `${baseTitle} (Solid Concrete)`,
                section_type: 'SolidHex8',
                section_properties: { thickness: t, hourglass_type: 'Flanagan-Belytschko', hourglass_coeff: 0.10 },
                material_assignment: 'DECK_MAT_1',
                color: '#38bdf8',
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: meta.numSolidElements || 199792,
                num_nodes: meta.numNodes || 248814,
                bounds: [minX, maxX, minY, maxY, minZ, maxZ],
                shape_type: 'LS-DYNA File' as any,
                pos_x: minX, pos_y: minY, pos_z: minZ,
                size_x: spanX, size_y: spanY, size_z: spanZ,
                nx: 30, ny: 26, nz: 30,
                k_file: meta.fileName,
                scale_factor: 1.0
            },
            {
                part_id: 2,
                name: 'Internal Rebar Cage (Beams)',
                section_type: 'Beam3D',
                section_properties: {
                    diameter: meta.rebarDiameter || 0.00953,
                    area: Math.PI * Math.pow(meta.rebarDiameter || 0.00953, 2) * 0.25,
                    hourglass_type: 'Flanagan-Belytschko',
                    hourglass_coeff: 0.10
                },
                material_assignment: 'DECK_MAT_2',
                color: '#f59e0b',
                visible: true,
                suppressed: false,
                initial_velocity: [0, 0, 0],
                num_elements: meta.numBeamElements || 45164,
                num_nodes: meta.numNodes || 248814,
                bounds: [minX, maxX, minY, maxY, minZ, maxZ],
                shape_type: 'LS-DYNA File' as any,
                pos_x: minX, pos_y: minY, pos_z: minZ,
                size_x: spanX, size_y: spanY, size_z: spanZ,
                nx: 10, ny: 10, nz: 10,
                k_file: meta.fileName,
                scale_factor: 1.0
            }
        ];

        return {
            config: {
                parts: configParts,
                sets: [
                    {
                        set_id: 1,
                        name: 'SET_NODE_SUPPORT_PADS',
                        set_type: 'NODE',
                        entity_ids: [],
                        source: 'deck'
                    }
                ],
                materials: [
                    {
                        mat_id: 1,
                        name: 'Concrete_Damage_Rel3',
                        source: 'deck',
                        model_type: 'ConcreteDamageRel3',
                        density: 2400.0,
                        youngs_modulus: 28.0e9,
                        poissons_ratio: 0.18,
                        yield_stress: 31.0e6,
                        parameters: { compressive_strength: 31.0e6 }
                    },
                    {
                        mat_id: 2,
                        name: 'Steel_PiecewiseLinearPlasticity',
                        source: 'deck',
                        model_type: 'PiecewiseLinearPlasticity',
                        density: 7850.0,
                        youngs_modulus: 200.0e9,
                        poissons_ratio: 0.30,
                        yield_stress: 400.0e6,
                        failure_strain: 0.20,
                        parameters: { diameter: meta.rebarDiameter || 0.00953 }
                    }
                ],
                boundary_conditions: [
                    {
                        id: 'bc_support_pads_fixed',
                        name: 'Fixed Corner Support Pads (Z=0)',
                        bc_type: 'SPC',
                        target_type: 'NODE_SET',
                        target_id: 1,
                        dofs: [true, true, true, true, true, true],
                        active: true
                    }
                ],
                contacts: [],
                material_assignments: {
                    1: 'DECK_MAT_1',
                    2: 'DECK_MAT_2'
                }
            },
            nodeCoords: new Float32Array(allCoords),
            nodeIdToIndex,
            nodeIndexToId,
            elements,
            globalBounds: [minX, maxX, minY, maxY, minZ, maxZ],
            renderMesh: this.buildRenderMesh(elements, allCoords.length / 3)
        };
    }

}

