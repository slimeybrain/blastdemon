export function rotateVectorAroundAxis(v: number[], axis: number[], angle: number): number[] {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const dotP = axis[0]*v[0] + axis[1]*v[1] + axis[2]*v[2];
    const crossP = [
        axis[1]*v[2] - axis[2]*v[1],
        axis[2]*v[0] - axis[0]*v[2],
        axis[0]*v[1] - axis[1]*v[0]
    ];
    return [
        v[0]*cosA + crossP[0]*sinA + axis[0]*dotP*(1.0 - cosA),
        v[1]*cosA + crossP[1]*sinA + axis[1]*dotP*(1.0 - cosA),
        v[2]*cosA + crossP[2]*sinA + axis[2]*dotP*(1.0 - cosA)
    ];
}

export function rotatePointEuler(u: number, v: number, w: number, ax: number, ay: number, az: number): [number, number, number] {
    if (ax === 0 && ay === 0 && az === 0) return [u, v, w];
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);

    // Step 1: Rotate by +ax around X
    const u1 = u;
    const v1 = cx * v - sx * w;
    const w1 = sx * v + cx * w;

    // Step 2: Rotate by +ay around Y
    const u2 = cy * u1 + sy * w1;
    const v2 = v1;
    const w2 = -sy * u1 + cy * w1;

    // Step 3: Rotate by +az around Z
    const u_rot = cz * u2 - sz * v2;
    const v_rot = sz * u2 + cz * v2;
    const w_rot = w2;

    return [u_rot, v_rot, w_rot];
}

export function invRotatePointEuler(u: number, v: number, w: number, ax: number, ay: number, az: number): [number, number, number] {
    if (ax === 0 && ay === 0 && az === 0) return [u, v, w];
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    const cz = Math.cos(az), sz = Math.sin(az);

    // Step 1: Inverse rotation around Z (-az)
    const u1 = cz * u + sz * v;
    const v1 = -sz * u + cz * v;
    const w1 = w;

    // Step 2: Inverse rotation around Y (-ay)
    const u2 = cy * u1 - sy * w1;
    const v2 = v1;
    const w2 = sy * u1 + cy * w1;

    // Step 3: Inverse rotation around X (-ax)
    const u_rot = u2;
    const v_rot = cx * v2 + sx * w2;
    const w_rot = -sx * v2 + cx * w2;

    return [u_rot, v_rot, w_rot];
}

export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
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

export function invertMatrix4(m: Float32Array): Float32Array | null {
    const inv = new Float32Array(16);
    inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8]  =  m[4]*m[9] *m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9] *m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];

    inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9]  = -m[0]*m[9] *m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] =  m[0]*m[9] *m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];

    inv[2]  =  m[1]*m[6] *m[15] - m[1]*m[7] *m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
    inv[6]  = -m[0]*m[6] *m[15] + m[0]*m[7] *m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
    inv[10] =  m[0]*m[5] *m[15] - m[0]*m[7] *m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5] *m[14] + m[0]*m[6] *m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];

    inv[3]  = -m[1]*m[6] *m[11] + m[1]*m[7] *m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9] *m[2]*m[7]  + m[9] *m[3]*m[6];
    inv[7]  =  m[0]*m[6] *m[11] - m[0]*m[7] *m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8] *m[2]*m[7]  - m[8] *m[3]*m[6];
    inv[11] = -m[0]*m[5] *m[11] + m[0]*m[7] *m[9]  + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8] *m[1]*m[7]  + m[8] *m[3]*m[5];
    inv[15] =  m[0]*m[5] *m[10] - m[0]*m[6] *m[9]  - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8] *m[1]*m[6]  - m[8] *m[2]*m[5];

    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (det === 0) return null;
    det = 1.0 / det;

    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
        out[i] = inv[i] * det;
    }
    return out;
}
