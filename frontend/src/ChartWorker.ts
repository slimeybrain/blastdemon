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
        ctx.strokeStyle = chartColor;
        ctx.lineWidth = 1;

        // Min/Max Decimation (Pixel Binning)
        // We assume rawData is purely Y values.
        const chunkSize = Math.max(1, Math.floor(numPoints / width));

        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const start = x * chunkSize;
            const end = Math.min(start + chunkSize, numPoints);
            if (start >= numPoints) break;

            let minY = pressureArray[start];
            let maxY = pressureArray[start];

            for (let i = start + 1; i < end; i++) {
                const val = pressureArray[i];
                if (isNaN(val)) continue;
                if (val < minY) minY = val;
                if (val > maxY) maxY = val;
            }

            // Handle possible Infinity or NaN from empty chunks or bad data
            if (!isFinite(minY) || !isFinite(maxY)) continue;

            const normMinY = (minY - displayMin) / (range || 1);
            const normMaxY = (maxY - displayMin) / (range || 1);

            const yTop = height - (normMaxY * height);
            const yBottom = height - (normMinY * height);

            ctx.moveTo(x, yTop);
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

        // Calculate auto-scaling ONCE per data update
        if (rawData.length > 0) {
            let min = Infinity;
            let max = -Infinity;
            let hasValidData = false;

            for (let i = 0; i < rawData.length; i++) {
                const val = rawData[i];
                if (isFinite(val)) {
                    if (val < min) min = val;
                    if (val > max) max = val;
                    hasValidData = true;
                }
            }

            if (hasValidData) {
                const padding = (max - min) * 0.1 || 1;
                displayMin = min - padding;
                displayMax = max + padding;
                range = displayMax - displayMin;
            } else {
                displayMin = 0;
                displayMax = 1;
                range = 1;
            }
        }
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
        } else if (typeof pressureData === 'number') {
            // Some events might just send a single number (e.g. progress)
            rawData = new Float32Array([pressureData]);
        }
    }
};
