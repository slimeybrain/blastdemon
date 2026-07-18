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
out vec3 vLocalPos;
out vec4 vViewPos;
void main() {
    vLocalPos = position;
    vViewPos = uView * uModel * vec4(position, 1.0);
    gl_Position = uProjection * vViewPos;
    vTexCoord = texCoord;
    vSliceSize = sliceSize;
}
`;

const FS_SOURCE_2 = `#version 300 es
precision highp float;
in vec2 vTexCoord;
in vec2 vSliceSize;
in vec3 vLocalPos;
in vec4 vViewPos;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uUseLogScale;
uniform int uIsWireframe;
uniform bool uShowCellEdges;
uniform bool uInterpolate;
uniform bool uEnableLighting;
uniform bool uEnableAO;
uniform float uAmbientLevel;
uniform float uSpecularLevel;
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
            return;
        }
        
        // Axes Indicator / STL Geometry
        vec4 baseColor = vec4(0.0);
        if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
        else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
        else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);
        else if (uIsWireframe == 5) baseColor = vec4(0.35, 0.5, 0.75, uAlpha);
        else if (uIsWireframe == 6) baseColor = vec4(0.0, 0.8, 1.0, 0.8);

        if (uEnableLighting) {
            vec3 viewPos3 = vViewPos.xyz;
            vec3 normal = normalize(cross(dFdx(viewPos3), dFdy(viewPos3)));
            vec3 lightDir = vec3(0.0, 0.0, 1.0);
            float diff = max(dot(normal, lightDir), 0.0);
            
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
            
            float ao = 1.0;
            if (uEnableAO) {
                ao = pow(max(normal.z, 0.0), 0.5);
            }
            
            vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
            outColor = vec4(lit * ao, baseColor.a);
        } else {
            outColor = baseColor;
        }
        return;
    }
    vec2 uv = vTexCoord;
    if (!uInterpolate) {
        vec2 texel = floor(vTexCoord * vSliceSize);
        uv = (texel + vec2(0.5)) / vSliceSize;
    }
    float raw = texture(uTexture, uv).r;
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
    
    if (uEnableLighting) {
        vec3 viewPos3 = vViewPos.xyz;
        vec3 normal = normalize(cross(dFdx(viewPos3), dFdy(viewPos3)));
        vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
        float diff = max(dot(normal, lightDir), 0.0) * 0.7 + max(dot(-normal, lightDir), 0.0) * 0.3;
        
        vec3 reflectDir = reflect(-lightDir, normal);
        vec3 viewDir = normalize(-viewPos3);
        float spec = pow(max(dot(reflectDir, viewDir), 0.0), 32.0);
        
        float ao = 1.0;
        
        vec3 lit = finalColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
        finalColor = vec4(lit * ao, finalColor.a);
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
varying vec3 vLocalPos;
varying vec4 vViewPos;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
void main() {
    vLocalPos = position;
    vViewPos = uView * uModel * vec4(position, 1.0);
    gl_Position = uProjection * vViewPos;
    vTexCoord = texCoord;
    vSliceSize = sliceSize;
}
`;

const FS_SOURCE_1 = `
precision highp float;
varying vec2 vTexCoord;
varying vec2 vSliceSize;
varying vec3 vLocalPos;
varying vec4 vViewPos;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uUseLogScale;
uniform int uIsWireframe;
uniform bool uShowCellEdges;
uniform bool uInterpolate;
uniform bool uEnableLighting;
uniform bool uEnableAO;
uniform float uAmbientLevel;
uniform float uSpecularLevel;

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
            return;
        }
        
        // Axes Indicator / STL Geometry
        vec4 baseColor = vec4(0.0);
        if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
        else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
        else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);
        else if (uIsWireframe == 5) baseColor = vec4(0.35, 0.5, 0.75, uAlpha);
        else if (uIsWireframe == 6) baseColor = vec4(0.0, 0.8, 1.0, 0.8);

        if (uEnableLighting) {
            vec3 viewPos3 = vViewPos.xyz;
            // Analytical normals fallback
            vec3 normal = vec3(0.0, 0.0, 1.0);
            #ifdef GL_OES_standard_derivatives
            normal = normalize(cross(dFdx(viewPos3), dFdy(viewPos3)));
            #endif
            vec3 lightDir = vec3(0.0, 0.0, 1.0);
            float diff = max(dot(normal, lightDir), 0.0);
            
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
            
            float ao = 1.0;
            if (uEnableAO) {
                ao = pow(max(normal.z, 0.0), 0.5);
            }
            
            vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
            gl_FragColor = vec4(lit * ao, baseColor.a);
        } else {
            gl_FragColor = baseColor;
        }
        return;
    }
    vec2 uv = vTexCoord;
    if (!uInterpolate) {
        vec2 texel = floor(vTexCoord * vSliceSize);
        uv = (texel + vec2(0.5)) / vSliceSize;
    }
    float raw = texture2D(uTexture, uv).r;
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
    
    if (uEnableLighting) {
        vec3 viewPos3 = vViewPos.xyz;
        vec3 normal = vec3(0.0, 0.0, 1.0);
        #ifdef GL_OES_standard_derivatives
        normal = normalize(cross(dFdx(viewPos3), dFdy(viewPos3)));
        #endif
        vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
        float diff = max(dot(normal, lightDir), 0.0) * 0.7 + max(dot(-normal, lightDir), 0.0) * 0.3;
        
        vec3 reflectDir = reflect(-lightDir, normal);
        vec3 viewDir = normalize(-viewPos3);
        float spec = pow(max(dot(reflectDir, viewDir), 0.0), 32.0);
        
        float ao = 1.0;
        
        vec3 lit = finalColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
        finalColor = vec4(lit * ao, finalColor.a);
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
    @location(2) vLocalPos: vec3<f32>,
    @location(3) vViewPos: vec4<f32>,
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
    interpolate: f32,
    enableLighting: f32,
    enableAO: f32,
    ambientLevel: f32,
    specularLevel: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) size: vec2<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.vViewPos = uniforms.view * uniforms.model * vec4<f32>(pos, 1.0);
    out.position = uniforms.projection * out.vViewPos;
    out.texCoord = uv;
    out.sliceSize = size;
    out.vLocalPos = pos;
    return out;
}

fn colormap_plasma(t: f32) -> vec3<f32> {
    return vec3<f32>(t * 1.5, t * t, 1.0 - t);
}

fn colormap_viridis(t: f32) -> vec3<f32> {
    return vec3<f32>(1.0 - t, t, 0.5 + 0.5 * t);
}

