import { GPUDevice, GPURenderPipeline, GPURenderPassEncoder, GPUBuffer, GPUBindGroup } from './WebGPUTypes';

export interface SliceUniforms {
    modelMatrix: Float32Array;
    viewMatrix: Float32Array;
    projectionMatrix: Float32Array;
    axisId: number; // 0=XY, 1=XZ, 2=YZ
    offset: number;
    colormapIndex: number;
    rangeMin: number;
    rangeMax: number;
    opacity: number;
}

export class SlicePipeline {
    private device: GPUDevice | null = null;
    private slicePipeline: GPURenderPipeline | null = null;

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
        quadVertexBuffer: GPUBuffer,
        bindGroup: GPUBindGroup
    ): void {
        if (!this.device || !this.slicePipeline) return;

        passEncoder.setPipeline(this.slicePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, quadVertexBuffer);
        passEncoder.draw(6); // 2 triangles
    }
}
