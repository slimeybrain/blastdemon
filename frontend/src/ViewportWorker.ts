// ViewportWorker.ts
export {};

// --- WebGL Shader Sources ---
const VS_SOURCE_2 = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec2 texCoord;
layout(location = 2) in vec2 sliceSize;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
out vec2 vTexCoord;
out vec2 vSliceSize;
void main() {
    gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
    vTexCoord = texCoord;
    vSliceSize = sliceSize;
}
`;

const FS_SOURCE_2 = `#version 300 es
precision highp float;
in vec2 vTexCoord;
in vec2 vSliceSize;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uUseLogScale;
uniform int uIsWireframe;
uniform bool uShowCellEdges;
out vec4 outColor;

vec3 colormap_plasma(float t) {
    return vec3(t * 1.5, t * t, 1.0 - t);
}

vec3 colormap_viridis(float t) {
    return vec3(1.0 - t, t, 0.5 + 0.5 * t);
}

void main() {
    if (uIsWireframe > 0) {
        if (uIsWireframe == 1) {
            outColor = vec4(0.3, 0.3, 0.4, 0.8);
        } else if (uIsWireframe == 2) {
            outColor = vec4(1.0, 0.1, 0.1, 1.0); // X Red
        } else if (uIsWireframe == 3) {
            outColor = vec4(0.1, 1.0, 0.1, 1.0); // Y Green
        } else if (uIsWireframe == 4) {
            outColor = vec4(0.2, 0.5, 1.0, 1.0); // Z Blue
        } else {
            outColor = vec4(0.15, 0.15, 0.18, 0.6); // Cell Edges
        }
        return;
    }
    float raw = texture(uTexture, vTexCoord).r;
    float t;
    float denom = uMax - uMin;
    if (denom < 1e-5) denom = 1e-5;
    if (uUseLogScale) {
        float logMin = log(max(uMin, 1e-5));
        float logMax = log(max(uMax, 1e-5));
        float logVal = log(max(raw, 1e-5));
        float logDenom = logMax - logMin;
        if (logDenom < 1e-5) logDenom = 1e-5;
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - uMin) / denom, 0.0, 1.0);
    }
    vec3 color;
    if (uColormap == 1) color = colormap_viridis(t);
    else color = colormap_plasma(t);
    
    vec4 finalColor = vec4(color, uAlpha);
    if (uShowCellEdges) {
        vec2 grid = fract(vTexCoord * vSliceSize);
        vec2 width = fwidth(vTexCoord * vSliceSize);
        vec2 edge = smoothstep(width, vec2(0.0), grid) + smoothstep(vec2(1.0) - width, vec2(1.0), grid);
        float isEdge = max(edge.x, edge.y);
        finalColor = mix(finalColor, vec4(0.1, 0.1, 0.1, 0.8), isEdge * 0.5);
    }
    outColor = finalColor;
}
`;

const VS_SOURCE_1 = `
attribute vec3 position;
attribute vec2 texCoord;
attribute vec2 sliceSize;
varying vec2 vTexCoord;
varying vec2 vSliceSize;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
void main() {
    gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
    vTexCoord = texCoord;
    vSliceSize = sliceSize;
}
`;

const FS_SOURCE_1 = `
precision highp float;
varying vec2 vTexCoord;
varying vec2 vSliceSize;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uUseLogScale;
uniform int uIsWireframe;
uniform bool uShowCellEdges;

vec3 colormap_plasma(float t) {
    return vec3(t * 1.5, t * t, 1.0 - t);
}

vec3 colormap_viridis(float t) {
    return vec3(1.0 - t, t, 0.5 + 0.5 * t);
}

void main() {
    if (uIsWireframe > 0) {
        if (uIsWireframe == 1) {
            gl_FragColor = vec4(0.3, 0.3, 0.4, 0.8);
        } else if (uIsWireframe == 2) {
            gl_FragColor = vec4(1.0, 0.1, 0.1, 1.0);
        } else if (uIsWireframe == 3) {
            gl_FragColor = vec4(0.1, 1.0, 0.1, 1.0);
        } else if (uIsWireframe == 4) {
            gl_FragColor = vec4(0.2, 0.5, 1.0, 1.0);
        } else {
            gl_FragColor = vec4(0.15, 0.15, 0.18, 0.6);
        }
        return;
    }
    float raw = texture2D(uTexture, vTexCoord).r;
    float t;
    float denom = uMax - uMin;
    if (denom < 1e-5) denom = 1e-5;
    if (uUseLogScale) {
        float logMin = log(max(uMin, 1e-5));
        float logMax = log(max(uMax, 1e-5));
        float logVal = log(max(raw, 1e-5));
        float logDenom = logMax - logMin;
        if (logDenom < 1e-5) logDenom = 1e-5;
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - uMin) / denom, 0.0, 1.0);
    }
    vec3 color;
    if (uColormap == 1) color = colormap_viridis(t);
    else color = colormap_plasma(t);
    
    vec4 finalColor = vec4(color, uAlpha);
    if (uShowCellEdges) {
        vec2 grid = fract(vTexCoord * vSliceSize);
        if (grid.x < 0.08 || grid.y < 0.08 || grid.x > 0.92 || grid.y > 0.92) {
            finalColor = mix(finalColor, vec4(0.1, 0.1, 0.1, 0.8), 0.4);
        }
    }
    gl_FragColor = finalColor;
}
`;

// --- WebGPU WGSL Source ---
const WGSL_SOURCE = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) sliceSize: vec2<f32>,
}

struct Uniforms {
    projection: mat4x4<f32>,
    view: mat4x4<f32>,
    model: mat4x4<f32>,
    alpha: f32,
    colormap: f32,
    minVal: f32,
    maxVal: f32,
    useLogScale: f32,
    isWireframe: f32,
    showCellEdges: f32,
    padding1: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) size: vec2<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.position = uniforms.projection * uniforms.view * uniforms.model * vec4<f32>(pos, 1.0);
    out.texCoord = uv;
    out.sliceSize = size;
    return out;
}

fn colormap_plasma(t: f32) -> vec3<f32> {
    return vec3<f32>(t * 1.5, t * t, 1.0 - t);
}

fn colormap_viridis(t: f32) -> vec3<f32> {
    return vec3<f32>(1.0 - t, t, 0.5 + 0.5 * t);
}

@fragment
fn fs_main(@location(0) texCoord: vec2<f32>, @location(1) sliceSize: vec2<f32>) -> @location(0) vec4<f32> {
    if (uniforms.isWireframe > 0.5) {
        if (uniforms.isWireframe < 1.5) {
            return vec4<f32>(0.3, 0.3, 0.4, 0.8); // Bounding box: grey
        } else if (uniforms.isWireframe < 2.5) {
            return vec4<f32>(1.0, 0.1, 0.1, 1.0); // X-axis: Red
        } else if (uniforms.isWireframe < 3.5) {
            return vec4<f32>(0.1, 1.0, 0.1, 1.0); // Y-axis: Green
        } else if (uniforms.isWireframe < 4.5) {
            return vec4<f32>(0.2, 0.5, 1.0, 1.0); // Z-axis: Blue
        } else {
            return vec4<f32>(0.15, 0.15, 0.18, 0.6); // Cell Edges grid
        }
    }
    let raw = textureSample(uTexture, uSampler, texCoord).r;
    var t = 0.0;
    var denom = uniforms.maxVal - uniforms.minVal;
    if (denom < 1e-5) {
        denom = 1e-5;
    }
    if (uniforms.useLogScale > 0.5) {
        let logMin = log(max(uniforms.minVal, 1e-5));
        let logMax = log(max(uniforms.maxVal, 1e-5));
        let logVal = log(max(raw, 1e-5));
        var logDenom = logMax - logMin;
        if (logDenom < 1e-5) {
            logDenom = 1e-5;
        }
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - uniforms.minVal) / denom, 0.0, 1.0);
    }
    var color: vec3<f32>;
    if (uniforms.colormap > 0.5) {
        color = colormap_viridis(t);
    } else {
        color = colormap_plasma(t);
    }

    var finalColor = vec4<f32>(color, uniforms.alpha);

    if (uniforms.showCellEdges > 0.5) {
        let gridX = fract(texCoord.x * sliceSize.x);
        let gridY = fract(texCoord.y * sliceSize.y);
        let widthX = fwidth(texCoord.x * sliceSize.x);
        let widthY = fwidth(texCoord.y * sliceSize.y);
        let edgeX = smoothstep(widthX, 0.0, gridX) + smoothstep(1.0 - widthX, 1.0, gridX);
        let edgeY = smoothstep(widthY, 0.0, gridY) + smoothstep(1.0 - widthY, 1.0, gridY);
        let isEdge = max(edgeX, edgeY);
        finalColor = mix(finalColor, vec4<f32>(0.1, 0.1, 0.1, 0.8), isEdge * 0.5);
    }

    return finalColor;
}
`;

