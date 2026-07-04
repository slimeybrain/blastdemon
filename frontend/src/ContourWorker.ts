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
let isAxisymmetric = true;

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

// Gorgeous plasma-like/spectral colormap for rich aesthetics
function getColor(val: number, min: number, max: number): { r: number; g: number; b: number } {
    let t = (max - min) === 0 ? 0 : (val - min) / (max - min);
    t = Math.max(0, Math.min(1, t));

    // Inferno/Plasma inspired palette
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
    if (!ctx || !canvas || width <= 0 || height <= 0 || !lastBuffer) return;

    lastRenderTime = Date.now();

    const frameInfo = extractChannel2D(lastBuffer, selectedChannel);
    if (!frameInfo) return;

    const { data, nr, nz } = frameInfo;

    // Update scale
    updateAutoScale(data);

    // Calculate out dimensions based on stride
    const outNr = Math.ceil(nr / stride);
    const outNz = Math.ceil(nz / stride);

    // Initialise or resize temporary offscreen canvas for raw grid
    if (!tempCanvas || tempCanvas.width !== outNr || tempCanvas.height !== outNz) {
        tempCanvas = new OffscreenCanvas(outNr, outNz);
        tempCtx = tempCanvas.getContext('2d');
    }

    if (!tempCtx) return;

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

    // Calculate drawing box keeping aspect ratio
    // If axisymmetric, the shown width is double the nr cells due to reflection (r goes from -max_r to max_r)
    const aspect = isAxisymmetric ? (2 * outNr) / outNz : outNr / outNz;
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

    // Draw heatmap preserving aspect ratio (sharp pixels per cell)
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    if (isAxisymmetric) {
        // Draw left reflected half (r from -max_r to 0)
        ctx.save();
        ctx.translate(dx + dw / 2, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(tempCanvas, 0, 0, outNr, outNz, 0, 0, dw / 2, dh);
        ctx.restore();

        // Draw right normal half (r from 0 to max_r)
        ctx.drawImage(tempCanvas, 0, 0, outNr, outNz, dx + dw / 2, dy, dw / 2, dh);
    } else {
        // Draw standard full width
        ctx.drawImage(tempCanvas, 0, 0, outNr, outNz, dx, dy, dw, dh);
    }

    // Draw grid info overlay (glassmorphism/ HUD styling)
    ctx.save();
    ctx.font = '11px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Mesh: ${nr} × ${nz} (Render: ${outNr} × ${outNz})`, 15, 20);
    ctx.fillText(`Range: [${displayMin.toExponential(2)}, ${displayMax.toExponential(2)}]`, 15, 35);
    ctx.restore();
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
        if (typeof data.channel === 'number') selectedChannel = data.channel;
        if (typeof data.stride === 'number') stride = data.stride;
        if (typeof data.refreshRate === 'number') refreshRate = data.refreshRate;
        if (typeof data.autoScale === 'boolean') autoScale = data.autoScale;
        if (typeof data.isAxisymmetric === 'boolean') isAxisymmetric = data.isAxisymmetric;
        if (!autoScale) {
            if (typeof data.min === 'number') displayMin = data.min;
            if (typeof data.max === 'number') displayMax = data.max;
        }
        range = displayMax - displayMin || 1;
        requestRender();
    }
};
