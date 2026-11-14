import { Node, SimulationState, isDomainMesh3DNode, isDomainMesh2DNode } from './types.js';
import { calculateCFDMemory, resolveFEMCounts, getMPMObjectVolume } from './state-manager.js';

export interface MemoryEstimateResult {
    ramBytes: number;
    vramBytes: number;
    riskLevel: 'OK' | 'WARNING' | 'CRITICAL';
    summaryText: string;
    ramText: string;
    vramText: string;
}

export function formatBytes(bytes: number): string {
    if (bytes <= 0 || isNaN(bytes)) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) {
        return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
}

export function categorizeRisk(ramBytes: number, vramBytes: number): 'OK' | 'WARNING' | 'CRITICAL' {
    const GIGABYTE = 1024 * 1024 * 1024;
    if (ramBytes > 24 * GIGABYTE || vramBytes > 14 * GIGABYTE) {
        return 'CRITICAL';
    }
    if (ramBytes > 12 * GIGABYTE || vramBytes > 6 * GIGABYTE) {
        return 'WARNING';
    }
    return 'OK';
}

export function estimateNodeMemory(node: Node, state?: SimulationState): MemoryEstimateResult {
    if (!node || !node.parameters) {
        return { ramBytes: 0, vramBytes: 0, riskLevel: 'OK', summaryText: 'No data', ramText: '0 MB', vramText: '0 MB' };
    }

    let ramBytes = 0;
    let vramBytes = 0;
    const type = node.type;
    const params = node.parameters;
    const device = String(params.device || 'cpu').toLowerCase();
    const isCuda = device === 'cuda' || device === 'gpu' || device.includes('cuda');

    if (type === 'CFDSolver3D' || type === 'CFDSolver2D' || type === 'CFDSolver') {
        const cfdMem = calculateCFDMemory(node, state);
        if (cfdMem.isCpu) {
            ramBytes = cfdMem.totalBytes;
            vramBytes = 0;
        } else {
            vramBytes = cfdMem.totalBytes;
            ramBytes = cfdMem.totalBytes * 0.2; // host staging buffer
        }
    } else if (isDomainMesh3DNode(type) || isDomainMesh2DNode(type) || type === 'DomainMesh') {
        const hasCfdSolver = state ? state.nodes.some(n => ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'FSICoupler3D', 'FEMFSICoupler3D', 'FSICoupler2D'].includes(n.type)) : true;
        if (hasCfdSolver) {
            const cfdMem = calculateCFDMemory(node, state);
            if (cfdMem.isCpu) {
                ramBytes = cfdMem.totalBytes;
                vramBytes = 0;
            } else {
                vramBytes = cfdMem.totalBytes;
                ramBytes = cfdMem.totalBytes * 0.2; // host staging buffer
            }
        } else {
            // For pure MPM models, DomainMesh is the background grid whose memory is tracked by MPMDomain
            ramBytes = 0;
            vramBytes = 0;
        }
    } else if (type === 'MPMDomain3D') {
        const meshNode = state ? (
            state.nodes.find(n => isDomainMesh3DNode(n.type) && state.connections.some(c =>
                (c.fromNode === n.id && c.toNode === node.id) || (c.toNode === n.id && c.fromNode === node.id)
            )) || state.nodes.find(n => isDomainMesh3DNode(n.type))
        ) : undefined;
        const mp = meshNode?.parameters || params;
        const isSparse = meshNode?.type === 'SparseDomainMesh3D' || Boolean(params.mpm_sparse_grid) || Boolean(params.sparse_grid);

        const cellSize = Number(mp.cell_size ?? params.cell_size) || 0.01;
        const xmin = Number(mp.xmin ?? params.xmin) || 0;
        const xmax = Number(mp.xmax ?? params.xmax) || (xmin + 1.0);
        const ymin = Number(mp.ymin ?? params.ymin) || 0;
        const ymax = Number(mp.ymax ?? params.ymax) || (ymin + 1.0);
        const zmin = Number(mp.zmin ?? params.zmin) || 0;
        const zmax = Number(mp.zmax ?? params.zmax) || (zmin + 1.0);

        const nx = Math.max(1, Math.round((xmax - xmin) / cellSize)) + 1;
        const ny = Math.max(1, Math.round((ymax - ymin) / cellSize)) + 1;
        const nz = Math.max(1, Math.round((zmax - zmin) / cellSize)) + 1;
        const gridNodes = nx * ny * nz;

        const ppc = Number(params.ppc) || 8;
        let estParticles = 0;
        if (state) {
            const mpmObjects = state.nodes.filter(n => n.type === 'MPMObject3D');
            if (mpmObjects.length > 0) {
                const cellVol = cellSize * cellSize * cellSize;
                const domainVol = Math.max(0.0001, (xmax - xmin) * (ymax - ymin) * (zmax - zmin));
                let totalEst = 0;
                for (const obj of mpmObjects) {
                    const op = obj.parameters || {};
                    const objPpc = Math.max(1, Math.round(Number(op.ppc ?? ppc)));
                    const pVol = cellVol / objPpc;
                    const { volume: rawVol } = getMPMObjectVolume(obj, state);
                    const objVol = Math.min(rawVol, domainVol * 0.4);
                    totalEst += Math.max(10, Math.ceil(objVol / pVol));
                }
                estParticles = Math.max(1000, totalEst);
            }
        }
        if (estParticles === 0) {
            estParticles = Math.min(gridNodes * Math.min(ppc, 4), 20000000);
        }

        let allocatedGridNodes = gridNodes;
        let tileDirBytes = 0;
        if (isSparse) {
            const ntx = Math.ceil(nx / 8);
            const nty = Math.ceil(ny / 8);
            const ntz = Math.ceil(nz / 8);
            const totalTiles = Math.max(1, ntx * nty * ntz);
            tileDirBytes = totalTiles * 4;
            const minTiles = Math.ceil((estParticles / (512 * Math.max(1, ppc))) * 4.0) + 64;
            const activeTiles = Math.min(totalTiles, Math.max(64, minTiles));
            allocatedGridNodes = activeTiles * 512;
        }

        if (isCuda) {
            vramBytes = tileDirBytes + (allocatedGridNodes * 104) + (estParticles * 160) + (64 * 1024 * 1024);
            ramBytes = tileDirBytes + (estParticles * 256) + (64 * 1024 * 1024);
        } else {
            ramBytes = tileDirBytes + (allocatedGridNodes * 128) + (estParticles * 256 * 2);
            vramBytes = 0;
        }
    } else if (type === 'MPMDomain2D') {
        const meshNode = state ? (
            state.nodes.find(n => isDomainMesh2DNode(n.type) && state.connections.some(c =>
                (c.fromNode === n.id && c.toNode === node.id) || (c.toNode === n.id && c.fromNode === node.id)
            )) || state.nodes.find(n => isDomainMesh2DNode(n.type))
        ) : undefined;
        const mp = meshNode?.parameters || params;
        const isSparse = meshNode?.type === 'SparseDomainMesh2D' || Boolean(params.mpm_sparse_grid) || Boolean(params.sparse_grid);
        const cellSize = Number(mp.cell_size ?? params.cell_size) || 0.005;
        const maxR = Number(mp.max_r ?? params.max_r) || 1.0;
        const maxZ = Number(mp.max_z ?? params.max_z) || 1.0;
        const nr = Math.max(1, Math.round(maxR / cellSize)) + 1;
        const nz = Math.max(1, Math.round(maxZ / cellSize)) + 1;
        const gridNodes = nr * nz;
        const ppc = Number(params.ppc) || 4;
        let estParticles = 0;
        if (state) {
            const mpmObjects2D = state.nodes.filter(n => n.type === 'MPMObject2D');
            if (mpmObjects2D.length > 0) {
                const cellArea = cellSize * cellSize;
                const domainArea = Math.max(0.0001, maxR * maxZ);
                let totalEst = 0;
                for (const obj of mpmObjects2D) {
                    const op = obj.parameters || {};
                    const objPpc = Math.max(1, Math.round(Number(op.ppc ?? ppc)));
                    const pArea = cellArea / objPpc;
                    const { volume: rawArea } = getMPMObjectVolume(obj, state);
                    const objArea = Math.min(rawArea, domainArea * 0.4);
                    totalEst += Math.max(10, Math.ceil(objArea / pArea));
                }
                estParticles = Math.max(100, totalEst);
            }
        }
        if (estParticles === 0) {
            estParticles = Math.min(gridNodes * ppc, 2000000);
        }

        let allocatedGridNodes = gridNodes;
        let tileDirBytes = 0;
        if (isSparse) {
            const ntx = Math.ceil(nr / 8);
            const nty = Math.ceil(nz / 8);
            const totalTiles = Math.max(1, ntx * nty);
            tileDirBytes = totalTiles * 4;
            const minTiles = Math.ceil((estParticles / (64 * Math.max(1, ppc))) * 4.0) + 32;
            const activeTiles = Math.min(totalTiles, Math.max(32, minTiles));
            allocatedGridNodes = activeTiles * 64;
        }
        ramBytes = tileDirBytes + (allocatedGridNodes * 96) + (estParticles * 192);
        vramBytes = 0;
    } else if (type === 'FEMDomain3D') {
        const counts = resolveFEMCounts(node, state);
        const numElements = counts.totalElements || counts.numElements;
        const numNodes = counts.totalNodes || counts.numNodes;

        if (numElements > 0 || numNodes > 0) {
            if (isCuda) {
                vramBytes = (numNodes * 128) + (numElements * 1024) + (64 * 1024 * 1024);
                ramBytes = (numNodes * 128) + (numElements * 512) + (64 * 1024 * 1024);
            } else {
                ramBytes = (numNodes * 128) + (numElements * 1024);
                vramBytes = 0;
            }
        }
    }

    const riskLevel = categorizeRisk(ramBytes, vramBytes);
    const ramText = formatBytes(ramBytes);
    const vramText = formatBytes(vramBytes);
    const summaryText = isCuda ? `Est. RAM: ${ramText} | Est. VRAM: ${vramText}` : `Est. RAM: ${ramText}`;

    return { ramBytes, vramBytes, riskLevel, summaryText, ramText, vramText };
}