// Render Mode State
let isWebGPU = false;
let isWebGL2 = false;
let isWebGL1 = false;
let is2DFallback = false;

// Contexts
let gpuDevice: any = null;
let gpuContext: any = null;
let gpuPipeline: any = null;
let gpuLinePipeline: any = null;
let gpuSampler: any = null;
let gpuUniformBuffer: any = null;
let gpuUniformBufferWF: any = null;
let gpuAxesUniformBuffers: any[] = [];
let cachedMsaaColorTexture: any = null;
let cachedMsaaColorView: any = null;
let cachedDepthTexture: any = null;
let cachedDepthView: any = null;
let cachedWidth = 0;
let cachedHeight = 0;

let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let bboxBuffer: WebGLBuffer | null = null;

let ctx2D: OffscreenCanvasRenderingContext2D | null = null;

// Camera / Projection Settings
let projectionMatrix = new Float32Array(16);
let viewMatrix = new Float32Array(16);
let modelMatrix = new Float32Array(16);

let distance = 2.45;
let pitch = 0.42;
let yaw = 1.107;
let targetX = 0.0;
let targetY = 0.0;
let targetZ = 0.0;
let usePerspective = false;
let fov = 45.0;

// Contour Visualization Configurations
let colormap = 0; // 0=plasma, 1=viridis
let minY = 101325.0;
let maxY = 1000000.0;
let autoScale = true;
let showGrid = true;
let useLogScale = false;
let showCellEdges = false;

// Domain Bounds Configurations
let xmin = 0.0;
let ymin = 0.0;
let zmin = 0.0;
let dx = 0.01;
let nx = 64;
let ny = 64;
let nz = 64;

// Axes Indicator Buffers
let gpuAxesBuffer: any = null;
let axesBuffer: WebGLBuffer | null = null;

interface SliceDataWebGPU {
    axis: number;
    offset: number;
    w: number;
    h: number;
    gpuTexture: any;
    gpuTextureView: any;
    vertexBuffer: any;
    bindGroup: any;
}

interface SliceDataWebGL {
    axis: number;
    offset: number;
    w: number;
    h: number;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
}

interface SliceData2D {
    axis: number;
    offset: number;
    w: number;
    h: number;
    data: Float32Array;
}

let activeSlicesWebGPU: { [axis: number]: SliceDataWebGPU } = {};
let activeSlicesWebGL: { [axis: number]: SliceDataWebGL } = {};
let activeSlices2D: SliceData2D[] = [];

let hasFloatLinear = false;
const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;

// WebGPU Bounding Box Geometry buffer
let gpuBBoxBuffer: any = null;
let gpuBBoxBindGroup: any = null;
let gpuDummyTextureView: any = null;
let bindGroupLayout: any = null;

