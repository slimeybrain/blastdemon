/**
 * ColormapShaders.ts
 * Scientific colormaps (plasma, viridis, rainbow, coolwarm, cividis, grayscale) in GLSL and WGSL.
 */

export function getColormapIndex(name?: string): number {
    switch (name?.toLowerCase()) {
        case 'plasma': return 0;
        case 'viridis': return 1;
        case 'coolwarm': return 3;
        case 'cividis': return 4;
        case 'grayscale': return 5;
        case 'materials':
        case 'material':
        case 'phase': return 6;
        case 'rainbow':
        default: return 2;
    }
}

export const GLSL_COLORMAP_FUNCTIONS = `
vec3 colormap_plasma(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(
        0.058 + 0.942 * t,
        0.015 + 0.900 * pow(t, 2.0) - 0.200 * pow(t, 4.0),
        0.533 + 0.400 * sin(3.14159 * t) - 0.450 * t
    );
}

vec3 colormap_viridis(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(
        0.267 + 0.700 * t - 0.300 * pow(t, 3.0),
        0.004 + 1.200 * t - 0.400 * pow(t, 2.0),
        0.329 + 0.500 * t - 0.750 * pow(t, 2.0)
    );
}

vec3 colormap_rainbow(float t) {
    t = clamp(t, 0.0, 1.0);
    float r = clamp(1.5 - abs(4.0 * t - 3.0), 0.0, 1.0);
    float g = clamp(1.5 - abs(4.0 * t - 2.0), 0.0, 1.0);
    float b = clamp(1.5 - abs(4.0 * t - 1.0), 0.0, 1.0);
    return vec3(r, g, b);
}

vec3 colormap_coolwarm(float t) {
    t = clamp(t, 0.0, 1.0);
    return mix(vec3(0.23, 0.299, 0.754), vec3(0.706, 0.016, 0.150), t);
}

vec3 colormap_cividis(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(
        0.000 + 0.950 * t,
        0.135 + 0.750 * t,
        0.304 + 0.300 * t
    );
}

vec3 colormap_grayscale(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(t, t, t);
}

vec3 colormap_materials(float t) {
    float id = floor(t * 5.0 + 0.5);
    if (id < 0.5) return vec3(0.53, 0.81, 0.98); // Air (Sky Blue)
    if (id < 1.5) return vec3(0.05, 0.45, 0.85); // Water (Ocean Blue)
    if (id < 2.5) return vec3(0.85, 0.58, 0.25); // Soil (Sand Amber)
    if (id < 3.5) return vec3(1.00, 0.50, 0.00); // HE Solid (Warning Orange)
    if (id < 4.5) return vec3(0.95, 0.15, 0.15); // Detonation Products (Crimson Fire)
    return vec3(0.58, 0.20, 0.92);               // FEM Solid / Obstacle (Purple)
}

vec3 getColormapColor(float t, int cmap) {
    if (cmap == 0) return colormap_plasma(t);
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    if (cmap == 6) return colormap_materials(t);
    return colormap_rainbow(t);
}
`;

export const WGSL_COLORMAP_FUNCTIONS = `
fn colormap_plasma(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    return vec3<f32>(
        0.058 + 0.942 * val,
        0.015 + 0.900 * pow(val, 2.0) - 0.200 * pow(val, 4.0),
        0.533 + 0.400 * sin(3.14159265 * val) - 0.450 * val
    );
}

fn colormap_viridis(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    return vec3<f32>(
        0.267 + 0.700 * val - 0.300 * pow(val, 3.0),
        0.004 + 1.200 * val - 0.400 * pow(val, 2.0),
        0.329 + 0.500 * val - 0.750 * pow(val, 2.0)
    );
}

fn colormap_rainbow(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    let r = clamp(1.5 - abs(4.0 * val - 3.0), 0.0, 1.0);
    let g = clamp(1.5 - abs(4.0 * val - 2.0), 0.0, 1.0);
    let b = clamp(1.5 - abs(4.0 * val - 1.0), 0.0, 1.0);
    return vec3<f32>(r, g, b);
}

fn colormap_coolwarm(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    return mix(vec3<f32>(0.230, 0.299, 0.754), vec3<f32>(0.706, 0.016, 0.150), val);
}

fn colormap_cividis(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    return vec3<f32>(
        0.000 + 0.950 * val,
        0.135 + 0.750 * val,
        0.304 + 0.300 * val
    );
}

fn colormap_grayscale(t: f32) -> vec3<f32> {
    let val = clamp(t, 0.0, 1.0);
    return vec3<f32>(val, val, val);
}

fn colormap_materials(t: f32) -> vec3<f32> {
    let id = floor(t * 5.0 + 0.5);
    if (id < 0.5) { return vec3<f32>(0.53, 0.81, 0.98); }
    if (id < 1.5) { return vec3<f32>(0.05, 0.45, 0.85); }
    if (id < 2.5) { return vec3<f32>(0.85, 0.58, 0.25); }
    if (id < 3.5) { return vec3<f32>(1.00, 0.50, 0.00); }
    if (id < 4.5) { return vec3<f32>(0.95, 0.15, 0.15); }
    return vec3<f32>(0.58, 0.20, 0.92);
}

fn getColormapColor(t: f32, c: i32) -> vec3<f32> {
    if (c == 0) { return colormap_plasma(t); }
    if (c == 1) { return colormap_viridis(t); }
    if (c == 3) { return colormap_coolwarm(t); }
    if (c == 4) { return colormap_cividis(t); }
    if (c == 5) { return colormap_grayscale(t); }
    if (c == 6) { return colormap_materials(t); }
    return colormap_rainbow(t);
}
`;