export function estimateGraphMemory(state: SimulationState): MemoryEstimateResult {
    let totalRam = 0;
    let totalVram = 0;

    for (const node of state.nodes) {
        const est = estimateNodeMemory(node, state);
        totalRam += est.ramBytes;
        totalVram += est.vramBytes;
    }

    const riskLevel = categorizeRisk(totalRam, totalVram);
    const ramText = formatBytes(totalRam);
    const vramText = formatBytes(totalVram);
    const summaryText = totalVram > 0 ? `Est. RAM: ${ramText} | Est. VRAM: ${vramText}` : `Est. RAM: ${ramText}`;

    return { ramBytes: totalRam, vramBytes: totalVram, riskLevel, summaryText, ramText, vramText };
}

export function getMemoryDisplayHTML(node: Node, state?: SimulationState): string {
    const est = estimateNodeMemory(node, state);
    if (est.ramBytes === 0 && est.vramBytes === 0) return '';

    let badgeColor = '#10b981'; // Green (OK)
    let badgeText = 'OPTIMAL';
    if (est.riskLevel === 'WARNING') {
        badgeColor = '#f59e0b'; // Yellow (WARNING)
        badgeText = 'HEAVY';
    } else if (est.riskLevel === 'CRITICAL') {
        badgeColor = '#ef4444'; // Red (CRITICAL)
        badgeText = 'CRITICAL / DANGER';
    }

    return `
        <div style="margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.25); border-radius: 6px; border: 1px solid ${badgeColor}; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-weight: 600; color: #eee;">💾 Memory Footprint</span>
                <span style="background: ${badgeColor}; color: #000; font-weight: bold; font-size: 10px; padding: 2px 6px; border-radius: 4px;">${badgeText}</span>
            </div>
            <div style="color: #ccc;">${est.summaryText}</div>
            ${est.riskLevel === 'CRITICAL' ? '<div style="color: #f87171; font-weight: 600; margin-top: 4px;">⚠️ Exceeds safe allocation limits! May freeze system without pre-checks.</div>' : ''}
        </div>
    `;
}