// Initialize visualizer context
async function initContext(canvas: OffscreenCanvas) {
    // 1. Try WebGPU
    if (nav && nav.gpu) {
        try {
            const adapter = await nav.gpu.requestAdapter();
            if (adapter) {
                gpuDevice = await adapter.requestDevice();
                gpuContext = canvas.getContext('webgpu') as any;
                if (gpuContext && gpuDevice) {
                    gpuContext.configure({
                        device: gpuDevice,
                        format: nav.gpu.getPreferredCanvasFormat(),
                        alphaMode: 'opaque'
                    });

                    gpuDevice.onuncapturederror = (event: any) => {
                        console.error("WebGPU error:", event.error.message);
                        self.postMessage({ type: 'error', message: "WebGPU Error: " + event.error.message });
                    };

                    // Compile Shaders
                    const shaderModule = gpuDevice.createShaderModule({ code: WGSL_SOURCE });
                    // Define explicit BindGroupLayout for non-filtering r32float compatibility
                    bindGroupLayout = gpuDevice.createBindGroupLayout({
                        entries: [
                            {
                                binding: 0,
                                visibility: 1 | 2, // VERTEX | FRAGMENT
                                buffer: { type: 'uniform' }
                            },
                            {
                                binding: 1,
                                visibility: 2, // FRAGMENT
                                texture: { sampleType: 'unfilterable-float' }
                            },
                            {
                                binding: 2,
                                visibility: 2, // FRAGMENT
                                sampler: { type: 'non-filtering' }
                            }
                        ]
                    });

                    const pipelineLayout = gpuDevice.createPipelineLayout({
                        bindGroupLayouts: [bindGroupLayout]
                    });

                    gpuPipeline = gpuDevice.createRenderPipeline({
                        layout: pipelineLayout,
                        vertex: {
                            module: shaderModule,
                            entryPoint: 'vs_main',
                            buffers: [{
                                arrayStride: 28, // 7 floats (x, y, z, u, v, w, h)
                                attributes: [
                                    { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
                                    { shaderLocation: 1, offset: 12, format: 'float32x2' }, // texCoord
                                    { shaderLocation: 2, offset: 20, format: 'float32x2' } // sliceSize
                                ]
                            }]
                        },
                        fragment: {
                            module: shaderModule,
                            entryPoint: 'fs_main',
                            targets: [{
                                format: nav.gpu.getPreferredCanvasFormat(),
                                blend: {
                                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                                    alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
                                }
                            }]
                        },
                        primitive: { topology: 'triangle-list' },
                        multisample: { count: 4 },
                        depthStencil: {
                            depthWriteEnabled: true,
                            depthCompare: 'less-equal',
                            format: 'depth24plus'
                        }
                    });

                    // Create separate line pipeline for bounding box wireframe
                    gpuLinePipeline = gpuDevice.createRenderPipeline({
                        layout: pipelineLayout,
                        vertex: {
                            module: shaderModule,
                            entryPoint: 'vs_main',
                            buffers: [{
                                arrayStride: 20,
                                attributes: [
                                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                                    { shaderLocation: 1, offset: 12, format: 'float32x2' },
                                    { shaderLocation: 2, offset: 12, format: 'float32x2' } // dummy mapping
                                ]
                            }]
                        },
                        fragment: {
                            module: shaderModule,
                            entryPoint: 'fs_main',
                            targets: [{
                                format: nav.gpu.getPreferredCanvasFormat(),
                                blend: {
                                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                                    alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
                                }
                            }]
                        },
                        primitive: { topology: 'line-list' },
                        multisample: { count: 4 },
                        depthStencil: {
                            depthWriteEnabled: true,
                            depthCompare: 'less-equal',
                            format: 'depth24plus'
                        }
                    });

                    gpuSampler = gpuDevice.createSampler({
                        magFilter: 'nearest',
                        minFilter: 'nearest'
                    });

                    // GPUBufferUsage: UNIFORM = 64, COPY_DST = 8
                    gpuUniformBuffer = gpuDevice.createBuffer({
                        size: 224, // 16*4*3 + 8*4 bytes (padded)
                        usage: 64 | 8
                    });
                    gpuUniformBufferWF = gpuDevice.createBuffer({
                        size: 224,
                        usage: 64 | 8
                    });

                    gpuAxesUniformBuffers = [];
                    for (let a = 0; a < 3; a++) {
                        const buf = gpuDevice.createBuffer({
                            size: 224,
                            usage: 64 | 8
                        });
                        gpuAxesUniformBuffers.push(buf);
                    }

                    // Build static Bounding Box GPU buffer
                    const box = getBBoxVertices();
                    // GPUBufferUsage: VERTEX = 32
                    gpuBBoxBuffer = gpuDevice.createBuffer({
                        size: box.byteLength,
                        usage: 32,
                        mappedAtCreation: true
                    });
                    new Float32Array(gpuBBoxBuffer.getMappedRange()).set(box);
                    gpuBBoxBuffer.unmap();

                    // Build static Axes GPU buffer
                    const axesLines = new Float32Array([
                        -0.5, -0.5, -0.5, 0, 0,
                        -0.2, -0.5, -0.5, 0, 0,
                        -0.5, -0.5, -0.5, 0, 0,
                        -0.5, -0.2, -0.5, 0, 0,
                        -0.5, -0.5, -0.5, 0, 0,
                        -0.5, -0.5, -0.2, 0, 0
                    ]);
                    gpuAxesBuffer = gpuDevice.createBuffer({
                        size: axesLines.byteLength,
                        usage: 32,
                        mappedAtCreation: true
                    });
                    new Float32Array(gpuAxesBuffer.getMappedRange()).set(axesLines);
                    gpuAxesBuffer.unmap();

                    const dummyTex = gpuDevice.createTexture({
                        size: [1, 1, 1],
                        format: 'r32float',
                        usage: 4 // TEXTURE_BINDING
                    });
                    gpuDummyTextureView = dummyTex.createView();

                    isWebGPU = true;
                    self.postMessage({ type: 'rendererInfo', renderer: 'WebGPU' });
                    console.log("[ViewportWorker] WebGPU Initialized successfully.");
                    return;
                }
            }
        } catch (e: any) {
            console.warn("[ViewportWorker] Failed to initialize WebGPU, falling back to WebGL.", e);
            self.postMessage({ type: 'error', message: "WebGPU Init Warning: " + (e.message || String(e)) });
        }
    }

    // 2. Try WebGL
    try {
        await initGL(canvas);
    } catch (e: any) {
        self.postMessage({ type: 'error', message: "WebGL Init Error: " + (e.message || String(e)) });
        ctx2D = canvas.getContext("2d") as any;
        if (!ctx2D) {
            throw new Error("Could not initialize WebGPU, WebGL2, WebGL1, or 2D canvas context: " + (e.message || String(e)));
        }
        is2DFallback = true;
        self.postMessage({ type: 'rendererInfo', renderer: '2D Fallback' });
        console.log("[ViewportWorker] 2D Fallback Initialized.");
    }
}

function getBBoxVertices(): Float32Array {
    return new Float32Array([
        -0.5,-0.5,-0.5, 0,0,  0.5,-0.5,-0.5, 0,0,
         0.5,-0.5,-0.5, 0,0,  0.5, 0.5,-0.5, 0,0,
         0.5, 0.5,-0.5, 0,0, -0.5, 0.5,-0.5, 0,0,
        -0.5, 0.5,-0.5, 0,0, -0.5,-0.5,-0.5, 0,0,
        -0.5,-0.5, 0.5, 0,0,  0.5,-0.5, 0.5, 0,0,
         0.5,-0.5, 0.5, 0,0,  0.5, 0.5, 0.5, 0,0,
         0.5, 0.5, 0.5, 0,0, -0.5, 0.5, 0.5, 0,0,
        -0.5, 0.5, 0.5, 0,0, -0.5,-0.5, 0.5, 0,0,
        -0.5,-0.5,-0.5, 0,0, -0.5,-0.5, 0.5, 0,0,
         0.5,-0.5,-0.5, 0,0,  0.5,-0.5, 0.5, 0,0,
         0.5, 0.5,-0.5, 0,0,  0.5, 0.5, 0.5, 0,0,
        -0.5, 0.5,-0.5, 0,0, -0.5, 0.5, 0.5, 0,0
    ]);
}

async function initGL(canvas: OffscreenCanvas) {
    gl = canvas.getContext("webgl2", { alpha: false, antialias: true }) as any;
    if (gl) {
        isWebGL2 = true;
    } else {
        gl = canvas.getContext("webgl", { alpha: false, antialias: true }) as any;
        if (gl) {
            isWebGL1 = true;
        }
    }

    if (!gl) {
        throw new Error("WebGL context (WebGL2/WebGL1) creation returned null (canvas context may be locked or GPU process crashed)");
    }

    if (isWebGL2) {
        hasFloatLinear = !!gl.getExtension("OES_texture_float_linear");
    } else {
        gl.getExtension("OES_texture_float");
        hasFloatLinear = !!gl.getExtension("OES_texture_float_linear");
    }

    bboxBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, getBBoxVertices(), gl.STATIC_DRAW);

    axesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, axesBuffer);
    const axesLines = new Float32Array([
        -0.5, -0.5, -0.5, 0, 0,
        -0.2, -0.5, -0.5, 0, 0,
        -0.5, -0.5, -0.5, 0, 0,
        -0.5, -0.2, -0.5, 0, 0,
        -0.5, -0.5, -0.5, 0, 0,
        -0.5, -0.5, -0.2, 0, 0
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, axesLines, gl.STATIC_DRAW);

    const vsSource = isWebGL2 ? VS_SOURCE_2 : VS_SOURCE_1;
    const fsSource = isWebGL2 ? FS_SOURCE_2 : FS_SOURCE_1;
    
    const vs = createShader(gl as any, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl as any, gl.FRAGMENT_SHADER, fsSource);
    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error("Program link failed: " + gl.getProgramInfoLog(program));
    }
    
    gl.useProgram(program);

    const uTexLoc = gl.getUniformLocation(program, "uTexture");
    if (uTexLoc !== null) {
        gl.uniform1i(uTexLoc, 0);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    self.postMessage({ type: 'rendererInfo', renderer: isWebGL2 ? 'WebGL2' : 'WebGL1' });
    console.log("[ViewportWorker] WebGL Initialized successfully.");
}

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        throw new Error(`Shader compile failed (${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}): ${log}`);
    }
    return shader;
}

