// ContourWorker.ts
import {
    buildColormapRGBA32LUT,
    evaluateColormapRGB,
    normalizeColormapId,
    quantizeContourT
} from './contour-style.js';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let width = 0;
let height = 0;
let dpr = 1;

let lastBuffer: ArrayBuffer | null = null;
let lastCfdBuffer: ArrayBuffer | null = null;
let lastMpmBuffer: ArrayBuffer | null = null;
let selectedChannel = 0; // 0=p, 1=rho, 2=ur, 3=uz, 4=e_int, 5=alpha1, 6=alpha2, 7=von_mises, 8=plastic_strain, 9=vmag, 10=dp
let displayMin = 0;
let displayMax = 1;
let range = 1;
let autoScale = true;
let useLogScale = false;
let selectedColormap = 'rainbow';
let showColorbar = false; // Handled by 3D-identical floating glassmorphic HTML Colorbar Card in WorkspaceManager
let showMPMParticles = true;
let showCharge = true;
let showDetonator = true;
let showObstacles = true;
let showGauges = true;
let theme: 'dark' | 'slate' | 'light' = 'slate';
let clearBgRgb: [number, number, number] | null = null;
let simStep = 0;
let simTime = 0;
let simDt = 0;
let hoverMx: number | null = null;
let hoverMy: number | null = null;
let lastValidData: Float32Array | null = null;
let lastValidNr = 0;
let lastValidNz = 0;
let cachedAmrTiles: AMRLeafTile[] | null = null;
let contourLevels = 0;
let isAxisymmetric = true;
let chargeInfo: any = null;
let remapInfo: { r: number; z: number; radius: number } | null = null;
let detonatorInfo: any = null;
let obstacles: Array<{ r_min: number; r_max: number; z_min: number; z_max: number; name?: string }> = [];
let mpmObjects: Array<{ shape_type?: string; pos_x: number; pos_y: number; size_x?: number; size_y?: number; radius?: number; name?: string }> = [];
let gauges: Array<{ id?: string; name?: string; r: number; z: number }> = [];
let showGridlines = false;
let interpolate = true;
let max_r = 1.0;
let max_z = 1.0;
let meshType = 'regular';
let amrMaxLevels = 3;
let baseNr = 128;
let baseNz = 128;
let fillMode: 'fill' | 'aspect' = 'aspect';
let showExtrema = true;
let selectedProbeIndex = -1;
let hoveredProbeIndex = -1;
let boxZoomRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

interface FieldExtrema {
    hasData: boolean;
    peakVal: number;
    peakR: number;
    peakZ: number;
    troughVal: number;
    troughR: number;
    troughZ: number;
}
let fieldExtrema: FieldExtrema = {
    hasData: false,
    peakVal: 0,
    peakR: 0,
    peakZ: 0,
    troughVal: 0,
    troughR: 0,
    troughZ: 0
};

// Zoom and pan state
let zoom = 1.0;
let panX = 0.0;
let panY = 0.0;
let outNr = 0;
let outNz = 0;
let hasCachedHeatmap = false;
let heatmapDirty = true;
let lutDirty = true;

let stride = 1;
let refreshRate = 0.0; // in seconds
let lastRenderTime = 0;
let renderTimeout: any = null;
let renderQueued = false;

// Helper offscreen canvas & reusable ImageData to cache rasterized scalar field
let tempCanvas: OffscreenCanvas | null = null;
let tempCtx: OffscreenCanvasRenderingContext2D | null = null;
let cachedImgData: ImageData | null = null;

// Precomputed 1024-entry RGBA Uint32 LUT (ABGR packed on little-endian x86/ARM)
const LUT_SIZE = 1024;
const colormapLUT = new Uint32Array(LUT_SIZE);
let currentParticles: Float32Array | null = null;

function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    const raf = (self as any).requestAnimationFrame;
    if (typeof raf === 'function') {
        raf(() => {
            renderQueued = false;
            render();
        });
    } else {
        setTimeout(() => {
            renderQueued = false;
            render();
        }, 0);
    }
}

function sampleColormapNormalized(val: number, cmapName: string): [number, number, number] {
    return evaluateColormapRGB(val, cmapName);
}

function rebuildColormapLUT(): void {
    colormapLUT.set(buildColormapRGBA32LUT(selectedColormap, contourLevels, contourLevels <= 1, LUT_SIZE));
    lutDirty = false;
}

function extractParticles2D(buffer: ArrayBuffer): Float32Array | null {
    const HEADER_SIZE = 12;
    if (buffer.byteLength < HEADER_SIZE) return null;
    const header = new DataView(buffer);
    const nr = header.getUint32(0, true);
    const nz = header.getUint32(4, true);
    const n_channels = header.getUint32(8, true);
    const gridBytes = nr * nz * n_channels * 4;

    if (buffer.byteLength < HEADER_SIZE + gridBytes + 4) return null;

    const particlesHeaderView = new DataView(buffer, HEADER_SIZE + gridBytes, 4);
    const numParticles = particlesHeaderView.getUint32(0, true);

    if (numParticles === 0) return null;
    if (buffer.byteLength < HEADER_SIZE + gridBytes + 4 + numParticles * 8) return null;

    return new Float32Array(buffer, HEADER_SIZE + gridBytes + 4, numParticles * 2);
}

function extractChannel2D(buffer: ArrayBuffer, channel: number): { data: Float32Array; nr: number; nz: number } | null {
    const HEADER_SIZE = 12;
    if (buffer.byteLength < HEADER_SIZE) return null;

    const header = new DataView(buffer);
    const nr = header.getUint32(0, true);
    const nz = header.getUint32(4, true);
    const n_channels = header.getUint32(8, true);

    const expectedPayload = nr * nz * n_channels * 4;
    if (buffer.byteLength < HEADER_SIZE + expectedPayload) return null;

    const nCells = nr * nz;

    // Channel 9: Velocity Magnitude |u| = sqrt(u_r^2 + u_z^2)
    if (channel === 9 && n_channels >= 4) {
        const ur = new Float32Array(buffer, HEADER_SIZE + 2 * nCells * 4, nCells);
        const uz = new Float32Array(buffer, HEADER_SIZE + 3 * nCells * 4, nCells);
        const vmag = new Float32Array(nCells);
        for (let i = 0; i < nCells; ++i) {
            vmag[i] = Math.hypot(ur[i], uz[i]);
        }
        return { data: vmag, nr, nz };
    }

    // Channel 10: Overpressure dP = P - 101325
    if (channel === 10 && n_channels >= 1) {
        const p = new Float32Array(buffer, HEADER_SIZE, nCells);
        const dp = new Float32Array(nCells);
        for (let i = 0; i < nCells; ++i) {
            dp[i] = p[i] === 0 ? 0 : (p[i] - 101325.0);
        }
        return { data: dp, nr, nz };
    }

    const clampedChannel = Math.max(0, Math.min(channel, n_channels - 1));
    const byteOffset = HEADER_SIZE + clampedChannel * nCells * 4;
    const floatData = new Float32Array(buffer, byteOffset, nCells);

    return { data: floatData, nr, nz };
}

interface AMRLeafTile {
    r_idx: number;
    z_idx: number;
    level: number;
    data: Float32Array;
}

function extractAMRChannel2D(buffer: ArrayBuffer, channel: number): AMRLeafTile[] | null {
    if (buffer.byteLength < 8) return null;

    const view = new DataView(buffer);
    const num_leaves = view.getUint32(0, true);
    const n_channels = view.getUint32(4, true);

    const floatsPerTile = 2 + 256 * n_channels;
    const expectedBytes = 8 + num_leaves * floatsPerTile * 4;
    if (buffer.byteLength < expectedBytes) return null;

    const tiles: AMRLeafTile[] = new Array(num_leaves);
    const clampedChannel = Math.max(0, Math.min(channel, n_channels - 1));

    for (let l = 0; l < num_leaves; ++l) {
        const offset = 8 + l * floatsPerTile * 4;
        const meta1 = view.getUint32(offset, true);
        const meta2 = view.getUint32(offset + 4, true);

        const r_idx = meta1 >>> 16;
        const z_idx = meta1 & 0xFFFF;
        const level = (meta2 >>> 8) & 0xFF;

        const tileData = new Float32Array(256);
        if (channel === 9 && n_channels >= 4) {
            for (let c = 0; c < 256; ++c) {
                const baseCellOffset = offset + 8 + c * n_channels * 4;
                const ur = view.getFloat32(baseCellOffset + 8, true);
                const uz = view.getFloat32(baseCellOffset + 12, true);
                tileData[c] = Math.hypot(ur, uz);
            }
        } else if (channel === 10 && n_channels >= 1) {
            for (let c = 0; c < 256; ++c) {
                const baseCellOffset = offset + 8 + c * n_channels * 4;
                const p = view.getFloat32(baseCellOffset, true);
                tileData[c] = p === 0 ? 0 : (p - 101325.0);
            }
        } else {
            const chByteOff = clampedChannel * 4;
            for (let c = 0; c < 256; ++c) {
                tileData[c] = view.getFloat32(offset + 8 + c * n_channels * 4 + chByteOff, true);
            }
        }

        tiles[l] = { r_idx, z_idx, level, data: tileData };
    }

    return tiles;
}

function updateAutoScaleAMR(tiles: AMRLeafTile[]): void {
    if (!autoScale) return;
    const isStrictlyPos = (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 4);
    let min = Infinity;
    let max = -Infinity;
    let posMin = Infinity;
    for (let t = 0; t < tiles.length; ++t) {
        const td = tiles[t].data;
        for (let i = 0; i < 256; ++i) {
            const v = td[i];
            if (isFinite(v)) {
                if (isStrictlyPos && v <= 0) continue;
                if (v < min) min = v;
                if (v > max) max = v;
                if (v > 0 && v < posMin) posMin = v;
            }
        }
    }
    if (min !== Infinity && max !== -Infinity) {
        if (useLogScale && max > 0) {
            const dynamicFloor = max * 1e-6;
            const effMin = (isFinite(posMin) && posMin > dynamicFloor) ? posMin : dynamicFloor;
            displayMin = effMin;
            displayMax = max;
        } else {
            displayMin = min;
            displayMax = max;
        }
        range = displayMax - displayMin || 1;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    }
}

