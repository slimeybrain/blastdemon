import { Node, SimulationState } from './types.js';
import { calculateCFDMemory } from './state-manager.js';

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
    if (ramBytes > 16 * GIGABYTE || vramBytes > 8 * GIGABYTE) {
        return 'CRITICAL';
    }
    if (ramBytes > 4 * GIGABYTE || vramBytes > 3 * GIGABYTE) {
        return 'WARNING';
    }
    return 'OK';
}

export function estimateNodeMemory(node: Node): MemoryEstimateResult {
    if (!node || !node.parameters) {
        return { ramBytes: 0, vramBytes: 0, riskLevel: 'OK', summaryText: 'No data', ramText: '0 MB', vramText: '0 MB' };
    }

    let ramBytes = 0;
    let vramBytes = 0;
    const type = node.type;
    const params = node.parameters;
    const device = String(params.device || 'cpu').toLowerCase();
    const isCuda = device === 'cuda' || device === 'gpu' || device.includes('cuda');

    if (type === 'CFDSolver3D' || type === 'CFDSolver2D' || type === 'CFDSolver' || type === 'DomainMesh3D' || type === 'DomainMesh2D' || type === 'DomainMesh') {
        const cfdMem = calculateCFDMemory(node);
        if (cfdMem.isCpu) {
            ramBytes = cfdMem.totalBytes;
            vramBytes = 0;
        } else {
            vramBytes = cfdMem.totalBytes;
            ramBytes = cfdMem.totalBytes * 0.2; // host staging buffer
        }
    } else if (type === 'MPMDomain3D') {
        const cellSize = Number(params.cell_size) || 0.01;
        const xmin = Number(params.xmin) || 0;
        const xmax = Number(params.xmax) || (xmin + 1.0);
        const ymin = Number(params.ymin) || 0;
        const ymax = Number(params.ymax) || (ymin + 1.0);
        const zmin = Number(params.zmin) || 0;
        const zmax = Number(params.zmax) || (zmin + 1.0);

        const nx = Math.max(1, Math.round((xmax - xmin) / cellSize));
        const ny = Math.max(1, Math.round((ymax - ymin) / cellSize));
        const nz = Math.max(1, Math.round((zmax - zmin) / cellSize));
        const gridNodes = nx * ny * nz;

        const ppc = Number(params.ppc) || 8;
        const estParticles = gridNodes * Math.min(ppc, 4);

        ramBytes = (gridNodes * 128) + (estParticles * 256 * 2);
        vramBytes = isCuda ? ramBytes : 0;
    } else if (type === 'FEMDomain3D') {
        const nx = Number(params.nx) || 20;
        const ny = Number(params.ny) || 20;
        const nz = Number(params.nz) || 20;
        const numElements = nx * ny * nz;
        const numNodes = (nx + 1) * (ny + 1) * (nz + 1);

        ramBytes = (numNodes * 128) + (numElements * 256 * 2);
        vramBytes = isCuda ? ramBytes : 0;
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

    for (const node of state.nodes.values()) {
        const est = estimateNodeMemory(node);
        totalRam += est.ramBytes;
        totalVram += est.vramBytes;
    }

    const riskLevel = categorizeRisk(totalRam, totalVram);
    const ramText = formatBytes(totalRam);
    const vramText = formatBytes(totalVram);
    const summaryText = totalVram > 0 ? `Est. RAM: ${ramText} | Est. VRAM: ${vramText}` : `Est. RAM: ${ramText}`;

    return { ramBytes: totalRam, vramBytes: totalVram, riskLevel, summaryText, ramText, vramText };
}

export function getMemoryDisplayHTML(node: Node): string {
    const est = estimateNodeMemory(node);
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

