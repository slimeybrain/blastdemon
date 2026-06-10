// ChartWorker.ts
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let width = 0;
let height = 0;

let rawData: Float32Array | null = null;
let chartColor = '#00f0ff';
let displayMin = 0;
let displayMax = 1;
let range = 1;

// Polyfill requestAnimationFrame for Worker if needed
const rAF = typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame
    : (cb: Function) => setTimeout(() => cb(Date.now()), 1000 / 60);

function updateAutoScale() {
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
        // Add 10% padding so the line doesn't touch the top/bottom
        const rawRange = maxY_raw - minY_raw === 0 ? 1 : maxY_raw - minY_raw;
        displayMin = minY_raw - (rawRange * 0.1);
        displayMax = maxY_raw + (rawRange * 0.1);
        range = displayMax - displayMin;
        self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax });
    } else {
        displayMin = 0;
        displayMax = 1;
        range = 1;
    }
}

function render() {
    try {
        if (!ctx || !canvas || width <= 0 || height <= 0 || !rawData || rawData.length === 0) {
            rAF(render);
            return;
        }

        const pressureArray = rawData;
        const numPoints = pressureArray.length;
        ctx.clearRect(0, 0, width, height);

        // Neon Styling
        ctx.strokeStyle = '#00ff00'; // Force Bright Green
        ctx.lineWidth = 2;
        ctx.beginPath();

        // Min/Max Decimation (Pixel Binning)
        // We assume rawData is purely Y values.
        let first = true;
        for (let x = 0; x < width; x++) {
            const start = Math.floor(x * numPoints / width);
            const end = Math.max(start + 1, Math.floor((x + 1) * numPoints / width));
            if (start >= numPoints) break;

            let minY = pressureArray[start];
            let maxY = pressureArray[start];

            for (let i = start + 1; i < end; i++) {
                const val = pressureArray[i];
                if (!isFinite(val)) continue;
                if (val < minY) minY = val;
                if (val > maxY) maxY = val;
            }

            // Handle possible Infinity or NaN from empty chunks or bad data
            if (!isFinite(minY) || !isFinite(maxY)) continue;

            // Coordinate mapping math using dynamic bounds
            const yTop = height - ((maxY - displayMin) / (range || 1)) * height;
            const yBottom = height - ((minY - displayMin) / (range || 1)) * height;

            if (isNaN(x) || isNaN(yTop) || isNaN(yBottom)) {
                console.error("[WORKER] Calculated NaN coordinate!", { x, yTop, yBottom });
                ctx.stroke(); // Finish current path
                return;
            }

            if (first) {
                ctx.moveTo(x, yTop);
                first = false;
            } else {
                ctx.lineTo(x, yTop);
            }
            ctx.lineTo(x, yBottom);
        }
        ctx.stroke();
    } catch (err) {
        console.error("ChartWorker rendering error:", err);
    }

    rAF(render);
}

rAF(render);

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        rawData = new Float32Array(data);

        console.warn(`[WORKER] Received ArrayBuffer. Length: ${rawData.length}`);
        if (rawData.length > 0) {
            console.warn(`[WORKER] First 4 bytes: ${rawData[0]}, ${rawData[1]}, ${rawData[2]}, ${rawData[3]}`);
        }

        updateAutoScale();
        return;
    }

    // 1. Initialization Phase
    if (data.type === 'init') {
        canvas = data.canvas as OffscreenCanvas;
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        width = canvas.width;
        height = canvas.height;
        return;
    }

    // 2. Resize Phase
    if (data.type === 'resize' && canvas) {
        canvas.width = data.width;
        canvas.height = data.height;
        width = data.width;
        height = data.height;
        // Immediate redraw for smooth scaling
        requestAnimationFrame(render);
        return;
    }

    if (data.type === 'setConfig') {
        if (data.color) chartColor = data.color;
        if (typeof data.min === 'number') displayMin = data.min;
        if (typeof data.max === 'number') displayMax = data.max;
        range = displayMax - displayMin || 1;
        return;
    }

    // Compatibility for legacy JSON frames if still needed during transition
    const isTelemetryEvent = data.type === 'telemetry' || data.type === 'TELEMETRY' || data.type === 'frame' || data.type === 'data';
    if (isTelemetryEvent) {
        const pressureData = data.data || data.telemetry || data.percent;
        if (pressureData && Array.isArray(pressureData)) {
            rawData = new Float32Array(pressureData);
            updateAutoScale();
        } else if (typeof pressureData === 'number') {
            // Some events might just send a single number (e.g. progress)
            rawData = new Float32Array([pressureData]);
            updateAutoScale();
        }
    }
};
