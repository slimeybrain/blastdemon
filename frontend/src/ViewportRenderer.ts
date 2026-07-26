// ViewportWorker.ts
export {};

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

vec3 colormap_rainbow(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.25) {
        float localT = t / 0.25;
        r = 0.0; g = localT; b = 1.0;
    } else if (t < 0.5) {
        float localT = (t - 0.25) / 0.25;
        r = 0.0; g = 1.0; b = 1.0 - localT;
    } else if (t < 0.75) {
        float localT = (t - 0.5) / 0.25;
        r = localT; g = 1.0; b = 0.0;
    } else {
        float localT = (t - 0.75) / 0.25;
        r = 1.0; g = 1.0 - localT; b = 0.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_coolwarm(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.5) {
        float localT = t / 0.5;
        r = (59.0 + localT * 161.0) / 255.0;
        g = (76.0 + localT * 144.0) / 255.0;
        b = (192.0 + localT * 28.0) / 255.0;
    } else {
        float localT = (t - 0.5) / 0.5;
        r = (220.0 + localT * 9.0) / 255.0;
        g = (220.0 - localT * 184.0) / 255.0;
        b = (220.0 - localT * 161.0) / 255.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_cividis(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.5) {
        float localT = t / 0.5;
        r = (0.0 + localT * 84.0) / 255.0;
        g = (33.0 + localT * 79.0) / 255.0;
        b = (84.0 + localT * 53.0) / 255.0;
    } else {
        float localT = (t - 0.5) / 0.5;
        r = (84.0 + localT * 168.0) / 255.0;
        g = (112.0 + localT * 102.0) / 255.0;
        b = (137.0 - localT * 86.0) / 255.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_grayscale(float t) {
    return vec3(t, t, t);
}


void main() {
    if (uIsWireframe > 0) {
        if (uIsWireframe == 1) {
            outColor = vec4(0.3, 0.3, 0.4, 0.8);
            return;
        }
        
        // Axes Indicator (2=X Red, 3=Y Green, 4=Z Blue)
        vec4 baseColor = vec4(0.0);
        if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
        else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
        else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);

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
    else if (uColormap == 2) color = colormap_rainbow(t);
    else if (uColormap == 3) color = colormap_coolwarm(t);
    else if (uColormap == 4) color = colormap_cividis(t);
    else if (uColormap == 5) color = colormap_grayscale(t);
    else color = colormap_plasma(t);
    
    vec4 finalColor = vec4(color, uAlpha);
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

    if (uShowCellEdges) {
        vec2 grid = abs(fract(vTexCoord * vSliceSize - 0.5) - 0.5);
        vec2 threshold = max(fwidth(vTexCoord * vSliceSize), vec2(0.003));
        vec2 distToEdge = grid / threshold;
        float minDist = min(distToEdge.x, distToEdge.y);
        float isEdge = 1.0 - smoothstep(0.4, 1.4, minDist);
        finalColor = vec4(mix(finalColor.rgb, vec3(0.0, 0.0, 0.0), isEdge), finalColor.a);
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
#extension GL_OES_standard_derivatives : enable
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

vec3 colormap_rainbow(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.25) {
        float localT = t / 0.25;
        r = 0.0; g = localT; b = 1.0;
    } else if (t < 0.5) {
        float localT = (t - 0.25) / 0.25;
        r = 0.0; g = 1.0; b = 1.0 - localT;
    } else if (t < 0.75) {
        float localT = (t - 0.5) / 0.25;
        r = localT; g = 1.0; b = 0.0;
    } else {
        float localT = (t - 0.75) / 0.25;
        r = 1.0; g = 1.0 - localT; b = 0.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_coolwarm(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.5) {
        float localT = t / 0.5;
        r = (59.0 + localT * 161.0) / 255.0;
        g = (76.0 + localT * 144.0) / 255.0;
        b = (192.0 + localT * 28.0) / 255.0;
    } else {
        float localT = (t - 0.5) / 0.5;
        r = (220.0 + localT * 9.0) / 255.0;
        g = (220.0 - localT * 184.0) / 255.0;
        b = (220.0 - localT * 161.0) / 255.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_cividis(float t) {
    float r = 0.0, g = 0.0, b = 0.0;
    if (t < 0.5) {
        float localT = t / 0.5;
        r = (0.0 + localT * 84.0) / 255.0;
        g = (33.0 + localT * 79.0) / 255.0;
        b = (84.0 + localT * 53.0) / 255.0;
    } else {
        float localT = (t - 0.5) / 0.5;
        r = (84.0 + localT * 168.0) / 255.0;
        g = (112.0 + localT * 102.0) / 255.0;
        b = (137.0 - localT * 86.0) / 255.0;
    }
    return vec3(r, g, b);
}

vec3 colormap_grayscale(float t) {
    return vec3(t, t, t);
}


void main() {
    if (uIsWireframe > 0) {
        if (uIsWireframe == 1) {
            gl_FragColor = vec4(0.3, 0.3, 0.4, 0.8);
            return;
        }
        
        // Axes Indicator (2=X Red, 3=Y Green, 4=Z Blue)
        vec4 baseColor = vec4(0.0);
        if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
        else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
        else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);

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
    else if (uColormap == 2) color = colormap_rainbow(t);
    else if (uColormap == 3) color = colormap_coolwarm(t);
    else if (uColormap == 4) color = colormap_cividis(t);
    else if (uColormap == 5) color = colormap_grayscale(t);
    else color = colormap_plasma(t);
    
    vec4 finalColor = vec4(color, uAlpha);
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

    if (uShowCellEdges) {
        #ifdef GL_OES_standard_derivatives
        vec2 grid = abs(fract(vTexCoord * vSliceSize - 0.5) - 0.5);
        vec2 threshold = max(fwidth(vTexCoord * vSliceSize), vec2(0.003));
        vec2 distToEdge = grid / threshold;
        float minDist = min(distToEdge.x, distToEdge.y);
        float isEdge = 1.0 - smoothstep(0.4, 1.4, minDist);
        #else
        vec2 grid = fract(vTexCoord * vSliceSize);
        vec2 edge = step(grid, vec2(0.01)) + step(vec2(0.99), grid);
        float isEdge = clamp(edge.x + edge.y, 0.0, 1.0);
        #endif
        finalColor = vec4(mix(finalColor.rgb, vec3(0.0, 0.0, 0.0), isEdge), finalColor.a);
    }
    gl_FragColor = finalColor;
}
`;



function getColormapIndex(name?: string): number {
    switch (name) {
        case 'viridis': return 1;
        case 'rainbow': return 2;
        case 'coolwarm': return 3;
        case 'cividis': return 4;
        case 'grayscale': return 5;
        case 'plasma':
        default: return 0;
    }
}

export function createViewportRenderer() {
let gl: WebGL2RenderingContext | null = null;
let isWebGL2 = true;
let is2DFallback = false;
let ctx2D: CanvasRenderingContext2D | null = null;

let program: WebGLProgram | null = null;
let projectionMatrix = new Float32Array(16);
let viewMatrix = new Float32Array(16);
let modelMatrix = new Float32Array(16);
let hasFloatLinear = false;

let zoom = -3.0;
let rotX = 0.5;
let rotY = 0.5;
let panX = 0.0;
let panY = 0.0;
let cameraEyeX = 0.0;
let cameraEyeY = 0.0;
let cameraEyeZ = 0.0;

let colormap = 0;
let minY = 101325.0;
let maxY = 1000000.0;
let autoScale = true;
let useLogScale = false;
let interpolate = false;
let showGrid = true;
let showCellEdges = false;

let lightingEnabled = true;
let aoEnabled = true;
let specularIntensity = 0.4;
let ambientLevel = 0.3;
let sliceOpacities = [1.0, 1.0, 1.0];
let slicesConfig: any[] = [];

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

let bboxBuffer: WebGLBuffer | null = null;
let axesBuffer: WebGLBuffer | null = null;

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

    if (gl && axesBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, axesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, axesData, gl.DYNAMIC_DRAW);
    }
}

function shouldShowCellEdges(): boolean {
    if (!showCellEdges) return false;
    const maxN = Math.max(nx, ny, nz) || 1;
    const h = gl ? gl.canvas.height : 150;
    const distanceVal = Math.abs(zoom);
    const fov = 45 * Math.PI / 180;
    const modelPixelsVal = h / (2.0 * distanceVal * Math.tan(fov / 2.0));
    const cellPixels = modelPixelsVal / maxN;
    return cellPixels >= 6.0;
}

interface SliceData {
    axis: number; // 0=xy, 1=xz, 2=yz
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

let activeSlices: SliceData[] = [];

// Fallback slice structures
interface SliceData2D {
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
let activeSlices2D: SliceData2D[] = [];

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

function initGL(canvas: HTMLCanvasElement) {
    gl = canvas.getContext("webgl2", { alpha: false, antialias: true }) as any;
    isWebGL2 = true;
    if (!gl) {
        gl = canvas.getContext("webgl", { alpha: false, antialias: true }) as any;
        isWebGL2 = false;
    }
    if (!gl) {
        ctx2D = canvas.getContext("2d") as any;
        if (!ctx2D) {
            throw new Error("Could not initialize WebGL2, WebGL1, or 2D canvas context");
        }
        is2DFallback = true;
        return;
    }

    if (isWebGL2) {
        hasFloatLinear = !!gl.getExtension("OES_texture_float_linear");
    } else {
        gl.getExtension("OES_texture_float");
        hasFloatLinear = !!gl.getExtension("OES_texture_float_linear");
    }

    bboxBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
    const box = new Float32Array([
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
    gl.bufferData(gl.ARRAY_BUFFER, box, gl.STATIC_DRAW);

    axesBuffer = gl.createBuffer();
    updateAxesGeometry();

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
}

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
    const fov = 45 * Math.PI / 180;
    const zNear = Math.max(1e-5, Math.min(0.05, Math.abs(zoom) * 0.1));
    const zFar = 100.0;

    // Perspective matrix
    const f = 1.0 / Math.tan(fov / 2);
    projectionMatrix.fill(0);
    projectionMatrix[0] = f / aspect;
    projectionMatrix[5] = f;
    projectionMatrix[10] = (zFar + zNear) / (zNear - zFar);
    projectionMatrix[11] = -1;
    projectionMatrix[14] = (2 * zFar * zNear) / (zNear - zFar);

    // View matrix
    viewMatrix.set([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        panX, panY, zoom, 1
    ]);

    // Model matrix (Rotation)
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    modelMatrix.set([
        cy, sx*sy, cx*sy, 0,
        0, cx, -sx, 0,
        -sy, sx*cy, cx*cy, 0,
        0, 0, 0, 1
    ]);

    // Camera position in model space
    const distanceVal = Math.abs(zoom);
    cameraEyeX = -sy * distanceVal;
    cameraEyeY = sx * cy * distanceVal;
    cameraEyeZ = cx * cy * distanceVal;
}

let xmin = 0.0;
let ymin = 0.0;
let zmin = 0.0;
let dx = 0.01;
let nx = 64;
let ny = 64;
let nz = 64;

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

    const sliceDataArray = [];
    let offset = 12;
    for (let i = 0; i < numSlices; i++) {
        const axis = view.getUint32(offset, true);
        const zOff = view.getFloat32(offset + 4, true);
        const w = view.getUint32(offset + 8, true);
        const h = view.getUint32(offset + 12, true);
        let numElements = w * h;
        if (axis === 4) {
            const volNz = (Math.round(zOff) > 0) ? Math.round(zOff) : (nz || 64);
            numElements = w * h * volNz;
        }
        const dataStart = offset + 16;
        const floatData = new Float32Array(buffer, dataStart, numElements);

        const config = slicesConfig[i] || {};
        const useAxis = axis;
        const useOffset = zOff;

        const qty = config.quantities?.[0] || 'pressure';
        const sliceAutoScale = config.auto_scale !== false;
        const colormapVal = config.colormap || 'plasma';
        const logVal = config.log_scale === true;
        const interpVal = config.interpolate !== false;

        let sliceMin = Infinity;
        let sliceMax = -Infinity;
        let slicePosMin = Infinity;
        for (let j = 0; j < floatData.length; j++) {
            const v = floatData[j];
            if (isFinite(v)) {
                if (v < sliceMin) sliceMin = v;
                if (v > sliceMax) sliceMax = v;
                if (v > 0 && v < slicePosMin) slicePosMin = v;
            }
        }

        let sliceMinY = minY;
        let sliceMaxY = maxY;

        if (sliceAutoScale) {
            if (sliceMin < sliceMax) {
                if (logVal && sliceMax > 0) {
                    const dynamicFloor = sliceMax / 1000000.0;
                    const effMin = (isFinite(slicePosMin) && slicePosMin > dynamicFloor) ? slicePosMin : dynamicFloor;
                    sliceMinY = effMin;
                    sliceMaxY = sliceMax;
                } else {
                    sliceMinY = sliceMin;
                    sliceMaxY = sliceMax;
                }
            } else {
                const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
                sliceMinY = range[0];
                sliceMaxY = range[1];
            }
        } else {
            const range = config.min_val !== undefined && config.max_val !== undefined ? [config.min_val, config.max_val] : (DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0]);
            sliceMinY = range[0];
            sliceMaxY = range[1];
        }

        sliceDataArray.push({
            axis: useAxis,
            offset: useOffset,
            w,
            h,
            floatData,
            minY: sliceMinY,
            maxY: sliceMaxY,
            colormap: colormapVal,
            useLogScale: logVal,
            interpolate: interpVal
        });

        offset = dataStart + (numElements * 4);
    }

    if (is2DFallback) {
        activeSlices2D = sliceDataArray.map(s => ({
            axis: s.axis,
            offset: s.offset,
            w: s.w,
            h: s.h,
            data: new Float32Array(s.floatData),
            minY: s.minY,
            maxY: s.maxY,
            colormap: s.colormap,
            useLogScale: s.useLogScale,
            interpolate: s.interpolate
        }));
        return;
    }

    if (!gl) return;

    // Simple state cleanup for count mismatch
    if (activeSlices.length !== numSlices) {
        activeSlices.forEach(s => {
            gl!.deleteTexture(s.texture);
            gl!.deleteBuffer(s.buffer);
        });
        activeSlices = [];
    }

    const internalFormat = isWebGL2 ? gl.R32F : gl.LUMINANCE;
    const format = isWebGL2 ? gl.RED : gl.LUMINANCE;

    sliceDataArray.forEach((sliceObj, i) => {
        const opacity = sliceOpacities[i] !== undefined ? sliceOpacities[i] : 1.0;
        let slice: SliceData;
        if (activeSlices[i]) {
            slice = activeSlices[i];
            gl!.bindTexture(gl!.TEXTURE_2D, slice.texture);
            gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, sliceObj.w, sliceObj.h, 0, format, gl!.FLOAT, sliceObj.floatData);

            gl!.bindBuffer(gl!.ARRAY_BUFFER, slice.buffer);
            gl!.bufferData(gl!.ARRAY_BUFFER, getSliceGeometry(sliceObj.axis, sliceObj.offset, sliceObj.w, sliceObj.h), gl!.STATIC_DRAW);

            slice.axis = sliceObj.axis;
            slice.offset = sliceObj.offset;
            slice.w = sliceObj.w;
            slice.h = sliceObj.h;
            slice.opacity = opacity;
            slice.minY = sliceObj.minY;
            slice.maxY = sliceObj.maxY;
            slice.colormap = sliceObj.colormap;
            slice.useLogScale = sliceObj.useLogScale;
            slice.interpolate = sliceObj.interpolate;
        } else {
            const tex = gl!.createTexture()!;
            gl!.bindTexture(gl!.TEXTURE_2D, tex);
            const filter = hasFloatLinear ? gl!.LINEAR : gl!.NEAREST;
            gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
            gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
            gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
            gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
            gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, sliceObj.w, sliceObj.h, 0, format, gl!.FLOAT, sliceObj.floatData);

            const buf = gl!.createBuffer()!;
            gl!.bindBuffer(gl!.ARRAY_BUFFER, buf);
            gl!.bufferData(gl!.ARRAY_BUFFER, getSliceGeometry(sliceObj.axis, sliceObj.offset, sliceObj.w, sliceObj.h), gl!.STATIC_DRAW);

            slice = {
                axis: sliceObj.axis,
                offset: sliceObj.offset,
                w: sliceObj.w,
                h: sliceObj.h,
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
            activeSlices.push(slice);
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

    ctx2D.fillStyle = "#ff5555";
    ctx2D.font = "12px monospace";
    ctx2D.fillText("WebGL Unsupported: Showing raw 2D slice.", 10, height - 10);

    if (activeSlices2D.length > 0) {
        const slice = activeSlices2D[0];
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = slice.w;
        tempCanvas.height = slice.h;
        const tempCtx = tempCanvas.getContext("2d")!;
        const imgData = tempCtx.createImageData(slice.w, slice.h);
        
        const sliceMinY = slice.minY ?? minY;
        const sliceMaxY = slice.maxY ?? maxY;
        const sliceLogScale = slice.useLogScale === true;
        const sliceColormap = slice.colormap || 'plasma';

        for (let i = 0; i < slice.w * slice.h; i++) {
            const val = slice.data[i];
            let t = 0.0;
            if (sliceLogScale) {
                const logMin = Math.log(Math.max(sliceMinY, 1e-5));
                const logMax = Math.log(Math.max(sliceMaxY, 1e-5));
                const logVal = Math.log(Math.max(val, 1e-5));
                const logDenom = logMax - logMin;
                t = Math.max(0.0, Math.min(1.0, (logVal - logMin) / (logDenom < 1e-5 ? 1e-5 : logDenom)));
            } else {
                const denom = sliceMaxY - sliceMinY;
                t = Math.max(0.0, Math.min(1.0, (val - sliceMinY) / (denom < 1e-5 ? 1e-5 : denom)));
            }
            let r = 0, g = 0, b = 0;
            if (sliceColormap === 'viridis') {
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
            imgData.data[i * 4 + 3] = 255;
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
        // Stride is 20 (5 floats * 4 bytes)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.drawArrays(gl.LINES, 0, 24);
    }

    // Draw Axes Indicator (disabled to draw tick labels on bounding box instead)
    /*
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
    */

    gl.uniform1i(uIsWF, 0);
    const uShowEdges = gl.getUniformLocation(program, "uShowCellEdges");
    if (uShowEdges !== null) {
        gl.uniform1i(uShowEdges, shouldShowCellEdges() ? 1 : 0);
    }
    const uInterp = gl.getUniformLocation(program, "uInterpolate");
    if (uInterp !== null) {
        gl.uniform1i(uInterp, interpolate ? 1 : 0);
    }

    const slicesArrayWebGL = [...activeSlices];
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
            gl!.uniform1i(uColormap, getColormapIndex(slice.colormap));
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
                gl!.uniform1i(uColormap, getColormapIndex(slice.colormap));
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



    return {
        postMessage: (msg: any) => {
            const e = { data: msg };
    try {
        const { type, data } = e.data;
        if (type === "init") {
            const canvas = data.canvas as HTMLCanvasElement;
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            canvas.width = w;
            canvas.height = h;
            initGL(canvas);
            updateMatrices(w, h);
            render();
        } else if (type === "resize") {
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            if (is2DFallback && ctx2D) {
                ctx2D.canvas.width = w;
                ctx2D.canvas.height = h;
            } else if (gl) {
                gl.canvas.width = w;
                gl.canvas.height = h;
                gl.viewport(0, 0, w, h);
            }
            updateMatrices(w, h);
            render();
        } else if (type === "input") {
            if (data.dy) zoom = Math.max(-10, Math.min(-0.0001, zoom + data.dy * 0.01));
            if (data.drx) rotX += data.drx * 0.01;
            if (data.dry) rotY += data.dry * 0.01;
            if (data.dpx !== undefined) {
                panX += data.dpx * 0.005;
                console.log("[ViewportRenderer] Panning X:", panX, "dx:", data.dpx);
            }
            if (data.dpy !== undefined) {
                panY -= data.dpy * 0.005;
                console.log("[ViewportRenderer] Panning Y:", panY, "dy:", data.dpy);
            }
            if (is2DFallback && ctx2D) {
                updateMatrices(ctx2D.canvas.width, ctx2D.canvas.height);
            } else if (gl) {
                updateMatrices(gl.canvas.width, gl.canvas.height);
            }
            render();
        } else if (type === "setView") {
            if (data.rotX !== undefined) rotX = data.rotX;
            if (data.rotY !== undefined) rotY = data.rotY;
            if (data.zoom !== undefined) zoom = data.zoom;
            if (data.panX !== undefined) panX = data.panX;
            if (data.panY !== undefined) panY = data.panY;
            if (is2DFallback && ctx2D) {
                updateMatrices(ctx2D.canvas.width, ctx2D.canvas.height);
            } else if (gl) {
                updateMatrices(gl.canvas.width, gl.canvas.height);
            }
            render();
        } else if (type === "frame") {
            handleFrame(data.buffer);
            render();
        } else if (type === "setConfig") {
            if (data.colormap !== undefined) {
                colormap = getColormapIndex(data.colormap);
            }
            if (data.minY !== undefined) minY = data.minY;
            if (data.maxY !== undefined) maxY = data.maxY;
            if (data.autoScale !== undefined) autoScale = data.autoScale;
            if (data.useLogScale !== undefined) useLogScale = data.useLogScale;
            if (data.interpolate !== undefined) interpolate = data.interpolate;
            if (data.showGrid !== undefined) showGrid = data.showGrid;
            if (data.showCellEdges !== undefined) showCellEdges = data.showCellEdges;
            if (data.lightingEnabled !== undefined) lightingEnabled = data.lightingEnabled;
            if (data.aoEnabled !== undefined) aoEnabled = data.aoEnabled;
            if (data.specularIntensity !== undefined) specularIntensity = data.specularIntensity;
            if (data.ambientLevel !== undefined) ambientLevel = data.ambientLevel;
            if (data.sliceOpacities !== undefined) sliceOpacities = data.sliceOpacities;
            if (data.slices !== undefined) {
                slicesConfig = data.slices;
                slicesConfig.forEach((config: any, i: number) => {
                    if (activeSlices[i]) {
                        const targetAxis = config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2;
                        if (targetAxis === activeSlices[i].axis) {
                            activeSlices[i].offset = config.offset;
                            if (gl) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, activeSlices[i].buffer);
                                gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(activeSlices[i].axis, activeSlices[i].offset, activeSlices[i].w, activeSlices[i].h), gl.STATIC_DRAW);
                            }
                        }
                        activeSlices[i].opacity = config.opacity !== undefined ? config.opacity : 1.0;
                        activeSlices[i].colormap = config.colormap || 'plasma';
                        activeSlices[i].useLogScale = config.log_scale === true;
                        activeSlices[i].interpolate = config.interpolate !== false;
                        activeSlices[i].minY = config.min_val;
                        activeSlices[i].maxY = config.max_val;
                    }
                    if (activeSlices2D[i]) {
                        const targetAxis = config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2;
                        if (targetAxis === activeSlices2D[i].axis) {
                            activeSlices2D[i].offset = config.offset;
                        }
                        activeSlices2D[i].colormap = config.colormap || 'plasma';
                        activeSlices2D[i].useLogScale = config.log_scale === true;
                        activeSlices2D[i].minY = config.min_val;
                        activeSlices2D[i].maxY = config.max_val;
                    }
                });
            }

            if (data.xmin !== undefined) xmin = data.xmin;
            if (data.ymin !== undefined) ymin = data.ymin;
            if (data.zmin !== undefined) zmin = data.zmin;
            if (data.dx !== undefined) dx = data.dx;
            if (data.nx !== undefined) nx = data.nx;
            if (data.ny !== undefined) ny = data.ny;
            if (data.nz !== undefined) nz = data.nz;
            updateAxesGeometry();
            render();
        }
    } catch (err: any) {
        console.error("ViewportRenderer Error:", err);
    }
        }
    };
}
