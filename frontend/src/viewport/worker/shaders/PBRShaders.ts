/**
 * PBRShaders.ts
 * Physically-Based Rendering (PBR) Cook-Torrance microfacet BRDF shaders in WGSL and GLSL.
 * Implements GGX normal distribution, Schlick-GGX geometric shadowing, and Schlick Fresnel.
 */

export const WGSL_PBR_FUNCTIONS = `
const PI: f32 = 3.14159265359;

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    let denom = (NdotH2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom + 1e-5);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = (roughness + 1.0);
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k + 1e-5);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let ggx2 = geometrySchlickGGX(NdotV, roughness);
    let ggx1 = geometrySchlickGGX(NdotL, roughness);
    return ggx1 * ggx2;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn computePBRLighting(
    worldPos: vec3<f32>,
    normal: vec3<f32>,
    viewPos: vec3<f32>,
    lightPos: vec3<f32>,
    lightColor: vec3<f32>,
    albedo: vec3<f32>,
    metallic: f32,
    roughness: f32,
    ao: f32
) -> vec3<f32> {
    let N = normalize(normal);
    let V = normalize(viewPos - worldPos);
    let L = normalize(lightPos - worldPos);
    let H = normalize(V + L);

    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);

    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let numerator = NDF * G * F;
    let denominator = 4.0 * NdotV * NdotL + 1e-5;
    let specular = numerator / denominator;

    let kS = F;
    let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);

    let diffuse = kD * albedo / PI;
    let radiance = lightColor;

    let Lo = (diffuse + specular) * radiance * NdotL;
    let ambient = vec3<f32>(0.03) * albedo * ao;
    return ambient + Lo;
}
`;

export const GLSL_PBR_FUNCTIONS = `
const float PI = 3.14159265359;

float distributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom + 1e-5);
}

float geometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k + 1e-5);
}

float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2 = geometrySchlickGGX(NdotV, roughness);
    float ggx1 = geometrySchlickGGX(NdotL, roughness);
    return ggx1 * ggx2;
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
    return F0 + (vec3(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 computePBRLighting(
    vec3 worldPos,
    vec3 normal,
    vec3 viewPos,
    vec3 lightPos,
    vec3 lightColor,
    vec3 albedo,
    float metallic,
    float roughness,
    float ao
) {
    vec3 N = normalize(normal);
    vec3 V = normalize(viewPos - worldPos);
    vec3 L = normalize(lightPos - worldPos);
    vec3 H = normalize(V + L);

    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    float NdotL = max(dot(N, L), 0.0);
    float NdotV = max(dot(N, V), 0.0);

    float NDF = distributionGGX(N, H, roughness);
    float G = geometrySmith(N, V, L, roughness);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    vec3 numerator = NDF * G * F;
    float denominator = 4.0 * NdotV * NdotL + 1e-5;
    vec3 specular = numerator / denominator;

    vec3 kS = F;
    vec3 kD = (vec3(1.0) - kS) * (1.0 - metallic);

    vec3 diffuse = kD * albedo / PI;
    vec3 Lo = (diffuse + specular) * lightColor * NdotL;
    vec3 ambient = vec3(0.03) * albedo * ao;
    return ambient + Lo;
}
`;
