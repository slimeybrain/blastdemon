// ViewportWorker.ts
export {};

const VS_SOURCE_2 = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec2 texCoord;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
out vec2 vTexCoord;
void main() {
    gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
    vTexCoord = texCoord;
}
`;

const FS_SOURCE_2 = `#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uIsWireframe;
uniform vec2 uSliceSize;
uniform bool uInterpolate;
out vec4 outColor;

vec3 colormap_plasma(float t) {
    return vec3(t * 1.5, t * t, 1.0 - t);
}

vec3 colormap_viridis(float t) {
    return vec3(1.0 - t, t, 0.5 + 0.5 * t);
}

void main() {
    if (uIsWireframe) {
        outColor = vec4(0.3, 0.3, 0.4, 1.0);
        return;
    }
    vec2 uv = vTexCoord;
    if (!uInterpolate) {
        vec2 texel = floor(vTexCoord * uSliceSize);
        uv = (texel + vec2(0.5)) / uSliceSize;
    }
    float raw = texture(uTexture, uv).r;
    float t = clamp((raw - uMin) / (uMax - uMin), 0.0, 1.0);
    vec3 color;
    if (uColormap == 1) color = colormap_viridis(t);
    else color = colormap_plasma(t);
    outColor = vec4(color, uAlpha);
}
`;

const VS_SOURCE_1 = `
attribute vec3 position;
attribute vec2 texCoord;
varying vec2 vTexCoord;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
void main() {
    gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
    vTexCoord = texCoord;
}
`;

const FS_SOURCE_1 = `
precision highp float;
varying vec2 vTexCoord;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uIsWireframe;
uniform vec2 uSliceSize;
uniform bool uInterpolate;

vec3 colormap_plasma(float t) {
    return vec3(t * 1.5, t * t, 1.0 - t);
}

vec3 colormap_viridis(float t) {
    return vec3(1.0 - t, t, 0.5 + 0.5 * t);
}

