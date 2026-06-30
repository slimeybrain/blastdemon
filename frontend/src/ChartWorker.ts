// ChartWorker.ts
export {};
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// Logical (CSS-pixel) drawing dimensions
let width = 0;
let height = 0;
// Physical pixel ratio
let dpr = 1;

let rawData: Float32Array | null = null;
let chartColor = '#00f0ff';
let displayMin = 0;
let displayMax = 1;
let range = 1;
let showAxes = true;

// Multi-channel telemetry: which channel index to display (0=p, 1=rho, 2=u, 3=e_int, 4=mass_frac)
let selectedChannel = 0;

// Last received raw multi-channel buffer so we can re-slice when channel changes
let lastBuffer: ArrayBuffer | null = null;

// X-axis configuration
let xAxisMode = 'radius';
let domainRadius = 1.0;

// Padding in logical CSS pixels
const PADDING = 55;

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

function applyTransform(): void {
    // Re-apply the DPR scale after any canvas resize (canvas resize resets transform)
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Parse a multi-channel binary frame and extract the selected channel.
 * Frame format: [uint32 n_cells][uint32 n_channels][float32 × n_cells × n_channels]
 * Channels are laid out as contiguous n_cells-length blocks: ch0 | ch1 | ch2 | ch3 ...
 * Falls back to raw float32 interpretation for legacy pressure-only frames.
 */
function extractChannel(buffer: ArrayBuffer, channel: number): Float32Array {
    const MIN_HEADER = 8; // 2 × uint32
    if (buffer.byteLength < MIN_HEADER) {
        return new Float32Array(buffer);
    }

    const headerView = new DataView(buffer);
    const n_cells    = headerView.getUint32(0, true); // little-endian
    const n_channels = headerView.getUint32(4, true);

    const expectedPayload = n_cells * n_channels * 4;
    const expectedTotal   = MIN_HEADER + expectedPayload;

    if (n_channels === 0 || n_cells === 0 || buffer.byteLength < expectedTotal) {
        // Doesn't match multi-channel layout — legacy fallback
        return new Float32Array(buffer);
    }

    const clampedChannel = Math.max(0, Math.min(channel, n_channels - 1));
    const byteOffset = MIN_HEADER + clampedChannel * n_cells * 4;
    // NOTE: Float32Array requires byteOffset to be a multiple of 4 (always true here)
    return new Float32Array(buffer, byteOffset, n_cells);
}

function updateAutoScale(): void {
    if (selectedChannel === 4) {
        displayMin = 0.0;
        displayMax = 1.0;
        range = 1.0;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
        return;
    }

    if (!rawData || rawData.length === 0) return;

    let minY_raw = Infinity;
    let maxY_raw = -Infinity;
    let hasValidData = false;

    for (let i = 0; i < rawData.length; i++) {
        const val = rawData[i];
        if (isFinite(val)) {
            if (val < minY_raw) minY_raw = val;
            if (val > maxY_raw) maxY_raw = val;
            hasValidData = true;
        }
    }

    if (hasValidData) {
        const rawRange = maxY_raw - minY_raw === 0 ? 1 : maxY_raw - minY_raw;
        displayMin = minY_raw - (rawRange * 0.1);
        // Clamp displayMin to 0 for positive-only channels if raw minimum is non-negative
        if (minY_raw >= 0 && (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 3 || selectedChannel === 4)) {
            displayMin = Math.max(0, displayMin);
        }
        displayMax = maxY_raw + (rawRange * 0.1);
        range = displayMax - displayMin;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    } else {
        displayMin = 0;
        displayMax = 1;
        range = 1;
    }
}

function drawCurve(data: Float32Array, color: string, physDrawWidth: number, drawHeight: number, currentPadding: number): void {
    if (!ctx) return;
    const numPoints = data.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let first = true;
    for (let px = 0; px < physDrawWidth; px++) {
        const x = px / dpr;
        const start = Math.floor(px * numPoints / physDrawWidth);
        const end = Math.max(start + 1, Math.floor((px + 1) * numPoints / physDrawWidth));
        if (start >= numPoints) break;

        let minY = data[start];
        let maxY = data[start];
        for (let i = start + 1; i < end; i++) {
            const val = data[i];
            if (!isFinite(val)) continue;
            if (val < minY) minY = val;
            if (val > maxY) maxY = val;
        }

        if (!isFinite(minY) || !isFinite(maxY)) continue;

        const yTop    = drawHeight - ((maxY - displayMin) / (range || 1)) * drawHeight;
        const yBottom = drawHeight - ((minY - displayMin) / (range || 1)) * drawHeight;
        const canvasX = currentPadding + x;

        if (first) {
            ctx.moveTo(canvasX, yTop);
            first = false;
        } else {
            ctx.lineTo(canvasX, yTop);
        }
        if (Math.abs(yBottom - yTop) > 0.5) {
            ctx.lineTo(canvasX, yBottom);
        }
    }
    ctx.stroke();
}

function drawLegend(currentPadding: number): void {
    if (!ctx) return;
    ctx.save();
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const items = [
        { label: 'Air (Ideal Gas)', color: '#38bdf8' },
        { label: 'Unburnt Explosive', color: '#f59e0b' },
        { label: 'Burned Explosive (JWL)', color: '#f43f5e' }
    ];

    const boxWidth = 175;
    const boxHeight = 65;
    const x = width - boxWidth - 15;
    const y = 15;

    // Draw background (glassmorphic panel)
    ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(x, y, boxWidth, boxHeight, 4);
    } else {
        ctx.rect(x, y, boxWidth, boxHeight);
    }
    ctx.fill();
    ctx.stroke();

    // Draw items
    for (let i = 0; i < items.length; i++) {
        const itemY = y + 12 + i * 17;
        
        // Color block
        ctx.fillStyle = items[i].color;
        ctx.fillRect(x + 10, itemY - 4, 12, 8);

        // Label
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(items[i].label, x + 28, itemY);
    }
    ctx.restore();
}

