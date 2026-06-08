/**
 * ChartWorker.ts
 * Handles high-performance telemetry rendering in a Web Worker.
 */

// Define missing types for TS environment if they aren't properly loaded from libs
interface OffscreenCanvas extends EventTarget {
    width: number;
    height: number;
    getContext(contextId: "2d", options?: CanvasRenderingContext2DSettings): OffscreenCanvasRenderingContext2D | null;
}

interface OffscreenCanvasRenderingContext2D extends CanvasState, CanvasTransform, CanvasCompositing, CanvasImageSmoothing, CanvasFillStrokeStyles, CanvasShadowStyles, CanvasFilters, CanvasRect, CanvasDrawPath, CanvasText, CanvasDrawImage, CanvasImageData, CanvasPathDrawingStyles, CanvasPath {
    readonly canvas: OffscreenCanvas;
    font: string; // Add font explicitly if missing in extended interfaces
}

interface DataPayload {
    type: 'data';
    telemetry: any;
}

interface ResizePayload {
    type: 'resize';
    width: number;
    height: number;
}

interface InitPayload {
    type: 'init';
    canvas: OffscreenCanvas;
}

type WorkerMessage = DataPayload | ResizePayload | InitPayload;

class AutoRanger {
    public min: number = 0;
    public max: number = 1;

    public update(values: number[]) {
        let vMin = Infinity;
        let vMax = -Infinity;
        for (let i = 0; i < values.length; i++) {
            if (values[i] < vMin) vMin = values[i];
            if (values[i] > vMax) vMax = values[i];
        }

        if (vMin === Infinity) return;

        const range = vMax - vMin;
        const padding = range === 0 ? 0.5 : range * 0.1;
        this.min = vMin - padding;
        this.max = vMax + padding;
    }

    public transform(value: number, height: number): number {
        const range = this.max - this.min;
        if (range === 0) return height / 2;
        return height - ((value - this.min) / range) * height;
    }
}

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const autoRanger = new AutoRanger();
let lastData: number[][] = []; // Store multiple curves

const COLORS = {
    bg: '#111111',
    curves: ['#00ffff', '#ff8c00', '#00ff00', '#ff00ff'], // Neon Cyan, Bright Orange, Neon Green, Neon Magenta
    grid: '#333333',
    text: '#888888'
};

const MARGIN = 30;

function decimateData(rawData: number[], canvasWidth: number): { min: number, max: number }[] {
    const dataWidth = canvasWidth - 2 * MARGIN;
    if (dataWidth <= 0) return [];

    const decimated: { min: number, max: number }[] = [];
    const chunkSize = rawData.length / dataWidth;

    for (let i = 0; i < dataWidth; i++) {
        const start = Math.floor(i * chunkSize);
        const end = Math.floor((i + 1) * chunkSize);

        let min = Infinity;
        let max = -Infinity;

        for (let j = start; j < end; j++) {
            const val = rawData[j];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        if (min === Infinity) {
            // Fallback for very small datasets or gaps
            const val = rawData[Math.min(start, rawData.length - 1)] || 0;
            decimated.push({ min: val, max: val });
        } else {
            decimated.push({ min, max });
        }
    }

    return decimated;
}

function render() {
    if (!canvas || !ctx) return;

    const { width, height } = canvas;

    // Clear background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
        const y = MARGIN + (i / 4) * (height - 2 * MARGIN);
        ctx.moveTo(MARGIN, y);
        ctx.lineTo(width - MARGIN, y);
    }
    ctx.stroke();

    if (lastData.length === 0) return;

    // Draw curves
    lastData.forEach((curve, index) => {
        const color = COLORS.curves[index % COLORS.curves.length];
        const decimated = decimateData(curve, width);

        ctx!.strokeStyle = color;
        ctx!.lineWidth = 2;
        ctx!.beginPath();

        decimated.forEach((point, i) => {
            const x = MARGIN + i;
            const yMin = autoRanger.transform(point.min, height);
            const yMax = autoRanger.transform(point.max, height);

            if (i === 0) {
                ctx!.moveTo(x, yMin);
            }

            // Draw a vertical line between min and max for this pixel
            ctx!.lineTo(x, yMax);

            // Connect to next chunk
            if (i < decimated.length - 1) {
                const nextYMin = autoRanger.transform(decimated[i+1].min, height);
                ctx!.lineTo(x + 1, nextYMin);
            }
        });
        ctx!.stroke();
    });

    // Draw axis labels (simplified)
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText(`Min: ${autoRanger.min.toFixed(2)}`, MARGIN, height - 5);
    ctx.fillText(`Max: ${autoRanger.max.toFixed(2)}`, width - MARGIN - 60, height - 5);
}

self.onmessage = (evt: MessageEvent<WorkerMessage>) => {
    const msg = evt.data;

    switch (msg.type) {
        case 'init':
            canvas = msg.canvas;
            ctx = canvas.getContext('2d');
            render();
            break;

        case 'resize':
            if (canvas) {
                canvas.width = msg.width;
                canvas.height = msg.height;
                render();
            }
            break;

        case 'data':
            let values: number[] = [];
            if (Array.isArray(msg.telemetry)) {
                values = msg.telemetry;
            } else if (typeof msg.telemetry === 'string') {
                if (msg.telemetry.includes(',')) {
                    values = msg.telemetry.split(',').map(Number);
                } else {
                    try {
                        const parsed = JSON.parse(msg.telemetry);
                        values = Array.isArray(parsed) ? parsed : (parsed.telemetry ? parsed.telemetry.split(',').map(Number) : []);
                    } catch (e) { }
                }
            }

            if (values.length > 0) {
                autoRanger.update(values);
                lastData = [values];
                render();
            }
            break;
    }
};