void main() {
    if (uIsWireframe) {
        gl_FragColor = vec4(0.3, 0.3, 0.4, 1.0);
        return;
    }
    vec2 uv = vTexCoord;
    if (!uInterpolate) {
        vec2 texel = floor(vTexCoord * uSliceSize);
        uv = (texel + vec2(0.5)) / uSliceSize;
    }
    float raw = texture2D(uTexture, uv).r;
    float t = clamp((raw - uMin) / (uMax - uMin), 0.0, 1.0);
    vec3 color;
    if (uColormap == 1) color = colormap_viridis(t);
    else color = colormap_plasma(t);
    gl_FragColor = vec4(color, uAlpha);
}
`;


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

let colormap = 0;
let minY = 101325.0;
let maxY = 1000000.0;
let autoScale = true;
let interpolate = false;

let bboxBuffer: WebGLBuffer | null = null;

interface SliceData {
    axis: number; // 0=xy, 1=xz, 2=yz
    offset: number;
    w: number;
    h: number;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
}

let activeSlices: SliceData[] = [];

// Fallback slice structures
interface SliceData2D {
    axis: number;
    offset: number;
    w: number;
    h: number;
    data: Float32Array;
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

function updateMatrices(width: number, height: number) {
    const w = width > 0 ? width : 1;
    const h = height > 0 ? height : 1;
    const aspect = w / h;
    const fov = 45 * Math.PI / 180;
    const zNear = 0.1;
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
}

let xmin = 0.0;
let ymin = 0.0;
let zmin = 0.0;
let dx = 0.01;
let nx = 64;
let ny = 64;
let nz = 64;

function getSliceGeometry(axis: number, offset: number) {
    if (axis === 0) { // XY
        const dimZ = (nz && dx) ? (nz * dx) : 1.0;
        const z = (offset - zmin) / dimZ - 0.5;
        return new Float32Array([
            -0.5, -0.5, z,  0, 0,
             0.5, -0.5, z,  1, 0,
             0.5,  0.5, z,  1, 1,
            -0.5, -0.5, z,  0, 0,
             0.5,  0.5, z,  1, 1,
            -0.5,  0.5, z,  0, 1
        ]);
    } else if (axis === 1) { // XZ
        const dimY = (ny && dx) ? (ny * dx) : 1.0;
        const y = (offset - ymin) / dimY - 0.5;
        return new Float32Array([
            -0.5, y, -0.5,  0, 0,
             0.5, y, -0.5,  1, 0,
             0.5, y,  0.5,  1, 1,
            -0.5, y, -0.5,  0, 0,
             0.5, y,  0.5,  1, 1,
            -0.5, y,  0.5,  0, 1
        ]);
    } else { // YZ
        const dimX = (nx && dx) ? (nx * dx) : 1.0;
        const x = (offset - xmin) / dimX - 0.5;
        return new Float32Array([
            x, -0.5, -0.5,  0, 0,
            x,  0.5, -0.5,  1, 0,
            x,  0.5,  0.5,  1, 1,
            x, -0.5, -0.5,  0, 0,
            x,  0.5,  0.5,  1, 1,
            x, -0.5,  0.5,  0, 1
        ]);
    }
}

function handleFrame(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x43494c53) return; // "SLIC"

    const time = view.getFloat32(4, true);
    const numSlices = view.getUint32(8, true);

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

            if (autoScale) {
                let minVal = Infinity;
                let maxVal = -Infinity;
                for (let j = 0; j < floatData.length; j++) {
                    const v = floatData[j];
                    if (isFinite(v)) {
                        if (v < minVal) minVal = v;
                        if (v > maxVal) maxVal = v;
                    }
                }
                if (minVal < maxVal) {
                    minY = minVal;
                    maxY = maxVal;
                }
            }
        }
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

    let offset = 12;
    for (let i = 0; i < numSlices; i++) {
        const axis = view.getUint32(offset, true);
        const zOff = view.getFloat32(offset + 4, true);
        const w = view.getUint32(offset + 8, true);
        const h = view.getUint32(offset + 12, true);
        const dataStart = offset + 16;
        const floatData = new Float32Array(buffer, dataStart, w * h);

        if (autoScale) {
            let minVal = Infinity;
            let maxVal = -Infinity;
            for (let j = 0; j < floatData.length; j++) {
                const v = floatData[j];
                if (isFinite(v)) {
                    if (v < minVal) minVal = v;
                    if (v > maxVal) maxVal = v;
                }
            }
            if (minVal < maxVal) {
                minY = minVal;
                maxY = maxVal;
            }
        }

        let slice: SliceData;
        if (activeSlices[i]) {
            slice = activeSlices[i];
            gl.bindTexture(gl.TEXTURE_2D, slice.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.FLOAT, floatData);

            gl.bindBuffer(gl.ARRAY_BUFFER, slice.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff), gl.STATIC_DRAW);
        } else {
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            const filter = hasFloatLinear ? gl.LINEAR : gl.NEAREST;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.FLOAT, floatData);

            const buf = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff), gl.STATIC_DRAW);

            slice = { axis, offset: zOff, w, h, texture: tex, buffer: buf };
            activeSlices.push(slice);
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
        
        for (let i = 0; i < slice.w * slice.h; i++) {
            const val = slice.data[i];
            const t = Math.max(0.0, Math.min(1.0, (val - minY) / (maxY - minY)));
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
    const uIsWF = gl.getUniformLocation(program, "uIsWireframe");

    gl.uniformMatrix4fv(uProj, false, projectionMatrix);
    gl.uniform1i(uColormap, colormap);
    gl.uniform1f(uMin, minY);
    gl.uniform1f(uMax, maxY);
    gl.uniformMatrix4fv(uView, false, viewMatrix);
    gl.uniformMatrix4fv(uModel, false, modelMatrix);
    gl.uniform1f(uAlpha, 0.7);

    const uInterp = gl.getUniformLocation(program, "uInterpolate");
    if (uInterp !== null) {
        gl.uniform1i(uInterp, interpolate ? 1 : 0);
    }

    // Draw BBox
    gl.uniform1i(uIsWF, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(gl.LINES, 0, 24);

    gl.uniform1i(uIsWF, 0);
    const uSliceSizeLoc = gl.getUniformLocation(program, "uSliceSize");
    activeSlices.forEach(slice => {
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, slice.texture);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, slice.buffer);
        if (uSliceSizeLoc !== null) {
            gl!.uniform2f(uSliceSizeLoc, slice.w, slice.h);
        }

        gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 20, 0);
        gl!.enableVertexAttribArray(0);
        gl!.vertexAttribPointer(1, 2, gl!.FLOAT, false, 20, 12);
        gl!.enableVertexAttribArray(1);

        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
    });
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
            if (data.dy) zoom = Math.max(-10, Math.min(-0.5, zoom + data.dy * 0.01));
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
                if (data.colormap === 'viridis') colormap = 1;
                else colormap = 0;
            }
            if (data.minY !== undefined) minY = data.minY;
            if (data.maxY !== undefined) maxY = data.maxY;
            if (data.autoScale !== undefined) autoScale = data.autoScale;
            if (data.interpolate !== undefined) interpolate = data.interpolate;
            if (data.xmin !== undefined) xmin = data.xmin;
            if (data.ymin !== undefined) ymin = data.ymin;
            if (data.zmin !== undefined) zmin = data.zmin;
            if (data.dx !== undefined) dx = data.dx;
            if (data.nx !== undefined) nx = data.nx;
            if (data.ny !== undefined) ny = data.ny;
            if (data.nz !== undefined) nz = data.nz;
            render();
        }
    } catch (err: any) {
        console.error("ViewportRenderer Error:", err);
    }
        }
    };
}