@fragment
fn fs_main(@location(0) texCoord: vec2<f32>, @location(1) sliceSize: vec2<f32>, @location(2) vLocalPos: vec3<f32>, @location(3) vViewPos: vec4<f32>) -> @location(0) vec4<f32> {
    if (uniforms.isWireframe > 0.5) {
        if (uniforms.isWireframe < 1.5) {
            return vec4<f32>(0.3, 0.3, 0.4, 0.8); // Bounding box: grey
        }
        
        // Axes Indicator / STL Geometry
        var baseColor = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        if (uniforms.isWireframe < 2.5) {
            baseColor = vec4<f32>(1.0, 0.1, 0.1, 1.0);
        } else if (uniforms.isWireframe < 3.5) {
            baseColor = vec4<f32>(0.1, 1.0, 0.1, 1.0);
        } else if (uniforms.isWireframe < 4.5) {
            baseColor = vec4<f32>(0.2, 0.5, 1.0, 1.0);
        } else if (uniforms.isWireframe < 5.5) {
            baseColor = vec4<f32>(0.35, 0.5, 0.75, uniforms.alpha);
        } else if (uniforms.isWireframe < 6.5) {
            baseColor = vec4<f32>(0.0, 0.8, 1.0, 0.8);
        }

        if (uniforms.enableLighting > 0.5) {
            let viewPos3 = vViewPos.xyz;
            let normal = normalize(cross(dpdx(viewPos3), dpdy(viewPos3)));
            let lightDir = vec3<f32>(0.0, 0.0, 1.0);
            let diff = max(dot(normal, lightDir), 0.0);
            
            let reflectDir = reflect(-lightDir, normal);
            let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
            
            var ao = 1.0;
            if (uniforms.enableAO > 0.5) {
                ao = pow(max(normal.z, 0.0), 0.5);
            }
            
            let lit = baseColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
            return vec4<f32>(lit * ao, baseColor.a);
        } else {
            return baseColor;
        }
    }
    var uv = texCoord;
    if (uniforms.interpolate < 0.5) {
        let texel = floor(texCoord * sliceSize);
        uv = (texel + vec2<f32>(0.5, 0.5)) / sliceSize;
    }
    let raw = textureSample(uTexture, uSampler, uv).r;
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

    if (uniforms.enableLighting > 0.5) {
        let viewPos3 = vViewPos.xyz;
        let normal = normalize(cross(dpdx(viewPos3), dpdy(viewPos3)));
        
        let lightDir = normalize(vec3<f32>(0.5, 0.8, 1.0));
        let diff = max(dot(normal, lightDir), 0.0) * 0.7 + max(dot(-normal, lightDir), 0.0) * 0.3;
        
        let reflectDir = reflect(-lightDir, normal);
        let viewDir = normalize(-viewPos3);
        let spec = pow(max(dot(reflectDir, viewDir), 0.0), 32.0);
        
        var ao = 1.0;
        
        let lit = finalColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0, 1.0, 1.0) * (uniforms.specularLevel * spec);
        finalColor = vec4<f32>(lit * ao, finalColor.a);
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
let gpuSlicePipeline: any = null;
let gpuLinePipeline: any = null;
let gpuSTLLinePipeline: any = null;
let gpuSampler: any = null;
let gpuUniformBuffer: any = null;
let gpuUniformBufferWF: any = null;
let gpuSTLUniformSolid: any = null;
let gpuSTLUniformWireframe: any = null;
let gpuAxesUniformBuffers: any[] = [];
let gpuSliceUniformBuffers: { [axis: number]: any } = {};
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
let usePerspective = true;
let fov = 45.0;
let cameraEyeX = 0.0;
let cameraEyeY = 0.0;
let cameraEyeZ = 0.0;

// Contour Visualization Configurations
let colormap = 0; // 0=plasma, 1=viridis
let minY = 101325.0;
let maxY = 1000000.0;
let autoScale = true;
let showGrid = true;
let useLogScale = false;
let showCellEdges = false;
let interpolate = false;

// STL Geometry Buffers & Settings
let rawSTLVertices: Float32Array | null = null;
let transformedSTLVertices: Float32Array | null = null;
let gpuSTLBuffer: any = null;
let gpuSTLIndexBuffer: any = null;
let stlBuffer: WebGLBuffer | null = null;
let stlIndexBuffer: WebGLBuffer | null = null;
let stlIndexCount = 0;

let showSTL = true;
let stlWireframe = false;
let stlSolids = true;
let stlOpacity = 0.5;

interface CachedSlice {
    axis: number;
    offset: number;
    w: number;
    h: number;
    data: Float32Array;
    minY?: number;
    maxY?: number;
    colormap?: string;
    useLogScale?: boolean;
    interpolate?: boolean;
}
let cachedSlices: CachedSlice[] = [];

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

// Lighting / Shadow / Opacity Configurations
let lightingEnabled = true;
let aoEnabled = true;
let specularIntensity = 0.4;
let ambientLevel = 0.3;
let sliceOpacities = [1.0, 1.0, 1.0]; // xy, xz, yz

const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0],
    solid: [0.0, 1.0],
    overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0]
};

let slicesConfig: any[] = [];
let quantityRanges: Record<string, [number, number]> = {};
let focusedSliceIndex = 0;

function buildArrow(axis: number, ox: number, oy: number, oz: number): number[] {
    let D = [0, 0, 0];
    let U = [0, 0, 0];
    let V = [0, 0, 0];
    
    if (axis === 0) { // X
        D = [1, 0, 0]; U = [0, 1, 0]; V = [0, 0, 1];
    } else if (axis === 1) { // Y
        D = [0, 1, 0]; U = [0, 0, 1]; V = [1, 0, 0];
    } else { // Z
        D = [0, 0, 1]; U = [1, 0, 0]; V = [0, 1, 0];
    }

    const L_shaft = 0.22;
    const L_total = 0.35;
    const W_shaft = 0.012;
    const W_head = 0.028;
    const N = 12;

    const addVert = (p: number[], list: number[]) => {
        list.push(p[0], p[1], p[2], 0, 0, 0, 0); // 7 floats per vertex
    };

    const getPos = (dVal: number, uVal: number, vVal: number) => {
        return [
            ox + dVal * D[0] + uVal * U[0] + vVal * V[0],
            oy + dVal * D[1] + uVal * U[1] + vVal * V[1],
            oz + dVal * D[2] + uVal * U[2] + vVal * V[2]
        ];
    };

    const baseCircle: number[][] = [];
    const endCircle: number[][] = [];
    const headBaseCircle: number[][] = [];

    for (let i = 0; i <= N; i++) {
        const theta = (i % N) * 2 * Math.PI / N;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        
        baseCircle.push(getPos(0, W_shaft/2 * cosT, W_shaft/2 * sinT));
        endCircle.push(getPos(L_shaft, W_shaft/2 * cosT, W_shaft/2 * sinT));
        headBaseCircle.push(getPos(L_shaft, W_head/2 * cosT, W_head/2 * sinT));
    }

    const vertices: number[] = [];

    // Cylinder Sides: N * 2 triangles
    for (let i = 0; i < N; i++) {
        const p1 = baseCircle[i];
        const p2 = baseCircle[i+1];
        const p3 = endCircle[i];
        const p4 = endCircle[i+1];

        // Triangle 1: p1, p3, p2
        addVert(p1, vertices); addVert(p3, vertices); addVert(p2, vertices);
        // Triangle 2: p2, p3, p4
        addVert(p2, vertices); addVert(p3, vertices); addVert(p4, vertices);
    }

    // Cylinder Base Cap: N triangles
    const centerBase = getPos(0, 0, 0);
    for (let i = 0; i < N; i++) {
        addVert(centerBase, vertices);
        addVert(baseCircle[i+1], vertices);
        addVert(baseCircle[i], vertices);
    }

    // Cone Head Sides: N triangles
    const tip = getPos(L_total, 0, 0);
    for (let i = 0; i < N; i++) {
        addVert(headBaseCircle[i], vertices);
        addVert(headBaseCircle[i+1], vertices);
        addVert(tip, vertices);
    }

    // Cone Head Base Cap: N triangles
    const centerHeadBase = getPos(L_shaft, 0, 0);
    for (let i = 0; i < N; i++) {
        addVert(centerHeadBase, vertices);
        addVert(headBaseCircle[i+1], vertices);
        addVert(headBaseCircle[i], vertices);
    }

    return vertices;
}

function updateAxesGeometry() {
    const ox = -0.5;
    const oy = -0.5;
    const oz = -0.5;

    const axesDataArray: number[] = [];
    for (let a = 0; a < 3; a++) {
        axesDataArray.push(...buildArrow(a, ox, oy, oz));
    }
    const axesData = new Float32Array(axesDataArray);

    if (isWebGPU && gpuDevice && gpuAxesBuffer) {
        gpuDevice.queue.writeBuffer(gpuAxesBuffer, 0, axesData.buffer);
    } else if (gl && axesBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, axesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, axesData, gl.DYNAMIC_DRAW);
    }
}