function subtract(a: number[], b: number[]) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross(a: number[], b: number[]) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function normalize(a: number[]) { let len = Math.hypot(a[0], a[1], a[2]); if (len>0) { return [a[0]/len, a[1]/len, a[2]/len]; } return [0,0,0]; }

function updateMatrices(width: number, height: number) {
    const w = width > 0 ? width : 1;
    const h = height > 0 ? height : 1;
    const aspect = w / h;
    const zNear = 0.1;
    const zFar = 1000.0;

    // Model matrix (Scaling)
    const sizeX = nx * dx || 1.0;
    const sizeY = ny * dx || 1.0;
    const sizeZ = nz * dx || 1.0;
    const maxSize = Math.max(sizeX, sizeY, sizeZ);
    const sX = sizeX / maxSize;
    const sY = sizeY / maxSize;
    const sZ = sizeZ / maxSize;
    
    // Shift model to be centered at its local origin if desired, or keep as is.
    // The previous implementation didn't translate the model, so we leave translation at 0.
    modelMatrix.set([
        sX, 0, 0, 0,
        0, sY, 0, 0,
        0, 0, sZ, 0,
        0, 0, 0, 1
    ]);

    // View matrix (LookAt)
    let eyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
    let eyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
    let eyeZ = targetZ + distance * Math.sin(pitch);
    
    let eye = [eyeX, eyeY, eyeZ];
    let center = [targetX, targetY, targetZ];
    let up = [0, 0, 1]; // Z is up

    let z = normalize(subtract(eye, center));
    // If z is parallel to up [0,0,1] or [0,0,-1] (looking straight along Z axis)
    if (Math.abs(z[0]) < 1e-4 && Math.abs(z[1]) < 1e-4) {
        up = [0, 1, 0]; // temporarily set up to Y
    }

    let x = normalize(cross(up, z));
    let y = cross(z, x);
    viewMatrix.set([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -(x[0]*eye[0] + x[1]*eye[1] + x[2]*eye[2]),
        -(y[0]*eye[0] + y[1]*eye[1] + y[2]*eye[2]),
        -(z[0]*eye[0] + z[1]*eye[1] + z[2]*eye[2]),
        1
    ]);

    // Projection matrix
    if (usePerspective) {
        let f = 1.0 / Math.tan((fov * Math.PI / 180) / 2);
        projectionMatrix.fill(0);
        projectionMatrix[0] = f / aspect;
        projectionMatrix[5] = f;
        if (isWebGPU) {
            projectionMatrix[10] = -zFar / (zFar - zNear);
            projectionMatrix[14] = -(zFar * zNear) / (zFar - zNear);
        } else {
            projectionMatrix[10] = (zFar + zNear) / (zNear - zFar);
            projectionMatrix[14] = (2 * zFar * zNear) / (zNear - zFar);
        }
        projectionMatrix[11] = -1;
    } else {
        // Orthographic projection based on distance
        let scale = distance * 0.5; // simple heuristic to match zoom feeling
        let left = -scale * aspect;
        let right = scale * aspect;
        let bottom = -scale;
        let top = scale;
        projectionMatrix.fill(0);
        projectionMatrix[0] = 2/(right-left);
        projectionMatrix[5] = 2/(top-bottom);
        if (isWebGPU) {
            projectionMatrix[10] = -1/(zFar-zNear);
            projectionMatrix[14] = -zNear/(zFar-zNear);
        } else {
            projectionMatrix[10] = -2/(zFar-zNear);
            projectionMatrix[14] = -(zFar+zNear)/(zFar-zNear);
        }
        projectionMatrix[12] = -(right+left)/(right-left);
        projectionMatrix[13] = -(top+bottom)/(top-bottom);
        projectionMatrix[15] = 1;
    }
}

