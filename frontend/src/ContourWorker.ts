// ContourWorker.ts
export {};
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let width = 0;
let height = 0;
let dpr = 1;

let lastBuffer: ArrayBuffer | null = null;
let selectedChannel = 0; // 0=p, 1=rho, 2=ur, 3=uz, 4=e_int, 5=alpha1, 6=alpha2
let displayMin = 0;
let displayMax = 1;
let range = 1;
let autoScale = true;
let useLogScale = false;
let selectedColormap = 'plasma';
let isAxisymmetric = true;
let chargeInfo: any = null;
let detonatorInfo: any = null;
let showGridlines = false;
let max_r = 1.0;
let max_z = 1.0;
let meshType = 'regular';
let amrMaxLevels = 3;
let baseNr = 128;
let baseNz = 128;

// Zoom and pan state
let zoom = 1.0;
let panX = 0.0;
let panY = 0.0;
let outNr = 0;
let outNz = 0;

let stride = 1;
let refreshRate = 0.0; // in seconds
let lastRenderTime = 0;
let renderTimeout: any = null;

// Helper offscreen canvas to render the raw grid before stretching
let tempCanvas: OffscreenCanvas | null = null;
let tempCtx: OffscreenCanvasRenderingContext2D | null = null;

const rAF = typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame
    : (cb: Function) => setTimeout(() => cb(Date.now()), 1000 / 60);

let renderRequested = false;
function requestRender(): void {
    if (renderRequested) return;
    renderRequested = true;
    rAF(() => {
        renderRequested = false;
        render();
    });
}

function extractChannel2D(buffer: ArrayBuffer, channel: number): { data: Float32Array; nr: number; nz: number } | null {
    const HEADER_SIZE = 12; // nr, nz, n_channels (all uint32)
    if (buffer.byteLength < HEADER_SIZE) return null;

    const header = new DataView(buffer);
    const nr = header.getUint32(0, true);
    const nz = header.getUint32(4, true);
    const n_channels = header.getUint32(8, true);

    const expectedPayload = nr * nz * n_channels * 4;
    if (buffer.byteLength < HEADER_SIZE + expectedPayload) return null;

    const clampedChannel = Math.max(0, Math.min(channel, n_channels - 1));
    const byteOffset = HEADER_SIZE + clampedChannel * nr * nz * 4;
    const floatData = new Float32Array(buffer, byteOffset, nr * nz);

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

    // 2 floats metadata + 256 cells * n_channels floats
    const floatsPerTile = 2 + 256 * n_channels;
    const expectedBytes = 8 + num_leaves * floatsPerTile * 4;
    if (buffer.byteLength < expectedBytes) return null;

    const tiles: AMRLeafTile[] = [];
    const clampedChannel = Math.max(0, Math.min(channel, n_channels - 1));

    for (let l = 0; l < num_leaves; ++l) {
        const offset = 8 + l * floatsPerTile * 4;
        const meta1 = view.getUint32(offset, true);
        const meta2 = view.getUint32(offset + 4, true);

        const r_idx = meta1 >>> 16;
        const z_idx = meta1 & 0xFFFF;
        const level = (meta2 >>> 8) & 0xFF;

        const tileData = new Float32Array(256);
        for (let c = 0; c < 256; ++c) {
            const cellOffset = offset + 8 + c * n_channels * 4 + clampedChannel * 4;
            tileData[c] = view.getFloat32(cellOffset, true);
        }

        tiles.push({ r_idx, z_idx, level, data: tileData });
    }

    return tiles;
}

