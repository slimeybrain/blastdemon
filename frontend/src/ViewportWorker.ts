const VS_SOURCE = `#version 300 es
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

const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uIsWireframe;

out vec4 outColor;

vec3 colormap_plasma(float t) {
    return vec3(t * 1.5, t * t, 1.0 - t);
}

vec3 colormap_viridis(float t) {
    return vec3(1.0 - t, t, 0.5 + 0.5 * t);
}

void main() {
    float raw = texture(uTexture, vTexCoord).r;
    float t = clamp((raw - uMin) / (uMax - uMin), 0.0, 1.0);

    vec3 color;
    if (uIsWireframe) {
        outColor = vec4(0.3, 0.3, 0.4, 1.0);
        return;
    }

    if (uColormap == 1) color = colormap_viridis(t);
    else color = colormap_plasma(t);

    outColor = vec4(color, uAlpha);
}
`;

let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let projectionMatrix = new Float32Array(16);
let viewMatrix = new Float32Array(16);
let modelMatrix = new Float32Array(16);

let zoom = -3.0;
let rotX = 0.5;
let rotY = 0.5;

let colormap = 0;
let minY = 101325.0;
let maxY = 1000000.0;

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

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
    }
    return shader;
}

function initGL(canvas: OffscreenCanvas) {
    gl = canvas.getContext("webgl2", { alpha: false, antialias: true }) as WebGL2RenderingContext;
    if (!gl) return;

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

    const vs = createShader(gl, gl.VERTEX_SHADER, VS_SOURCE);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE);
    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

function updateMatrices(width: number, height: number) {
    if (!gl) return;
    const aspect = width / height;
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
        0, 0, zoom, 1
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

function getSliceGeometry(axis: number, offset: number) {
    const z = offset - 0.5;
    if (axis === 0) { // XY
        return new Float32Array([
            -0.5, -0.5, z,  0, 0,
             0.5, -0.5, z,  1, 0,
             0.5,  0.5, z,  1, 1,
            -0.5, -0.5, z,  0, 0,
             0.5,  0.5, z,  1, 1,
            -0.5,  0.5, z,  0, 1
        ]);
    } else if (axis === 1) { // XZ
        return new Float32Array([
            -0.5, z, -0.5,  0, 0,
             0.5, z, -0.5,  1, 0,
             0.5, z,  0.5,  1, 1,
            -0.5, z, -0.5,  0, 0,
             0.5, z,  0.5,  1, 1,
            -0.5, z,  0.5,  0, 1
        ]);
    } else { // YZ
        return new Float32Array([
            z, -0.5, -0.5,  0, 0,
            z,  0.5, -0.5,  1, 0,
            z,  0.5,  0.5,  1, 1,
            z, -0.5, -0.5,  0, 0,
            z,  0.5,  0.5,  1, 1,
            z, -0.5,  0.5,  0, 1
        ]);
    }
}

function handleFrame(buffer: ArrayBuffer) {
    if (!gl) return;
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x43494c53) return; // "SLIC"

    const time = view.getFloat32(4, true);
    const numSlices = view.getUint32(8, true);

    // Simple state cleanup for count mismatch
    if (activeSlices.length !== numSlices) {
        activeSlices.forEach(s => {
            gl!.deleteTexture(s.texture);
            gl!.deleteBuffer(s.buffer);
        });
        activeSlices = [];
    }

    let offset = 12;
    for (let i = 0; i < numSlices; i++) {
        const axis = view.getUint32(offset, true);
        const zOff = view.getFloat32(offset + 4, true);
        const w = view.getUint32(offset + 8, true);
        const h = view.getUint32(offset + 12, true);
        const dataStart = offset + 16;
        const floatData = new Float32Array(buffer, dataStart, w * h);

        let slice: SliceData;
        if (activeSlices[i]) {
            slice = activeSlices[i];
            gl.bindTexture(gl.TEXTURE_2D, slice.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, floatData);

            gl.bindBuffer(gl.ARRAY_BUFFER, slice.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff), gl.STATIC_DRAW);
        } else {
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, floatData);

            const buf = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, getSliceGeometry(axis, zOff), gl.STATIC_DRAW);

            slice = { axis, offset: zOff, w, h, texture: tex, buffer: buf };
            activeSlices.push(slice);
        }
        offset = dataStart + (w * h * 4);
    }
}

function render() {
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

    // Draw BBox
    gl.uniform1i(uIsWF, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(0);
    gl.drawArrays(gl.LINES, 0, 24);

    gl.uniform1i(uIsWF, 0);
    activeSlices.forEach(slice => {
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, slice.texture);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, slice.buffer);

        gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 20, 0);
        gl!.enableVertexAttribArray(0);
        gl!.vertexAttribPointer(1, 2, gl!.FLOAT, false, 20, 12);
        gl!.enableVertexAttribArray(1);

        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
    });
}

self.onmessage = (e) => {
    const { type, data } = e.data;
    if (type === "init") {
        initGL(data.canvas);
        updateMatrices(data.width, data.height);
        render();
    } else if (type === "resize") {
        if (gl) gl.viewport(0, 0, data.width, data.height);
        updateMatrices(data.width, data.height);
        render();
    } else if (type === "input") {
        if (data.dy) zoom = Math.max(-10, Math.min(-0.5, zoom + data.dy * 0.01));
        if (data.drx) rotX += data.drx * 0.01;
        if (data.dry) rotY += data.dry * 0.01;
        updateMatrices(gl!.canvas.width, gl!.canvas.height);
        render();
    } else if (type === "frame") {
        handleFrame(data.buffer);
        render();
    } else if (type === "setConfig") {
        if (data.colormap !== undefined) colormap = data.colormap;
        if (data.minY !== undefined) minY = data.minY;
        if (data.maxY !== undefined) maxY = data.maxY;
        render();
    }
};