function getSliceGeometry(axis: number, offset: number, w: number, h: number) {
    if (axis === 0) { // XY
        const dimZ = (nz && dx) ? (nz * dx) : 1.0;
        const z = (offset - zmin) / dimZ - 0.5;
        return new Float32Array([
            -0.5, -0.5, z,  0, 0,  w, h,
             0.5, -0.5, z,  1, 0,  w, h,
             0.5,  0.5, z,  1, 1,  w, h,
            -0.5, -0.5, z,  0, 0,  w, h,
             0.5,  0.5, z,  1, 1,  w, h,
            -0.5,  0.5, z,  0, 1,  w, h
        ]);
    } else if (axis === 1) { // XZ
        const dimY = (ny && dx) ? (ny * dx) : 1.0;
        const y = (offset - ymin) / dimY - 0.5;
        return new Float32Array([
            -0.5, y, -0.5,  0, 0,  w, h,
             0.5, y, -0.5,  1, 0,  w, h,
             0.5, y,  0.5,  1, 1,  w, h,
            -0.5, y, -0.5,  0, 0,  w, h,
             0.5, y,  0.5,  1, 1,  w, h,
            -0.5, y,  0.5,  0, 1,  w, h
        ]);
    } else { // YZ
        const dimX = (nx && dx) ? (nx * dx) : 1.0;
        const x = (offset - xmin) / dimX - 0.5;
        return new Float32Array([
            x, -0.5, -0.5,  0, 0,  w, h,
            x,  0.5, -0.5,  1, 0,  w, h,
            x,  0.5,  0.5,  1, 1,  w, h,
            x, -0.5, -0.5,  0, 0,  w, h,
            x,  0.5,  0.5,  1, 1,  w, h,
            x, -0.5,  0.5,  0, 1,  w, h
        ]);
    }
}

function handleFrame(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x43494c53) return; // "SLIC"

    const time = view.getFloat32(4, true);
    const numSlices = view.getUint32(8, true);

    // Compute combined scaling range across ALL slices to prevent scale flickering
    if (autoScale) {
        let globalMin = Infinity;
        let globalMax = -Infinity;
        let offset = 12;
        for (let i = 0; i < numSlices; i++) {
            const w = view.getUint32(offset + 8, true);
            const h = view.getUint32(offset + 12, true);
            const dataStart = offset + 16;
            const floatData = new Float32Array(buffer, dataStart, w * h);
            for (let j = 0; j < floatData.length; j++) {
                const v = floatData[j];
                if (isFinite(v)) {
                    if (v < globalMin) globalMin = v;
                    if (v > globalMax) globalMax = v;
                }
            }
            offset = dataStart + (w * h * 4);
        }
        if (globalMin < globalMax) {
            minY = globalMin;
            maxY = globalMax;
        }
    }

    if (is2DFallback) {
        activeSlices2D = [];
        let offset = 12;
        for (let i = 0; i < numSlices; i++) {
            const axis = view.getUint32(offset, true);
            const zOff = view.getFloat32(offset + 4, true);
            const w = view.getUint32(offset + 8, true);
            const h = view.getUint32(offset + 12, true);
            const dataStart = offset + 16;
            const floatData = new Float32Array(buffer.slice(dataStart, dataStart + w * h * 4));
            activeSlices2D.push({ axis, offset: zOff, w, h, data: floatData });
            offset = dataStart + (w * h * 4);
        }
        return;
    }