function updateAutoScaleAMR(tiles: AMRLeafTile[]): void {
    if (!autoScale) return;
    let min = Infinity;
    let max = -Infinity;
    for (const tile of tiles) {
        for (let i = 0; i < tile.data.length; ++i) {
            const v = tile.data[i];
            if (isFinite(v)) {
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
    }
    if (min !== Infinity && max !== -Infinity) {
        displayMin = min;
        displayMax = max;
        range = max - min || 1;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    }
}

// Inferno/Plasma inspired palette (existing default)
function getPlasmaColor(t: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0;
    if (t < 0.25) {
        const localT = t / 0.25;
        r = Math.round(0 + localT * 140);
        g = Math.round(10 + localT * 10);
        b = Math.round(40 + localT * 80);
    } else if (t < 0.5) {
        const localT = (t - 0.25) / 0.25;
        r = Math.round(140 + localT * 90);
        g = Math.round(20 + localT * 40);
        b = Math.round(120 - localT * 80);
    } else if (t < 0.75) {
        const localT = (t - 0.5) / 0.25;
        r = Math.round(230 + localT * 20);
        g = Math.round(60 + localT * 130);
        b = Math.round(40 - localT * 20);
    } else {
        const localT = (t - 0.75) / 0.25;
        r = Math.round(250 + localT * 5);
        g = Math.round(190 + localT * 65);
        b = Math.round(20 + localT * 235);
    }
    return { r, g, b };
}

// Perceptually uniform Viridis colormap approximation
function getViridisColor(t: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0;
    if (t < 0.25) {
        const localT = t / 0.25;
        r = Math.round(68 - localT * 10);
        g = Math.round(1 + localT * 70);
        b = Math.round(84 + localT * 30);
    } else if (t < 0.5) {
        const localT = (t - 0.25) / 0.25;
        r = Math.round(58 + localT * 18);
        g = Math.round(71 + localT * 57);
        b = Math.round(114 + localT * 15);
    } else if (t < 0.75) {
        const localT = (t - 0.5) / 0.25;
        r = Math.round(76 + localT * 130);
        g = Math.round(128 + localT * 63);
        b = Math.round(129 - localT * 88);
    } else {
        const localT = (t - 0.75) / 0.25;
        r = Math.round(206 + localT * 47);
        g = Math.round(191 + localT * 58);
        b = Math.round(41 - localT * 5);
    }
    return { r, g, b };
}

// Classic Rainbow (Jet) spectral colormap
function getRainbowColor(t: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0;
    if (t < 0.25) {
        const localT = t / 0.25;
        r = 0;
        g = Math.round(localT * 255);
        b = 255;
    } else if (t < 0.5) {
        const localT = (t - 0.25) / 0.25;
        r = 0;
        g = 255;
        b = Math.round(255 - localT * 255);
    } else if (t < 0.75) {
        const localT = (t - 0.5) / 0.25;
        r = Math.round(localT * 255);
        g = 255;
        b = 0;
    } else {
        const localT = (t - 0.75) / 0.25;
        r = 255;
        g = Math.round(255 - localT * 255);
        b = 0;
    }
    return { r, g, b };
}

// Diverging CoolWarm (Blue to White to Red)
function getCoolWarmColor(t: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0;
    if (t < 0.5) {
        const localT = t / 0.5;
        r = Math.round(59 + localT * 161);
        g = Math.round(76 + localT * 144);
        b = Math.round(192 + localT * 28);
    } else {
        const localT = (t - 0.5) / 0.5;
        r = Math.round(220 + localT * 9);
        g = Math.round(220 - localT * 184);
        b = Math.round(220 - localT * 161);
    }
    return { r, g, b };
}

// Color-blind friendly Cividis approximation
function getCividisColor(t: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0;
    if (t < 0.5) {
        const localT = t / 0.5;
        r = Math.round(0 + localT * 84);
        g = Math.round(33 + localT * 79);
        b = Math.round(84 + localT * 53);
    } else {
        const localT = (t - 0.5) / 0.5;
        r = Math.round(84 + localT * 168);
        g = Math.round(112 + localT * 102);
        b = Math.round(137 - localT * 86);
    }
    return { r, g, b };
}

// Grayscale/Monochrome colormap
function getGrayscaleColor(t: number): { r: number; g: number; b: number } {
    const v = Math.round(t * 255);
    return { r: v, g: v, b: v };
}

// Master color lookup function
function getColor(val: number, min: number, max: number): { r: number; g: number; b: number } {
    let t = 0;
    if (useLogScale) {
        const safeMax = Math.max(1e-20, max);
        const dynamicFloor = safeMax * 1e-6; // dynamic range limit
        const safeMin = Math.max(dynamicFloor, min);
        
        const logMin = Math.log10(safeMin);
        const logMax = Math.log10(safeMax);
        const logVal = Math.log10(Math.max(safeMin, val));
        
        if (logMax !== logMin) {
            t = (logVal - logMin) / (logMax - logMin);
        }
    } else {
        t = (max - min) === 0 ? 0 : (val - min) / (max - min);
    }
    t = Math.max(0, Math.min(1, t));

    switch (selectedColormap) {
        case 'viridis': return getViridisColor(t);
        case 'rainbow': return getRainbowColor(t);
        case 'coolwarm': return getCoolWarmColor(t);
        case 'cividis': return getCividisColor(t);
        case 'grayscale': return getGrayscaleColor(t);
        case 'plasma':
        default: return getPlasmaColor(t);
    }
}

function updateAutoScale(data: Float32Array): void {
    if (!autoScale) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; ++i) {
        const v = data[i];
        if (isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    if (min !== Infinity && max !== -Infinity) {
        displayMin = min;
        displayMax = max;
        range = max - min || 1;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    }
}

function render(): void {
    const context = ctx;
    if (!context || !canvas || width <= 0 || height <= 0) return;

    lastRenderTime = Date.now();

    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;

    let hasHeatmap = false;
    let nr = 0;
    let nz = 0;
    let amrTiles: AMRLeafTile[] | null = null;

    if (meshType === 'amr') {
        const tiles = lastBuffer ? extractAMRChannel2D(lastBuffer, selectedChannel) : null;
        if (tiles) {
            amrTiles = tiles;
            updateAutoScaleAMR(tiles);

            const maxLvl = Math.max(0, amrMaxLevels - 1);
            const scaleFactor = 1 << maxLvl;
            outNr = (baseNr || 128) * scaleFactor;
            outNz = (baseNz || 128) * scaleFactor;

            if (!isFinite(outNr) || isNaN(outNr) || outNr <= 0) outNr = 128;
            if (!isFinite(outNz) || isNaN(outNz) || outNz <= 0) outNz = 128;

            if (!tempCanvas || tempCanvas.width !== outNr || tempCanvas.height !== outNz) {
                tempCanvas = new OffscreenCanvas(outNr, outNz);
                tempCtx = tempCanvas.getContext('2d');
            }

            if (tempCtx) {
                tempCtx.fillStyle = '#000000';
                tempCtx.fillRect(0, 0, outNr, outNz);

                const imgData = tempCtx.createImageData(outNr, outNz);
                const pixels = imgData.data;

                for (const tile of tiles) {
                    const cellSizeInFinestPixels = 1 << (maxLvl - tile.level);
                    const tileWidthInFinestPixels = 16 * cellSizeInFinestPixels;
                    const startX = tile.r_idx * tileWidthInFinestPixels;
                    const startY = tile.z_idx * tileWidthInFinestPixels;

                    for (let i = 0; i < 16; ++i) {
                        for (let j = 0; j < 16; ++j) {
                            const val = tile.data[i * 16 + j];
                            const col = getColor(val, displayMin, displayMax);

                            const cellStartX = startX + i * cellSizeInFinestPixels;
                            const cellStartY = startY + j * cellSizeInFinestPixels;

                            for (let ii = 0; ii < cellSizeInFinestPixels; ++ii) {
                                const px = cellStartX + ii;
                                if (px < 0 || px >= outNr) continue;

                                for (let jj = 0; jj < cellSizeInFinestPixels; ++jj) {
                                    const py_raw = cellStartY + jj;
                                    if (py_raw < 0 || py_raw >= outNz) continue;

                                    const py = outNz - 1 - py_raw;
                                    const pixelIdx = (py * outNr + px) * 4;

                                    pixels[pixelIdx + 0] = col.r;
                                    pixels[pixelIdx + 1] = col.g;
                                    pixels[pixelIdx + 2] = col.b;
                                    pixels[pixelIdx + 3] = 255;
                                }
                            }
                        }
                    }
                }
                tempCtx.putImageData(imgData, 0, 0);
                hasHeatmap = true;
                nr = baseNr;
                nz = baseNz;
            }
        }
    } else {
        const frameInfo = lastBuffer ? extractChannel2D(lastBuffer, selectedChannel) : null;
        if (frameInfo) {
            const { data, nr: cellNr, nz: cellNz } = frameInfo;
            nr = cellNr;
            nz = cellNz;

            // Update scale
            updateAutoScale(data);

            // Calculate out dimensions based on stride
            outNr = Math.ceil(nr / stride);
            outNz = Math.ceil(nz / stride);

            // Initialise or resize temporary offscreen canvas for raw grid
            if (!tempCanvas || tempCanvas.width !== outNr || tempCanvas.height !== outNz) {
                tempCanvas = new OffscreenCanvas(outNr, outNz);
                tempCtx = tempCanvas.getContext('2d');
            }

            if (tempCtx) {
                // Build the image data for the raw outNr x outNz grid
                const imgData = tempCtx.createImageData(outNr, outNz);
                const pixels = imgData.data;

                for (let i = 0; i < outNr; ++i) {
                    for (let j = 0; j < outNz; ++j) {
                        const rawI = Math.min(nr - 1, i * stride);
                        const rawJ = Math.min(nz - 1, j * stride);
                        const solverIdx = rawI * nz + rawJ;
                        const val = data[solverIdx];

                        const col = getColor(val, displayMin, displayMax);
                        
                        // Flip y-coordinate for intuitive contour plot (z vertical)
                        const canvasY = outNz - 1 - j;
                        const pixelIdx = (canvasY * outNr + i) * 4;

                        pixels[pixelIdx + 0] = col.r;
                        pixels[pixelIdx + 1] = col.g;
                        pixels[pixelIdx + 2] = col.b;
                        pixels[pixelIdx + 3] = 255; // Alpha
                    }
                }
                tempCtx.putImageData(imgData, 0, 0);
                hasHeatmap = true;
            }
        }
    }

    // Determine domain dimensions for overlay mapping
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

    // Calculate aspect ratio
    // If we have a heatmap, use its aspect ratio. Otherwise, use physical domain bounds.
    const aspect = hasHeatmap
        ? (isAxisymmetric ? (2 * outNr) / outNz : outNr / outNz)
        : (isAxisymmetric ? (2 * max_r) / max_z : max_r / max_z);

    let dw = width;
    let dh = height;
    if (width / height > aspect) {
        dw = height * aspect;
        dh = height;
    } else {
        dw = width;
        dh = width / aspect;
    }
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;

    // Draw heatmap and overlays within a clipped and transformed context
    context.save();
    context.beginPath();
    context.rect(dx, dy, dw, dh);
    context.clip();

    // Zoom and pan around center of the plot
    const px = dx + dw / 2;
    const py = dy + dh / 2;
    context.translate(px + panX, py + panY);
    context.scale(zoom, zoom);
    context.translate(-px, -py);

    // Draw heatmap
    if (hasHeatmap && tempCanvas) {
        if (isAxisymmetric) {
            // Draw left reflected half (r from -max_r to 0)
            context.save();
            context.translate(dx + dw / 2, dy);
            context.scale(-1, 1);
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, 0, 0, dw / 2, dh);
            context.restore();

            // Draw right normal half (r from 0 to max_r)
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, dx + dw / 2, dy, dw / 2, dh);
        } else {
            // Draw standard full width
            context.drawImage(tempCanvas, 0, 0, outNr, outNz, dx, dy, dw, dh);
        }
    } else {
        // Draw grid placeholder when waiting for telemetry
        context.save();
        context.strokeStyle = 'rgba(71, 85, 105, 0.4)';
        context.lineWidth = 1 / zoom;
        context.strokeRect(dx, dy, dw, dh);
        // Draw center axis if axisymmetric
        if (isAxisymmetric) {
            context.beginPath();
            context.moveTo(dx + dw / 2, dy);
            context.lineTo(dx + dw / 2, dy + dh);
            context.stroke();
        }
        context.restore();
    }

    // Draw cell boundary gridlines if enabled
    if (showGridlines) {
        if (meshType === 'amr' && amrTiles) {
            context.save();
            context.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            context.lineWidth = 0.5 / zoom;
            context.beginPath();

            for (const tile of amrTiles) {
                const factor = 1.0 / (1 << tile.level);
                const tileWidth = 16 * (max_r / baseNr) * factor;
                const tileHeight = 16 * (max_z / baseNz) * factor;
                const rMin = tile.r_idx * tileWidth;
                const zMin = tile.z_idx * tileHeight;

                const cellW = tileWidth / 16;
                const cellH = tileHeight / 16;

                // Draw tile boundary and internal cell lines
                for (let i = 0; i <= 16; ++i) {
                    const r = rMin + i * cellW;
                    let cx1 = dx + dw / 2;
                    if (isAxisymmetric) {
                        cx1 += (r / max_r) * (dw / 2);
                    } else {
                        cx1 = dx + (r / max_r) * dw;
                    }
                    const cy1 = dy + dh - (zMin / max_z) * dh;
                    const cy2 = dy + dh - ((zMin + tileHeight) / max_z) * dh;

                    context.moveTo(cx1, cy1);
                    context.lineTo(cx1, cy2);

                    if (isAxisymmetric) {
                        const cx2 = dx + dw / 2 - (r / max_r) * (dw / 2);
                        context.moveTo(cx2, cy1);
                        context.lineTo(cx2, cy2);
                    }
                }

                for (let j = 0; j <= 16; ++j) {
                    const z = zMin + j * cellH;
                    const cy = dy + dh - (z / max_z) * dh;
                    let cx1 = dx;
                    let cx2 = dx + dw;
                    if (isAxisymmetric) {
                        const rMax = rMin + tileWidth;
                        cx1 = dx + dw / 2 - (rMax / max_r) * (dw / 2);
                        cx2 = dx + dw / 2 + (rMax / max_r) * (dw / 2);
                    }
                    context.moveTo(cx1, cy);
                    context.lineTo(cx2, cy);
                }
            }
            context.stroke();
            context.restore();
        } else if (nr > 0 && nz > 0) {
            const cellWidthOnScreen = (isAxisymmetric ? (dw / 2) : dw) / nr * zoom;
            if (cellWidthOnScreen >= 3) {
                context.save();
                context.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                context.lineWidth = 0.5 / zoom;
                context.beginPath();
                
                // Horizontal lines (z gridlines)
                for (let j = 0; j <= nz; ++j) {
                    const y = dy + j * dh / nz;
                    context.moveTo(dx, y);
                    context.lineTo(dx + dw, y);
                }
                
                // Vertical lines (r gridlines)
                if (isAxisymmetric) {
                    for (let i = 0; i <= nr; ++i) {
                        const xRight = (dx + dw / 2) + i * (dw / 2) / nr;
                        context.moveTo(xRight, dy);
                        context.lineTo(xRight, dy + dh);
                        
                        const xLeft = (dx + dw / 2) - i * (dw / 2) / nr;
                        context.moveTo(xLeft, dy);
                        context.lineTo(xLeft, dy + dh);
                    }
                } else {
                    for (let i = 0; i <= nr; ++i) {
                        const x = dx + i * dw / nr;
                        context.moveTo(x, dy);
                        context.lineTo(x, dy + dh);
                    }
                }
                context.stroke();
                context.restore();
            }
        }
    }

    // Render overlays (charge shape and detonator location)
    if (chargeInfo) {
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
            if (shape === 'Sphere') {
                const center = getCanvasCoords(cR, cZ);
                const edge = getCanvasCoords(cR + radius, cZ);
                const rCanvas = Math.abs(edge.x - center.x);
                context.arc(center.x, center.y, rCanvas, 0, 2 * Math.PI);
            } else if (shape === 'Cylinder') {
                const topLeft = getCanvasCoords(cR - radius, cZ + cH / 2);
                const bottomRight = getCanvasCoords(cR + radius, cZ - cH / 2);
                const rectW = Math.abs(bottomRight.x - topLeft.x);
                const rectH = Math.abs(bottomRight.y - topLeft.y);
                context.rect(Math.min(topLeft.x, bottomRight.x), Math.min(topLeft.y, bottomRight.y), rectW, rectH);
            }
            // Double stroke for maximum visibility (white inside, black outside border)
            context.strokeStyle = '#000000';
            context.lineWidth = 3 / zoom;
            context.stroke();
            
            context.strokeStyle = '#ffffff';
            context.lineWidth = 1.5 / zoom;
            context.stroke();
        };

        drawOutline(false);
        if (isAxisymmetric) {
            drawOutline(true);
        }
        context.restore();
    }

    if (detonatorInfo) {
        const { r: dR, z: dZ } = detonatorInfo;
        context.save();
        
        const drawDet = (flipX: boolean) => {
            let cx = dx + dw / 2;
            if (isAxisymmetric) {
                const sign = flipX ? -1 : 1;
                cx += sign * (dR / max_r) * (dw / 2);
            } else {
                cx = dx + (dR / max_r) * dw;
            }
            const cy = dy + dh - (dZ / max_z) * dh;

            context.beginPath();
            context.arc(cx, cy, 4 / zoom, 0, 2 * Math.PI);
            context.fillStyle = '#ff3b30'; // red detonator dot
            context.strokeStyle = '#ffffff';
            context.lineWidth = 1.5 / zoom;
            context.fill();
            context.stroke();
        };

        drawDet(false);
        if (isAxisymmetric) {
            drawDet(true);
        }
        context.restore();
    }

    context.restore(); // Restore transformed context

    // Draw grid info overlay (glassmorphism/ HUD styling)
    context.save();
    context.font = '11px monospace';
    context.fillStyle = '#94a3b8';
    if (hasHeatmap) {
        if (meshType === 'amr' && amrTiles) {
            context.fillText(`Mesh: AMR ${amrTiles.length} active leaves (Max Level: ${amrMaxLevels})`, 15, 20);
        } else {
            context.fillText(`Mesh: ${nr} × ${nz} (Render: ${outNr} × ${outNz})`, 15, 20);
        }
        context.fillText(`Range: [${displayMin.toExponential(2)}, ${displayMax.toExponential(2)}]`, 15, 35);
    } else {
        context.fillText('Waiting for telemetry...', 15, 20);
    }
    context.restore();
}

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        lastBuffer = data;

        // Robustness: throttle & catch-up logic
        const now = Date.now();
        const intervalMs = refreshRate * 1000;

        if (intervalMs <= 0) {
            if (renderTimeout) {
                clearTimeout(renderTimeout);
                renderTimeout = null;
            }
            requestRender();
        } else {
            const timeSinceLast = now - lastRenderTime;
            if (timeSinceLast >= intervalMs) {
                if (renderTimeout) {
                    clearTimeout(renderTimeout);
                    renderTimeout = null;
                }
                requestRender();
            } else {
                // If a rendering is not already pending, schedule it to run
                // exactly when the throttle period expires.
                if (!renderTimeout) {
                    const delay = intervalMs - timeSinceLast;
                    renderTimeout = setTimeout(() => {
                        renderTimeout = null;
                        requestRender();
                    }, delay);
                }
            }
        }
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
        dpr = data.dpr || 1;
        width = canvas.width;
        height = canvas.height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.scale(dpr, dpr);
        requestRender();
        return;
    }

    if (data.type === 'resize' && canvas && ctx) {
        width = data.width;
        height = data.height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.scale(dpr, dpr);
        requestRender();
        return;
    }

    if (data.type === 'setConfig') {
        if (typeof data.meshType === 'string') meshType = data.meshType;
        if (typeof data.amrMaxLevels === 'number') amrMaxLevels = data.amrMaxLevels;
        if (typeof data.baseNr === 'number') baseNr = data.baseNr;
        if (typeof data.baseNz === 'number') baseNz = data.baseNz;
        if (typeof data.channel === 'number') selectedChannel = data.channel;
        if (typeof data.stride === 'number') stride = data.stride;
        if (typeof data.refreshRate === 'number') refreshRate = data.refreshRate;
        if (typeof data.autoScale === 'boolean') autoScale = data.autoScale;
        if (typeof data.logScale === 'boolean') useLogScale = data.logScale;
        if (typeof data.colormap === 'string') selectedColormap = data.colormap;
        if (typeof data.isAxisymmetric === 'boolean') isAxisymmetric = data.isAxisymmetric;
        if (data.chargeInfo !== undefined) chargeInfo = data.chargeInfo;
        if (data.detonatorInfo !== undefined) detonatorInfo = data.detonatorInfo;
        if (typeof data.showGridlines === 'boolean') showGridlines = data.showGridlines;
        if (!autoScale) {
            if (typeof data.min === 'number') displayMin = data.min;
            if (typeof data.max === 'number') displayMax = data.max;
        }
        if (typeof data.max_r === 'number') {
            max_r = data.max_r;
        } else if (chargeInfo && chargeInfo.max_r) {
            max_r = chargeInfo.max_r;
        } else if (detonatorInfo && detonatorInfo.max_r) {
            max_r = detonatorInfo.max_r;
        }
        if (typeof data.max_z === 'number') {
            max_z = data.max_z;
        } else if (chargeInfo && chargeInfo.max_z) {
            max_z = chargeInfo.max_z;
        } else if (detonatorInfo && detonatorInfo.max_z) {
            max_z = detonatorInfo.max_z;
        }
        range = displayMax - displayMin || 1;
        requestRender();
        return;
    }

    if (data.type === 'pan') {
        const dxVal = data.dx;
        const dyVal = data.dy;
        if (zoom > 1.0) {
            panX += dxVal;
            panY += dyVal;
            
            const aspect = outNr > 0 && outNz > 0
                ? (isAxisymmetric ? (2 * outNr) / outNz : outNr / outNz)
                : (isAxisymmetric ? (2 * max_r) / max_z : max_r / max_z);

            let dw = width;
            let dh = height;
            if (width / height > aspect) {
                dw = height * aspect;
                dh = height;
            } else {
                dw = width;
                dh = width / aspect;
            }
            const maxPanX = dw * (zoom - 1) / 2 + dw * 0.2;
            const maxPanY = dh * (zoom - 1) / 2 + dh * 0.2;
            panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
            panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
            
            requestRender();
        }
        return;
    }

    if (data.type === 'zoom') {
        const deltaY = data.deltaY;
        const mx = data.mx;
        const my = data.my;

        const aspect = outNr > 0 && outNz > 0
            ? (isAxisymmetric ? (2 * outNr) / outNz : outNr / outNz)
            : (isAxisymmetric ? (2 * max_r) / max_z : max_r / max_z);

        let dw = width;
        let dh = height;
        if (width / height > aspect) {
            dw = height * aspect;
            dh = height;
        } else {
            dw = width;
            dh = width / aspect;
        }
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;

        const clampedMx = Math.max(dx, Math.min(dx + dw, mx));
        const clampedMy = Math.max(dy, Math.min(dy + dh, my));

        const factor = deltaY < 0 ? 1.05 : 0.95;
        const oldZoom = zoom;
        let newZoom = zoom * factor;
        if (newZoom < 1.01) {
            newZoom = 1.0;
        }
        newZoom = Math.max(1.0, Math.min(100.0, newZoom));

        const px = dx + dw / 2;
        const py = dy + dh / 2;

        if (newZoom > 1.0) {
            zoom = newZoom;
            panX = clampedMx - px - (clampedMx - px - panX) * (newZoom / oldZoom);
            panY = clampedMy - py - (clampedMy - py - panY) * (newZoom / oldZoom);
            
            const maxPanX = dw * (zoom - 1) / 2 + dw * 0.2;
            const maxPanY = dh * (zoom - 1) / 2 + dh * 0.2;
            panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
            panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
        } else {
            zoom = 1.0;
            panX = 0;
            panY = 0;
        }
        requestRender();
        return;
    }

    if (data.type === 'clickFocus') {
        const mx = data.mx;
        const my = data.my;

        const aspect = outNr > 0 && outNz > 0
            ? (isAxisymmetric ? (2 * outNr) / outNz : outNr / outNz)
            : (isAxisymmetric ? (2 * max_r) / max_z : max_r / max_z);

        let dw = width;
        let dh = height;
        if (width / height > aspect) {
            dw = height * aspect;
            dh = height;
        } else {
            dw = width;
            dh = width / aspect;
        }
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;

        const clampedMx = Math.max(dx, Math.min(dx + dw, mx));
        const clampedMy = Math.max(dy, Math.min(dy + dh, my));

        const px = dx + dw / 2;
        const py = dy + dh / 2;

        if (zoom <= 1.01) {
            zoom = 3.0;
            panX = - (clampedMx - px) * 3.0;
            panY = - (clampedMy - py) * 3.0;
        } else {
            panX = panX + (px - clampedMx);
            panY = panY + (py - clampedMy);
        }

        const maxPanX = dw * (zoom - 1) / 2 + dw * 0.2;
        const maxPanY = dh * (zoom - 1) / 2 + dh * 0.2;
        panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
        panY = Math.max(-maxPanY, Math.min(maxPanY, panY));

        requestRender();
        return;
    }

    if (data.type === 'resetView') {
        zoom = 1.0;
        panX = 0.0;
        panY = 0.0;
        requestRender();
        return;
    }
};
