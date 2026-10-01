import { GPUDevice, GPURenderPipeline, GPURenderPassEncoder, GPUBuffer, GPUBindGroup } from './WebGPUTypes';

export interface MeshRenderUniforms {
    modelMatrix: Float32Array;
    viewMatrix: Float32Array;
    projectionMatrix: Float32Array;
    displacementScale: number;
    wireframeEnabled: boolean;
    wireframeColor: [number, number, number, number];
    colormapIndex: number;
    scalarRangeMin: number;
    scalarRangeMax: number;
    metallic: number;
    roughness: number;
}

export class MeshPipeline {
    private device: GPUDevice | null = null;
    private renderPipeline: GPURenderPipeline | null = null;
    private wireframePipeline: GPURenderPipeline | null = null;

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
        vertexBuffer: GPUBuffer,
        indexBuffer: GPUBuffer,
        indexCount: number,
        uniformBindGroup: GPUBindGroup,
        isWireframe: boolean = false
    ): void {
        if (!this.device) return;

        const pipeline = isWireframe && this.wireframePipeline ? this.wireframePipeline : this.renderPipeline;
        if (!pipeline) return;

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint32');
        passEncoder.drawIndexed(indexCount);
    }
}
