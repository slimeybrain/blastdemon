import { GPUDevice, GPURenderPipeline, GPURenderPassEncoder, GPUBuffer, GPUBindGroup } from './WebGPUTypes';

export interface ParticleUniforms {
    modelMatrix: Float32Array;
    viewMatrix: Float32Array;
    projectionMatrix: Float32Array;
    particleDiameter: number;
    viewportHeight: number;
    colormapIndex: number;
    scalarMin: number;
    scalarMax: number;
}

export class ParticlePipeline {
    private device: GPUDevice | null = null;
    private pointPipeline: GPURenderPipeline | null = null;

    constructor(device?: GPUDevice) {
        if (device) {
            this.device = device;
        }
    }

    public setDevice(device: GPUDevice): void {
        this.device = device;
    }

    public isReady(): boolean {
        return this.device !== null;
    }

    public recordDraw(
        passEncoder: GPURenderPassEncoder,
        particleBuffer: GPUBuffer,
        particleCount: number,
        bindGroup: GPUBindGroup
    ): void {
        if (!this.device || !this.pointPipeline || particleCount <= 0) return;

        passEncoder.setPipeline(this.pointPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, particleBuffer);
        passEncoder.draw(particleCount);
    }
}
