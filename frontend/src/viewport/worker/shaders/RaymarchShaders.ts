/**
 * RaymarchShaders.ts
 * Volumetric raymarching shader functions for 3D Eulerian shock waves, smoke, and emissive fireball core glow.
 */

export const WGSL_RAYMARCH_FUNCTIONS = `
struct RaymarchParams {
    stepSize: f32,
    densityScale: f32,
    absorption: f32,
    fireballEmission: f32,
};

fn sampleVolumeDensity(tex: texture_3d<f32>, samp: sampler, uvw: vec3<f32>) -> f32 {
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) {
        return 0.0;
    }
    return textureSampleLevel(tex, samp, uvw, 0.0).r;
}

fn raymarchVolume(
    tex: texture_3d<f32>,
    samp: sampler,
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    boxMin: vec3<f32>,
    boxMax: vec3<f32>,
    params: RaymarchParams
) -> vec4<f32> {
    // Ray-box intersection
    let invDir = 1.0 / (rayDir + vec3<f32>(1e-6));
    let t0 = (boxMin - rayOrigin) * invDir;
    let t1 = (boxMax - rayOrigin) * invDir;
    let tmin_v = min(t0, t1);
    let tmax_v = max(t0, t1);
    let tEnter = max(max(tmin_v.x, tmin_v.y), tmin_v.z);
    let tExit = min(min(tmax_v.x, tmax_v.y), tmax_v.z);

    if (tEnter >= tExit || tExit < 0.0) {
        return vec4<f32>(0.0);
    }

    let startT = max(tEnter, 0.0);
    let boxSize = boxMax - boxMin;
    var currentT = startT;
    var accumulatedColor = vec4<f32>(0.0);

    for (var i = 0; i < 128; i++) {
        if (currentT >= tExit || accumulatedColor.a >= 0.98) {
            break;
        }

        let pos = rayOrigin + rayDir * currentT;
        let uvw = (pos - boxMin) / boxSize;
        let density = sampleVolumeDensity(tex, samp, uvw) * params.densityScale;

        if (density > 0.01) {
            let opacity = 1.0 - exp(-density * params.stepSize * params.absorption);
            
            // Core fireball emission color ramp
            var emissionColor = vec3<f32>(1.0, 0.5, 0.1);
            if (density > 0.8) {
                emissionColor = vec3<f32>(1.0, 0.95, 0.7); // Bright white-hot core
            } else if (density > 0.4) {
                emissionColor = vec3<f32>(1.0, 0.3, 0.05); // Flaming orange
            } else {
                emissionColor = vec3<f32>(0.2, 0.2, 0.2);  // Expanding smoke plume
            }

            let sliceColor = vec4<f32>(emissionColor * params.fireballEmission, opacity);
            accumulatedColor = accumulatedColor + sliceColor * (1.0 - accumulatedColor.a);
        }

        currentT += params.stepSize;
    }

    return accumulatedColor;
}
`;

export const GLSL_RAYMARCH_FUNCTIONS = `
struct RaymarchParams {
    float stepSize;
    float densityScale;
    float absorption;
    float fireballEmission;
};

vec4 raymarchVolumeGLSL(
    sampler3D tex,
    vec3 rayOrigin,
    vec3 rayDir,
    vec3 boxMin,
    vec3 boxMax,
    RaymarchParams params
) {
    vec3 invDir = 1.0 / (rayDir + vec3(1e-6));
    vec3 t0 = (boxMin - rayOrigin) * invDir;
    vec3 t1 = (boxMax - rayOrigin) * invDir;
    vec3 tmin_v = min(t0, t1);
    vec3 tmax_v = max(t0, t1);
    float tEnter = max(max(tmin_v.x, tmin_v.y), tmin_v.z);
    float tExit = min(min(tmax_v.x, tmax_v.y), tmax_v.z);

    if (tEnter >= tExit || tExit < 0.0) return vec4(0.0);

    float startT = max(tEnter, 0.0);
    vec3 boxSize = boxMax - boxMin;
    float currentT = startT;
    vec4 accumulatedColor = vec4(0.0);

    for (int i = 0; i < 128; i++) {
        if (currentT >= tExit || accumulatedColor.a >= 0.98) break;

        vec3 pos = rayOrigin + rayDir * currentT;
        vec3 uvw = (pos - boxMin) / boxSize;
        if (uvw.x >= 0.0 && uvw.x <= 1.0 && uvw.y >= 0.0 && uvw.y <= 1.0 && uvw.z >= 0.0 && uvw.z <= 1.0) {
            float density = texture(tex, uvw).r * params.densityScale;
            if (density > 0.01) {
                float opacity = 1.0 - exp(-density * params.stepSize * params.absorption);
                vec3 emissionColor = vec3(1.0, 0.5, 0.1);
                if (density > 0.8) {
                    emissionColor = vec3(1.0, 0.95, 0.7);
                } else if (density > 0.4) {
                    emissionColor = vec3(1.0, 0.3, 0.05);
                } else {
                    emissionColor = vec3(0.2, 0.2, 0.2);
                }
                vec4 sliceColor = vec4(emissionColor * params.fireballEmission, opacity);
                accumulatedColor += sliceColor * (1.0 - accumulatedColor.a);
            }
        }
        currentT += params.stepSize;
    }
    return accumulatedColor;
}
`;