// Helper to copy and pad Float32Array rows to satisfy WebGPU bytesPerRow alignment (multiple of 256 bytes)
function padFloatData(src: Float32Array, w: number, h: number): { data: Float32Array, bytesPerRow: number } {
    const bytesPerPixel = 4; // float32
    const srcRowBytes = w * bytesPerPixel;
    const destRowBytes = Math.ceil(srcRowBytes / 256) * 256;
    const destW = destRowBytes / bytesPerPixel;

    if (destRowBytes === srcRowBytes) {
        return { data: src, bytesPerRow: destRowBytes };
    }

    const padded = new Float32Array(destW * h);
    for (let y = 0; y < h; y++) {
        const srcOffset = y * w;
        const destOffset = y * destW;
        padded.set(src.subarray(srcOffset, srcOffset + w), destOffset);
    }
    return { data: padded, bytesPerRow: destRowBytes };
}

    // We clear slices on size changes or if configuration changes
    let sizeChanged = false;
    // We will clear the maps if sizeChanged is detected via setConfig or when numSlices doesn't match active count
    const activeCount = Object.keys(activeSlicesWebGPU).length;
    if (activeCount !== numSlices) {
        Object.values(activeSlicesWebGPU).forEach(s => {
            s.gpuTexture.destroy();
            s.vertexBuffer.destroy();
        });
        activeSlicesWebGPU = {};
    }

    if (isWebGPU && gpuDevice) {
        let offset = 12;
        for (let i = 0; i < numSlices; i++) {
            const axis = view.getUint32(offset, true);
            const zOff = view.getFloat32(offset + 4, true);
            const w = view.getUint32(offset + 8, true);
            const h = view.getUint32(offset + 12, true);
            const dataStart = offset + 16;
            const floatData = new Float32Array(buffer, dataStart, w * h);

            let slice: SliceDataWebGPU;
            const geo = getSliceGeometry(axis, zOff, w, h);

            if (activeSlicesWebGPU[axis]) {
                slice = activeSlicesWebGPU[axis];
                if (slice.w !== w || slice.h !== h) {
                    slice.gpuTexture.destroy();
                    slice.gpuTexture = gpuDevice.createTexture({
                        size: [w, h, 1],
                        format: 'r32float',
                        // GPUTextureUsage: TEXTURE_BINDING = 4, COPY_DST = 2
                        usage: 4 | 2
                    });
                    slice.gpuTextureView = slice.gpuTexture.createView();
                    slice.w = w; slice.h = h;
                    slice.bindGroup = gpuDevice.createBindGroup({
                        layout: bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: gpuUniformBuffer! } },
                            { binding: 1, resource: slice.gpuTextureView },
                            { binding: 2, resource: gpuSampler! }
                        ]
                    });
                }
                // Pad the Float32Array to meet WebGPU 256-byte row alignment requirement
                const paddedResult = padFloatData(floatData, w, h);
                // Write Texture
                gpuDevice.queue.writeTexture(
                    { texture: slice.gpuTexture },
                    paddedResult.data,
                    { bytesPerRow: paddedResult.bytesPerRow },
                    [w, h, 1]
                );
                // Write Geometry
                gpuDevice.queue.writeBuffer(slice.vertexBuffer, 0, geo);
                slice.axis = axis; slice.offset = zOff;
            } else {
                const tex = gpuDevice.createTexture({
                    size: [w, h, 1],
                    format: 'r32float',
                    // GPUTextureUsage: TEXTURE_BINDING = 4, COPY_DST = 2
                    usage: 4 | 2
                });
                const paddedResult = padFloatData(floatData, w, h);
                gpuDevice.queue.writeTexture(
                    { texture: tex },
                    paddedResult.data,
                    { bytesPerRow: paddedResult.bytesPerRow },
                    [w, h, 1]
                );
                const texView = tex.createView();

                const vb = gpuDevice.createBuffer({
                    size: geo.byteLength,
                    // GPUBufferUsage: VERTEX = 32, COPY_DST = 8
                    usage: 32 | 8
                });
                gpuDevice.queue.writeBuffer(vb, 0, geo);

                const bindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBuffer! } },
                        { binding: 1, resource: texView },
                        { binding: 2, resource: gpuSampler! }
                    ]
                });

                slice = { axis, offset: zOff, w, h, gpuTexture: tex, gpuTextureView: texView, vertexBuffer: vb, bindGroup };
                activeSlicesWebGPU[axis] = slice;
            }
            offset = dataStart + (w * h * 4);
        }
        return;
    }

    // WebGL frame processing
    if (!gl) return;

    if (Object.keys(activeSlicesWebGL).length !== numSlices) {
        Object.values(activeSlicesWebGL).forEach(s => {
            gl!.deleteTexture(s.texture);
            gl!.deleteBuffer(s.buffer);
        });
        activeSlicesWebGL = {};
    }

    const internalFormat = isWebGL2 ? gl.R32F : gl.LUMINANCE;
    const format = isWebGL2 ? gl.RED : gl.LUMINANCE;

    let offset = 12;
    for (let i = 0; i < numSlices; i++) {
        const axis = view.getUint32(offset, true);
        const zOff = view.getFloat32(offset + 4, true);
        const w = view.getUint32(offset + 8, true);
        const h = view.getUint32(offset + 12, true);
        const dataStart = offset + 16;
        const floatData = new Float32Array(buffer, dataStart, w * h);

        let slice: SliceDataWebGL;
        if (activeSlicesWebGL[axis]) {
            slice = activeSlicesWebGL[axis];
            gl.bindTexture(gl.TEXTURE_2D, slice.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.FLOAT, floatData);

            gl.bindBuffer(gl.ARRAY_BUFFER, slice.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h), gl.STATIC_DRAW);
        } else {
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            const filter = gl.NEAREST;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.FLOAT, floatData);

            const buf = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h), gl.STATIC_DRAW);

            slice = { axis, offset: zOff, w, h, texture: tex, buffer: buf };
            activeSlicesWebGL[axis] = slice;
        }
        offset = dataStart + (w * h * 4);
    }
}

// 2D Projection helper matrix math
function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let i = 0; i < 4; i++) {
                sum += a[row + i * 4] * b[i + col * 4];
            }
            out[row + col * 4] = sum;
        }
    }
    return out;
}

function projectPoint(v: number[], mvp: Float32Array, width: number, height: number) {
    const x = v[0], y = v[1], z = v[2];
    const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] || 1;
    const px = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
    const py = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
    return {
        x: (px * 0.5 + 0.5) * width,
        y: (1.0 - (py * 0.5 + 0.5)) * height
    };
}

function render2D() {
    if (!ctx2D) return;
    const canvas = ctx2D.canvas;
    const width = canvas.width;
    const height = canvas.height;

    ctx2D.fillStyle = "#050505";
    ctx2D.fillRect(0, 0, width, height);

    ctx2D.fillStyle = "#555566";
    ctx2D.font = "10px monospace";
    ctx2D.fillText("2D Viewport Fallback", 10, height - 10);

    const vertices = [
        [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]
    ];

    const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    const mvp = multiplyMatrices(projectionMatrix, multiplyMatrices(viewMatrix, modelMatrix));

    const projected: {x: number, y: number}[] = [];
    for (const v of vertices) {
        projected.push(projectPoint(v, mvp, width, height));
    }

    if (showGrid) {
        ctx2D.strokeStyle = "rgba(75, 75, 100, 0.6)";
        ctx2D.lineWidth = 1;
        ctx2D.beginPath();
        for (const edge of edges) {
            const p1 = projected[edge[0]];
            const p2 = projected[edge[1]];
            ctx2D.moveTo(p1.x, p1.y);
            ctx2D.lineTo(p2.x, p2.y);
        }
        ctx2D.stroke();
    }

    if (activeSlices2D.length > 0) {
        const slice = activeSlices2D[0];
        const tempCanvas = new OffscreenCanvas(slice.w, slice.h);
        const tempCtx = tempCanvas.getContext("2d")!;
        const imgData = tempCtx.createImageData(slice.w, slice.h);
        
        for (let i = 0; i < slice.w * slice.h; i++) {
            const val = slice.data[i];
            let t = 0.0;
            if (useLogScale) {
                const logMin = Math.log(Math.max(minY, 1e-5));
                const logMax = Math.log(Math.max(maxY, 1e-5));
                const logVal = Math.log(Math.max(val, 1e-5));
                t = Math.max(0.0, Math.min(1.0, (logVal - logMin) / (logMax - logMin)));
            } else {
                t = Math.max(0.0, Math.min(1.0, (val - minY) / (maxY - minY)));
            }
            let r = 0, g = 0, b = 0;
            if (colormap === 1) { // Viridis
                r = Math.round((1.0 - t) * 255);
                g = Math.round(t * 255);
                b = Math.round((0.5 + 0.5 * t) * 255);
            } else { // Plasma
                r = Math.round(t * 1.5 * 255);
                g = Math.round(t * t * 255);
                b = Math.round((1.0 - t) * 255);
            }
            imgData.data[i * 4 + 0] = r;
            imgData.data[i * 4 + 1] = g;
            imgData.data[i * 4 + 2] = b;
            imgData.data[i * 4 + 3] = 180;
        }
        tempCtx.putImageData(imgData, 0, 0);

        const size = Math.min(width, height) * 0.65;
        ctx2D.drawImage(tempCanvas, (width - size)/2, (height - size)/2, size, size);
    }
}