function updateSTLGeometry() {
    if (!rawSTLVertices || rawSTLVertices.length === 0) {
        transformedSTLVertices = null;
        if (gpuSTLBuffer) {
            gpuSTLBuffer.destroy();
            gpuSTLBuffer = null;
        }
        if (gpuSTLIndexBuffer) {
            gpuSTLIndexBuffer.destroy();
            gpuSTLIndexBuffer = null;
        }
        if (gl) {
            if (stlBuffer) {
                gl.deleteBuffer(stlBuffer);
                stlBuffer = null;
            }
            if (stlIndexBuffer) {
                gl.deleteBuffer(stlIndexBuffer);
                stlIndexBuffer = null;
            }
        }
        stlIndexCount = 0;
        return;
    }

    const sizeX = nx * dx || 1.0;
    const sizeY = ny * dx || 1.0;
    const sizeZ = nz * dx || 1.0;

    const count = rawSTLVertices.length / 3;
    const data = new Float32Array(count * 7);

    for (let i = 0; i < count; i++) {
        data[i * 7 + 0] = rawSTLVertices[i * 3 + 0];
        data[i * 7 + 1] = rawSTLVertices[i * 3 + 1];
        data[i * 7 + 2] = rawSTLVertices[i * 3 + 2];
        
        data[i * 7 + 3] = 0.0;
        data[i * 7 + 4] = 0.0;
        data[i * 7 + 5] = 0.0;
        data[i * 7 + 6] = 0.0;
    }

    transformedSTLVertices = data;

    const numTriangles = count / 3;
    const indices = new Uint32Array(numTriangles * 6);
    for (let i = 0; i < numTriangles; i++) {
        indices[i * 6 + 0] = i * 3 + 0;
        indices[i * 6 + 1] = i * 3 + 1;
        indices[i * 6 + 2] = i * 3 + 1;
        indices[i * 6 + 3] = i * 3 + 2;
        indices[i * 6 + 4] = i * 3 + 2;
        indices[i * 6 + 5] = i * 3 + 0;
    }
    stlIndexCount = indices.length;

    if (isWebGPU && gpuDevice) {
        if (gpuSTLBuffer) gpuSTLBuffer.destroy();
        gpuSTLBuffer = gpuDevice.createBuffer({
            size: data.byteLength,
            usage: 32 | 8,
            mappedAtCreation: true
        });
        new Float32Array(gpuSTLBuffer.getMappedRange()).set(data);
        gpuSTLBuffer.unmap();

        if (gpuSTLIndexBuffer) gpuSTLIndexBuffer.destroy();
        gpuSTLIndexBuffer = gpuDevice.createBuffer({
            size: indices.byteLength,
            usage: 16 | 8,
            mappedAtCreation: true
        });
        new Uint32Array(gpuSTLIndexBuffer.getMappedRange()).set(indices);
        gpuSTLIndexBuffer.unmap();
    } else if (gl) {
        if (!stlBuffer) {
            stlBuffer = gl.createBuffer();
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, stlBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

        if (!stlIndexBuffer) {
            stlIndexBuffer = gl.createBuffer();
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, stlIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }
}

function shouldShowCellEdges(): boolean {
    if (!showCellEdges) return false;
    const maxN = Math.max(nx, ny, nz) || 1;
    const h = canvasHeight();
    let modelPixels = h / distance;
    if (usePerspective) {
        const fovRad = (fov * Math.PI) / 180;
        modelPixels = h / (2.0 * distance * Math.tan(fovRad / 2.0));
    }
    const cellPixels = modelPixels / maxN;
    return cellPixels >= 3.0;
}

interface SliceDataWebGPU {
    axis: number;
    offset: number;
    w: number;
    h: number;
    gpuTexture: any;
    gpuTextureView: any;
    vertexBuffer: any;
    bindGroup: any;
    opacity: number;
    index: number;
    minY?: number;
    maxY?: number;
    colormap?: string;
    useLogScale?: boolean;
    interpolate?: boolean;
}

interface SliceDataWebGL {
    axis: number;
    offset: number;
    w: number;
    h: number;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
    opacity: number;
    index: number;
    minY?: number;
    maxY?: number;
    colormap?: string;
    useLogScale?: boolean;
    interpolate?: boolean;
}

interface SliceData2D {
    axis: number;
    offset: number;
    w: number;
    h: number;
    data: Float32Array;
}

let activeSlicesWebGPU: { [index: number]: SliceDataWebGPU } = {};
let activeSlicesWebGL: { [index: number]: SliceDataWebGL } = {};
let activeSlices2D: SliceData2D[] = [];
let cachedDynamicMinMax: Record<string, { min: number, max: number }> = {};

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
                const requiredFeatures = [];
                if (adapter.features.has('float32-filterable')) {
                    requiredFeatures.push('float32-filterable');
                }
                gpuDevice = await adapter.requestDevice({ requiredFeatures: requiredFeatures as any });
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
                    const isFilterable = gpuDevice.features.has('float32-filterable');
                    // Define explicit BindGroupLayout for r32float compatibility
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
                                texture: { sampleType: isFilterable ? 'float' : 'unfilterable-float' }
                            },
                            {
                                binding: 2,
                                visibility: 2, // FRAGMENT
                                sampler: { type: isFilterable ? 'filtering' : 'non-filtering' }
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

                    gpuSlicePipeline = gpuDevice.createRenderPipeline({
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
                            depthWriteEnabled: false,
                            depthCompare: 'less-equal',
                            format: 'depth24plus'
                        }
                    });

                    // Bounding Box setup and BBox/Axes buffer initialization
                    updateAxesGeometry();

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

                    // Create separate line pipeline for STL wireframe
                    gpuSTLLinePipeline = gpuDevice.createRenderPipeline({
                        layout: pipelineLayout,
                        vertex: {
                            module: shaderModule,
                            entryPoint: 'vs_main',
                            buffers: [{
                                arrayStride: 28,
                                attributes: [
                                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                                    { shaderLocation: 1, offset: 12, format: 'float32x2' },
                                    { shaderLocation: 2, offset: 20, format: 'float32x2' }
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
                        magFilter: isFilterable ? 'linear' : 'nearest',
                        minFilter: isFilterable ? 'linear' : 'nearest'
                    });

                    // GPUBufferUsage: UNIFORM = 64, COPY_DST = 8
                    gpuUniformBuffer = gpuDevice.createBuffer({
                        size: 256, // 16*4*3 + 16*4 bytes (padded)
                        usage: 64 | 8
                    });
                    gpuUniformBufferWF = gpuDevice.createBuffer({
                        size: 256,
                        usage: 64 | 8
                    });
                    gpuSTLUniformSolid = gpuDevice.createBuffer({
                        size: 256,
                        usage: 64 | 8
                    });
                    gpuSTLUniformWireframe = gpuDevice.createBuffer({
                        size: 256,
                        usage: 64 | 8
                    });

                    gpuAxesUniformBuffers = [];
                    for (let a = 0; a < 3; a++) {
                        const buf = gpuDevice.createBuffer({
                            size: 256,
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

                    // Build dynamic Axes GPU buffer
                    gpuAxesBuffer = gpuDevice.createBuffer({
                        size: 15120, // 3 arrows * 180 vertices * 7 floats * 4 bytes
                        usage: 32 | 8 // VERTEX | COPY_DST
                    });
                    updateAxesGeometry();
                    updateSTLGeometry();

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
        gl.getExtension("OES_element_index_uint");
    }

    bboxBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, getBBoxVertices(), gl.STATIC_DRAW);

    axesBuffer = gl.createBuffer();
    updateAxesGeometry();
    updateSTLGeometry();

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

function getSliceCenterDistance(axis: number, offset: number, eye: number[]): number {
    const dimX = (nx && dx) ? (nx * dx) : 1.0;
    const dimY = (ny && dx) ? (ny * dx) : 1.0;
    const dimZ = (nz && dx) ? (nz * dx) : 1.0;

    let sx = 0;
    let sy = 0;
    let sz = 0;

    if (axis === 0) { // XY
        sz = (offset - zmin) / dimZ - 0.5;
    } else if (axis === 1) { // XZ
        sy = (offset - ymin) / dimY - 0.5;
    } else { // YZ
        sx = (offset - xmin) / dimX - 0.5;
    }

    const dxVal = eye[0] - sx;
    const dyVal = eye[1] - sy;
    const dzVal = eye[2] - sz;
    return dxVal * dxVal + dyVal * dyVal + dzVal * dzVal;
}

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
    cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
    cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
    cameraEyeZ = targetZ + distance * Math.sin(pitch);
    
    let eye = [cameraEyeX, cameraEyeY, cameraEyeZ];
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

function handleFrame(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x43494c53) return; // "SLIC"

    const time = view.getFloat32(4, true);
    const numSlices = view.getUint32(8, true);

    // Populate cachedSlices
    cachedSlices = [];
    let cacheOffset = 12;
    for (let i = 0; i < numSlices; i++) {
        const axis = view.getUint32(cacheOffset, true);
        const zOff = view.getFloat32(cacheOffset + 4, true);
        const w = view.getUint32(cacheOffset + 8, true);
        const h = view.getUint32(cacheOffset + 12, true);
        const dataStart = cacheOffset + 16;
        const floatData = new Float32Array(buffer, dataStart, w * h);

        const config = slicesConfig[i] || {};
        const useAxis = config.axis !== undefined ? (config.axis === 'xy' ? 0 : (config.axis === 'xz' ? 1 : 2)) : axis;
        const useOffset = config.offset !== undefined ? config.offset : zOff;

        cachedSlices.push({
            axis: useAxis,
            offset: useOffset,
            w,
            h,
            data: new Float32Array(floatData)
        });
        cacheOffset = dataStart + (w * h * 4);
    }

    // Assign slice-specific ranges and configs
    const sliceRanges: { min: number, max: number }[] = [];
    for (let i = 0; i < cachedSlices.length; i++) {
        const slice = cachedSlices[i];
        const config = slicesConfig[i] || {};
        const qty = config.quantities?.[0] || 'pressure';
        const sliceAutoScale = config.auto_scale !== false;
        const colormapVal = config.colormap || 'plasma';
        const logVal = config.log_scale === true;
        const interpVal = config.interpolate !== false;
        
        let sliceMin = Infinity;
        let sliceMax = -Infinity;
        for (let j = 0; j < slice.data.length; j++) {
            const v = slice.data[j];
            if (isFinite(v)) {
                if (v < sliceMin) sliceMin = v;
                if (v > sliceMax) sliceMax = v;
            }
        }

        let sliceMinY = minY;
        let sliceMaxY = maxY;

        if (sliceAutoScale) {
            if (sliceMin < sliceMax) {
                sliceMinY = sliceMin;
                sliceMaxY = sliceMax;
            } else {
                const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
                sliceMinY = range[0];
                sliceMaxY = range[1];
            }
        } else {
            const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
            sliceMinY = range[0];
            sliceMaxY = range[1];
        }

        slice.minY = sliceMinY;
        slice.maxY = sliceMaxY;
        slice.colormap = colormapVal;
        slice.useLogScale = logVal;
        slice.interpolate = interpVal;

        if (sliceMin < sliceMax) {
            sliceRanges.push({ min: sliceMin, max: sliceMax });
        } else {
            const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
            sliceRanges.push({ min: range[0], max: range[1] });
        }
    }

    self.postMessage({ type: 'sliceRanges', ranges: sliceRanges });

    // Send dynamic min/max range of the currently focused slice back to the main thread
    const focusedSlice = cachedSlices[focusedSliceIndex] || cachedSlices[0];
    if (focusedSlice) {
        let sliceMin = Infinity;
        let sliceMax = -Infinity;
        for (let j = 0; j < focusedSlice.data.length; j++) {
            const v = focusedSlice.data[j];
            if (isFinite(v)) {
                if (v < sliceMin) sliceMin = v;
                if (v > sliceMax) sliceMax = v;
            }
        }
        if (sliceMin < sliceMax) {
            self.postMessage({ type: 'currentRange', min: sliceMin, max: sliceMax });
        } else {
            const focusedConfig = slicesConfig[focusedSliceIndex] || slicesConfig[0] || {};
            const focusedQty = focusedConfig.quantities?.[0] || 'pressure';
            const range = focusedConfig.min_val !== undefined && focusedConfig.max_val !== undefined ? [focusedConfig.min_val, focusedConfig.max_val] : (quantityRanges[focusedQty] || DEFAULT_QUANTITY_RANGES[focusedQty] || [0.0, 1.0]);
            self.postMessage({ type: 'currentRange', min: range[0], max: range[1] });
        }
    }

    if (is2DFallback) {
        activeSlices2D = cachedSlices;
        return;
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
        cachedSlices.forEach((sliceObj, i) => {
            const axis = sliceObj.axis;
            const zOff = sliceObj.offset;
            const w = sliceObj.w;
            const h = sliceObj.h;
            const floatData = sliceObj.data;
            const opacity = sliceOpacities[i] !== undefined ? sliceOpacities[i] : 1.0;

            let slice: SliceDataWebGPU;
            const geo = getSliceGeometry(axis, zOff, w, h);

            if (activeSlicesWebGPU[i]) {
                slice = activeSlicesWebGPU[i];
                if (slice.w !== w || slice.h !== h) {
                    slice.gpuTexture.destroy();
                    slice.gpuTexture = gpuDevice.createTexture({
                        size: [w, h, 1],
                        format: 'r32float',
                        usage: 4 | 2
                    });
                    slice.gpuTextureView = slice.gpuTexture.createView();
                    slice.w = w; slice.h = h;

                    if (!gpuSliceUniformBuffers[i]) {
                        gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                            size: 256,
                            usage: 64 | 8
                        });
                    }

                    slice.bindGroup = gpuDevice.createBindGroup({
                        layout: bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                            { binding: 1, resource: slice.gpuTextureView },
                            { binding: 2, resource: gpuSampler! }
                        ]
                    });
                }
                const paddedResult = padFloatData(floatData, w, h);
                gpuDevice.queue.writeTexture(
                    { texture: slice.gpuTexture },
                    paddedResult.data,
                    { bytesPerRow: paddedResult.bytesPerRow },
                    [w, h, 1]
                );
                gpuDevice.queue.writeBuffer(slice.vertexBuffer, 0, geo);
                slice.axis = axis; slice.offset = zOff; slice.opacity = opacity;
                slice.minY = sliceObj.minY; slice.maxY = sliceObj.maxY;
                slice.colormap = sliceObj.colormap; slice.useLogScale = sliceObj.useLogScale; slice.interpolate = sliceObj.interpolate;
            } else {
                const tex = gpuDevice.createTexture({
                    size: [w, h, 1],
                    format: 'r32float',
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
                    usage: 32 | 8
                });
                gpuDevice.queue.writeBuffer(vb, 0, geo);

                if (!gpuSliceUniformBuffers[i]) {
                    gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                        size: 256,
                        usage: 64 | 8
                    });
                }

                const bindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                        { binding: 1, resource: texView },
                        { binding: 2, resource: gpuSampler! }
                    ]
                });

                slice = { axis, offset: zOff, w, h, gpuTexture: tex, gpuTextureView: texView, vertexBuffer: vb, bindGroup, opacity, index: i, minY: sliceObj.minY, maxY: sliceObj.maxY, colormap: sliceObj.colormap, useLogScale: sliceObj.useLogScale, interpolate: sliceObj.interpolate };
                activeSlicesWebGPU[i] = slice;
            }
        });
        return;
    }

    // WebGL frame processing
    if (!gl) return;
    const activeGl = gl;

    if (Object.keys(activeSlicesWebGL).length !== numSlices) {
        Object.values(activeSlicesWebGL).forEach(s => {
            activeGl.deleteTexture(s.texture);
            activeGl.deleteBuffer(s.buffer);
        });
        activeSlicesWebGL = {};
    }

    const internalFormat = isWebGL2 ? activeGl.R32F : activeGl.LUMINANCE;
    const format = isWebGL2 ? activeGl.RED : activeGl.LUMINANCE;

    cachedSlices.forEach((sliceObj, i) => {
        const axis = sliceObj.axis;
        const zOff = sliceObj.offset;
        const w = sliceObj.w;
        const h = sliceObj.h;
        const floatData = sliceObj.data;
        const opacity = sliceOpacities[i] !== undefined ? sliceOpacities[i] : 1.0;

        let slice: SliceDataWebGL;
        if (activeSlicesWebGL[i]) {
            slice = activeSlicesWebGL[i];
            activeGl.bindTexture(activeGl.TEXTURE_2D, slice.texture);
            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, slice.buffer);
            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h), activeGl.STATIC_DRAW);

            slice.axis = axis;
            slice.offset = zOff;
            slice.w = w;
            slice.h = h;
            slice.opacity = opacity;
            slice.minY = sliceObj.minY;
            slice.maxY = sliceObj.maxY;
            slice.colormap = sliceObj.colormap;
            slice.useLogScale = sliceObj.useLogScale;
            slice.interpolate = sliceObj.interpolate;
        } else {
            const tex = activeGl.createTexture()!;
            activeGl.bindTexture(activeGl.TEXTURE_2D, tex);
            const filter = hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST;
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_S, activeGl.CLAMP_TO_EDGE);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_T, activeGl.CLAMP_TO_EDGE);
            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

            const buf = activeGl.createBuffer()!;
            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, buf);
            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h), activeGl.STATIC_DRAW);

            slice = { axis, offset: zOff, w, h, texture: tex, buffer: buf, opacity, index: i, minY: sliceObj.minY, maxY: sliceObj.maxY, colormap: sliceObj.colormap, useLogScale: sliceObj.useLogScale, interpolate: sliceObj.interpolate };
            activeSlicesWebGL[i] = slice;
        }
    });
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
        const uniformData = new Float32Array(64); // 256 bytes
        uniformData.set(projectionMatrix, 0);
        uniformData.set(viewMatrix, 16);
        uniformData.set(modelMatrix, 32);
        uniformData[48] = 1.0; // Alpha
        uniformData[49] = colormap;
        uniformData[50] = minY;
        uniformData[51] = maxY;
        
        uniformData[52] = useLogScale ? 1.0 : 0.0;
        uniformData[53] = 0.0; // isWireframe placeholder
        uniformData[54] = shouldShowCellEdges() ? 1.0 : 0.0;
        uniformData[55] = interpolate ? 1.0 : 0.0;
        
        uniformData[56] = lightingEnabled ? 1.0 : 0.0;
        uniformData[57] = aoEnabled ? 1.0 : 0.0;
        uniformData[58] = ambientLevel;
        uniformData[59] = specularIntensity;
        
        gpuDevice.queue.writeBuffer(gpuUniformBuffer!, 0, uniformData.buffer);

        // Build uniforms data for Wireframe (isWireframe = 1.0)
        const uniformDataWF = new Float32Array(uniformData);
        uniformDataWF[53] = 1.0; // set isWireframe to 1.0
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
        if (gpuAxesBuffer && gpuPipeline && gpuAxesUniformBuffers.length === 3) {
            passEncoder.setPipeline(gpuPipeline);
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
                passEncoder.draw(180, 1, a * 180, 0);
            }
        }

        // Draw STL Geometry
        if (showSTL && gpuSTLBuffer && transformedSTLVertices && gpuSTLUniformSolid && gpuSTLUniformWireframe) {
            const count = transformedSTLVertices.length / 7;
            const dummyTexView = Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView;

            const sizeX = nx * dx || 1.0;
            const sizeY = ny * dx || 1.0;
            const sizeZ = nz * dx || 1.0;
            const sx = 1.0 / sizeX;
            const sy = 1.0 / sizeY;
            const sz = 1.0 / sizeZ;
            const tx = -xmin * sx - 0.5;
            const ty = -ymin * sy - 0.5;
            const tz = -zmin * sz - 0.5;

            const stlModel = new Float32Array([
                sx, 0, 0, 0,
                0, sy, 0, 0,
                0, 0, sz, 0,
                tx, ty, tz, 1
            ]);
            const stlFinalModel = multiplyMatrices(modelMatrix, stlModel);

            if (stlSolids && gpuPipeline) {
                const uSolid = new Float32Array(uniformData);
                uSolid.set(stlFinalModel, 32);
                uSolid[48] = stlOpacity;
                uSolid[53] = 5.0;
                gpuDevice.queue.writeBuffer(gpuSTLUniformSolid, 0, uSolid.buffer);

                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformSolid } },
                        { binding: 1, resource: dummyTexView },
                        { binding: 2, resource: gpuSampler! }
                    ]
                });

                passEncoder.setPipeline(gpuPipeline);
                passEncoder.setBindGroup(0, solidBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.draw(count);
            }

            if (stlWireframe && gpuLinePipeline) {
                const uWire = new Float32Array(uniformData);
                uWire.set(stlFinalModel, 32);
                uWire[48] = 0.8;
                uWire[53] = 6.0;
                gpuDevice.queue.writeBuffer(gpuSTLUniformWireframe, 0, uWire.buffer);

                const wireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformWireframe } },
                        { binding: 1, resource: dummyTexView },
                        { binding: 2, resource: gpuSampler! }
                    ]
                });

                passEncoder.setPipeline(gpuSTLLinePipeline);
                passEncoder.setBindGroup(0, wireBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.setIndexBuffer(gpuSTLIndexBuffer, 'uint32');
                passEncoder.drawIndexed(stlIndexCount);
            }
        }

        // 2. Draw Slices
        const slicesArray = Object.values(activeSlicesWebGPU);
        if (slicesArray.length > 0) {
            const opaqueSlices = slicesArray.filter(s => {
                const opac = s.opacity !== undefined ? s.opacity : 1.0;
                return opac >= 0.999;
            });
            const transparentSlices = slicesArray.filter(s => {
                const opac = s.opacity !== undefined ? s.opacity : 1.0;
                return opac < 0.999;
            });

            // Pass 1: Opaque Slices (depth write enabled)
            if (opaqueSlices.length > 0) {
                passEncoder.setPipeline(gpuPipeline!);
                opaqueSlices.forEach(slice => {
                    if (!gpuSliceUniformBuffers[slice.index]) {
                        gpuSliceUniformBuffers[slice.index] = gpuDevice.createBuffer({
                            size: 256,
                            usage: 64 | 8
                        });
                        slice.bindGroup = gpuDevice.createBindGroup({
                            layout: bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: gpuSliceUniformBuffers[slice.index] } },
                                { binding: 1, resource: slice.gpuTextureView },
                                { binding: 2, resource: gpuSampler! }
                            ]
                        });
                    }
                    const sliceUniformData = new Float32Array(uniformData);
                    sliceUniformData[48] = 1.0;
                    sliceUniformData[49] = slice.colormap === 'viridis' ? 1.0 : 0.0;
                    sliceUniformData[50] = slice.minY ?? minY;
                    sliceUniformData[51] = slice.maxY ?? maxY;
                    sliceUniformData[52] = slice.useLogScale ? 1.0 : 0.0;
                    sliceUniformData[55] = slice.interpolate ? 1.0 : 0.0;
                    gpuDevice.queue.writeBuffer(gpuSliceUniformBuffers[slice.index], 0, sliceUniformData.buffer);

                    passEncoder.setBindGroup(0, slice.bindGroup);
                    passEncoder.setVertexBuffer(0, slice.vertexBuffer);
                    passEncoder.draw(6);
                });
            }

            // Pass 2: Transparent Slices (depth write disabled, sorted back-to-front)
            if (transparentSlices.length > 0) {
                passEncoder.setPipeline(gpuSlicePipeline!);
                const eye = [cameraEyeX, cameraEyeY, cameraEyeZ];
                transparentSlices.sort((a, b) => {
                    const distA = getSliceCenterDistance(a.axis, a.offset, eye);
                    const distB = getSliceCenterDistance(b.axis, b.offset, eye);
                    return distB - distA; // Descending: furthest first
                });
                transparentSlices.forEach(slice => {
                    if (!gpuSliceUniformBuffers[slice.index]) {
                        gpuSliceUniformBuffers[slice.index] = gpuDevice.createBuffer({
                            size: 256,
                            usage: 64 | 8
                        });
                        slice.bindGroup = gpuDevice.createBindGroup({
                            layout: bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: gpuSliceUniformBuffers[slice.index] } },
                                { binding: 1, resource: slice.gpuTextureView },
                                { binding: 2, resource: gpuSampler! }
                            ]
                        });
                    }
                    const sliceUniformData = new Float32Array(uniformData);
                    sliceUniformData[48] = slice.opacity;
                    sliceUniformData[49] = slice.colormap === 'viridis' ? 1.0 : 0.0;
                    sliceUniformData[50] = slice.minY ?? minY;
                    sliceUniformData[51] = slice.maxY ?? maxY;
                    sliceUniformData[52] = slice.useLogScale ? 1.0 : 0.0;
                    sliceUniformData[55] = slice.interpolate ? 1.0 : 0.0;
                    gpuDevice.queue.writeBuffer(gpuSliceUniformBuffers[slice.index], 0, sliceUniformData.buffer);

                    passEncoder.setBindGroup(0, slice.bindGroup);
                    passEncoder.setVertexBuffer(0, slice.vertexBuffer);
                    passEncoder.draw(6);
                });
            }
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
    gl.uniform1f(uAlpha, 1.0); // Will be overwritten per slice

    const uEnableLightLoc = gl.getUniformLocation(program, "uEnableLighting");
    if (uEnableLightLoc !== null) gl.uniform1i(uEnableLightLoc, lightingEnabled ? 1 : 0);

    const uEnableAOLoc = gl.getUniformLocation(program, "uEnableAO");
    if (uEnableAOLoc !== null) gl.uniform1i(uEnableAOLoc, aoEnabled ? 1 : 0);

    const uAmbientLoc = gl.getUniformLocation(program, "uAmbientLevel");
    if (uAmbientLoc !== null) gl.uniform1f(uAmbientLoc, ambientLevel);

    const uSpecularLoc = gl.getUniformLocation(program, "uSpecularLevel");
    if (uSpecularLoc !== null) gl.uniform1f(uSpecularLoc, specularIntensity);

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
        // Stride is 28 (7 floats * 4 bytes)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);

        for (let a = 0; a < 3; a++) {
            gl.uniform1i(uIsWF, 2 + a); // 2=X Red, 3=Y Green, 4=Z Blue
            gl.drawArrays(gl.TRIANGLES, a * 180, 180);
        }
    }

    // Draw STL Geometry fallback in WebGL
    if (showSTL && stlBuffer && transformedSTLVertices) {
        const count = transformedSTLVertices.length / 7;

        const sizeX = nx * dx || 1.0;
        const sizeY = ny * dx || 1.0;
        const sizeZ = nz * dx || 1.0;
        const sx = 1.0 / sizeX;
        const sy = 1.0 / sizeY;
        const sz = 1.0 / sizeZ;
        const tx = -xmin * sx - 0.5;
        const ty = -ymin * sy - 0.5;
        const tz = -zmin * sz - 0.5;

        const stlModel = new Float32Array([
            sx, 0, 0, 0,
            0, sy, 0, 0,
            0, 0, sz, 0,
            tx, ty, tz, 1
        ]);
        const stlFinalModel = multiplyMatrices(modelMatrix, stlModel);
        gl.uniformMatrix4fv(uModel, false, stlFinalModel);

        gl.bindBuffer(gl.ARRAY_BUFFER, stlBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);

        if (stlSolids) {
            gl.uniform1i(uIsWF, 5);
            gl.uniform1f(uAlpha, stlOpacity);
            gl.drawArrays(gl.TRIANGLES, 0, count);
        }

        if (stlWireframe && stlIndexBuffer && stlIndexCount > 0) {
            gl.uniform1i(uIsWF, 6);
            gl.uniform1f(uAlpha, 0.8);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, stlIndexBuffer);
            gl.drawElements(gl.LINES, stlIndexCount, gl.UNSIGNED_INT, 0);
        }

        // Restore base model matrix for slices
        gl.uniformMatrix4fv(uModel, false, modelMatrix);
    }

    gl.uniform1i(uIsWF, 0);
    const uShowEdges = gl.getUniformLocation(program, "uShowCellEdges");
    if (uShowEdges !== null) {
        gl.uniform1i(uShowEdges, shouldShowCellEdges() ? 1 : 0);
    }
    const uInterp = gl.getUniformLocation(program, "uInterpolate");
    if (uInterp !== null) {
        gl.uniform1i(uInterp, interpolate ? 1 : 0);
    }

    const slicesArrayWebGL = Object.values(activeSlicesWebGL);
    if (slicesArrayWebGL.length > 0) {
        const opaqueSlices = slicesArrayWebGL.filter(s => {
            const opac = s.opacity;
            return opac >= 0.999;
        });
        const transparentSlices = slicesArrayWebGL.filter(s => {
            const opac = s.opacity;
            return opac < 0.999;
        });

        // Pass 1: Opaque Slices (depth write enabled)
        opaqueSlices.forEach(slice => {
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

            gl!.uniform1f(uMin, slice.minY ?? minY);
            gl!.uniform1f(uMax, slice.maxY ?? maxY);
            gl!.uniform1i(uColormap, slice.colormap === 'viridis' ? 1 : 0);
            gl!.uniform1i(uUseLog, slice.useLogScale ? 1 : 0);
            if (uInterp !== null) {
                gl!.uniform1i(uInterp, slice.interpolate ? 1 : 0);
            }
            gl!.uniform1f(uAlpha, 1.0);
            gl!.drawArrays(gl!.TRIANGLES, 0, 6);
        });

        // Pass 2: Transparent Slices (depth write disabled, sorted back-to-front)
        if (transparentSlices.length > 0) {
            gl.depthMask(false);

            const eye = [cameraEyeX, cameraEyeY, cameraEyeZ];
            transparentSlices.sort((a, b) => {
                const distA = getSliceCenterDistance(a.axis, a.offset, eye);
                const distB = getSliceCenterDistance(b.axis, b.offset, eye);
                return distB - distA; // Descending: furthest first
            });

            transparentSlices.forEach(slice => {
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

                gl!.uniform1f(uMin, slice.minY ?? minY);
                gl!.uniform1f(uMax, slice.maxY ?? maxY);
                gl!.uniform1i(uColormap, slice.colormap === 'viridis' ? 1 : 0);
                gl!.uniform1i(uUseLog, slice.useLogScale ? 1 : 0);
                if (uInterp !== null) {
                    gl!.uniform1i(uInterp, slice.interpolate ? 1 : 0);
                }
                gl!.uniform1f(uAlpha, slice.opacity);
                gl!.drawArrays(gl!.TRIANGLES, 0, 6);
            });

            gl.depthMask(true);
        }
    }
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
        } else if (type === "setSTLGeometry") {
            rawSTLVertices = data.vertices;
            updateSTLGeometry();
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
            if (data.minY !== undefined) minY = data.minY;
            if (data.min !== undefined) minY = data.min;
            if (data.maxY !== undefined) maxY = data.maxY;
            if (data.max !== undefined) maxY = data.max;
            if (data.autoScale !== undefined) autoScale = data.autoScale;
            if (data.useLogScale !== undefined) useLogScale = data.useLogScale;
            if (data.showGrid !== undefined) showGrid = data.showGrid;
            if (data.showCellEdges !== undefined) showCellEdges = data.showCellEdges;
            if (data.interpolate !== undefined) interpolate = data.interpolate;
            if (data.xmin !== undefined) xmin = data.xmin;
            if (data.ymin !== undefined) ymin = data.ymin;
            if (data.zmin !== undefined) zmin = data.zmin;
            if (data.dx !== undefined) dx = data.dx;
            if (data.nx !== undefined) nx = data.nx;
            if (data.ny !== undefined) ny = data.ny;
            if (data.nz !== undefined) nz = data.nz;
            if (data.usePerspective !== undefined) usePerspective = data.usePerspective;
            if (data.fov !== undefined) fov = data.fov;
            if (data.lightingEnabled !== undefined) lightingEnabled = data.lightingEnabled;
            if (data.aoEnabled !== undefined) aoEnabled = data.aoEnabled;
            if (data.specularIntensity !== undefined) specularIntensity = data.specularIntensity;
            if (data.ambientLevel !== undefined) ambientLevel = data.ambientLevel;
            if (data.sliceOpacities !== undefined) sliceOpacities = data.sliceOpacities;
            if (data.slices !== undefined) {
                slicesConfig = data.slices;
                
                // Ensure cachedSlices length matches slicesConfig length if we have at least one valid slice
                if (cachedSlices.length > 0) {
                    while (cachedSlices.length < slicesConfig.length) {
                        const i = cachedSlices.length;
                        const config = slicesConfig[i];
                        const refSlice = cachedSlices[0];
                        const w = refSlice ? refSlice.w : 64;
                        const h = refSlice ? refSlice.h : 64;
                        const dummyData = new Float32Array(w * h);
                        if (refSlice && refSlice.data.length > 0) {
                            dummyData.fill(refSlice.data[0]);
                        }
                        cachedSlices.push({
                            axis: config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2,
                            offset: config.offset,
                            w,
                            h,
                            data: dummyData,
                            minY: config.min_val ?? 101325.0,
                            maxY: config.max_val ?? 1013250.0,
                            colormap: config.colormap || 'plasma',
                            useLogScale: config.log_scale === true,
                            interpolate: config.interpolate !== false
                        });
                    }
                    if (cachedSlices.length > slicesConfig.length) {
                        // Destroy resources for slices that are being deleted
                        for (let i = slicesConfig.length; i < cachedSlices.length; i++) {
                            if (isWebGPU && activeSlicesWebGPU[i]) {
                                activeSlicesWebGPU[i].gpuTexture.destroy();
                                activeSlicesWebGPU[i].vertexBuffer.destroy();
                                delete activeSlicesWebGPU[i];
                            }
                            if (gl && activeSlicesWebGL[i]) {
                                gl.deleteTexture(activeSlicesWebGL[i].texture);
                                gl.deleteBuffer(activeSlicesWebGL[i].buffer);
                                delete activeSlicesWebGL[i];
                            }
                        }
                        cachedSlices = cachedSlices.slice(0, slicesConfig.length);
                    }
                }
                
                // Now, update cachedSlices configurations in-place
                cachedSlices.forEach((sliceObj, i) => {
                    const config = slicesConfig[i];
                    if (!config) return;
                    sliceObj.axis = config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2;
                    sliceObj.offset = config.offset;
                    sliceObj.minY = config.min_val ?? sliceObj.minY;
                    sliceObj.maxY = config.max_val ?? sliceObj.maxY;
                    sliceObj.colormap = config.colormap || 'plasma';
                    sliceObj.useLogScale = config.log_scale === true;
                    sliceObj.interpolate = config.interpolate !== false;
                });

                // Update active slices (WebGL / WebGPU) immediately so they are in sync!
                if (isWebGPU && gpuDevice) {
                    cachedSlices.forEach((sliceObj, i) => {
                        const axis = sliceObj.axis;
                        const zOff = sliceObj.offset;
                        const w = sliceObj.w;
                        const h = sliceObj.h;
                        const floatData = sliceObj.data;
                        const opacity = sliceOpacities[i] !== undefined ? sliceOpacities[i] : 1.0;
                        const geo = getSliceGeometry(axis, zOff, w, h);

                        if (activeSlicesWebGPU[i]) {
                            const slice = activeSlicesWebGPU[i];
                            if (slice.w !== w || slice.h !== h) {
                                slice.gpuTexture.destroy();
                                slice.gpuTexture = gpuDevice.createTexture({
                                    size: [w, h, 1],
                                    format: 'r32float',
                                    usage: 4 | 2
                                });
                                slice.gpuTextureView = slice.gpuTexture.createView();
                                slice.w = w; slice.h = h;

                                if (!gpuSliceUniformBuffers[i]) {
                                    gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                                        size: 256,
                                        usage: 64 | 8
                                    });
                                }
                                slice.bindGroup = gpuDevice.createBindGroup({
                                    layout: bindGroupLayout,
                                    entries: [
                                        { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                                        { binding: 1, resource: slice.gpuTextureView },
                                        { binding: 2, resource: gpuSampler! }
                                    ]
                                });
                            }
                            const paddedResult = padFloatData(floatData, w, h);
                            gpuDevice.queue.writeTexture(
                                { texture: slice.gpuTexture },
                                paddedResult.data,
                                { bytesPerRow: paddedResult.bytesPerRow },
                                [w, h, 1]
                            );
                            gpuDevice.queue.writeBuffer(slice.vertexBuffer, 0, geo);
                            slice.axis = axis;
                            slice.offset = zOff;
                            slice.opacity = opacity;
                            slice.minY = sliceObj.minY;
                            slice.maxY = sliceObj.maxY;
                            slice.colormap = sliceObj.colormap;
                            slice.useLogScale = sliceObj.useLogScale;
                            slice.interpolate = sliceObj.interpolate;
                        } else {
                            const tex = gpuDevice.createTexture({
                                size: [w, h, 1],
                                format: 'r32float',
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
                                usage: 32 | 8
                            });
                            gpuDevice.queue.writeBuffer(vb, 0, geo);

                            if (!gpuSliceUniformBuffers[i]) {
                                gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                                    size: 256,
                                    usage: 64 | 8
                                });
                            }

                            const bindGroup = gpuDevice.createBindGroup({
                                layout: bindGroupLayout,
                                entries: [
                                    { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                                    { binding: 1, resource: texView },
                                    { binding: 2, resource: gpuSampler! }
                                ]
                            });

                            activeSlicesWebGPU[i] = {
                                axis,
                                offset: zOff,
                                w,
                                h,
                                gpuTexture: tex,
                                gpuTextureView: texView,
                                vertexBuffer: vb,
                                bindGroup,
                                opacity,
                                index: i,
                                minY: sliceObj.minY,
                                maxY: sliceObj.maxY,
                                colormap: sliceObj.colormap,
                                useLogScale: sliceObj.useLogScale,
                                interpolate: sliceObj.interpolate
                            };
                        }
                    });
                } else if (gl) {
                    const activeGl = gl;
                    const internalFormat = isWebGL2 ? activeGl.R32F : activeGl.LUMINANCE;
                    const format = isWebGL2 ? activeGl.RED : activeGl.LUMINANCE;

                    cachedSlices.forEach((sliceObj, i) => {
                        const axis = sliceObj.axis;
                        const zOff = sliceObj.offset;
                        const w = sliceObj.w;
                        const h = sliceObj.h;
                        const floatData = sliceObj.data;
                        const opacity = sliceOpacities[i] !== undefined ? sliceOpacities[i] : 1.0;
                        const axisNum = axis;

                        if (activeSlicesWebGL[i]) {
                            const slice = activeSlicesWebGL[i];
                            activeGl.bindTexture(activeGl.TEXTURE_2D, slice.texture);
                            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

                            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, slice.buffer);
                            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axisNum, zOff, w, h), activeGl.STATIC_DRAW);

                            slice.axis = axisNum;
                            slice.offset = zOff;
                            slice.w = w;
                            slice.h = h;
                            slice.opacity = opacity;
                            slice.minY = sliceObj.minY;
                            slice.maxY = sliceObj.maxY;
                            slice.colormap = sliceObj.colormap;
                            slice.useLogScale = sliceObj.useLogScale;
                            slice.interpolate = sliceObj.interpolate;
                        } else {
                            const tex = activeGl.createTexture()!;
                            activeGl.bindTexture(activeGl.TEXTURE_2D, tex);
                            const filter = hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST;
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_S, activeGl.CLAMP_TO_EDGE);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_T, activeGl.CLAMP_TO_EDGE);
                            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

                            const buf = activeGl.createBuffer()!;
                            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, buf);
                            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axisNum, zOff, w, h), activeGl.STATIC_DRAW);

                            activeSlicesWebGL[i] = {
                                axis: axisNum,
                                offset: zOff,
                                w,
                                h,
                                texture: tex,
                                buffer: buf,
                                opacity,
                                index: i,
                                minY: sliceObj.minY,
                                maxY: sliceObj.maxY,
                                colormap: sliceObj.colormap,
                                useLogScale: sliceObj.useLogScale,
                                interpolate: sliceObj.interpolate
                            };
                        }
                    });
                }
            }
            if (data.quantityRanges !== undefined) quantityRanges = data.quantityRanges;
            if (data.focusedSliceIndex !== undefined) focusedSliceIndex = data.focusedSliceIndex;
            if (data.showSTL !== undefined) showSTL = data.showSTL;
            if (data.stlWireframe !== undefined) stlWireframe = data.stlWireframe;
            if (data.stlSolids !== undefined) stlSolids = data.stlSolids;
            if (data.stlOpacity !== undefined) stlOpacity = data.stlOpacity;

            // Recalculate range immediately using cached frame data
            if (cachedSlices.length > 0) {
                const sliceRanges: { min: number, max: number }[] = [];
                for (let i = 0; i < cachedSlices.length; i++) {
                    const slice = cachedSlices[i];
                    const config = slicesConfig[i] || {};
                    const qty = config.quantities?.[0] || 'pressure';
                    const sliceAutoScale = config.auto_scale !== false;

                    let sliceMin = Infinity;
                    let sliceMax = -Infinity;
                    for (let j = 0; j < slice.data.length; j++) {
                        const v = slice.data[j];
                        if (isFinite(v)) {
                            if (v < sliceMin) sliceMin = v;
                            if (v > sliceMax) sliceMax = v;
                        }
                    }

                    let sliceMinY = minY;
                    let sliceMaxY = maxY;

                    if (sliceAutoScale) {
                        if (sliceMin < sliceMax) {
                            sliceMinY = sliceMin;
                            sliceMaxY = sliceMax;
                        } else {
                            const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
                            sliceMinY = range[0];
                            sliceMaxY = range[1];
                        }
                    } else {
                        const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
                        sliceMinY = range[0];
                        sliceMaxY = range[1];
                    }

                    slice.minY = sliceMinY;
                    slice.maxY = sliceMaxY;
                    
                    // Update active slice properties as well
                    if (isWebGPU && activeSlicesWebGPU[i]) {
                        activeSlicesWebGPU[i].minY = sliceMinY;
                        activeSlicesWebGPU[i].maxY = sliceMaxY;
                    } else if (gl && activeSlicesWebGL[i]) {
                        activeSlicesWebGL[i].minY = sliceMinY;
                        activeSlicesWebGL[i].maxY = sliceMaxY;
                    }

                    if (sliceMin < sliceMax) {
                        sliceRanges.push({ min: sliceMin, max: sliceMax });
                    } else {
                        const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (quantityRanges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
                        sliceRanges.push({ min: range[0], max: range[1] });
                    }
                }

                self.postMessage({ type: 'sliceRanges', ranges: sliceRanges });

                const focusedSlice = cachedSlices[focusedSliceIndex] || cachedSlices[0];
                if (focusedSlice) {
                    let sliceMin = Infinity;
                    let sliceMax = -Infinity;
                    for (let j = 0; j < focusedSlice.data.length; j++) {
                        const v = focusedSlice.data[j];
                        if (isFinite(v)) {
                            if (v < sliceMin) sliceMin = v;
                            if (v > sliceMax) sliceMax = v;
                        }
                    }
                    if (sliceMin < sliceMax) {
                        minY = sliceMin;
                        maxY = sliceMax;
                        self.postMessage({ type: 'currentRange', min: sliceMin, max: sliceMax });
                    } else {
                        const focusedConfig = slicesConfig[focusedSliceIndex] || slicesConfig[0] || {};
                        const focusedQty = focusedConfig.quantities?.[0] || 'pressure';
                        const range = focusedConfig.min_val !== undefined && focusedConfig.max_val !== undefined ? [focusedConfig.min_val, focusedConfig.max_val] : (quantityRanges[focusedQty] || DEFAULT_QUANTITY_RANGES[focusedQty] || [0.0, 1.0]);
                        minY = range[0];
                        maxY = range[1];
                        self.postMessage({ type: 'currentRange', min: range[0], max: range[1] });
                    }
                }
            }

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
                updateSTLGeometry();
            }
            updateAxesGeometry();
            render();
        } else if (type === "scaleToCurrent") {
            const idx = e.data.index !== undefined ? e.data.index : focusedSliceIndex;
            const slice = cachedSlices[idx];
            if (slice) {
                let sliceMin = Infinity;
                let sliceMax = -Infinity;
                for (let j = 0; j < slice.data.length; j++) {
                    const v = slice.data[j];
                    if (isFinite(v)) {
                        if (v < sliceMin) sliceMin = v;
                        if (v > sliceMax) sliceMax = v;
                    }
                }

                if (sliceMin < sliceMax) {
                    slice.minY = sliceMin;
                    slice.maxY = sliceMax;
                    
                    if (isWebGPU && activeSlicesWebGPU[idx]) {
                        activeSlicesWebGPU[idx].minY = sliceMin;
                        activeSlicesWebGPU[idx].maxY = sliceMax;
                    } else if (gl && activeSlicesWebGL[idx]) {
                        activeSlicesWebGL[idx].minY = sliceMin;
                        activeSlicesWebGL[idx].maxY = sliceMax;
                    }

                    self.postMessage({ type: 'rangeUpdated', index: idx, min: sliceMin, max: sliceMax });
                    render();
                }
            }
        }
    } catch (err: any) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
