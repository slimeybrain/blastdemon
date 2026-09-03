export interface MPMParticleData2D {
    x: number;
    y: number;
    vx: number;
    vy: number;
    vonMises: number;
    plasticStrain: number;
    density: number;
    pressure: number;
}

export interface MPMGridContour2D {
    nx: number;
    ny: number;
    dx: number;
    dy: number;
    values: Float32Array; // Flattened scalar field values
}

export type ColorMapType = 'rainbow' | 'viridis' | 'plasma' | 'jet' | 'coolwarm' | 'grayscale';

export class MPMRenderer2D {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private colorMap: ColorMapType = 'rainbow';
    private particleRadius: number = 3.0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Failed to obtain 2D canvas rendering context for MPMRenderer2D');
        }
        this.ctx = context;
    }

    public setColormap(map: ColorMapType): void {
        this.colorMap = map;
    }

    /**
     * Map a normalized scalar val in [0, 1] to an RGB color tuple.
     */
    private sampleColormap(val: number): [number, number, number] {
        const v = Math.max(0.0, Math.min(1.0, val));
        switch (this.colorMap) {
            case 'rainbow': {
                // Classic Rainbow palette (Blue -> Cyan -> Green -> Yellow -> Red)
                const four = 4.0 * v;
                const r = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 1.5, -four + 4.5))));
                const g = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 0.5, -four + 3.5))));
                const b = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four + 0.5, -four + 2.5))));
                return [r, g, b];
            }
            case 'plasma': {
                // Approximate Plasma palette: (Purple -> Red -> Yellow)
                const r = Math.min(255, Math.floor(255 * Math.pow(v, 0.5)));
                const g = Math.floor(255 * Math.pow(v, 2.0) * 0.85);
                const b = Math.floor(255 * Math.cos(v * Math.PI * 0.5));
                return [r, Math.max(0, g), Math.max(0, b)];
            }
            case 'viridis': {
                // Approximate Viridis palette: (Purple -> Cyan -> Yellow)
                const r = Math.floor(255 * (0.2 + 0.8 * Math.pow(v, 2)));
                const g = Math.floor(255 * Math.sin(v * Math.PI * 0.8));
                const b = Math.floor(255 * (0.5 + 0.5 * Math.cos(v * Math.PI)));
                return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
            }
            case 'jet': {
                // Classic Jet palette: (Blue -> Cyan -> Green -> Yellow -> Red)
                const four = 4.0 * v;
                const r = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 1.5, -four + 4.5))));
                const g = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 0.5, -four + 3.5))));
                const b = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four + 0.5, -four + 2.5))));
                return [r, g, b];
            }
            case 'coolwarm': {
                // Blue to Red
                const r = Math.floor(255 * v);
                const g = Math.floor(255 * (1.0 - Math.abs(v - 0.5) * 2.0));
                const b = Math.floor(255 * (1.0 - v));
                return [r, g, b];
            }
            case 'grayscale': {
                const c = Math.floor(255 * v);
                return [c, c, c];
            }
            default: {
                const four = 4.0 * v;
                const r = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 1.5, -four + 4.5))));
                const g = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 0.5, -four + 3.5))));
                const b = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four + 0.5, -four + 2.5))));
                return [r, g, b];
            }
        }
    }

    /**
     * Render discrete MPM particles on canvas with coordinate transforms.
     */
    public renderParticles(
        particles: MPMParticleData2D[],
        scalarKey: keyof MPMParticleData2D = 'vonMises',
        minVal: number = 0.0,
        maxVal: number = 500.0e6,
        domainWidth: number = 1.0,
        domainHeight: number = 1.0
    ): void {
        const w = this.canvas.width;
        const h = this.canvas.height;

        this.ctx.clearRect(0, 0, w, h);

        const range = Math.max(1.0e-9, maxVal - minVal);

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];

            // Normalize particle domain coords to canvas pixels
            const px = (p.x / domainWidth) * w;
            const py = h - (p.y / domainHeight) * h; // flip Y for Cartesian standard

            const val = Number(p[scalarKey] ?? 0);
            const normVal = (val - minVal) / range;
            const [r, g, b] = this.sampleColormap(normVal);

            this.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            this.ctx.beginPath();
            this.ctx.arc(px, py, this.particleRadius, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    /**
     * Render smooth continuous 2D scalar field grid contours.
     */
    public renderContourGrid(
        grid: MPMGridContour2D,
        minVal: number = 0.0,
        maxVal: number = 500.0e6,
        opacity: number = 1.0
    ): void {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const imgData = this.ctx.createImageData(grid.nx, grid.ny);
        const data = imgData.data;

        const range = Math.max(1.0e-9, maxVal - minVal);

        for (let j = 0; j < grid.ny; j++) {
            for (let i = 0; i < grid.nx; i++) {
                const srcIdx = j * grid.nx + i;
                const val = grid.values[srcIdx];
                const normVal = (val - minVal) / range;

                const [r, g, b] = this.sampleColormap(normVal);

                // Flip Y coordinate for canvas raster image
                const targetY = grid.ny - 1 - j;
                const dstIdx = (targetY * grid.nx + i) * 4;

                data[dstIdx] = r;
                data[dstIdx + 1] = g;
                data[dstIdx + 2] = b;
                data[dstIdx + 3] = Math.floor(255 * opacity);
            }
        }

        // Draw offscreen contour grid image stretched to full canvas size
        const offCanvas = document.createElement('canvas');
        offCanvas.width = grid.nx;
        offCanvas.height = grid.ny;
        const offCtx = offCanvas.getContext('2d');
        if (offCtx) {
            offCtx.putImageData(imgData, 0, 0);
            this.ctx.drawImage(offCanvas, 0, 0, w, h);
        }
    }
}