function render(): void {
    try {
        if (!ctx || !canvas || width <= 0 || height <= 0) {
            return;
        }

        const currentPadding = showAxes ? PADDING : 0;

        // Clear using logical CSS-pixel coordinates (ctx has dpr scale applied)
        ctx.clearRect(0, 0, width, height);

        if (showAxes) {
            // Draw axes
            ctx.strokeStyle = '#475569';
            ctx.lineWidth = 1 / dpr; // hairline in logical pixels
            ctx.beginPath();
            ctx.moveTo(currentPadding, 0);
            ctx.lineTo(currentPadding, height - currentPadding);
            ctx.lineTo(width, height - currentPadding);
            ctx.stroke();

            // Axis labels configuration
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px monospace';

            // Vertical axis ticks & labels (Y-axis)
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const numTicksY = 5;
            for (let i = 0; i < numTicksY; i++) {
                const pct = i / (numTicksY - 1);
                // i = 0 is bottom (displayMin), i = numTicksY - 1 is top (displayMax)
                const val = displayMin + pct * range;
                const y = height - currentPadding - pct * (height - currentPadding);
                
                // Draw tick
                ctx.strokeStyle = '#475569';
                ctx.beginPath();
                ctx.moveTo(currentPadding - 4, y);
                ctx.lineTo(currentPadding, y);
                ctx.stroke();
                
                // Draw text
                const labelText = (selectedChannel === 4) ? val.toFixed(2) : val.toExponential(2);
                ctx.fillText(labelText, currentPadding - 6, y);
            }

            // Horizontal axis ticks & labels (X-axis)
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const numTicksX = 5;
            const maxXVal = (rawData && rawData.length > 0) ? rawData.length - 1 : 100;
            for (let i = 0; i < numTicksX; i++) {
                const pct = i / (numTicksX - 1);
                const x = currentPadding + pct * (width - currentPadding);
                
                // Draw tick
                ctx.strokeStyle = '#475569';
                ctx.beginPath();
                ctx.moveTo(x, height - currentPadding);
                ctx.lineTo(x, height - currentPadding + 4);
                ctx.stroke();
                
                // Draw text
                let labelText = '';
                if (xAxisMode === 'radius') {
                    const radiusVal = pct * domainRadius;
                    labelText = radiusVal.toFixed(2);
                } else {
                    const val = Math.round(pct * maxXVal);
                    labelText = String(val);
                }
                ctx.fillText(labelText, x, height - currentPadding + 6);
            }
        }

        const drawWidth = width - currentPadding;
        const drawHeight = height - currentPadding;
        const physDrawWidth = Math.round(drawWidth * dpr);

        if (selectedChannel === 4 && lastBuffer) {
            const dataBurned = extractChannel(lastBuffer, 4);
            const dataUnburnt = extractChannel(lastBuffer, 5);
            const dataAir = extractChannel(lastBuffer, 6);

            // Draw Air (sky blue)
            drawCurve(dataAir, '#38bdf8', physDrawWidth, drawHeight, currentPadding);
            // Draw Unburnt (amber)
            drawCurve(dataUnburnt, '#f59e0b', physDrawWidth, drawHeight, currentPadding);
            // Draw Burned (rose/pink)
            drawCurve(dataBurned, '#f43f5e', physDrawWidth, drawHeight, currentPadding);

            // Draw Legend
            drawLegend(currentPadding);
        } else {
            if (!rawData || rawData.length === 0) {
                return;
            }
            drawCurve(rawData, chartColor, physDrawWidth, drawHeight, currentPadding);
        }
    } catch (err) {
        console.error('ChartWorker rendering error:', err);
    }
}

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        lastBuffer = data;
        rawData = extractChannel(data, selectedChannel);
        updateAutoScale();
        requestRender();
        return;
    }

    if (data.type === 'init') {
        canvas = data.canvas as OffscreenCanvas;
        // dpr comes from the main thread; avoid referencing `window` in Worker scope
        dpr = data.dpr || (typeof self !== 'undefined' && (self as any).devicePixelRatio) || 1;
        // Canvas was transferred with its CSS pixel size already set by the main thread
        width  = canvas.width;
        height = canvas.height;
        // Scale the physical canvas to device pixels, then apply ctx transform
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        applyTransform();
        requestRender();
        return;
    }

    if (data.type === 'resize' && canvas && ctx) {
        width  = data.width;
        height = data.height;
        // Resize physical canvas then re-apply transform (resize resets it)
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        applyTransform();
        requestRender();
        return;
    }

    if (data.type === 'setConfig') {
        if (data.color)                         chartColor = data.color;
        if (typeof data.min === 'number')        displayMin = data.min;
        if (typeof data.max === 'number')        displayMax = data.max;
        if (typeof data.showAxes === 'boolean')  showAxes = data.showAxes;
        if (data.xAxisMode)                     xAxisMode = data.xAxisMode;
        if (typeof data.domainRadius === 'number') domainRadius = data.domainRadius;
        range = displayMax - displayMin || 1;

        // Channel switch: re-slice the cached buffer immediately without a new frame
        if (typeof data.channel === 'number' && data.channel !== selectedChannel) {
            selectedChannel = data.channel;
            if (lastBuffer) {
                rawData = extractChannel(lastBuffer, selectedChannel);
                updateAutoScale();
            }
        }
        requestRender();
        return;
    }

    const isTelemetryEvent =
        data.type === 'telemetry' || data.type === 'TELEMETRY' ||
        data.type === 'frame'    || data.type === 'data';
    if (isTelemetryEvent) {
        const pressureData = data.data || data.telemetry;
        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
            rawData = new Float32Array(pressureData);
            updateAutoScale();
            requestRender();
        }
    }
};