function updateAutoScale(data: Float32Array): void {
    if (!autoScale) return;
    const isStrictlyPos = (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 4);
    let min = Infinity;
    let max = -Infinity;
    let posMin = Infinity;
    for (let i = 0; i < data.length; ++i) {
        const v = data[i];
        if (isFinite(v)) {
            if (isStrictlyPos && v <= 0) continue;
            if (v < min) min = v;
            if (v > max) max = v;
            if (v > 0 && v < posMin) posMin = v;
        }
    }
    if (min !== Infinity && max !== -Infinity) {
        if (useLogScale && max > 0) {
            const dynamicFloor = max * 1e-6;
            const effMin = (isFinite(posMin) && posMin > dynamicFloor) ? posMin : dynamicFloor;
            displayMin = effMin;
            displayMax = max;
        } else {
            displayMin = min;
            displayMax = max;
        }
        range = displayMax - displayMin || 1;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    }
}

function formatSciNumber(v: number): string {
    if (!isFinite(v)) return '0';
    if (v === 0) return '0';
    const absV = Math.abs(v);
    if (absV >= 1e4 || absV < 1e-2) {
        return v.toExponential(2);
    }
    if (absV >= 100) return v.toFixed(1);
    if (absV >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

const CHANNEL_TITLES: Record<number, { name: string; unit: string }> = {
    0: { name: 'Pressure P', unit: 'Pa' },
    1: { name: 'Density ρ', unit: 'kg/m³' },
    2: { name: 'Radial Vel u_r', unit: 'm/s' },
    3: { name: 'Axial Vel u_z', unit: 'm/s' },
    4: { name: 'Specific Energy e', unit: 'J/kg' },
    5: { name: 'Reacted α₁', unit: '-' },
    6: { name: 'Unreacted α₂', unit: '-' },
    7: { name: 'MPM von Mises', unit: 'Pa' },
    8: { name: 'MPM Plastic ε_p', unit: '-' },
    9: { name: 'Velocity Mag |u|', unit: 'm/s' },
    10: { name: 'Overpressure ΔP', unit: 'Pa' }
};

function rebuildHeatmapTexture(): void {
    if (lutDirty) {
        rebuildColormapLUT();
    }

    hasCachedHeatmap = false;
    fieldExtrema = { hasData: false, peakVal: 0, peakR: 0, peakZ: 0, troughVal: 0, troughR: 0, troughZ: 0 };

    if (meshType === 'amr') {
        const tiles = lastBuffer ? extractAMRChannel2D(lastBuffer, selectedChannel) : null;
        cachedAmrTiles = tiles;
        if (!tiles || tiles.length === 0) {
            heatmapDirty = false;
            return;
        }

        updateAutoScaleAMR(tiles);

        const maxLvl = Math.max(0, amrMaxLevels - 1);
        const scaleFactor = 1 << maxLvl;
        const level0TilesR = Math.max(1, Math.ceil((baseNr || 128) / 16));
        const dr_base = (max_r || 1.0) / (level0TilesR * 16);
        const level0TilesZ = Math.max(1, Math.round((max_z || 1.0) / (dr_base * 16)));
        const fullNr = Math.max(16, (level0TilesR * 16) * scaleFactor);
        const fullNz = Math.max(16, (level0TilesZ * 16) * scaleFactor);

        // Detect exact AMR domain Peak & Trough
        let pVal = -Infinity, pR = 0, pZ = 0;
        let tVal = Infinity, tR = 0, tZ = 0;
        const skipNonPos = (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 4);
        for (let tIdx = 0; tIdx < tiles.length; ++tIdx) {
            const tile = tiles[tIdx];
            const factor = 1.0 / (1 << tile.level);
            const tileW = (max_r / level0TilesR) * factor;
            const tileH = (max_z / level0TilesZ) * factor;
            const rMin = tile.r_idx * tileW;
            const zMin = tile.z_idx * tileH;
            const td = tile.data;
            for (let i = 0; i < 16; ++i) {
                const rc = rMin + ((i + 0.5) / 16) * tileW;
                const rowOff = i * 16;
                for (let j = 0; j < 16; ++j) {
                    const v = td[rowOff + j];
                    if (!isFinite(v)) continue;
                    const zc = zMin + ((j + 0.5) / 16) * tileH;
                    if (v > pVal) { pVal = v; pR = rc; pZ = zc; }
                    if (skipNonPos && v <= 0) continue;
                    if (v < tVal) { tVal = v; tR = rc; tZ = zc; }
                }
            }
        }
        if (isFinite(pVal) && isFinite(tVal)) {
            fieldExtrema = { hasData: true, peakVal: pVal, peakR: pR, peakZ: pZ, troughVal: tVal, troughR: tR, troughZ: tZ };
        }

        // Cap raster texture to <= 1024 px on longest axis so huge AMR grids (e.g. 3200x6400) rasterize in < 2ms!
        const maxAxis = Math.max(fullNr, fullNz);
        const texScale = maxAxis > 1024 ? (1024 / maxAxis) : 1.0;
        outNr = Math.max(16, Math.round(fullNr * texScale));
        outNz = Math.max(16, Math.round(fullNz * texScale));

        if (!tempCanvas || tempCanvas.width !== outNr || tempCanvas.height !== outNz) {
            tempCanvas = new OffscreenCanvas(outNr, outNz);
            tempCtx = tempCanvas.getContext('2d');
            cachedImgData = tempCtx ? tempCtx.createImageData(outNr, outNz) : null;
        } else if (!cachedImgData && tempCtx) {
            cachedImgData = tempCtx.createImageData(outNr, outNz);
        }

        if (tempCtx && cachedImgData) {
            const pixels32 = new Uint32Array(cachedImgData.data.buffer);
            pixels32.fill(colormapLUT[0]);

            const safeMax = Math.max(1e-20, displayMax);
            const safeMin = Math.max(safeMax * 1e-6, displayMin > 0 ? displayMin : safeMax * 1e-6);
            const logMin = useLogScale ? Math.log10(safeMin) : 0;
            const invLogSpan = useLogScale ? (1.0 / Math.max(1e-12, Math.log10(safeMax) - logMin)) : 0;
            const invLinSpan = !useLogScale ? (1.0 / (displayMax - displayMin || 1)) : 0;
            const lutMax = LUT_SIZE - 1;

            const scaleX = outNr / fullNr;
            const scaleY = outNz / fullNz;

            for (let tIdx = 0; tIdx < tiles.length; ++tIdx) {
                const tile = tiles[tIdx];
                const cellFinest = 1 << Math.max(0, maxLvl - tile.level);
                const tileStartX = tile.r_idx * 16 * cellFinest;
                const tileStartY = tile.z_idx * 16 * cellFinest;
                const td = tile.data;

                for (let i = 0; i < 16; ++i) {
                    const x0 = Math.max(0, Math.floor((tileStartX + i * cellFinest) * scaleX));
                    const x1 = Math.min(outNr, Math.max(x0 + 1, Math.floor((tileStartX + (i + 1) * cellFinest) * scaleX)));
                    if (x0 >= outNr) continue;

                    const rowOff = i * 16;
                    for (let j = 0; j < 16; ++j) {
                        const yRaw0 = Math.max(0, Math.floor((tileStartY + j * cellFinest) * scaleY));
                        const yRaw1 = Math.min(outNz, Math.max(yRaw0 + 1, Math.floor((tileStartY + (j + 1) * cellFinest) * scaleY)));
                        if (yRaw0 >= outNz) continue;

                        const val = td[rowOff + j];
                        let norm = 0;
                        if (useLogScale) {
                            norm = (Math.log10(Math.max(safeMin, val)) - logMin) * invLogSpan;
                        } else {
                            norm = (val - displayMin) * invLinSpan;
                        }
                        const lutIdx = norm <= 0 ? 0 : (norm >= 1 ? lutMax : ((norm * lutMax) | 0));
                        const rgba = colormapLUT[lutIdx];

                        for (let pyRaw = yRaw0; pyRaw < yRaw1; ++pyRaw) {
                            const rowBase = (outNz - 1 - pyRaw) * outNr;
                            for (let px = x0; px < x1; ++px) {
                                pixels32[rowBase + px] = rgba;
                            }
                        }
                    }
                }
            }

            tempCtx.putImageData(cachedImgData, 0, 0);
            hasCachedHeatmap = true;
            lastValidNr = baseNr;
            lastValidNz = baseNz;
        }
    } else {
        cachedAmrTiles = null;
        const cfdBufToUse = lastCfdBuffer || lastBuffer;
        const mpmBufToUse = lastMpmBuffer || lastBuffer;
        if (mpmBufToUse) {
            currentParticles = extractParticles2D(mpmBufToUse);
        }
        const frameInfo = cfdBufToUse ? extractChannel2D(cfdBufToUse, selectedChannel) : null;
        if (!frameInfo) {
            heatmapDirty = false;
            return;
        }

        const { data, nr, nz } = frameInfo;
        updateAutoScale(data);

        lastValidData = data;
        lastValidNr = nr;
        lastValidNz = nz;

        // Detect exact 2D domain Peak & Trough
        if (nr > 0 && nz > 0) {
            let pVal = -Infinity, pI = 0, pJ = 0;
            let tVal = Infinity, tI = 0, tJ = 0;
            const skipNonPos = (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 4);
            for (let i = 0; i < nr; ++i) {
                const colOff = i * nz;
                for (let j = 0; j < nz; ++j) {
                    const v = data[colOff + j];
                    if (!isFinite(v)) continue;
                    if (v > pVal) { pVal = v; pI = i; pJ = j; }
                    if (skipNonPos && v <= 0) continue;
                    if (v < tVal) { tVal = v; tI = i; tJ = j; }
                }
            }
            if (!isFinite(tVal) && isFinite(pVal)) {
                tVal = 0; tI = 0; tJ = 0;
            }
            if (isFinite(pVal) && isFinite(tVal)) {
                fieldExtrema = {
                    hasData: true,
                    peakVal: pVal,
                    peakR: ((pI + 0.5) / nr) * (max_r || 1.0),
                    peakZ: ((pJ + 0.5) / nz) * (max_z || 1.0),
                    troughVal: tVal,
                    troughR: ((tI + 0.5) / nr) * (max_r || 1.0),
                    troughZ: ((tJ + 0.5) / nz) * (max_z || 1.0)
                };
            }
        }

        // Cap texture size to <= 1024 on longest side while respecting user stride
        const effStrideR = Math.max(1, stride, Math.ceil(nr / 1024));
        const effStrideZ = Math.max(1, stride, Math.ceil(nz / 1024));
        outNr = Math.max(1, Math.ceil(nr / effStrideR));
        outNz = Math.max(1, Math.ceil(nz / effStrideZ));

        if (!tempCanvas || tempCanvas.width !== outNr || tempCanvas.height !== outNz) {
            tempCanvas = new OffscreenCanvas(outNr, outNz);
            tempCtx = tempCanvas.getContext('2d');
            cachedImgData = tempCtx ? tempCtx.createImageData(outNr, outNz) : null;
        } else if (!cachedImgData && tempCtx) {
            cachedImgData = tempCtx.createImageData(outNr, outNz);
        }

        if (tempCtx && cachedImgData) {
            const pixels32 = new Uint32Array(cachedImgData.data.buffer);
            const safeMax = Math.max(1e-20, displayMax);
            const safeMin = Math.max(safeMax * 1e-6, displayMin > 0 ? displayMin : safeMax * 1e-6);
            const logMin = useLogScale ? Math.log10(safeMin) : 0;
            const invLogSpan = useLogScale ? (1.0 / Math.max(1e-12, Math.log10(safeMax) - logMin)) : 0;
            const invLinSpan = !useLogScale ? (1.0 / (displayMax - displayMin || 1)) : 0;
            const lutMax = LUT_SIZE - 1;
            const clampZeroPositive = (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 4) && displayMin > 0;

            for (let i = 0; i < outNr; ++i) {
                const rawI = Math.min(nr - 1, i * effStrideR);
                const colOffset = rawI * nz;
                for (let j = 0; j < outNz; ++j) {
                    const rawJ = Math.min(nz - 1, j * effStrideZ);
                    let val = data[colOffset + rawJ];
                    if (!isFinite(val)) val = displayMin;
                    else if (clampZeroPositive && val === 0) val = displayMin;

                    let norm = 0;
                    if (useLogScale) {
                        norm = (Math.log10(Math.max(safeMin, val)) - logMin) * invLogSpan;
                    } else {
                        norm = (val - displayMin) * invLinSpan;
                    }
                    const lutIdx = norm <= 0 ? 0 : (norm >= 1 ? lutMax : ((norm * lutMax) | 0));
                    pixels32[(outNz - 1 - j) * outNr + i] = colormapLUT[lutIdx];
                }
            }

            tempCtx.putImageData(cachedImgData, 0, 0);
            hasCachedHeatmap = true;
        }
    }

    heatmapDirty = false;
}

function getViewportRect(): { vpX: number; vpY: number; vpW: number; vpH: number } {
    const padLeft = 50;
    const padRight = showColorbar ? 84 : 14;
    const padTop = 12;
    const padBottom = 30;
    return {
        vpX: padLeft,
        vpY: padTop,
        vpW: Math.max(60, width - padLeft - padRight),
        vpH: Math.max(60, height - padTop - padBottom)
    };
}

function getDomainBaseRect(): { dx: number; dy: number; dw: number; dh: number; vpX: number; vpY: number; vpW: number; vpH: number } {
    const { vpX, vpY, vpW, vpH } = getViewportRect();

    let cellsR: number;
    let cellsZ: number;
    if (meshType === 'amr') {
        const level0TilesR = Math.max(1, Math.ceil((baseNr || 128) / 16));
        const drBase = Math.max(1e-6, max_r || 1.0) / (level0TilesR * 16);
        const level0TilesZ = Math.max(1, Math.round(Math.max(1e-6, max_z || 1.0) / (drBase * 16)));
        max_z = level0TilesZ * 16 * drBase;
        cellsR = level0TilesR * 16;
        cellsZ = level0TilesZ * 16;
    } else if (lastValidNr > 0 && lastValidNz > 0) {
        cellsR = lastValidNr;
        cellsZ = lastValidNz;
    } else if (baseNr > 0 && baseNz > 0) {
        cellsR = baseNr;
        cellsZ = baseNz;
    } else {
        cellsR = Math.max(1, Math.round(Math.max(1e-6, max_r) * 100));
        cellsZ = Math.max(1, Math.round(Math.max(1e-6, max_z) * 100));
    }

    // Strict 1:1 aspect ratio for computational cells: (dw / totalCellsX) === (dh / cellsZ)
    const totalCellsX = isAxisymmetric ? 2 * cellsR : cellsR;
    const aspect = Math.max(1e-4, totalCellsX / Math.max(1, cellsZ));

    let dw = vpW;
    let dh = vpH;
    if (vpW / vpH > aspect) {
        dw = vpH * aspect;
        dh = vpH;
    } else {
        dw = vpW;
        dh = vpW / aspect;
    }
    dw = Math.max(20, dw);
    dh = Math.max(20, dh);
    const dx = vpX + (vpW - dw) / 2;
    const dy = vpY + (vpH - dh) / 2;
    return { dx, dy, dw, dh, vpX, vpY, vpW, vpH };
}

function domainToScreen(physSignedR: number, physZ: number): { sx: number; sy: number } {
    const { dx, dy, dw, dh, vpX, vpY, vpW, vpH } = getDomainBaseRect();
    const px = vpX + vpW / 2;
    const py = vpY + vpH / 2;
    const ux = isAxisymmetric
        ? (dx + dw / 2 + (physSignedR / Math.max(1e-6, max_r)) * (dw / 2))
        : (dx + (physSignedR / Math.max(1e-6, max_r)) * dw);
    const uy = dy + dh - (physZ / Math.max(1e-6, max_z)) * dh;
    return {
        sx: px + panX + (ux - px) * zoom,
        sy: py + panY + (uy - py) * zoom
    };
}

function hitTestProbe(mx: number, my: number): number {
    if (!showGauges || !gauges || gauges.length === 0) return -1;
    let bestIdx = -1;
    let bestDistSq = 14 * 14;
    for (let idx = 0; idx < gauges.length; ++idx) {
        const g = gauges[idx];
        const gr = Number(g.r ?? 0);
        const gz = Number(g.z ?? 0);
        const posR = domainToScreen(gr, gz);
        const dR2 = (mx - posR.sx) * (mx - posR.sx) + (my - posR.sy) * (my - posR.sy);
        if (dR2 <= bestDistSq) {
            bestDistSq = dR2;
            bestIdx = idx;
        }
        if (isAxisymmetric && gr > 0) {
            const posL = domainToScreen(-gr, gz);
            const dL2 = (mx - posL.sx) * (mx - posL.sx) + (my - posL.sy) * (my - posL.sy);
            if (dL2 <= bestDistSq) {
                bestDistSq = dL2;
                bestIdx = idx;
            }
        }
    }
    return bestIdx;
}

function clampPanToViewport(): void {
    const { vpW, vpH } = getViewportRect();
    const maxPanX = vpW * Math.max(0.65, zoom * 0.65);
    const maxPanY = vpH * Math.max(0.65, zoom * 0.65);
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
}

function drawRoundedBox(context: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    context.beginPath();
    if (typeof (context as any).roundRect === 'function') {
        (context as any).roundRect(x, y, w, h, r);
    } else {
        context.rect(x, y, w, h);
    }
}

function render(): void {
    const context = ctx;
    if (!context || !canvas || width <= 0 || height <= 0) return;

    lastRenderTime = Date.now();

    if (chargeInfo && chargeInfo.max_r) {
        max_r = chargeInfo.max_r;
    } else if (detonatorInfo && detonatorInfo.max_r) {
        max_r = detonatorInfo.max_r;
    }
    if (chargeInfo && chargeInfo.max_z) {
        max_z = chargeInfo.max_z;
    } else if (detonatorInfo && detonatorInfo.max_z) {
        max_z = detonatorInfo.max_z;
    }

    if (meshType === 'amr') {
        const level0TilesR = Math.max(1, Math.ceil((baseNr || 128) / 16));
        const dr_base = (max_r || 1.0) / (level0TilesR * 16);
        const level0TilesZ = Math.max(1, Math.round((max_z || 1.0) / (dr_base * 16)));
        max_z = level0TilesZ * 16 * dr_base;
    }

    if (heatmapDirty || lutDirty) {
        rebuildHeatmapTexture();
    }

    const isLight = theme === 'light';

    // Studio backdrop matching 3D WebGPU stage theme
    context.clearRect(0, 0, width, height);
    if (clearBgRgb) {
        context.fillStyle = `rgb(${clearBgRgb[0]}, ${clearBgRgb[1]}, ${clearBgRgb[2]})`;
        context.fillRect(0, 0, width, height);
    } else {
        const bgGrad = context.createRadialGradient(
            width * 0.5, height * 0.45, Math.min(width, height) * 0.08,
            width * 0.5, height * 0.5, Math.max(width, height) * 0.78
        );
        if (isLight) {
            bgGrad.addColorStop(0, '#f8fafc');
            bgGrad.addColorStop(1, '#e2e8f0');
        } else if (theme === 'slate') {
            bgGrad.addColorStop(0, '#1e293b');
            bgGrad.addColorStop(1, '#0f172a');
        } else {
            bgGrad.addColorStop(0, '#131926');
            bgGrad.addColorStop(1, '#090d16');
        }
        context.fillStyle = bgGrad;
        context.fillRect(0, 0, width, height);
    }

    const { dx, dy, dw, dh, vpX, vpY, vpW, vpH } = getDomainBaseRect();
    if (!isFinite(panX)) panX = 0;
    if (!isFinite(panY)) panY = 0;
    if (!isFinite(zoom) || zoom <= 0) zoom = 1.0;

    const px = vpX + vpW / 2;
    const py = vpY + vpH / 2;

    // Full-bleed viewport card background (never clipped to an inner square!)
    context.save();
    context.fillStyle = isLight ? 'rgba(255, 255, 255, 0.88)' : 'rgba(11, 17, 32, 0.76)';
    context.fillRect(vpX, vpY, vpW, vpH);

    // Subtle viewport reference grid across entire panel aligned with outer axis ticks
    const nBgX = vpW < 380 ? 4 : 6;
    const nBgY = vpH < 240 ? 4 : 5;
    context.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.06)' : 'rgba(148, 163, 184, 0.08)';
    context.lineWidth = 1;
    context.beginPath();
    for (let g = 1; g < nBgX; ++g) {
        const gx = vpX + (vpW * g) / nBgX;
        context.moveTo(gx, vpY);
        context.lineTo(gx, vpY + vpH);
    }
    for (let g = 1; g < nBgY; ++g) {
        const gy = vpY + vpH - (vpH * g) / nBgY;
        context.moveTo(vpX, gy);
        context.lineTo(vpX + vpW, gy);
    }
    context.stroke();
    context.restore();

    // Clip strictly to the FULL viewport (vpX, vpY, vpW, vpH) so zooming/panning fills 100% of the panel!
    context.save();
    context.beginPath();
    context.rect(vpX, vpY, vpW, vpH);
    context.clip();

    context.save();
    context.translate(px + panX, py + panY);
    context.scale(zoom, zoom);
    context.translate(-px, -py);

    const smoothDraw = interpolate && contourLevels <= 1;
    context.imageSmoothingEnabled = smoothDraw;
    if (smoothDraw) (context as any).imageSmoothingQuality = 'high';

    if (hasCachedHeatmap && tempCanvas && outNr > 0 && outNz > 0) {
        if (isAxisymmetric) {
            const halfDw = dw / 2;
            context.save();
            context.translate(dx + halfDw, dy);
            context.scale(-1, 1);
            context.imageSmoothingEnabled = smoothDraw;
            if (smoothDraw) (context as any).imageSmoothingQuality = 'high';
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, 0, 0, halfDw + 0.5, dh);
            context.restore();

            context.imageSmoothingEnabled = smoothDraw;
            if (smoothDraw) (context as any).imageSmoothingQuality = 'high';
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, dx + halfDw, dy, halfDw, dh);
        } else {
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, dx, dy, dw, dh);
        }
    } else {
        // Clean 3D-style pre-run domain grid placeholder with 1:1 square cells
        context.save();
        context.fillStyle = isLight ? '#f1f5f9' : '#0d1424';
        context.fillRect(dx, dy, dw, dh);
        context.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.18)' : 'rgba(148, 163, 184, 0.14)';
        context.lineWidth = 1 / zoom;
        const pNr = Math.max(1, baseNr || 32);
        const pNz = Math.max(1, baseNz || 32);
        const previewStride = Math.max(1, Math.ceil(Math.max(pNr, pNz) / 10));
        context.beginPath();
        for (let j = previewStride; j < pNz; j += previewStride) {
            const gy = dy + dh - (j / pNz) * dh;
            context.moveTo(dx, gy);
            context.lineTo(dx + dw, gy);
        }
        if (isAxisymmetric) {
            for (let i = previewStride; i < pNr; i += previewStride) {
                const off = (i / pNr) * (dw / 2);
                context.moveTo(dx + dw / 2 + off, dy);
                context.lineTo(dx + dw / 2 + off, dy + dh);
                context.moveTo(dx + dw / 2 - off, dy);
                context.lineTo(dx + dw / 2 - off, dy + dh);
            }
        } else {
            for (let i = previewStride; i < pNr; i += previewStride) {
                const gx = dx + (i / pNr) * dw;
                context.moveTo(gx, dy);
                context.lineTo(gx, dy + dh);
            }
        }
        context.stroke();
        if (isAxisymmetric) {
            context.beginPath();
            context.setLineDash([4 / zoom, 4 / zoom]);
            context.strokeStyle = 'rgba(56, 189, 248, 0.45)';
            context.moveTo(dx + dw / 2, dy);
            context.lineTo(dx + dw / 2, dy + dh);
            context.stroke();
            context.setLineDash([]);
        }
        context.restore();
    }

    // Physical domain outline when in 1:1 aspect or panned/zoomed out
    context.save();
    context.strokeStyle = isLight ? 'rgba(51, 65, 85, 0.55)' : 'rgba(56, 189, 248, 0.48)';
    context.lineWidth = 1.1 / zoom;
    context.strokeRect(dx, dy, dw, dh);
    context.restore();

    // Cell / AMR mesh overlay (LOD-culled for 60 FPS even on 5,000+ AMR leaves!)
    if (showGridlines) {
        if (meshType === 'amr' && cachedAmrTiles && cachedAmrTiles.length > 0) {
            context.save();
            const level0TilesR = Math.max(1, Math.ceil((baseNr || 128) / 16));
            const dr_base = (max_r || 1.0) / (level0TilesR * 16);
            const level0TilesZ = Math.max(1, Math.round((max_z || 1.0) / (dr_base * 16)));
            const halfDw = dw / 2;

            context.strokeStyle = 'rgba(255, 255, 255, 0.16)';
            context.lineWidth = 0.5 / zoom;
            context.beginPath();
            let drewSubCells = false;

            for (let tIdx = 0; tIdx < cachedAmrTiles.length; ++tIdx) {
                const tile = cachedAmrTiles[tIdx];
                const factor = 1.0 / (1 << tile.level);
                const tileWidth = (max_r / level0TilesR) * factor;
                const twScreen = ((tileWidth / max_r) * (isAxisymmetric ? halfDw : dw)) * zoom;
                if (twScreen < 64) continue;

                drewSubCells = true;
                const tileHeight = (max_z / level0TilesZ) * factor;
                const rMin = tile.r_idx * tileWidth;
                const zMin = tile.z_idx * tileHeight;
                const cellW = tileWidth / 16;
                const cellH = tileHeight / 16;
                const cyTop = dy + dh - ((zMin + tileHeight) / max_z) * dh;
                const cyBot = dy + dh - (zMin / max_z) * dh;

                for (let i = 1; i < 16; ++i) {
                    const r = rMin + i * cellW;
                    if (isAxisymmetric) {
                        const cxR = dx + halfDw + (r / max_r) * halfDw;
                        const cxL = dx + halfDw - (r / max_r) * halfDw;
                        context.moveTo(cxR, cyTop); context.lineTo(cxR, cyBot);
                        context.moveTo(cxL, cyTop); context.lineTo(cxL, cyBot);
                    } else {
                        const cx = dx + (r / max_r) * dw;
                        context.moveTo(cx, cyTop); context.lineTo(cx, cyBot);
                    }
                }
                for (let j = 1; j < 16; ++j) {
                    const z = zMin + j * cellH;
                    const cy = dy + dh - (z / max_z) * dh;
                    if (isAxisymmetric) {
                        const cx1R = dx + halfDw + (rMin / max_r) * halfDw;
                        const cx2R = dx + halfDw + ((rMin + tileWidth) / max_r) * halfDw;
                        const cx1L = dx + halfDw - (rMin / max_r) * halfDw;
                        const cx2L = dx + halfDw - ((rMin + tileWidth) / max_r) * halfDw;
                        context.moveTo(cx1R, cy); context.lineTo(cx2R, cy);
                        context.moveTo(cx1L, cy); context.lineTo(cx2L, cy);
                    } else {
                        const cx1 = dx + (rMin / max_r) * dw;
                        const cx2 = dx + ((rMin + tileWidth) / max_r) * dw;
                        context.moveTo(cx1, cy); context.lineTo(cx2, cy);
                    }
                }
            }
            if (drewSubCells) context.stroke();

            context.beginPath();
            context.strokeStyle = 'rgba(56, 189, 248, 0.55)';
            context.lineWidth = 0.9 / zoom;
            for (let tIdx = 0; tIdx < cachedAmrTiles.length; ++tIdx) {
                const tile = cachedAmrTiles[tIdx];
                const factor = 1.0 / (1 << tile.level);
                const tileWidth = (max_r / level0TilesR) * factor;
                const tileHeight = (max_z / level0TilesZ) * factor;
                const rMin = tile.r_idx * tileWidth;
                const zMin = tile.z_idx * tileHeight;
                const cyTop = dy + dh - ((zMin + tileHeight) / max_z) * dh;
                const cyBot = dy + dh - (zMin / max_z) * dh;
                const th = cyBot - cyTop;

                if (isAxisymmetric) {
                    const cxR = dx + halfDw + (rMin / max_r) * halfDw;
                    const tw = (tileWidth / max_r) * halfDw;
                    context.rect(cxR, cyTop, tw, th);
                    const cxL = dx + halfDw - ((rMin + tileWidth) / max_r) * halfDw;
                    context.rect(cxL, cyTop, tw, th);
                } else {
                    const cx = dx + (rMin / max_r) * dw;
                    const tw = (tileWidth / max_r) * dw;
                    context.rect(cx, cyTop, tw, th);
                }
            }
            context.stroke();
            context.restore();
        } else {
            const gridNr = lastValidNr > 0 ? lastValidNr : Math.max(1, Math.min(64, baseNr || 32));
            const gridNz = lastValidNz > 0 ? lastValidNz : Math.max(1, Math.min(64, baseNz || 32));
            const cellWidthOnScreen = (isAxisymmetric ? (dw / 2) : dw) / gridNr * zoom;
            const strideLines = cellWidthOnScreen >= 5 ? 1 : Math.max(1, Math.ceil(6 / Math.max(0.1, cellWidthOnScreen)));
            context.save();
            context.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(255, 255, 255, 0.20)';
            context.lineWidth = 0.6 / zoom;
            context.beginPath();

            for (let j = 0; j <= gridNz; j += strideLines) {
                const y = dy + (j * dh) / gridNz;
                context.moveTo(dx, y);
                context.lineTo(dx + dw, y);
            }

            if (isAxisymmetric) {
                for (let i = 0; i <= gridNr; i += strideLines) {
                    const xRight = dx + dw / 2 + (i * (dw / 2)) / gridNr;
                    const xLeft = dx + dw / 2 - (i * (dw / 2)) / gridNr;
                    context.moveTo(xRight, dy); context.lineTo(xRight, dy + dh);
                    context.moveTo(xLeft, dy); context.lineTo(xLeft, dy + dh);
                }
            } else {
                for (let i = 0; i <= gridNr; i += strideLines) {
                    const x = dx + (i * dw) / gridNr;
                    context.moveTo(x, dy);
                    context.lineTo(x, dy + dh);
                }
            }
            context.stroke();
            context.restore();
        }
    }

    // 2D Rigid Obstacles
    if (showObstacles && obstacles && obstacles.length > 0) {
        context.save();
        const drawObs = (obs: any, flipX: boolean) => {
            const rMinVal = Number(obs.r_min ?? obs.min_r ?? 0);
            const rMaxVal = Number(obs.r_max ?? obs.max_r ?? 0);
            const zMinVal = Number(obs.z_min ?? obs.min_z ?? 0);
            const zMaxVal = Number(obs.z_max ?? obs.max_z ?? 0);
            const r0 = Math.min(rMinVal, rMaxVal);
            const r1 = Math.max(rMinVal, rMaxVal);
            const z0 = Math.min(zMinVal, zMaxVal);
            const z1 = Math.max(zMinVal, zMaxVal);
            let x0: number, x1: number;
            if (isAxisymmetric) {
                const sign = flipX ? -1 : 1;
                x0 = dx + dw / 2 + sign * (r0 / max_r) * (dw / 2);
                x1 = dx + dw / 2 + sign * (r1 / max_r) * (dw / 2);
            } else {
                x0 = dx + (r0 / max_r) * dw;
                x1 = dx + (r1 / max_r) * dw;
            }
            const y0 = dy + dh - (z1 / max_z) * dh;
            const y1 = dy + dh - (z0 / max_z) * dh;
            const rx = Math.min(x0, x1);
            const ry = Math.min(y0, y1);
            const rw = Math.abs(x1 - x0);
            const rh = Math.abs(y1 - y0);

            context.fillStyle = 'rgba(30, 41, 59, 0.90)';
            context.strokeStyle = '#94a3b8';
            context.lineWidth = 1.4 / zoom;
            context.beginPath();
            context.rect(rx, ry, rw, rh);
            context.fill();
            context.stroke();
        };
        for (const obs of obstacles) {
            drawObs(obs, false);
            if (isAxisymmetric) drawObs(obs, true);
        }
        context.restore();
    }

    // Pre-run 2D MPM Object outlines
    if (showMPMParticles && (!currentParticles || currentParticles.length === 0) && mpmObjects && mpmObjects.length > 0) {
        context.save();
        context.fillStyle = 'rgba(56, 189, 248, 0.22)';
        context.strokeStyle = '#38bdf8';
        context.lineWidth = 1.5 / zoom;
        const drawMpmObj = (obj: any, flipX: boolean) => {
            const shapeType = String(obj.shape_type ?? obj.shape ?? 'Box');
            const posX = obj.pos_x !== undefined ? Number(obj.pos_x) : (obj.center_x !== undefined && Number(obj.center_x) !== 0 ? Number(obj.center_x) : 0.5 * (Number(obj.min_x ?? 0) + Number(obj.max_x ?? 0.2)));
            const posY = obj.pos_y !== undefined ? Number(obj.pos_y) : (obj.center_y !== undefined && Number(obj.center_y) !== 0 ? Number(obj.center_y) : 0.5 * (Number(obj.min_y ?? 0) + Number(obj.max_y ?? 0.2)));
            const sizeX = obj.size_x !== undefined ? Number(obj.size_x) : Math.max(0.02, Math.abs(Number(obj.max_x ?? 0.2) - Number(obj.min_x ?? 0)));
            const sizeY = obj.size_y !== undefined ? Number(obj.size_y) : Math.max(0.02, Math.abs(Number(obj.max_y ?? 0.2) - Number(obj.min_y ?? 0)));

            const cx = isAxisymmetric
                ? (dx + dw / 2 + (flipX ? -1 : 1) * (posX / max_r) * (dw / 2))
                : (dx + (posX / max_r) * dw);
            const cy = dy + dh - (posY / max_z) * dh;
            context.beginPath();
            if (shapeType === 'Circle' || shapeType === 'Cylinder' || shapeType === 'Sphere') {
                const rad = Number(obj.radius ?? 0.1) || 0.1;
                const rPx = isAxisymmetric ? (rad / max_r) * (dw / 2) : (rad / max_r) * dw;
                context.arc(cx, cy, Math.abs(rPx), 0, 2 * Math.PI);
            } else {
                const wPx = isAxisymmetric ? (sizeX / max_r) * (dw / 2) : (sizeX / max_r) * dw;
                const hPx = (sizeY / max_z) * dh;
                context.rect(cx - wPx / 2, cy - hPx / 2, wPx, hPx);
            }
            context.fill();
            context.stroke();
        };
        for (const obj of mpmObjects) {
            drawMpmObj(obj, false);
            if (isAxisymmetric) drawMpmObj(obj, true);
        }
        context.restore();
    }

    // Charge outline
    if (showCharge && chargeInfo && Number(chargeInfo.radius) > 0) {
        const { shape, r: cR, z: cZ, radius, height: cH } = chargeInfo;
        context.save();
        const drawOutline = (flipX: boolean) => {
            const getCanvasCoords = (pr: number, pz: number) => {
                let cx = dx + dw / 2;
                if (isAxisymmetric) {
                    const sign = flipX ? -1 : 1;
                    cx += sign * (pr / max_r) * (dw / 2);
                } else {
                    cx = dx + (pr / max_r) * dw;
                }
                const cy = dy + dh - (pz / max_z) * dh;
                return { x: cx, y: cy };
            };

            context.beginPath();
            if (shape === 'Cylinder') {
                const topLeft = getCanvasCoords(cR - radius, cZ + cH / 2);
                const bottomRight = getCanvasCoords(cR + radius, cZ - cH / 2);
                const rectW = Math.abs(bottomRight.x - topLeft.x);
                const rectH = Math.abs(bottomRight.y - topLeft.y);
                context.rect(Math.min(topLeft.x, bottomRight.x), Math.min(topLeft.y, bottomRight.y), rectW, rectH);
            } else {
                const center = getCanvasCoords(cR, cZ);
                const edge = getCanvasCoords(cR + radius, cZ);
                const rCanvas = Math.abs(edge.x - center.x);
                context.arc(center.x, center.y, rCanvas, 0, 2 * Math.PI);
            }
            if (!hasCachedHeatmap) {
                context.fillStyle = 'rgba(249, 115, 22, 0.25)';
                context.fill();
            }
            context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
            context.lineWidth = 2.6 / zoom;
            context.stroke();
            context.strokeStyle = '#fb923c';
            context.lineWidth = 1.4 / zoom;
            context.stroke();
        };
        drawOutline(false);
        if (isAxisymmetric && Math.abs(cR) > 1e-6) drawOutline(true);
        context.restore();
    }

    // Remap clearance circle (R_remap) for 1D -> 2D stage
    if (showCharge && remapInfo && Number(remapInfo.radius) > 0) {
        const rOrig = Number(remapInfo.r ?? 0);
        const zOrig = Number(remapInfo.z ?? (max_z * 0.5));
        const rRemap = Number(remapInfo.radius);
        context.save();
        context.beginPath();
        context.rect(dx, dy, dw, dh);
        context.clip();

        const drawRemapCircle = (flipX: boolean) => {
            const cx = isAxisymmetric
                ? (dx + dw / 2 + (flipX ? -1 : 1) * (rOrig / max_r) * (dw / 2))
                : (dx + (rOrig / max_r) * dw);
            const cy = dy + dh - (zOrig / max_z) * dh;
            const rPx = isAxisymmetric ? (rRemap / max_r) * (dw / 2) : (rRemap / max_r) * dw;
            context.beginPath();
            context.arc(cx, cy, Math.abs(rPx), 0, 2 * Math.PI);
            if (!hasCachedHeatmap) {
                context.fillStyle = 'rgba(0, 240, 255, 0.06)';
                context.fill();
            }
            context.setLineDash([6 / zoom, 4 / zoom]);
            context.strokeStyle = 'rgba(0, 240, 255, 0.85)';
            context.lineWidth = 1.6 / zoom;
            context.stroke();
            context.setLineDash([]);
        };
        drawRemapCircle(false);
        if (isAxisymmetric && Math.abs(rOrig) > 1e-6) drawRemapCircle(true);

        const labelCx = isAxisymmetric
            ? (dx + dw / 2 + (rOrig / max_r) * (dw / 2))
            : (dx + (rOrig / max_r) * dw);
        const labelCy = dy + dh - ((zOrig + rRemap) / max_z) * dh;
        context.font = `${Math.max(8, 9.5 / zoom)}px monospace`;
        context.fillStyle = '#67e8f9';
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        context.fillText(`R_remap = ${rRemap.toFixed(3)}m`, labelCx, Math.max(dy + 12 / zoom, labelCy - 3 / zoom));
        context.restore();
    }

    // Detonator marker
    if (showDetonator && detonatorInfo) {
        const { r: dR, z: dZ } = detonatorInfo;
        context.save();
        const drawDet = (flipX: boolean) => {
            let cx = dx + dw / 2;
            if (isAxisymmetric) {
                cx += (flipX ? -1 : 1) * (dR / max_r) * (dw / 2);
            } else {
                cx = dx + (dR / max_r) * dw;
            }
            const cy = dy + dh - (dZ / max_z) * dh;
            context.beginPath();
            context.arc(cx, cy, 4.2 / zoom, 0, 2 * Math.PI);
            context.fillStyle = '#ef4444';
            context.strokeStyle = '#ffffff';
            context.lineWidth = 1.4 / zoom;
            context.fill();
            context.stroke();
        };
        drawDet(false);
        if (isAxisymmetric) drawDet(true);
        context.restore();
    }

    // Live 2D MPM particle cloud
    if (showMPMParticles && currentParticles && currentParticles.length > 0) {
        context.save();
        context.fillStyle = '#38bdf8';
        const pRadius = Math.max(0.8, 1.3 / zoom);
        const numParticles = currentParticles.length / 2;
        const diam = pRadius * 2;

        context.beginPath();
        for (let k = 0; k < numParticles; ++k) {
            const xp = currentParticles[k * 2];
            const yp = currentParticles[k * 2 + 1];
            const pyPart = dy + (1.0 - yp / max_z) * dh;
            if (isAxisymmetric) {
                const pxR = dx + dw / 2 + (xp / max_r) * (dw / 2);
                const pxL = dx + dw / 2 - (xp / max_r) * (dw / 2);
                context.rect(pxR - pRadius, pyPart - pRadius, diam, diam);
                context.rect(pxL - pRadius, pyPart - pRadius, diam, diam);
            } else {
                const pxPart = dx + (xp / max_r) * dw;
                context.rect(pxPart - pRadius, pyPart - pRadius, diam, diam);
            }
        }
        context.fill();
        context.restore();
    }

    context.restore(); // Restore pan/zoom transform while staying clipped inside (vpX, vpY, vpW, vpH)

    // Screen-space crisp 2D Virtual Gauge Markers (constant pixel size regardless of zoom!)
    if (showGauges && gauges && gauges.length > 0) {
        context.save();
        context.font = "700 10px 'JetBrains Mono', monospace";
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        for (let idx = 0; idx < gauges.length; ++idx) {
            const g = gauges[idx];
            const gr = Number(g.r ?? 0);
            const gz = Number(g.z ?? 0);
            const { sx, sy } = domainToScreen(gr, gz);
            const isSel = selectedProbeIndex === idx;
            const isHov = hoveredProbeIndex === idx;
            const rMarker = isHov ? 6.5 : (isSel ? 5.8 : 4.6);

            if (isHov || isSel) {
                context.beginPath();
                context.arc(sx, sy, rMarker + 4, 0, 2 * Math.PI);
                context.fillStyle = isHov ? 'rgba(56, 189, 248, 0.28)' : 'rgba(16, 185, 129, 0.26)';
                context.fill();
            }

            context.beginPath();
            context.moveTo(sx, sy - rMarker);
            context.lineTo(sx + rMarker, sy);
            context.lineTo(sx, sy + rMarker);
            context.lineTo(sx - rMarker, sy);
            context.closePath();
            context.fillStyle = isHov ? '#38bdf8' : (isSel ? '#34d399' : '#10b981');
            context.strokeStyle = '#ffffff';
            context.lineWidth = isHov || isSel ? 1.8 : 1.3;
            context.fill();
            context.stroke();

            const label = g.name || g.id || `G${idx + 1}`;
            const labelW = context.measureText(label).width + 8;
            context.fillStyle = 'rgba(11, 15, 25, 0.82)';
            drawRoundedBox(context, sx + rMarker + 4, sy - 8, labelW, 16, 3);
            context.fill();
            context.fillStyle = isHov ? '#e0f2fe' : '#d1fae5';
            context.fillText(label, sx + rMarker + 8, sy);
        }
        context.restore();
    }

    // Screen-space automatic Domain Peak (▲) & Trough (▼) Callout Badges
    if (showExtrema && fieldExtrema.hasData && hasCachedHeatmap) {
        const drawExtremaMarker = (isPeak: boolean, val: number, pr: number, pz: number) => {
            const { sx, sy } = domainToScreen(pr, pz);
            if (sx < vpX - 10 || sx > vpX + vpW + 10 || sy < vpY - 10 || sy > vpY + vpH + 10) return;

            context.save();
            const accent = isPeak ? '#fbbf24' : '#38bdf8';
            const rTri = 5.5;
            context.beginPath();
            if (isPeak) {
                context.moveTo(sx, sy - rTri - 1);
                context.lineTo(sx + rTri, sy + rTri - 1);
                context.lineTo(sx - rTri, sy + rTri - 1);
            } else {
                context.moveTo(sx, sy + rTri + 1);
                context.lineTo(sx + rTri, sy - rTri + 1);
                context.lineTo(sx - rTri, sy - rTri + 1);
            }
            context.closePath();
            context.fillStyle = accent;
            context.strokeStyle = '#0b0f19';
            context.lineWidth = 1.6;
            context.fill();
            context.stroke();

            const badgeTxt = `${isPeak ? '▲' : '▼'} ${formatSciNumber(val)}`;
            context.font = "700 9px 'JetBrains Mono', monospace";
            const tw = context.measureText(badgeTxt).width + 10;
            const th = 16;
            let bx = sx + 8;
            let by = isPeak ? sy - th - 4 : sy + 4;
            if (bx + tw > vpX + vpW - 4) bx = sx - tw - 8;
            if (by < vpY + 4) by = sy + 6;
            if (by + th > vpY + vpH - 4) by = sy - th - 6;

            context.fillStyle = 'rgba(11, 15, 25, 0.88)';
            context.strokeStyle = isPeak ? 'rgba(251, 191, 36, 0.65)' : 'rgba(56, 189, 248, 0.65)';
            context.lineWidth = 1;
            drawRoundedBox(context, bx, by, tw, th, 4);
            context.fill();
            context.stroke();

            context.fillStyle = accent;
            context.textAlign = 'left';
            context.textBaseline = 'middle';
            context.fillText(badgeTxt, bx + 5, by + th / 2);
            context.restore();
        };

        drawExtremaMarker(false, fieldExtrema.troughVal, fieldExtrema.troughR, fieldExtrema.troughZ);
        drawExtremaMarker(true, fieldExtrema.peakVal, fieldExtrema.peakR, fieldExtrema.peakZ);
    }

    // Rubberband Box-Zoom Overlay
    if (boxZoomRect) {
        const bx0 = Math.max(vpX, Math.min(vpX + vpW, Math.min(boxZoomRect.x0, boxZoomRect.x1)));
        const bx1 = Math.max(vpX, Math.min(vpX + vpW, Math.max(boxZoomRect.x0, boxZoomRect.x1)));
        const by0 = Math.max(vpY, Math.min(vpY + vpH, Math.min(boxZoomRect.y0, boxZoomRect.y1)));
        const by1 = Math.max(vpY, Math.min(vpY + vpH, Math.max(boxZoomRect.y0, boxZoomRect.y1)));
        const bw = bx1 - bx0;
        const bh = by1 - by0;
        if (bw >= 2 || bh >= 2) {
            context.save();
            context.fillStyle = 'rgba(56, 189, 248, 0.16)';
            context.strokeStyle = 'rgba(56, 189, 248, 0.95)';
            context.lineWidth = 1.35;
            context.setLineDash([5, 3]);
            context.fillRect(bx0, by0, bw, bh);
            context.strokeRect(bx0, by0, bw, bh);
            context.restore();
        }
    }

    // Crosshair lines inside viewport when hovering
    if (!boxZoomRect && hoverMx !== null && hoverMy !== null && hoverMx >= vpX && hoverMx <= vpX + vpW && hoverMy >= vpY && hoverMy <= vpY + vpH) {
        context.save();
        context.setLineDash([4, 4]);
        context.strokeStyle = 'rgba(148, 163, 184, 0.42)';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(hoverMx, vpY);
        context.lineTo(hoverMx, vpY + vpH);
        context.moveTo(vpX, hoverMy);
        context.lineTo(vpX + vpW, hoverMy);
        context.stroke();
        context.setLineDash([]);

        context.strokeStyle = '#38bdf8';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(hoverMx, hoverMy, 4.5, 0, 2 * Math.PI);
        context.stroke();
        context.restore();
    }

    context.restore(); // End full-viewport clip (vpX, vpY, vpW, vpH)

    // Crisp outer full-bleed viewport border & Engineering R/Z coordinate axes
    context.save();
    context.strokeStyle = isLight ? 'rgba(51, 65, 85, 0.55)' : 'rgba(56, 189, 248, 0.42)';
    context.lineWidth = 1.1;
    context.strokeRect(vpX, vpY, vpW, vpH);

    context.font = "9.5px 'JetBrains Mono', monospace";
    const tickColor = isLight ? '#334155' : '#cbd5e1';
    const axisLabelColor = isLight ? '#475569' : '#94a3b8';
    const nTicksX = vpW < 380 ? 4 : 6;
    const nTicksY = vpH < 240 ? 4 : 5;

    context.strokeStyle = isLight ? 'rgba(71, 85, 105, 0.5)' : 'rgba(148, 163, 184, 0.45)';
    context.fillStyle = tickColor;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let t = 0; t <= nTicksX; ++t) {
        const frac = t / nTicksX;
        const tx = vpX + frac * vpW;
        const unzoomedX = px + (tx - px - panX) / zoom;
        const domFracX = (unzoomedX - dx) / Math.max(1, dw);
        const physR = isAxisymmetric
            ? (-max_r + domFracX * (2 * max_r))
            : (domFracX * max_r);

        context.beginPath();
        context.moveTo(tx, vpY + vpH);
        context.lineTo(tx, vpY + vpH + 4);
        context.stroke();
        context.fillText(`${physR.toFixed(2)}`, tx, vpY + vpH + 5);
    }
    context.fillStyle = axisLabelColor;
    context.fillText(isAxisymmetric ? 'r [m]' : 'X [m]', vpX + vpW / 2, vpY + vpH + 17);

    context.fillStyle = tickColor;
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let t = 0; t <= nTicksY; ++t) {
        const frac = t / nTicksY;
        const ty = vpY + vpH - frac * vpH;
        const unzoomedY = py + (ty - py - panY) / zoom;
        const domFracY = 1.0 - (unzoomedY - dy) / Math.max(1, dh);
        const physZ = domFracY * max_z;

        context.beginPath();
        context.moveTo(vpX - 4, ty);
        context.lineTo(vpX, ty);
        context.stroke();
        context.fillText(`${physZ.toFixed(2)}`, vpX - 6, ty);
    }
    context.restore();

    // Optional built-in right-margin colorbar (for standalone NodeViewer or export)
    if (showColorbar) {
        context.save();
        const barX = vpX + vpW + 12;
        const barY = vpY + 8;
        const barW = 14;
        const barH = Math.max(40, vpH - 16);
        for (let pyBar = 0; pyBar < barH; ++pyBar) {
            const rawNorm = 1.0 - pyBar / Math.max(1, barH - 1);
            const norm = quantizeContourT(rawNorm, contourLevels > 1 ? contourLevels : 0);
            const [r, g, b] = sampleColormapNormalized(norm, selectedColormap);
            context.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
            context.fillRect(barX, barY + pyBar, barW, 1.5);
        }
        context.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        context.lineWidth = 1;
        context.strokeRect(barX, barY, barW, barH);

        context.font = "9px 'JetBrains Mono', monospace";
        context.fillStyle = isLight ? '#334155' : '#cbd5e1';
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        const cbTicks = 4;
        for (let k = 0; k <= cbTicks; ++k) {
            const pct = k / cbTicks;
            const cy = barY + barH - pct * barH;
            let val = displayMin + pct * (displayMax - displayMin);
            if (useLogScale && displayMax > 0) {
                const sMin = Math.max(displayMax * 1e-6, displayMin > 0 ? displayMin : displayMax * 1e-6);
                val = Math.pow(10, Math.log10(sMin) + pct * (Math.log10(displayMax) - Math.log10(sMin)));
            }
            context.fillText(formatSciNumber(val), barX + barW + 5, cy);
        }
        context.restore();
    }

    // Rich Glassmorphic Hover Interrogation Card (Cursor Value + Automatic Domain Peak ▲ & Trough ▼)
    if (!boxZoomRect && hoverMx !== null && hoverMy !== null && hoverMx >= vpX && hoverMx <= vpX + vpW && hoverMy >= vpY && hoverMy <= vpY + vpH) {
        const unzoomedX = px + (hoverMx - px - panX) / zoom;
        const unzoomedY = py + (hoverMy - py - panY) / zoom;
        const domFracX = (unzoomedX - dx) / Math.max(1, dw);
        const domFracY = 1.0 - (unzoomedY - dy) / Math.max(1, dh);
        const signedR = isAxisymmetric ? (-max_r + domFracX * (2 * max_r)) : (domFracX * max_r);
        const physR = isAxisymmetric ? Math.abs(signedR) : signedR;
        const physZ = domFracY * max_z;

        const insideDomain = physR >= 0 && physR <= max_r && physZ >= 0 && physZ <= max_z;
        let probeVal: number | null = null;
        if (insideDomain) {
            if (meshType === 'amr' && cachedAmrTiles && cachedAmrTiles.length > 0) {
                const level0TilesR = Math.max(1, Math.ceil((baseNr || 128) / 16));
                const dr_base = (max_r || 1.0) / (level0TilesR * 16);
                const level0TilesZ = Math.max(1, Math.round((max_z || 1.0) / (dr_base * 16)));
                for (let tIdx = cachedAmrTiles.length - 1; tIdx >= 0; --tIdx) {
                    const tile = cachedAmrTiles[tIdx];
                    const factor = 1.0 / (1 << tile.level);
                    const tileW = (max_r / level0TilesR) * factor;
                    const tileH = (max_z / level0TilesZ) * factor;
                    const rMin = tile.r_idx * tileW;
                    const zMin = tile.z_idx * tileH;
                    if (physR >= rMin && physR <= rMin + tileW && physZ >= zMin && physZ <= zMin + tileH) {
                        const ci = Math.min(15, Math.max(0, Math.floor(((physR - rMin) / tileW) * 16)));
                        const cj = Math.min(15, Math.max(0, Math.floor(((physZ - zMin) / tileH) * 16)));
                        probeVal = tile.data[ci * 16 + cj];
                        break;
                    }
                }
            } else if (lastValidData && lastValidNr > 0 && lastValidNz > 0) {
                const ri = Math.min(lastValidNr - 1, Math.max(0, Math.floor((physR / max_r) * lastValidNr)));
                const zi = Math.min(lastValidNz - 1, Math.max(0, Math.floor((physZ / max_z) * lastValidNz)));
                probeVal = lastValidData[ri * lastValidNz + zi];
            }
        }

        const chMeta = CHANNEL_TITLES[selectedChannel] || { name: `Ch ${selectedChannel}`, unit: '' };
        const unitSuffix = chMeta.unit && chMeta.unit !== '-' ? ` ${chMeta.unit}` : '';
        const valPart = (probeVal !== null && isFinite(probeVal))
            ? `${formatSciNumber(probeVal)}${unitSuffix}`
            : (insideDomain ? '—' : 'Outside Domain');

        const hovGauge = hoveredProbeIndex >= 0 && gauges[hoveredProbeIndex]
            ? `  •  🎯 ${gauges[hoveredProbeIndex].name || gauges[hoveredProbeIndex].id || `G${hoveredProbeIndex + 1}`}`
            : '';
        const line1 = `(${signedR.toFixed(3)}, ${physZ.toFixed(3)}) m${hovGauge}`;
        const line2 = `${chMeta.name}: ${valPart}`;
        const rows: Array<{ text: string; color: string }> = [
            { text: line1, color: '#94a3b8' },
            { text: line2, color: '#f8fafc' }
        ];
        if (fieldExtrema.hasData && hasCachedHeatmap) {
            rows.push({
                text: `▲ Peak:   ${formatSciNumber(fieldExtrema.peakVal)}${unitSuffix} @ (${fieldExtrema.peakR.toFixed(2)}, ${fieldExtrema.peakZ.toFixed(2)})m`,
                color: '#fbbf24'
            });
            rows.push({
                text: `▼ Trough: ${formatSciNumber(fieldExtrema.troughVal)}${unitSuffix} @ (${fieldExtrema.troughR.toFixed(2)}, ${fieldExtrema.troughZ.toFixed(2)})m`,
                color: '#38bdf8'
            });
        }

        context.save();
        context.font = "600 9.5px 'JetBrains Mono', monospace";
        let maxTextW = 0;
        for (const r of rows) {
            const w = context.measureText(r.text).width;
            if (w > maxTextW) maxTextW = w;
        }
        const boxW = maxTextW + 18;
        const rowH = 15;
        const boxH = 10 + rows.length * rowH;
        let bx = hoverMx + 14;
        let by = hoverMy - boxH - 10;
        if (bx + boxW > width - 8) bx = Math.max(8, hoverMx - boxW - 14);
        if (by < 8) by = Math.min(height - boxH - 8, hoverMy + 14);

        context.fillStyle = 'rgba(11, 15, 25, 0.93)';
        context.strokeStyle = 'rgba(56, 189, 248, 0.52)';
        context.lineWidth = 1;
        drawRoundedBox(context, bx, by, boxW, boxH, 6);
        context.fill();
        context.stroke();

        context.textAlign = 'left';
        context.textBaseline = 'middle';
        for (let i = 0; i < rows.length; ++i) {
            context.fillStyle = rows[i].color;
            context.fillText(rows[i].text, bx + 9, by + 12 + i * rowH);
        }
        context.restore();
    }
}

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        lastBuffer = data;

        let isMpm = false;
        if (data.byteLength >= 12 && meshType !== 'amr') {
            const view = new DataView(data);
            const nr = view.getUint32(0, true);
            const nz = view.getUint32(4, true);
            const n_channels = view.getUint32(8, true);
            const gridBytes = nr * nz * n_channels * 4;
            if (data.byteLength > 12 + gridBytes) {
                isMpm = true;
            }
        }

        lastCfdBuffer = data;
        if (isMpm) {
            lastMpmBuffer = data;
        } else {
            lastMpmBuffer = null;
            currentParticles = null;
        }

        heatmapDirty = true;

        const now = Date.now();
        const intervalMs = refreshRate * 1000;

        if (intervalMs <= 0) {
            if (renderTimeout) {
                clearTimeout(renderTimeout);
                renderTimeout = null;
            }
            scheduleRender();
        } else {
            const timeSinceLast = now - lastRenderTime;
            if (timeSinceLast >= intervalMs) {
                if (renderTimeout) {
                    clearTimeout(renderTimeout);
                    renderTimeout = null;
                }
                scheduleRender();
            } else if (!renderTimeout) {
                renderTimeout = setTimeout(() => {
                    renderTimeout = null;
                    scheduleRender();
                }, intervalMs - timeSinceLast);
            }
        }
        return;
    }

    if (data.type === 'clearData') {
        lastBuffer = null;
        lastCfdBuffer = null;
        lastMpmBuffer = null;
        currentParticles = null;
        lastValidData = null;
        cachedAmrTiles = null;
        hasCachedHeatmap = false;
        fieldExtrema.hasData = false;
        heatmapDirty = true;
        simStep = 0;
        simTime = 0;
        scheduleRender();
        return;
    }

    if (data.type === 'hover') {
        hoverMx = typeof data.mx === 'number' ? data.mx : null;
        hoverMy = typeof data.my === 'number' ? data.my : null;
        const nextHov = (hoverMx !== null && hoverMy !== null) ? hitTestProbe(hoverMx, hoverMy) : -1;
        if (nextHov !== hoveredProbeIndex) {
            hoveredProbeIndex = nextHov;
            self.postMessage({ type: 'probeHover', probeIndex: hoveredProbeIndex });
        }
        scheduleRender();
        return;
    }

    if (data.type === 'click') {
        const mx = Number(data.mx);
        const my = Number(data.my);
        if (isFinite(mx) && isFinite(my)) {
            const hit = hitTestProbe(mx, my);
            if (hit >= 0) {
                selectedProbeIndex = selectedProbeIndex === hit ? -1 : hit;
                self.postMessage({ type: 'probeClick', probeIndex: hit, selectedProbe: selectedProbeIndex });
                scheduleRender();
            }
        }
        return;
    }

    if (data.type === 'boxZoomMove') {
        boxZoomRect = {
            x0: Number(data.x0 ?? 0),
            y0: Number(data.y0 ?? 0),
            x1: Number(data.x1 ?? 0),
            y1: Number(data.y1 ?? 0)
        };
        scheduleRender();
        return;
    }

    if (data.type === 'boxZoomCancel') {
        boxZoomRect = null;
        scheduleRender();
        return;
    }

    if (data.type === 'boxZoomCommit') {
        boxZoomRect = null;
        const { vpX, vpY, vpW, vpH } = getViewportRect();
        const bx0 = Math.max(vpX, Math.min(vpX + vpW, Math.min(Number(data.x0 ?? 0), Number(data.x1 ?? 0))));
        const bx1 = Math.max(vpX, Math.min(vpX + vpW, Math.max(Number(data.x0 ?? 0), Number(data.x1 ?? 0))));
        const by0 = Math.max(vpY, Math.min(vpY + vpH, Math.min(Number(data.y0 ?? 0), Number(data.y1 ?? 0))));
        const by1 = Math.max(vpY, Math.min(vpY + vpH, Math.max(Number(data.y0 ?? 0), Number(data.y1 ?? 0))));
        if (bx1 - bx0 >= 6 && by1 - by0 >= 6) {
            const px = vpX + vpW / 2;
            const py = vpY + vpH / 2;
            const oldZoom = isFinite(zoom) && zoom > 0 ? zoom : 1.0;
            const ux0 = px + (bx0 - px - panX) / oldZoom;
            const ux1 = px + (bx1 - px - panX) / oldZoom;
            const uy0 = py + (by0 - py - panY) / oldZoom;
            const uy1 = py + (by1 - py - panY) / oldZoom;
            const ucx = 0.5 * (ux0 + ux1);
            const ucy = 0.5 * (uy0 + uy1);
            const ubw = Math.max(1, ux1 - ux0);
            const ubh = Math.max(1, uy1 - uy0);
            const newZoom = Math.max(0.25, Math.min(100.0, Math.min(vpW / ubw, vpH / ubh)));
            zoom = newZoom;
            panX = -(ucx - px) * newZoom;
            panY = -(ucy - py) * newZoom;
            clampPanToViewport();
        }
        scheduleRender();
        return;
    }

    if (data.type === 'forceRender') {
        if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
        }
        render();
        return;
    }

    if (data.type === 'init') {
        canvas = data.canvas as OffscreenCanvas;
        dpr = Number(data.dpr) || 1;
        width = Number(data.width) || canvas.width || 400;
        height = Number(data.height) || canvas.height || 300;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        rebuildColormapLUT();
        scheduleRender();
        return;
    }

    if (data.type === 'resize' && canvas && ctx) {
        const nextW = Number(data.width);
        const nextH = Number(data.height);
        if (isFinite(nextW) && nextW > 0 && isFinite(nextH) && nextH > 0) {
            width = nextW;
            height = nextH;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            scheduleRender();
        }
        return;
    }

    if (data.type === 'setConfig') {
        if (typeof data.meshType === 'string' && data.meshType !== meshType) {
            meshType = data.meshType;
            heatmapDirty = true;
        }
        if (typeof data.amrMaxLevels === 'number' && data.amrMaxLevels !== amrMaxLevels) {
            amrMaxLevels = data.amrMaxLevels;
            heatmapDirty = true;
        }
        if (typeof data.baseNr === 'number' && data.baseNr !== baseNr) {
            baseNr = data.baseNr;
            heatmapDirty = true;
        }
        if (typeof data.baseNz === 'number' && data.baseNz !== baseNz) {
            baseNz = data.baseNz;
            heatmapDirty = true;
        }
        if (typeof data.channel === 'number' && data.channel !== selectedChannel) {
            selectedChannel = data.channel;
            heatmapDirty = true;
        }
        if (typeof data.stride === 'number' && data.stride !== stride) {
            stride = data.stride;
            heatmapDirty = true;
        }
        if (typeof data.refreshRate === 'number') refreshRate = data.refreshRate;
        if (typeof data.autoScale === 'boolean' && data.autoScale !== autoScale) {
            autoScale = data.autoScale;
            heatmapDirty = true;
        }
        if (typeof data.logScale === 'boolean' && data.logScale !== useLogScale) {
            useLogScale = data.logScale;
            heatmapDirty = true;
        }
        if (typeof data.colormap === 'string') {
            const normCmap = normalizeColormapId(data.colormap);
            if (normCmap !== selectedColormap) {
                selectedColormap = normCmap;
                lutDirty = true;
                heatmapDirty = true;
            }
        }
        if (typeof data.contourLevels === 'number' && data.contourLevels !== contourLevels) {
            contourLevels = data.contourLevels;
            lutDirty = true;
            heatmapDirty = true;
        }
        if (data.fillMode === 'fill' || data.fillMode === 'aspect') fillMode = data.fillMode;
        if (typeof data.showExtrema === 'boolean') showExtrema = data.showExtrema;
        if (typeof data.selectedProbe === 'number') selectedProbeIndex = data.selectedProbe;
        if (typeof data.hoveredProbe === 'number') hoveredProbeIndex = data.hoveredProbe;
        if (typeof data.showColorbar === 'boolean') showColorbar = data.showColorbar;
        if (typeof data.showMPMParticles === 'boolean') showMPMParticles = data.showMPMParticles;
        if (typeof data.showCharge === 'boolean') showCharge = data.showCharge;
        if (typeof data.showDetonator === 'boolean') showDetonator = data.showDetonator;
        if (typeof data.showObstacles === 'boolean') showObstacles = data.showObstacles;
        if (typeof data.showGauges === 'boolean') showGauges = data.showGauges;
        if (data.theme === 'dark' || data.theme === 'slate' || data.theme === 'light') theme = data.theme;
        if (Array.isArray(data.clearColor) && data.clearColor.length === 3) {
            clearBgRgb = [
                Math.round(Number(data.clearColor[0]) * 255),
                Math.round(Number(data.clearColor[1]) * 255),
                Math.round(Number(data.clearColor[2]) * 255)
            ];
        } else if (data.clearColor === null) {
            clearBgRgb = null;
        }
        if (typeof data.step === 'number') simStep = data.step;
        if (typeof data.time === 'number') simTime = data.time;
        if (typeof data.dt === 'number') simDt = data.dt;
        if (typeof data.isAxisymmetric === 'boolean') isAxisymmetric = data.isAxisymmetric;

        if (data.chargeInfo !== undefined) {
            chargeInfo = data.chargeInfo;
        } else if (typeof data.chargeRadius === 'number' && data.chargeRadius > 0) {
            chargeInfo = {
                shape: data.chargeShape || 'Sphere',
                r: Number(data.chargeR ?? 0),
                z: Number(data.chargeZOffset ?? (max_z * 0.5)),
                radius: Number(data.chargeRadius),
                height: Number(data.chargeHeight ?? (data.chargeRadius * 2))
            };
        }
        if (data.remapInfo !== undefined) {
            remapInfo = data.remapInfo;
        }
        if (data.detonatorInfo !== undefined) {
            detonatorInfo = data.detonatorInfo;
        } else if (typeof data.detonatorR === 'number' && typeof data.detonatorZ === 'number') {
            detonatorInfo = { r: data.detonatorR, z: data.detonatorZ };
        }
        if (Array.isArray(data.obstacles)) obstacles = data.obstacles;
        if (Array.isArray(data.mpmObjects)) mpmObjects = data.mpmObjects;
        if (Array.isArray(data.gauges)) gauges = data.gauges;
        if (typeof data.showGridlines === 'boolean') showGridlines = data.showGridlines;
        if (typeof data.interpolate === 'boolean') interpolate = data.interpolate;

        const minCandidate = typeof data.min === 'number' ? data.min : (typeof data.minVal === 'number' ? data.minVal : undefined);
        const maxCandidate = typeof data.max === 'number' ? data.max : (typeof data.maxVal === 'number' ? data.maxVal : undefined);
        if (!autoScale) {
            if (minCandidate !== undefined && isFinite(minCandidate) && minCandidate !== displayMin) {
                displayMin = minCandidate;
                heatmapDirty = true;
            }
            if (maxCandidate !== undefined && isFinite(maxCandidate) && maxCandidate !== displayMax) {
                displayMax = maxCandidate;
                heatmapDirty = true;
            }
        }
        if (typeof data.max_r === 'number' && data.max_r > 0) max_r = data.max_r;
        if (typeof data.max_z === 'number' && data.max_z > 0) max_z = data.max_z;

        range = displayMax - displayMin || 1;
        scheduleRender();
        return;
    }

    if (data.type === 'pan') {
        const dxVal = Number(data.dx ?? data.deltaX ?? 0);
        const dyVal = Number(data.dy ?? data.deltaY ?? 0);
        if (isFinite(dxVal) && isFinite(dyVal)) {
            panX = (isFinite(panX) ? panX : 0) + dxVal;
            panY = (isFinite(panY) ? panY : 0) + dyVal;
            clampPanToViewport();
            scheduleRender();
        }
        return;
    }

    if (data.type === 'zoom') {
        const { vpX, vpY, vpW, vpH } = getViewportRect();
        const rawMx = Number(data.mx ?? data.centerX ?? (vpX + vpW / 2));
        const rawMy = Number(data.my ?? data.centerY ?? (vpY + vpH / 2));
        const mx = isFinite(rawMx) ? rawMx : (vpX + vpW / 2);
        const my = isFinite(rawMy) ? rawMy : (vpY + vpH / 2);

        const clampedMx = Math.max(vpX, Math.min(vpX + vpW, mx));
        const clampedMy = Math.max(vpY, Math.min(vpY + vpH, my));

        let factor = Number(data.factor);
        if (!isFinite(factor) || factor <= 0) {
            const deltaY = Number(data.deltaY ?? 0);
            factor = deltaY < 0 ? 1.12 : 0.89;
        }

        const oldZoom = isFinite(zoom) && zoom > 0 ? zoom : 1.0;
        const newZoom = Math.max(0.25, Math.min(100.0, oldZoom * factor));

        const px = vpX + vpW / 2;
        const py = vpY + vpH / 2;

        zoom = newZoom;
        panX = clampedMx - px - (clampedMx - px - (isFinite(panX) ? panX : 0)) * (newZoom / oldZoom);
        panY = clampedMy - py - (clampedMy - py - (isFinite(panY) ? panY : 0)) * (newZoom / oldZoom);
        clampPanToViewport();

        scheduleRender();
        return;
    }

    if (data.type === 'clickFocus') {
        const { vpX, vpY, vpW, vpH } = getViewportRect();
        const mx = Number(data.mx ?? data.centerX ?? (vpX + vpW / 2));
        const my = Number(data.my ?? data.centerY ?? (vpY + vpH / 2));

        const clampedMx = Math.max(vpX, Math.min(vpX + vpW, isFinite(mx) ? mx : vpX + vpW / 2));
        const clampedMy = Math.max(vpY, Math.min(vpY + vpH, isFinite(my) ? my : vpY + vpH / 2));

        const px = vpX + vpW / 2;
        const py = vpY + vpH / 2;

        if (zoom <= 1.01) {
            zoom = 2.5;
            panX = -(clampedMx - px) * 2.5;
            panY = -(clampedMy - py) * 2.5;
        } else {
            panX = panX + (px - clampedMx);
            panY = panY + (py - clampedMy);
        }
        clampPanToViewport();

        scheduleRender();
        return;
    }

    if (data.type === 'resetView') {
        zoom = 1.0;
        panX = 0.0;
        panY = 0.0;
        boxZoomRect = null;
        scheduleRender();
        return;
    }
};