function render() {
    if (is2DFallback) {
        render2D();
        return;
    }

    if (isWebGPU && gpuDevice && gpuContext) {
        // Build uniforms data float buffer
        const uniformData = new Float32Array(56); // 16*3 floats (matrices) + 8 floats (with padding)
        uniformData.set(projectionMatrix, 0);
        uniformData.set(viewMatrix, 16);
        uniformData.set(modelMatrix, 32);
        uniformData[48] = 0.7; // Alpha
        uniformData[49] = colormap; // Colormap
        uniformData[50] = minY;
        uniformData[51] = maxY;
        // Float views for WebGPU uniform alignment padding
        const intView = new Int32Array(uniformData.buffer);
        intView[52] = useLogScale ? 1 : 0;
        intView[53] = 0; // Wireframe boolean placeholder
        intView[54] = showCellEdges ? 1 : 0;
        
        gpuDevice.queue.writeBuffer(gpuUniformBuffer!, 0, uniformData.buffer);

        // Build uniforms data for Wireframe (isWireframe = 1.0)
        const uniformDataWF = new Float32Array(uniformData);
        const intViewWF = new Int32Array(uniformDataWF.buffer);
        intViewWF[53] = 1; // set isWireframe to 1
        gpuDevice.queue.writeBuffer(gpuUniformBufferWF!, 0, uniformDataWF.buffer);

        const commandEncoder = gpuDevice.createCommandEncoder();
        const textureView = gpuContext.getCurrentTexture().createView();
        
        const w = canvasWidth();
        const h = canvasHeight();
        if (!cachedMsaaColorTexture || cachedWidth !== w || cachedHeight !== h) {
            if (cachedMsaaColorTexture) cachedMsaaColorTexture.destroy();
            if (cachedDepthTexture) cachedDepthTexture.destroy();

            cachedWidth = w;
            cachedHeight = h;

            cachedMsaaColorTexture = gpuDevice.createTexture({
                size: [w, h, 1],
                format: nav.gpu.getPreferredCanvasFormat(),
                usage: 16, // RENDER_ATTACHMENT
                sampleCount: 4
            });
            cachedMsaaColorView = cachedMsaaColorTexture.createView();

            cachedDepthTexture = gpuDevice.createTexture({
                size: [w, h, 1],
                format: 'depth24plus',
                usage: 16,
                sampleCount: 4
            });
            cachedDepthView = cachedDepthTexture.createView();
        }

        const msaaColorView = cachedMsaaColorView;
        const depthView = cachedDepthView;

        const renderPassDescriptor: any = {
            colorAttachments: [{
                view: msaaColorView,
                resolveTarget: textureView,
                clearValue: { r: 0.02, g: 0.02, b: 0.02, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store'
            }],
            depthStencilAttachment: {
                view: depthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store'
            }
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // 1. Draw bounding box if enabled
        if (showGrid && gpuBBoxBuffer && gpuLinePipeline) {
            passEncoder.setPipeline(gpuLinePipeline);

            const bboxBindGroup = gpuDevice.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpuUniformBufferWF! } },
                    // Use the dummy texture bind for the wireframe pass to avoid format validation errors
                    { binding: 1, resource: Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! }
                ]
            });

            passEncoder.setBindGroup(0, bboxBindGroup);
            passEncoder.setVertexBuffer(0, gpuBBoxBuffer);
            passEncoder.draw(24);
        }

        // Draw Axes Indicator
        if (gpuAxesBuffer && gpuLinePipeline && gpuAxesUniformBuffers.length === 3) {
            passEncoder.setPipeline(gpuLinePipeline);
            for (let a = 0; a < 3; a++) {
                const axesData = new Float32Array(uniformData);
                const axesInt = new Int32Array(axesData.buffer);
                axesInt[53] = 2 + a; // isWireframe = 2, 3, 4
                gpuDevice.queue.writeBuffer(gpuAxesUniformBuffers[a], 0, axesData.buffer);

                const axesBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuAxesUniformBuffers[a] } },
                        { binding: 1, resource: Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! }
                    ]
                });

                passEncoder.setBindGroup(0, axesBindGroup);
                passEncoder.setVertexBuffer(0, gpuAxesBuffer);
                passEncoder.draw(2, 1, a * 2, 0);
            }
        }

        // 2. Draw Slices
        const slicesArray = Object.values(activeSlicesWebGPU);
        if (slicesArray.length > 0) {
            passEncoder.setPipeline(gpuPipeline!);
            slicesArray.forEach(slice => {
                passEncoder.setBindGroup(0, slice.bindGroup);
                passEncoder.setVertexBuffer(0, slice.vertexBuffer);
                passEncoder.draw(6);
            });
        }

        passEncoder.end();
        gpuDevice.queue.submit([commandEncoder.finish()]);
        return;
    }

    // WebGL fallback rendering
    if (!gl || !program) return;
    gl.clearColor(0.02, 0.02, 0.02, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(program);
    const uProj = gl.getUniformLocation(program, "uProjection");
    const uView = gl.getUniformLocation(program, "uView");
    const uModel = gl.getUniformLocation(program, "uModel");
    const uAlpha = gl.getUniformLocation(program, "uAlpha");
    const uColormap = gl.getUniformLocation(program, "uColormap");
    const uMin = gl.getUniformLocation(program, "uMin");
    const uMax = gl.getUniformLocation(program, "uMax");
    const uUseLog = gl.getUniformLocation(program, "uUseLogScale");
    const uIsWF = gl.getUniformLocation(program, "uIsWireframe");

    gl.uniformMatrix4fv(uProj, false, projectionMatrix);
    gl.uniform1i(uColormap, colormap);
    gl.uniform1f(uMin, minY);
    gl.uniform1f(uMax, maxY);
    gl.uniform1i(uUseLog, useLogScale ? 1 : 0);
    gl.uniformMatrix4fv(uView, false, viewMatrix);
    gl.uniformMatrix4fv(uModel, false, modelMatrix);
    gl.uniform1f(uAlpha, 0.7);

    // Draw BBox
    if (showGrid && bboxBuffer) {
        gl.uniform1i(uIsWF, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.drawArrays(gl.LINES, 0, 24);
    }

    // Draw Axes Indicator
    if (axesBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, axesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);

        for (let a = 0; a < 3; a++) {
            gl.uniform1i(uIsWF, 2 + a); // 2=X Red, 3=Y Green, 4=Z Blue
            gl.drawArrays(gl.LINES, a * 2, 2);
        }
    }

    gl.uniform1i(uIsWF, 0);
    const uShowEdges = gl.getUniformLocation(program, "uShowCellEdges");
    if (uShowEdges !== null) {
        gl.uniform1i(uShowEdges, showCellEdges ? 1 : 0);
    }

    Object.values(activeSlicesWebGL).forEach(slice => {
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, slice.texture);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, slice.buffer);

        // Stride is 28 (7 floats * 4 bytes)
        gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 28, 0);
        gl!.enableVertexAttribArray(0);
        gl!.vertexAttribPointer(1, 2, gl!.FLOAT, false, 28, 12);
        gl!.enableVertexAttribArray(1);
        gl!.vertexAttribPointer(2, 2, gl!.FLOAT, false, 28, 20);
        gl!.enableVertexAttribArray(2);

        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
    });
}

