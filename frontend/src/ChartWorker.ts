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
    const chunkSize = Math.max(1, Math.floor(numPoints / width));

    ctx.beginPath();
    for (let x = 0; x < width; x++) {
        const start = x * chunkSize;
        const end = Math.min(start + chunkSize, numPoints);
        if (start >= numPoints) break;

        let minY = pressureArray[start];
        let maxY = pressureArray[start];

        for (let i = start + 1; i < end; i++) {
            if (pressureArray[i] < minY) minY = pressureArray[i];
            if (pressureArray[i] > maxY) maxY = pressureArray[i];
        }

        const normMinY = (minY - displayMin) / range;
        const normMaxY = (maxY - displayMin) / range;
        const yTop = height - (normMaxY * height);
        const yBottom = height - (normMinY * height);

        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBottom);
    }
    ctx.stroke();

    rAF(render);
}

rAF(render);

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        rawData = new Float32Array(data);

        // Calculate auto-scaling ONCE per data update
        if (rawData.length > 0) {
            let min = rawData[0];
            let max = rawData[0];
            for (let i = 1; i < rawData.length; i++) {
                if (rawData[i] < min) min = rawData[i];
                if (rawData[i] > max) max = rawData[i];
            }
            const padding = (max - min) * 0.1;
            displayMin = min - padding;
            displayMax = max + padding;
            range = displayMax - displayMin || 1;
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
        return;
    }

    if (data.type === 'setConfig') {
        if (data.color) chartColor = data.color;
        return;
    }

    // Compatibility for legacy JSON frames if still needed during transition
    const isTelemetryEvent = data.type === 'telemetry' || data.type === 'TELEMETRY' || data.type === 'frame' || data.type === 'data';
    if (isTelemetryEvent) {
        const pressureData = data.data || data.telemetry;
        if (pressureData && Array.isArray(pressureData)) {
            rawData = new Float32Array(pressureData);
        }
    }
};
