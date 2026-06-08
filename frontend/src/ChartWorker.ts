// ChartWorker.ts
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let width = 0;
let height = 0;

self.onmessage = (event) => {
    const data = event.data;

    // 1. Initialization Phase
    if (data.type === 'init') {
        canvas = data.canvas;
        ctx = canvas.getContext('2d');
        width = canvas.width;
        height = canvas.height;
        console.log(`[Worker] Initialized with dimensions: ${width}x${height}`);
        return;
    }

    // 2. Resize Phase
    if (data.type === 'resize' && canvas) {
        canvas.width = data.width;
        canvas.height = data.height;
        width = data.width;
        height = data.height;
        console.log(`[Worker] Resized to: ${width}x${height}`);
        return;
    }

    // --- THE FIX IS HERE ---
    // Catch 'telemetry', 'TELEMETRY', or 'data' (based on your TS interfaces)
    const isTelemetryEvent = data.type === 'telemetry' || data.type === 'TELEMETRY' || data.type === 'data';

    // 3. Telemetry Rendering Phase
    if (isTelemetryEvent) {
        // Ensure we actually have the canvas and dimensions ready
        if (!ctx || !canvas || width <= 0 || height <= 0) {
            console.warn(`[Worker] Ignored frame: Canvas not ready. W:${width}, H:${height}`);
            return;
        }

        // Catch the array whether you named the property 'data' or 'telemetry'
        const pressureArray: number[] = data.data || data.telemetry;

        if (!pressureArray || pressureArray.length === 0) {
            console.error("[Worker] Array is empty or missing! Raw data received:", data);
            return;
        }

        const numPoints = pressureArray.length;
        ctx.clearRect(0, 0, width, height);

        let min = pressureArray[0];
        let max = pressureArray[0];
        for (let i = 1; i < numPoints; i++) {
            if (pressureArray[i] < min) min = pressureArray[i];
            if (pressureArray[i] > max) max = pressureArray[i];
        }

        const padding = (max - min) * 0.1;
        const displayMin = min - padding;
        const displayMax = max + padding;
        const range = displayMax - displayMin || 1;

        // Neon Cyan styling
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';

        ctx.beginPath();

        for (let i = 0; i < numPoints; i++) {
            const x = (i / (numPoints - 1)) * width;
            const normalizedY = (pressureArray[i] - displayMin) / range;
            const y = height - (normalizedY * height);

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
    }
};