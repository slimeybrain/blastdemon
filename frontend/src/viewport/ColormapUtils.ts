export function getColormapIndex(name?: string): number {
    switch (name?.toLowerCase()) {
        case 'plasma': return 0;
        case 'viridis': return 1;
        case 'coolwarm': return 3;
        case 'cividis': return 4;
        case 'grayscale': return 5;
        case 'materials':
        case 'material':
        case 'phase': return 6;
        case 'rainbow':
        default: return 2;
    }
}

export function sampleColormapRGB(v: number, cmapName: string): [number, number, number] {
    const val = Math.max(0.0, Math.min(1.0, v));
    switch (cmapName) {
        case 'plasma': {
            const r = Math.min(1.0, Math.pow(val, 0.5));
            const g = Math.pow(val, 2.0) * 0.85;
            const b = Math.cos(val * Math.PI * 0.5);
            return [r, g, b];
        }
        case 'viridis': {
            const r = Math.max(0.0, Math.min(1.0, -1.8 * val * val + 2.0 * val));
            const g = Math.max(0.0, Math.min(1.0, 0.2 + 0.8 * Math.sin(val * Math.PI)));
            const b = Math.max(0.0, Math.min(1.0, Math.cos(val * Math.PI * 0.5)));
            return [r, g, b];
        }
        case 'coolwarm': {
            const r = Math.min(1.0, 0.23 + 1.5 * val);
            const g = Math.min(1.0, 1.0 - Math.abs(val - 0.5) * 1.2);
            const b = Math.min(1.0, 1.7 - 1.5 * val);
            return [r, g, b];
        }
        case 'grayscale':
            return [val, val, val];
        case 'materials':
        case 'material':
        case 'phase': {
            const id = Math.floor(val * 5.0 + 0.5);
            if (id < 0.5) return [0.53, 0.81, 0.98]; // Air
            if (id < 1.5) return [0.05, 0.45, 0.85]; // Water
            if (id < 2.5) return [0.85, 0.58, 0.25]; // Soil
            if (id < 3.5) return [1.00, 0.50, 0.00]; // HE Solid
            if (id < 4.5) return [0.95, 0.15, 0.15]; // Det Products
            return [0.58, 0.20, 0.92];               // FEM Solid / Obstacle
        }
        case 'rainbow':
        default: {
            const r = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(val * 4.0 - 3.0)));
            const g = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(val * 4.0 - 2.0)));
            const b = Math.max(0.0, Math.min(1.0, 1.5 - Math.abs(val * 4.0 - 1.0)));
            return [r, g, b];
        }
    }
}

export function getColormapCssGradient(cmapId: string, direction: 'to top' | 'to right' = 'to top', contourLevels: number = 0): string {
    if (cmapId === 'materials' || cmapId === 'material' || cmapId === 'phase') {
        return `linear-gradient(${direction}, #38bdf8 0% 16.67%, #0284c7 16.67% 33.33%, #d97706 33.33% 50%, #f97316 50% 66.67%, #ef4444 66.67% 83.33%, #a855f7 83.33% 100%)`;
    }
    if (contourLevels > 1) {
        const stops: string[] = [];
        for (let i = 0; i < contourLevels; i++) {
            const normVal = (i + 0.5) / contourLevels;
            const [r, g, b] = sampleColormapRGB(normVal, cmapId);
            const color = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
            const p0 = (i / contourLevels * 100).toFixed(2);
            const p1 = ((i + 1) / contourLevels * 100).toFixed(2);
            stops.push(`${color} ${p0}%`, `${color} ${p1}%`);
        }
        return `linear-gradient(${direction}, ${stops.join(', ')})`;
    }
    const cmapGradients: Record<string, string> = {
        rainbow: '#0000ff, #00ffff, #00ff00, #ffff00, #ff0000',
        plasma: '#0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921',
        viridis: '#440154, #3b528b, #21908d, #5dc963, #fde725',
        coolwarm: '#3b4cc0, #88b0f3, #ddd, #f49a7b, #b40426',
        cividis: '#002051, #395276, #678685, #9eb980, #fdea45',
        grayscale: '#000000, #ffffff',
        materials: '#38bdf8 0% 16.67%, #0284c7 16.67% 33.33%, #d97706 33.33% 50%, #f97316 50% 66.67%, #ef4444 66.67% 83.33%, #a855f7 83.33% 100%'
    };
    const stops = cmapGradients[cmapId] || cmapGradients.rainbow;
    return `linear-gradient(${direction}, ${stops})`;
}
