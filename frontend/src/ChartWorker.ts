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
let showAxes = true;

const padding = 40; // Requirement 9: Strict 40-pixel padding

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
        if (!ctx || !canvas || width <= 0 || height <= 0) {
            rAF(render);
            return;
        }

        const currentPadding = showAxes ? padding : 0;

        ctx.clearRect(0, 0, width, height);

        if (showAxes) {
            // Draw Axes (Requirement 9)
            ctx.strokeStyle = '#475569';
            ctx.lineWidth = 1;
            ctx.beginPath();
            // Vertical axis
            ctx.moveTo(currentPadding, 0);
            ctx.lineTo(currentPadding, height - currentPadding);
            // Horizontal axis
            ctx.lineTo(width, height - currentPadding);
            ctx.stroke();

            // Labels
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px monospace';
            ctx.fillText(displayMax.toExponential(1), 2, 10);
            ctx.fillText(displayMin.toExponential(1), 2, height - currentPadding - 2);
        }

        if (!rawData || rawData.length === 0) {
            rAF(render);
            return;
        }

        const pressureArray = rawData;
        const numPoints = pressureArray.length;

        const drawWidth = width - currentPadding;
        const drawHeight = height - currentPadding;

        ctx.strokeStyle = chartColor;
        ctx.lineWidth = 2;
        ctx.beginPath();

        let first = true;
        for (let x = 0; x < drawWidth; x++) {
            const start = Math.floor(x * numPoints / drawWidth);
            const end = Math.max(start + 1, Math.floor((x + 1) * numPoints / drawWidth));
            if (start >= numPoints) break;

            let minY = pressureArray[start];
            let maxY = pressureArray[start];

            for (let i = start + 1; i < end; i++) {
                const val = pressureArray[i];
                if (!isFinite(val)) continue;
                if (val < minY) minY = val;
                if (val > maxY) maxY = val;
            }

            if (!isFinite(minY) || !isFinite(maxY)) continue;

            const yTop = drawHeight - ((maxY - displayMin) / (range || 1)) * drawHeight;
            const yBottom = drawHeight - ((minY - displayMin) / (range || 1)) * drawHeight;

            const canvasX = currentPadding + x;

            if (first) {
                ctx.moveTo(canvasX, yTop);
                first = false;
            } else {
                ctx.lineTo(canvasX, yTop);
            }
            ctx.lineTo(canvasX, yBottom);
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
        updateAutoScale();
        return;
    }

    if (data.type === 'init') {
        canvas = data.canvas as OffscreenCanvas;
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        width = canvas.width;
        height = canvas.height;
        return;
    }

    if (data.type === 'resize' && canvas) {
        canvas.width = data.width;
        canvas.height = data.height;
        width = data.width;
        height = data.height;
        return;
    }

    if (data.type === 'setConfig') {
        if (data.color) chartColor = data.color;
        if (typeof data.min === 'number') displayMin = data.min;
        if (typeof data.max === 'number') displayMax = data.max;
        if (typeof data.showAxes === 'boolean') showAxes = data.showAxes;
        range = displayMax - displayMin || 1;
        return;
    }

    const isTelemetryEvent = data.type === 'telemetry' || data.type === 'TELEMETRY' || data.type === 'frame' || data.type === 'data';
    if (isTelemetryEvent) {
        const pressureData = data.data || data.telemetry;
        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
            rawData = new Float32Array(pressureData);
            updateAutoScale();
        }
    }
};
