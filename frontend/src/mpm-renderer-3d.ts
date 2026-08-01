export interface MPMParticleData3D {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    vonMises: number;
    plasticStrain: number;
    density: number;
    pressure: number;
}

export interface MPMGridContour3D {
    nx: number;
    ny: number;
    nz: number;
    dx: number;
    dy: number;
    dz: number;
    values: Float32Array; // Flattened 3D scalar field values (nx * ny * nz)
}

export type ColorMapType = 'viridis' | 'plasma' | 'jet' | 'coolwarm' | 'grayscale';

export class MPMRenderer3D {
    private colorMap: ColorMapType = 'plasma';

    public setColormap(map: ColorMapType): void {
        this.colorMap = map;
    }

    /**
     * Map a normalized scalar val in [0, 1] to an RGB color tuple.
     */
    public sampleColormap(val: number): [number, number, number] {
        const v = Math.max(0.0, Math.min(1.0, val));
        switch (this.colorMap) {
            case 'plasma': {
                const r = Math.min(255, Math.floor(255 * Math.pow(v, 0.5)));
                const g = Math.floor(255 * Math.pow(v, 2.0) * 0.85);
                const b = Math.floor(255 * Math.cos(v * Math.PI * 0.5));
                return [r, Math.max(0, g), Math.max(0, b)];
            }
            case 'viridis': {
                const r = Math.floor(255 * (0.2 + 0.8 * Math.pow(v, 2)));
                const g = Math.floor(255 * Math.sin(v * Math.PI * 0.8));
                const b = Math.floor(255 * (0.5 + 0.5 * Math.cos(v * Math.PI)));
                return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
            }
            case 'jet': {
                const four = 4.0 * v;
                const r = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 1.5, -four + 4.5))));
                const g = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four - 0.5, -four + 3.5))));
                const b = Math.min(255, Math.max(0, Math.floor(255 * Math.min(four + 0.5, -four + 2.5))));
                return [r, g, b];
            }
            case 'coolwarm': {
                const r = Math.floor(255 * v);
                const g = Math.floor(255 * (1.0 - Math.abs(v - 0.5) * 2.0));
                const b = Math.floor(255 * (1.0 - v));
                return [r, g, b];
            }
            case 'grayscale':
            default: {
                const c = Math.floor(255 * v);
                return [c, c, c];
            }
        }
    }

    /**
     * Convert an array of 3D MPM particles into packed Float32 vertex position + color buffer.
     * Output layout: [x, y, z, r, g, b] per particle (6 floats per vertex).
     */
    public generateParticlePointCloudBuffer(
        particles: MPMParticleData3D[],
        scalarKey: keyof MPMParticleData3D = 'vonMises',
        minVal: number = 0.0,
        maxVal: number = 500.0e6
    ): Float32Array {
        const numParticles = particles.length;
        const out = new Float32Array(numParticles * 6);
        const range = Math.max(1.0e-9, maxVal - minVal);

        for (let i = 0; i < numParticles; i++) {
            const p = particles[i];
            const val = Number(p[scalarKey] ?? 0);
            const normVal = (val - minVal) / range;
            const [r, g, b] = this.sampleColormap(normVal);

            const idx = i * 6;
            out[idx + 0] = p.x;
            out[idx + 1] = p.y;
            out[idx + 2] = p.z;
            out[idx + 3] = r / 255.0;
            out[idx + 4] = g / 255.0;
            out[idx + 5] = b / 255.0;
        }

        return out;
    }
}