function canvasWidth(): number {
    if (gpuContext) return (gpuContext.canvas as OffscreenCanvas).width;
    if (gl) return gl.canvas.width;
    if (ctx2D) return ctx2D.canvas.width;
    return 300;
}

function canvasHeight(): number {
    if (gpuContext) return (gpuContext.canvas as OffscreenCanvas).height;
    if (gl) return gl.canvas.height;
    if (ctx2D) return ctx2D.canvas.height;
    return 150;
}

self.onmessage = async (e) => {
    try {
        const { type, data } = e.data;
        if (type === "init") {
            const canvas = data.canvas as OffscreenCanvas;
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            canvas.width = w;
            canvas.height = h;
            await initContext(canvas);
            updateMatrices(w, h);
            render();
        } else if (type === "resize") {
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            if (is2DFallback && ctx2D) {
                ctx2D.canvas.width = w;
                ctx2D.canvas.height = h;
            } else if (gpuContext && gpuDevice) {
                const canvas = gpuContext.canvas as OffscreenCanvas;
                canvas.width = w;
                canvas.height = h;
                const prefFormat = nav && nav.gpu ? nav.gpu.getPreferredCanvasFormat() : 'bgra8unorm';
                gpuContext.configure({
                    device: gpuDevice,
                    format: prefFormat,
                    alphaMode: 'opaque'
                });
            } else if (gl) {
                gl.canvas.width = w;
                gl.canvas.height = h;
                gl.viewport(0, 0, w, h);
            }
            updateMatrices(w, h);
            render();
        } else if (type === "input") {
            if (data.dy !== undefined) {
                // Scroll zooms distance
                distance = Math.max(0.1, distance + data.dy * 0.01 * distance * 0.1);
            }
            if (data.drx !== undefined) {
                pitch += data.drx * 0.01;
                // Clamp pitch to avoid gimbal lock at exact poles
                pitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, pitch));
            }
            if (data.dry !== undefined) {
                yaw += data.dry * 0.01;
            }
            if (data.dpx !== undefined || data.dpy !== undefined) {
                // Pan in camera plane
                let z = [
                    Math.cos(pitch) * Math.sin(yaw),
                    Math.cos(pitch) * Math.cos(yaw),
                    Math.sin(pitch)
                ];
                let up = [0, 0, 1];
                let x = normalize(cross(up, z));
                let y = cross(z, x);

                let dpx = data.dpx || 0;
                let dpy = data.dpy || 0;
                let panSpeed = distance * 0.002;
                
                targetX += (x[0] * -dpx + y[0] * dpy) * panSpeed;
                targetY += (x[1] * -dpx + y[1] * dpy) * panSpeed;
                targetZ += (x[2] * -dpx + y[2] * dpy) * panSpeed;
            }
            
            const w = canvasWidth();
            const h = canvasHeight();
            updateMatrices(w, h);
            render();
        } else if (type === "setView") {
            if (data.pitch !== undefined) pitch = data.pitch;
            if (data.yaw !== undefined) yaw = data.yaw;
            if (data.distance !== undefined) distance = data.distance;
            if (data.targetX !== undefined) targetX = data.targetX;
            if (data.targetY !== undefined) targetY = data.targetY;
            if (data.targetZ !== undefined) targetZ = data.targetZ;
            
            updateMatrices(canvasWidth(), canvasHeight());
            render();
        } else if (type === "frame") {
            handleFrame(data.buffer);
            render();
        } else if (type === "setConfig") {
            if (data.colormap !== undefined) {
                if (data.colormap === 'viridis') colormap = 1;
                else colormap = 0;
            }
            if (data.min !== undefined) minY = data.min;
            if (data.max !== undefined) maxY = data.max;
            if (data.autoScale !== undefined) autoScale = data.autoScale;
            if (data.useLogScale !== undefined) useLogScale = data.useLogScale;
            if (data.showGrid !== undefined) showGrid = data.showGrid;
            if (data.showCellEdges !== undefined) showCellEdges = data.showCellEdges;
            if (data.xmin !== undefined) xmin = data.xmin;
            if (data.ymin !== undefined) ymin = data.ymin;
            if (data.zmin !== undefined) zmin = data.zmin;
            if (data.dx !== undefined) dx = data.dx;
            if (data.nx !== undefined) nx = data.nx;
            if (data.ny !== undefined) ny = data.ny;
            if (data.nz !== undefined) nz = data.nz;
            if (data.usePerspective !== undefined) usePerspective = data.usePerspective;
            if (data.fov !== undefined) fov = data.fov;

            let sizeChanged = false;
            if (data.xmin !== undefined && data.xmin !== xmin) { xmin = data.xmin; }
            if (data.ymin !== undefined && data.ymin !== ymin) { ymin = data.ymin; }
            if (data.zmin !== undefined && data.zmin !== zmin) { zmin = data.zmin; }
            if (data.dx !== undefined && data.dx !== dx) { dx = data.dx; sizeChanged = true; }
            if (data.nx !== undefined && data.nx !== nx) { nx = data.nx; sizeChanged = true; }
            if (data.ny !== undefined && data.ny !== ny) { ny = data.ny; sizeChanged = true; }
            if (data.nz !== undefined && data.nz !== nz) { nz = data.nz; sizeChanged = true; }

            if (sizeChanged) {
                updateMatrices(canvasWidth(), canvasHeight());
            }
            render();
        }
    } catch (err: any) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
