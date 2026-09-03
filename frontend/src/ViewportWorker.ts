// ViewportWorker.ts
export {};

function getColormapIndex(name?: string): number {
    switch (name) {
        case 'plasma': return 0;
        case 'viridis': return 1;
        case 'coolwarm': return 3;
        case 'cividis': return 4;
        case 'grayscale': return 5;
        case 'rainbow':
        default: return 2;
    }
}

// --- WebGL Shader Sources ---
const VS_SOURCE_2 = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec2 texCoord;
layout(location = 2) in vec2 sliceSize;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat4 uStlMatrix;
uniform float uParticleSize;
uniform float uParticleDiameter;
uniform float uViewportHeight;
out vec2 vTexCoord;
out vec2 vSliceSize;
out vec3 vLocalPos;
out vec3 vBoxPos;
out vec3 vWorldPos;
out vec4 vViewPos;
void main() {
    vLocalPos = position;
    vWorldPos = position;
    vBoxPos = (uStlMatrix * vec4(position, 1.0)).xyz;
    vViewPos = uView * uModel * vec4(position, 1.0);
    gl_Position = uProjection * vViewPos;
    if (uParticleDiameter > 0.0) {
        float fovY = uProjection[1][1];
        float vH = uViewportHeight > 0.0 ? uViewportHeight : 800.0;
        if (uProjection[3][3] == 0.0) {
            gl_PointSize = clamp((uParticleDiameter * fovY * vH * 0.5) / max(0.0001, -vViewPos.z), 1.0, 1024.0);
        } else {
            gl_PointSize = clamp(uParticleDiameter * fovY * vH * 0.5, 1.0, 1024.0);
        }
    } else {
        gl_PointSize = uParticleSize > 0.0 ? uParticleSize : 4.0;
    }
    vTexCoord = texCoord;
    vSliceSize = sliceSize;
}
`;

const FS_SOURCE_2 = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vTexCoord;
in vec2 vSliceSize;
in vec3 vLocalPos;
in vec3 vBoxPos;
in vec3 vWorldPos;
in vec4 vViewPos;
uniform sampler2D uTexture;
uniform float uAlpha;
uniform int uColormap;
uniform float uMin;
uniform float uMax;
uniform bool uUseLogScale;
uniform bool uIsAMR;
uniform int uIsWireframe;
uniform bool uShowCellEdges;
uniform bool uInterpolate;
uniform bool uEnableLighting;
uniform bool uEnableAO;
uniform float uAmbientLevel;
uniform float uSpecularLevel;
uniform float uAoRadius;
uniform float uAoIntensity;
uniform float uAoBias;
uniform bool uAoSphereImpostor;

uniform bool uStlShowResults;
uniform int uStlColormap;
uniform sampler3D uVolumeTexture3D;
uniform vec3 uDomainMin;
uniform vec3 uDomainExtent;
uniform float uDx;
uniform float uStlMin;
uniform float uStlMax;
uniform bool uStlLogScale;

uniform int uAxis;
uniform int uIsSubmesh;
uniform int uNumSubmeshMasks;
uniform vec4 uSubmeshMasks[32];

out vec4 outColor;

float computeSurfaceAO(vec3 viewPos, vec3 normal) {
    if (!uEnableAO) return 1.0;
    float viewFacing = max(abs(normal.z), 0.0);
    float normalAO = pow(viewFacing, 0.45);
    
    vec3 dNx = dFdx(normal);
    vec3 dNy = dFdy(normal);
    vec3 dPx = dFdx(viewPos);
    vec3 dPy = dFdy(viewPos);
    float lPx = dot(dPx, dPx);
    float lPy = dot(dPy, dPy);
    float curvature = 0.0;
    if (lPx > 1e-10 && lPy > 1e-10) {
        float kX = -dot(dNx, dPx) / lPx;
        float kY = -dot(dNy, dPy) / lPy;
        curvature = (kX + kY) * 0.5;
    }
    float creviceAO = clamp(1.0 - max(curvature, 0.0) * max(uAoRadius, 0.02) * 4.0, 0.2, 1.0);
    float combinedAO = mix(1.0, normalAO * creviceAO, clamp(uAoIntensity, 0.1, 3.0));
    return clamp(combinedAO, 0.05, 1.0);
}

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

vec3 getColormapColor(float t, int cmap) {
    if (cmap == 0) return colormap_plasma(t);
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    return colormap_rainbow(t);
}

float getT(float raw, float minVal, float maxVal, bool useLogScale) {
    float t;
    float denom = maxVal - minVal;
    if (denom < 1e-5) denom = 1e-5;
    if (useLogScale) {
        float logMin = log(max(minVal, 1e-5));
        float logMax = log(max(maxVal, 1e-5));
        float logVal = log(max(raw, 1e-5));
        float logDenom = logMax - logMin;
        if (logDenom < 1e-5) logDenom = 1e-5;
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - minVal) / denom, 0.0, 1.0);
    }
    return t;
}

void main() {
    if (uNumSubmeshMasks > 0) {
        vec2 coord2D;
        if (uAxis == 0) {
            coord2D = vLocalPos.xy;
        } else if (uAxis == 1) {
            coord2D = vLocalPos.xz;
        } else {
            coord2D = vLocalPos.yz;
        }
        for (int i = 0; i < uNumSubmeshMasks; i++) {
            vec4 maskBox = uSubmeshMasks[i];
            if (coord2D.x >= maskBox.x && coord2D.x <= maskBox.y &&
                coord2D.y >= maskBox.z && coord2D.y <= maskBox.w) {
                discard;
            }
        }
    }
    if (uIsWireframe > 0) {
        // Obstacle Surfaces (9 = Solid with lighting, 10 = Gridlines, 11 = Solid unlit)
        if (uIsWireframe >= 9 && uIsWireframe <= 11) {
            if (uIsWireframe == 10) {
                outColor = vec4(0.8, 0.8, 0.8, uAlpha * 0.5);
                return;
            }
            float val = vSliceSize.y;
            float t = getT(val, uMin, uMax, uUseLogScale);
            vec3 col = getColormapColor(t, uColormap);
            vec4 baseColor = vec4(col, uAlpha);
            
            if (uIsWireframe == 9 && uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
                if (normal.z < 0.0) normal = -normal;
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

        if (uIsWireframe == 12) {
            vec4 baseColor = vec4(0.0, 0.9, 1.0, uAlpha);
            if (uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
                if (normal.z < 0.0) normal = -normal;
                vec3 lightDir = vec3(0.0, 0.0, 1.0);
                float diff = max(dot(normal, lightDir), 0.0);
                vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff);
                outColor = vec4(lit, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        if (uIsWireframe == 16) {
            // Selection Highlight: Vibrant Electric Cyan
            outColor = vec4(0.0, 0.94, 1.0, uAlpha);
            return;
        }

        if (uIsWireframe == 17) {
            // Hover Emphasis: Vibrant Amber / Gold
            outColor = vec4(1.0, 0.78, 0.17, uAlpha);
            return;
        }

        if (uIsWireframe == 18) {
            // Selection Holographic Surface Wash with Fresnel Rim
            vec3 viewPos3 = vViewPos.xyz;
            vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
            float lX = length(dX); if (lX > 1e-12) dX /= lX;
            float lY = length(dY); if (lY > 1e-12) dY /= lY;
            vec3 rawN = cross(dX, dY);
            float lenN = length(rawN);
            vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
            if (normal.z < 0.0) normal = -normal;
            vec3 viewDir = normalize(-viewPos3);
            float NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            float rim = pow(1.0 - NdotV, 3.0);
            vec4 baseCyan = vec4(0.0, 0.85, 1.0, uAlpha * 0.20);
            vec4 rimCyan = vec4(0.4, 0.96, 1.0, uAlpha * 0.90);
            outColor = mix(baseCyan, rimCyan, rim);
            return;
        }

        if (uIsWireframe == 19) {
            // Hover Holographic Surface Wash with Fresnel Rim
            vec3 viewPos3 = vViewPos.xyz;
            vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
            float lX = length(dX); if (lX > 1e-12) dX /= lX;
            float lY = length(dY); if (lY > 1e-12) dY /= lY;
            vec3 rawN = cross(dX, dY);
            float lenN = length(rawN);
            vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
            if (normal.z < 0.0) normal = -normal;
            vec3 viewDir = normalize(-viewPos3);
            float NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            float rim = pow(1.0 - NdotV, 3.0);
            vec4 baseAmber = vec4(1.0, 0.72, 0.10, uAlpha * 0.20);
            vec4 rimAmber = vec4(1.0, 0.92, 0.45, uAlpha * 0.90);
            outColor = mix(baseAmber, rimAmber, rim);
            return;
        }

        if (uIsWireframe == 15) {
            outColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }

        if (uIsWireframe == 14) {
            vec2 pcoord = gl_PointCoord * 2.0 - 1.0;
            float distSq = dot(pcoord, pcoord);
            if (distSq > 1.0) {
                discard;
            }
            float z = sqrt(max(0.0, 1.0 - distSq));
            vec3 normal = vec3(pcoord.x, -pcoord.y, z);
            vec3 lightDir = normalize(vec3(0.4, 0.6, 0.9));
            float diff = max(dot(normal, lightDir), 0.0);
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0) * (uSpecularLevel * 0.75);
            
            float aoFactor = 1.0;
            if (uEnableAO) {
                if (uAoSphereImpostor) {
                    float sphereRim = smoothstep(0.0, 0.9, normal.z);
                    float sphereAO = pow(max(normal.z, 0.0), 0.7) * (0.6 + 0.4 * sphereRim);
                    aoFactor = mix(1.0, sphereAO, clamp(uAoIntensity, 0.0, 2.5));
                } else {
                    aoFactor = pow(max(normal.z, 0.0), 0.5);
                }
            }
            vec3 col = vec3(vTexCoord.x, vTexCoord.y, vSliceSize.x);
            vec3 lit = col * (uAmbientLevel * aoFactor + 0.7 * diff) + vec3(spec);
            outColor = vec4(lit, uAlpha);
            return;
        }

        if (uIsWireframe == 20) {
            vec4 baseColor = vec4(1.0, 0.15, 0.15, uAlpha);
            if (uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
                if (normal.z < 0.0) normal = -normal;
                vec3 lightDir = vec3(0.0, 0.0, 1.0);
                float diff = max(dot(normal, lightDir), 0.0);
                vec3 reflectDir = reflect(-lightDir, normal);
                float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                float ao = computeSurfaceAO(viewPos3, normal);
                vec3 lit = baseColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                outColor = vec4(lit, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        if (uIsWireframe == 21) {
            outColor = vec4(1.0, 0.35, 0.25, 1.0);
            return;
        }

        if (uIsWireframe == 13) {
            vec4 baseColor = vec4(1.0, 0.24, 0.0, uAlpha);
            if (uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
                if (normal.z < 0.0) normal = -normal;
                vec3 lightDir = vec3(0.0, 0.0, 1.0);
                float diff = max(dot(normal, lightDir), 0.0);
                vec3 reflectDir = reflect(-lightDir, normal);
                float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                float ao = computeSurfaceAO(viewPos3, normal);
                vec3 lit = baseColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                outColor = vec4(lit, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        if (uIsWireframe == 1) {
            outColor = vec4(0.3, 0.3, 0.4, 0.8);
            return;
        }
        
        // Axes Indicator (2, 3, 4)
        if (uIsWireframe >= 2 && uIsWireframe <= 4) {
            vec4 baseColor = vec4(0.0);
            if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
            else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
            else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);
            
            if (uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
                if (normal.z < 0.0) normal = -normal;
                vec3 lightDir = vec3(0.0, 0.0, 1.0);
                float diff = max(dot(normal, lightDir), 0.0);
                
                vec3 reflectDir = reflect(-lightDir, normal);
                float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                
                float ao = computeSurfaceAO(viewPos3, normal);
                
                vec3 lit = baseColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                outColor = vec4(lit, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        // STL Geometry (5 = Solid, 6 = Wireframe, 7 = Solid + Wireframe) or Gauges (8 = Solid Spheres)
        if (uIsWireframe >= 5) {
            vec3 relDomainPos = (vLocalPos - uDomainMin) / max(uDomainExtent, vec3(1e-6));
            bool inStlDomain = (relDomainPos.x >= -1e-4 && relDomainPos.x <= 1.0001 &&
                                relDomainPos.y >= -1e-4 && relDomainPos.y <= 1.0001 &&
                                relDomainPos.z >= -1e-4 && relDomainPos.z <= 1.0001);

            vec4 baseColor = vec4(0.42, 0.44, 0.48, uAlpha);
            if (uStlShowResults && inStlDomain && uIsWireframe <= 7) {
                vec3 baseNorm = clamp(relDomainPos, vec3(0.0), vec3(1.0));
                float val = texture(uVolumeTexture3D, baseNorm).r;
                float t = getT(val, uStlMin, uStlMax, uStlLogScale);
                vec3 col = getColormapColor(t, uStlColormap);
                baseColor = vec4(col, uAlpha);
            }
            if (uIsWireframe == 8) {
                baseColor = vec4(1.0, 0.66, 0.0, 1.0);
            } else if (vSliceSize.y > 0.5) {
                baseColor = vec4(1.0, 0.2, 0.2, uAlpha * 0.4);
            }
            
            if (uIsWireframe == 5 || uIsWireframe == 8) {
                if (uIsWireframe == 5 && baseColor.a <= 0.001) {
                    discard;
                }
                if (uEnableLighting) {
                    vec3 viewPos3 = vViewPos.xyz;
                    vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                    float lX = length(dX); if (lX > 1e-12) dX /= lX;
                    float lY = length(dY); if (lY > 1e-12) dY /= lY;
                    vec3 rawNormal = cross(dX, dY);
                    float lenN = length(rawNormal);
                    vec3 normal = (lenN > 1e-4) ? (rawNormal / lenN) : vec3(0.0, 0.0, 1.0);
                    if (normal.z < 0.0) normal = -normal;
                    vec3 lightDir = vec3(0.0, 0.0, 1.0);
                    float diff = max(abs(dot(normal, lightDir)), 0.25);
                    vec3 reflectDir = reflect(-lightDir, normal);
                    float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                    float ao = computeSurfaceAO(viewPos3, normal);
                    vec3 lit = baseColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                    outColor = vec4(lit, baseColor.a);
                } else {
                    outColor = baseColor;
                }
                return;
            }

            // Barycentric Wireframe Rendering
            vec3 barycentric = vec3(vTexCoord, vSliceSize.x);
            vec3 d = fwidth(barycentric);
            vec3 barycentricPixels = barycentric / max(d, vec3(1e-5));
            float minPixelDist = min(min(barycentricPixels.x, barycentricPixels.y), barycentricPixels.z);
            
            // Clean 1-pixel antialiased wireframe (0.6px line radius)
            float lineCoverage = 1.0 - smoothstep(0.2, 0.9, minPixelDist);
            
            // Relaxed density fade for dense distant meshes
            float triSize = max(d.x, max(d.y, d.z));
            float densityFade = 1.0 - smoothstep(0.25, 0.65, triSize);
            lineCoverage *= densityFade;
            
            if (uIsWireframe == 6) {
                vec4 wireColor = vec4(0.15, 0.15, 0.15, 0.95);
                if (uStlShowResults && inStlDomain) {
                    vec3 baseNorm = clamp(relDomainPos, vec3(0.0), vec3(1.0));
                    float val = texture(uVolumeTexture3D, baseNorm).r;
                    vec3 col = getColormapColor(getT(val, uStlMin, uStlMax, uStlLogScale), uStlColormap);
                    wireColor = vec4(col, 0.95);
                } else if (vSliceSize.y > 0.5) {
                    wireColor = vec4(0.8, 0.1, 0.1, 0.95);
                }
                if (lineCoverage < 0.01) discard;
                outColor = vec4(wireColor.rgb, wireColor.a * lineCoverage);
                return;
            }
            
            if (uIsWireframe == 7) {
                if (baseColor.a <= 0.001) {
                    if (lineCoverage < 0.01) discard;
                    vec4 wireColor = vec4(0.15, 0.15, 0.15, 0.95);
                    if (uStlShowResults && inStlDomain) {
                        vec3 baseNorm = clamp(relDomainPos, vec3(0.0), vec3(1.0));
                        float val = texture(uVolumeTexture3D, baseNorm).r;
                        vec3 col = getColormapColor(getT(val, uStlMin, uStlMax, uStlLogScale), uStlColormap);
                        wireColor = vec4(col, 0.95);
                    } else if (vSliceSize.y > 0.5) {
                        wireColor = vec4(0.8, 0.1, 0.1, 0.95);
                    }
                    outColor = vec4(wireColor.rgb, wireColor.a * lineCoverage);
                    return;
                }
                vec4 litColor = baseColor;
                if (uEnableLighting) {
                    vec3 viewPos3 = vViewPos.xyz;
                    vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                    float lX = length(dX); if (lX > 1e-12) dX /= lX;
                    float lY = length(dY); if (lY > 1e-12) dY /= lY;
                    vec3 rawNormal = cross(dX, dY);
                    float lenN = length(rawNormal);
                    vec3 normal = (lenN > 1e-4) ? (rawNormal / lenN) : vec3(0.0, 0.0, 1.0);
                    if (normal.z < 0.0) normal = -normal;
                    vec3 lightDir = vec3(0.0, 0.0, 1.0);
                    float diff = max(abs(dot(normal, lightDir)), 0.25);
                    vec3 reflectDir = reflect(-lightDir, normal);
                    float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                    float ao = computeSurfaceAO(viewPos3, normal);
                    vec3 lit = baseColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                    litColor = vec4(lit, baseColor.a);
                } else {
                    litColor = baseColor;
                }
                vec4 darkWireColor = vec4(0.0, 0.0, 0.0, max(litColor.a, 0.95));
                if (vSliceSize.y > 0.5) darkWireColor = vec4(0.8, 0.1, 0.1, max(litColor.a, 0.95));
                outColor = mix(litColor, darkWireColor, lineCoverage * 0.85);
                return;
            }
        }
        return;
    }
    vec3 color;
    if (!uInterpolate) {
        vec2 cellUv = (floor(vTexCoord * vSliceSize) + vec2(0.5)) / vSliceSize;
        float raw = texture(uTexture, cellUv).r;
        float t = getT(raw, uMin, uMax, uUseLogScale);
        color = getColormapColor(t, uColormap);
    } else {
        float raw = texture(uTexture, vTexCoord).r;
        float t = getT(raw, uMin, uMax, uUseLogScale);
        color = getColormapColor(t, uColormap);
    }
    vec4 finalColor = vec4(color, uAlpha);
    if (uEnableLighting) {
        vec3 viewPos3 = vViewPos.xyz;
        vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
        float lX = length(dX); if (lX > 1e-12) dX /= lX;
        float lY = length(dY); if (lY > 1e-12) dY /= lY;
        vec3 rawN = cross(dX, dY);
        float lenN = length(rawN);
        vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
        if (normal.z < 0.0) normal = -normal;
        vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
        float diff = max(dot(normal, lightDir), 0.0) * 0.7 + max(dot(-normal, lightDir), 0.0) * 0.3;
        
        vec3 reflectDir = reflect(-lightDir, normal);
        vec3 viewDir = normalize(-viewPos3);
        float spec = pow(max(dot(reflectDir, viewDir), 0.0), 32.0);
        
        float ao = computeSurfaceAO(viewPos3, normal);
        
        vec3 lit = finalColor.rgb * (uAmbientLevel * ao + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
        finalColor = vec4(lit, finalColor.a);
    }
    
    if (uShowCellEdges) {
        vec2 edgeSize = vSliceSize;
        vec2 grid = abs(fract(vTexCoord * edgeSize - 0.5) - 0.5);
        vec2 threshold = max(fwidth(vTexCoord * edgeSize), vec2(0.003));
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
varying vec3 vBoxPos;
varying vec3 vWorldPos;
varying vec4 vViewPos;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat4 uStlMatrix;
uniform float uParticleSize;
uniform float uParticleDiameter;
uniform float uViewportHeight;
void main() {
    vLocalPos = position;
    vWorldPos = position;
    vBoxPos = (uStlMatrix * vec4(position, 1.0)).xyz;
    vViewPos = uView * uModel * vec4(position, 1.0);
    gl_Position = uProjection * vViewPos;
    if (uParticleDiameter > 0.0) {
        float fovY = uProjection[1][1];
        float vH = uViewportHeight > 0.0 ? uViewportHeight : 800.0;
        if (uProjection[3][3] == 0.0) {
            gl_PointSize = clamp((uParticleDiameter * fovY * vH * 0.5) / max(0.0001, -vViewPos.z), 1.0, 1024.0);
        } else {
            gl_PointSize = clamp(uParticleDiameter * fovY * vH * 0.5, 1.0, 1024.0);
        }
    } else {
        gl_PointSize = uParticleSize > 0.0 ? uParticleSize : 4.0;
    }
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
varying vec3 vBoxPos;
varying vec3 vWorldPos;
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
uniform bool uStlShowResults;
uniform int uStlColormap;
uniform vec3 uDomainMin;
uniform vec3 uDomainExtent;
uniform float uDx;
uniform float uStlMin;
uniform float uStlMax;

uniform int uAxis;
uniform int uIsSubmesh;
uniform int uNumSubmeshMasks;
uniform vec4 uSubmeshMasks[32];

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

vec3 getColormapColor(float t, int cmap) {
    if (cmap == 0) return colormap_plasma(t);
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    return colormap_rainbow(t);
}

float getT(float raw, float minVal, float maxVal, bool useLogScale) {
    float t;
    float denom = maxVal - minVal;
    if (denom < 1e-5) return 0.0;
    if (useLogScale) {
        float logMin = log(max(minVal, 1e-5));
        float logMax = log(max(maxVal, 1e-5));
        float logVal = log(max(raw, 1e-5));
        float logDenom = logMax - logMin;
        if (logDenom < 1e-5) return 0.0;
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - minVal) / denom, 0.0, 1.0);
    }
    return t;
}

void main() {
    if (uNumSubmeshMasks > 0) {
        vec2 coord2D;
        if (uAxis == 0) {
            coord2D = vLocalPos.xy;
        } else if (uAxis == 1) {
            coord2D = vLocalPos.xz;
        } else {
            coord2D = vLocalPos.yz;
        }
        for (int i = 0; i < uNumSubmeshMasks; i++) {
            vec4 maskBox = uSubmeshMasks[i];
            if (coord2D.x >= maskBox.x && coord2D.x <= maskBox.y &&
                coord2D.y >= maskBox.z && coord2D.y <= maskBox.w) {
                discard;
            }
        }
    }
    if (uIsWireframe > 0) {
        if (uIsWireframe >= 9 && uIsWireframe <= 11) {
            if (uIsWireframe == 10) {
                outColor = vec4(0.0, 0.95, 1.0, 0.95);
                return;
            }
            float val = vSliceSize.y;
            float t = getT(val, uMin, uMax, uUseLogScale);
            vec3 col = getColormapColor(t, uColormap);
            vec4 baseColor = vec4(col, uAlpha);
            
            if (uIsWireframe == 9 && uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 normal = vec3(0.0, 0.0, 1.0);
                #ifdef GL_OES_standard_derivatives
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                if (lenN > 1e-4) normal = rawN / lenN;
                if (normal.z < 0.0) normal = -normal;
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
                outColor = vec4(lit * ao, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        if (uIsWireframe == 12) {
            outColor = vec4(0.0, 0.9, 1.0, uAlpha);
            return;
        }

        if (uIsWireframe == 16) {
            outColor = vec4(0.0, 0.94, 1.0, uAlpha);
            return;
        }

        if (uIsWireframe == 17) {
            outColor = vec4(1.0, 0.78, 0.17, uAlpha);
            return;
        }

        if (uIsWireframe == 18) {
            // Selection Holographic Surface Wash with Fresnel Rim
            vec3 viewPos3 = vViewPos.xyz;
            vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
            float lX = length(dX); if (lX > 1e-12) dX /= lX;
            float lY = length(dY); if (lY > 1e-12) dY /= lY;
            vec3 rawN = cross(dX, dY);
            float lenN = length(rawN);
            vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
            if (normal.z < 0.0) normal = -normal;
            vec3 viewDir = normalize(-viewPos3);
            float NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            float rim = pow(1.0 - NdotV, 3.0);
            vec4 baseCyan = vec4(0.0, 0.85, 1.0, uAlpha * 0.20);
            vec4 rimCyan = vec4(0.4, 0.96, 1.0, uAlpha * 0.90);
            outColor = mix(baseCyan, rimCyan, rim);
            return;
        }

        if (uIsWireframe == 19) {
            // Hover Holographic Surface Wash with Fresnel Rim
            vec3 viewPos3 = vViewPos.xyz;
            vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
            float lX = length(dX); if (lX > 1e-12) dX /= lX;
            float lY = length(dY); if (lY > 1e-12) dY /= lY;
            vec3 rawN = cross(dX, dY);
            float lenN = length(rawN);
            vec3 normal = (lenN > 1e-4) ? (rawN / lenN) : vec3(0.0, 0.0, 1.0);
            if (normal.z < 0.0) normal = -normal;
            vec3 viewDir = normalize(-viewPos3);
            float NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            float rim = pow(1.0 - NdotV, 3.0);
            vec4 baseAmber = vec4(1.0, 0.72, 0.10, uAlpha * 0.20);
            vec4 rimAmber = vec4(1.0, 0.92, 0.45, uAlpha * 0.90);
            outColor = mix(baseAmber, rimAmber, rim);
            return;
        }

        if (uIsWireframe == 15) {
            outColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }

        if (uIsWireframe == 14) {
            vec2 pcoord = gl_PointCoord * 2.0 - 1.0;
            float distSq = dot(pcoord, pcoord);
            if (distSq > 1.0) {
                discard;
            }
            float z = sqrt(max(0.0, 1.0 - distSq));
            vec3 normal = vec3(pcoord.x, -pcoord.y, z);
            vec3 lightDir = normalize(vec3(0.4, 0.6, 0.9));
            float diff = max(dot(normal, lightDir), 0.0);
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0) * (uSpecularLevel * 0.75);
            vec3 col = vec3(vTexCoord.x, vTexCoord.y, vSliceSize.x);
            vec3 lit = col * (uAmbientLevel + 0.7 * diff) + vec3(spec);
            outColor = vec4(lit, uAlpha);
            return;
        }

        if (uIsWireframe == 20) {
            outColor = vec4(1.0, 0.15, 0.15, uAlpha);
            return;
        }

        if (uIsWireframe == 21) {
            outColor = vec4(1.0, 0.35, 0.25, 1.0);
            return;
        }

        if (uIsWireframe == 13) {
            outColor = vec4(1.0, 0.24, 0.0, uAlpha);
            return;
        }

        if (uIsWireframe == 1) {
            outColor = vec4(0.3, 0.3, 0.4, 0.8);
            return;
        }
        
        // Axes Indicator (2, 3, 4)
        if (uIsWireframe >= 2 && uIsWireframe <= 4) {
            vec4 baseColor = vec4(0.0);
            if (uIsWireframe == 2) baseColor = vec4(1.0, 0.1, 0.1, 1.0);
            else if (uIsWireframe == 3) baseColor = vec4(0.1, 1.0, 0.1, 1.0);
            else if (uIsWireframe == 4) baseColor = vec4(0.2, 0.5, 1.0, 1.0);
            
            if (uEnableLighting) {
                vec3 viewPos3 = vViewPos.xyz;
                vec3 normal = vec3(0.0, 0.0, 1.0);
                #ifdef GL_OES_standard_derivatives
                vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                float lX = length(dX); if (lX > 1e-12) dX /= lX;
                float lY = length(dY); if (lY > 1e-12) dY /= lY;
                vec3 rawN = cross(dX, dY);
                float lenN = length(rawN);
                if (lenN > 1e-4) normal = rawN / lenN;
                if (normal.z < 0.0) normal = -normal;
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
                outColor = vec4(lit * ao, baseColor.a);
            } else {
                outColor = baseColor;
            }
            return;
        }

        // STL Geometry (5 = Solid, 6 = Wireframe, 7 = Solid + Wireframe) or Gauges (8 = Solid Spheres)
        if (uIsWireframe >= 5) {
            vec3 relDomainPos = (vWorldPos - uDomainMin) / max(uDomainExtent, vec3(1e-6));
            bool inStlDomain = (relDomainPos.x >= -1e-4 && relDomainPos.x <= 1.0001 &&
                                relDomainPos.y >= -1e-4 && relDomainPos.y <= 1.0001 &&
                                relDomainPos.z >= -1e-4 && relDomainPos.z <= 1.0001);

            vec4 baseColor = vec4(0.42, 0.44, 0.48, uAlpha);
            if (uIsWireframe == 8) {
                baseColor = vec4(1.0, 0.66, 0.0, 1.0);
            }
            
            if (uIsWireframe == 5 || uIsWireframe == 8) {
                if (uIsWireframe == 5 && baseColor.a <= 0.001) {
                    discard;
                }
                if (uEnableLighting) {
                    vec3 viewPos3 = vViewPos.xyz;
                    vec3 normal = vec3(0.0, 0.0, 1.0);
                    #ifdef GL_OES_standard_derivatives
                    vec3 dX = dFdx(viewPos3);
                    vec3 dY = dFdy(viewPos3);
                    float lX = length(dX); if (lX > 1e-12) dX /= lX;
                    float lY = length(dY); if (lY > 1e-12) dY /= lY;
                    vec3 rawNormal = cross(dX, dY);
                    float lenN = length(rawNormal);
                    if (lenN > 1e-4) normal = rawNormal / lenN;
                    if (normal.z < 0.0) normal = -normal;
                    #endif
                    vec3 lightDir = vec3(0.0, 0.0, 1.0);
                    float diff = max(abs(dot(normal, lightDir)), 0.25);
                    vec3 reflectDir = reflect(-lightDir, normal);
                    float spec = pow(max(dot(reflectDir, vec3(0.0, 0.0, 1.0)), 0.0), 16.0);
                    float ao = 1.0;
                    if (uEnableAO) {
                        ao = pow(max(abs(normal.z), 0.2), 0.5);
                    }
                    vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                    outColor = vec4(lit * ao, baseColor.a);
                } else {
                    outColor = baseColor;
                }
                return;
            }

            // Barycentric Wireframe Rendering
            vec3 barycentric = vec3(vTexCoord, vSliceSize.x);
            float lineCoverage = 0.0;
            #ifdef GL_OES_standard_derivatives
            vec3 d = fwidth(barycentric);
            vec3 barycentricPixels = barycentric / max(d, vec3(1e-5));
            float minPixelDist = min(min(barycentricPixels.x, barycentricPixels.y), barycentricPixels.z);
            lineCoverage = (1.0 - smoothstep(0.2, 0.9, minPixelDist)) * (1.0 - smoothstep(0.25, 0.65, max(d.x, max(d.y, d.z))));
            #else
            float edgeDist = min(min(barycentric.x, barycentric.y), barycentric.z);
            lineCoverage = 1.0 - smoothstep(0.002, 0.005, edgeDist);
            #endif
            
            vec4 wireColor = vec4(0.0, 0.0, 0.0, 0.95);
            if (vSliceSize.y > 0.5) wireColor = vec4(0.8, 0.1, 0.1, 0.95);
            
            if (uIsWireframe == 6) {
                if (lineCoverage < 0.01) discard;
                outColor = vec4(wireColor.rgb, wireColor.a * lineCoverage);
                return;
            }
            
            if (uIsWireframe == 7) {
                if (baseColor.a <= 0.001) {
                    if (lineCoverage < 0.01) discard;
                    vec4 wireColor = vec4(0.0, 0.0, 0.0, 0.95);
                    if (vSliceSize.y > 0.5) wireColor = vec4(0.8, 0.1, 0.1, 0.95);
                    outColor = vec4(wireColor.rgb, wireColor.a * lineCoverage);
                    return;
                }
                vec4 litColor;
                if (uEnableLighting) {
                    vec3 viewPos3 = vViewPos.xyz;
                    vec3 normal = vec3(0.0, 0.0, 1.0);
                    #ifdef GL_OES_standard_derivatives
                    vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
                    float lX = length(dX); if (lX > 1e-12) dX /= lX;
                    float lY = length(dY); if (lY > 1e-12) dY /= lY;
                    vec3 rawN = cross(dX, dY);
                    float lenN = length(rawN);
                    if (lenN > 1e-4) normal = rawN / lenN;
                    if (normal.z < 0.0) normal = -normal;
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
                    litColor = vec4(lit * ao, baseColor.a);
                } else {
                    litColor = baseColor;
                }
                vec4 darkWireColor = vec4(0.0, 0.0, 0.0, max(litColor.a, 0.95));
                if (vSliceSize.y > 0.5) darkWireColor = vec4(0.8, 0.1, 0.1, max(litColor.a, 0.95));
                outColor = mix(litColor, darkWireColor, lineCoverage * 0.85);
                return;
            }
        }
        return;
    }
    vec3 color;
    if (!uInterpolate) {
        vec2 cellUv = (floor(vTexCoord * vSliceSize) + vec2(0.5)) / vSliceSize;
        float raw = texture(uTexture, cellUv).r;
        float t = getT(raw, uMin, uMax, uUseLogScale);
        color = getColormapColor(t, uColormap);
    } else {
        float raw = texture(uTexture, vTexCoord).r;
        float t = getT(raw, uMin, uMax, uUseLogScale);
        color = getColormapColor(t, uColormap);
    }
    vec4 finalColor = vec4(color, uAlpha);
    
    if (uEnableLighting) {
        vec3 viewPos3 = vViewPos.xyz;
        vec3 normal = vec3(0.0, 0.0, 1.0);
        #ifdef GL_OES_standard_derivatives
        vec3 dX = dFdx(viewPos3); vec3 dY = dFdy(viewPos3);
        float lX = length(dX); if (lX > 1e-12) dX /= lX;
        float lY = length(dY); if (lY > 1e-12) dY /= lY;
        vec3 rawN = cross(dX, dY);
        float lenN = length(rawN);
        if (lenN > 1e-4) normal = rawN / lenN;
        if (normal.z < 0.0) normal = -normal;
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
    outColor = finalColor;
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
    @location(4) vWorldPos: vec3<f32>,
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
    stlShowResults: f32,
    stlColormap: f32,
    dx: f32,
    stlMinVal: f32,
    stlMaxVal: f32,
    stlLogScale: f32,
    aoRadius: f32,
    aoIntensity: f32,
    domainMin: vec3<f32>,
    aoBias: f32,
    domainExtent: vec3<f32>,
    aoSphereImpostor: f32,
    viewportWidth: f32,
    viewportHeight: f32,
    dummy5: f32,
    dummy6: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var uVolumeTexture: texture_3d<f32>;

fn computeSurfaceAO(viewPos: vec3<f32>, normal: vec3<f32>) -> f32 {
    if (uniforms.enableAO <= 0.5) {
        return 1.0;
    }
    let viewFacing = max(abs(normal.z), 0.0);
    var normalAO = pow(viewFacing, 0.45);
    
    var dNx = dpdx(normal);
    var dNy = dpdy(normal);
    var dPx = dpdx(viewPos);
    var dPy = dpdy(viewPos);
    let lPx = dot(dPx, dPx);
    let lPy = dot(dPy, dPy);
    var curvature: f32 = 0.0;
    if (lPx > 1e-10 && lPy > 1e-10) {
        let kX = -dot(dNx, dPx) / lPx;
        let kY = -dot(dNy, dPy) / lPy;
        curvature = (kX + kY) * 0.5;
    }
    
    let creviceAO = clamp(1.0 - max(curvature, 0.0) * max(uniforms.aoRadius, 0.02) * 4.0, 0.2, 1.0);
    let combinedAO = mix(1.0, normalAO * creviceAO, clamp(uniforms.aoIntensity, 0.1, 3.0));
    return clamp(combinedAO, 0.05, 1.0);
}

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) size: vec2<f32>) -> VertexOutput {
    var out: VertexOutput;
    out.vViewPos = uniforms.view * uniforms.model * vec4<f32>(pos, 1.0);
    out.position = uniforms.projection * out.vViewPos;
    out.texCoord = uv;
    out.sliceSize = size;
    out.vLocalPos = pos;
    out.vWorldPos = (uniforms.model * vec4<f32>(pos, 1.0)).xyz;
    return out;
}

struct ParticleOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec3<f32>,
}

@vertex
fn vs_particle_billboard(
    @builtin(vertex_index) vIdx: u32,
    @location(0) pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) size: vec2<f32>
) -> ParticleOutput {
    var out: ParticleOutput;
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0)
    );
    let corner = corners[vIdx % 6u];
    let viewCenter = uniforms.view * uniforms.model * vec4<f32>(pos, 1.0);
    let pointRadius = max(0.002, uniforms.showCellEdges);
    let viewPos = viewCenter + vec4<f32>(corner * pointRadius, 0.0, 0.0);
    out.position = uniforms.projection * viewPos;
    out.uv = corner;
    out.color = vec3<f32>(uv.x, uv.y, size.x);
    return out;
}

@fragment
fn fs_particle_billboard(in: ParticleOutput) -> @location(0) vec4<f32> {
    let distSq = dot(in.uv, in.uv);
    if (distSq > 1.0) {
        discard;
    }
    let z = sqrt(max(0.0, 1.0 - distSq));
    let normal = vec3<f32>(in.uv.x, -in.uv.y, z);
    let lightDir = normalize(vec3<f32>(0.4, 0.6, 0.9));
    let diff = max(dot(normal, lightDir), 0.0);
    let reflectDir = reflect(-lightDir, normal);
    let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0) * (uniforms.specularLevel * 0.75);
    
    var aoFactor = 1.0;
    if (uniforms.enableAO > 0.5) {
        if (uniforms.aoSphereImpostor > 0.5) {
            let sphereRim = smoothstep(0.0, 0.9, normal.z);
            let sphereAO = pow(max(normal.z, 0.0), 0.7) * (0.6 + 0.4 * sphereRim);
            aoFactor = mix(1.0, sphereAO, clamp(uniforms.aoIntensity, 0.0, 2.5));
        } else {
            aoFactor = pow(max(normal.z, 0.0), 0.5);
        }
    }
    
    // Subtle perimeter rim contour on sphere impostor edge for crisp definition
    let impostorRim = pow(distSq, 3.5);
    let lit = in.color * (uniforms.ambientLevel * aoFactor + 0.7 * diff) + vec3<f32>(spec) + in.color * (impostorRim * 0.35);
    return vec4<f32>(lit, uniforms.alpha);
}

fn colormap_plasma(t: f32) -> vec3<f32> {
    return vec3<f32>(t * 1.5, t * t, 1.0 - t);
}

fn colormap_viridis(t: f32) -> vec3<f32> {
    return vec3<f32>(1.0 - t, t, 0.5 + 0.5 * t);
}

fn colormap_rainbow(t: f32) -> vec3<f32> {
    var r: f32 = 0.0; var g: f32 = 0.0; var b: f32 = 0.0;
    if (t < 0.25) {
        let localT = t / 0.25;
        r = 0.0; g = localT; b = 1.0;
    } else if (t < 0.5) {
        let localT = (t - 0.25) / 0.25;
        r = 0.0; g = 1.0; b = 1.0 - localT;
    } else if (t < 0.75) {
        let localT = (t - 0.5) / 0.25;
        r = localT; g = 1.0; b = 0.0;
    } else {
        let localT = (t - 0.75) / 0.25;
        r = 1.0; g = 1.0 - localT; b = 0.0;
    }
    return vec3<f32>(r, g, b);
}

fn colormap_coolwarm(t: f32) -> vec3<f32> {
    var r: f32 = 0.0; var g: f32 = 0.0; var b: f32 = 0.0;
    if (t < 0.5) {
        let localT = t / 0.5;
        r = (59.0 + localT * 161.0) / 255.0;
        g = (76.0 + localT * 144.0) / 255.0;
        b = (192.0 + localT * 28.0) / 255.0;
    } else {
        let localT = (t - 0.5) / 0.5;
        r = (220.0 + localT * 9.0) / 255.0;
        g = (220.0 - localT * 184.0) / 255.0;
        b = (220.0 - localT * 161.0) / 255.0;
    }
    return vec3<f32>(r, g, b);
}

fn colormap_cividis(t: f32) -> vec3<f32> {
    var r: f32 = 0.0; var g: f32 = 0.0; var b: f32 = 0.0;
    if (t < 0.5) {
        let localT = t / 0.5;
        r = (0.0 + localT * 84.0) / 255.0;
        g = (33.0 + localT * 79.0) / 255.0;
        b = (84.0 + localT * 53.0) / 255.0;
    } else {
        let localT = (t - 0.5) / 0.5;
        r = (84.0 + localT * 168.0) / 255.0;
        g = (112.0 + localT * 102.0) / 255.0;
        b = (137.0 - localT * 86.0) / 255.0;
    }
    return vec3<f32>(r, g, b);
}

fn colormap_grayscale(t: f32) -> vec3<f32> {
    return vec3<f32>(t, t, t);
}

fn getColormapColor(t: f32, cmap: f32) -> vec3<f32> {
    let c = i32(cmap + 0.5);
    if (c == 0) { return colormap_plasma(t); }
    if (c == 1) { return colormap_viridis(t); }
    if (c == 3) { return colormap_coolwarm(t); }
    if (c == 4) { return colormap_cividis(t); }
    if (c == 5) { return colormap_grayscale(t); }
    return colormap_rainbow(t);
}

fn getT(raw: f32, minVal: f32, maxVal: f32, useLogScale: f32) -> f32 {
    var t: f32 = 0.0;
    let denom = maxVal - minVal;
    if (denom < 1e-5) {
        return 0.0;
    }
    if (useLogScale > 0.5) {
        let logMin = log(max(minVal, 1e-5));
        let logMax = log(max(maxVal, 1e-5));
        let logVal = log(max(raw, 1e-5));
        let logDenom = logMax - logMin;
        if (logDenom < 1e-5) {
            return 0.0;
        }
        t = clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    } else {
        t = clamp((raw - minVal) / denom, 0.0, 1.0);
    }
    return t;
}

@fragment
fn fs_main(vertexIn: VertexOutput, @builtin(front_facing) isFront: bool) -> @location(0) vec4<f32> {
    let texCoord = vertexIn.texCoord;
    let sliceSize = vertexIn.sliceSize;
    let vLocalPos = vertexIn.vLocalPos;
    let vViewPos = vertexIn.vViewPos;
    let vWorldPos = vertexIn.vWorldPos;
    if (uniforms.isWireframe > 0.5) {
        if (uniforms.isWireframe < 1.5) {
            return vec4<f32>(0.3, 0.3, 0.4, 0.8); // Bounding box: grey
        }

        if (uniforms.isWireframe >= 15.5 && uniforms.isWireframe < 16.5) {
            return vec4<f32>(0.0, 0.94, 1.0, uniforms.alpha); // Selection: Electric Cyan
        }

        if (uniforms.isWireframe >= 16.5 && uniforms.isWireframe < 17.5) {
            return vec4<f32>(1.0, 0.78, 0.17, uniforms.alpha); // Hover: Vibrant Amber
        }

        if (uniforms.isWireframe >= 17.5 && uniforms.isWireframe < 18.5) {
            // Selection Holographic Surface Wash with View-Space Fresnel Rim
            let viewPos3 = vViewPos.xyz;
            var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
            let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
            let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
            var rawN = cross(dX, dY);
            var lenN = length(rawN);
            var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
            if (normal.z < 0.0) { normal = -normal; }
            let viewDir = normalize(-viewPos3);
            let NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            let rim = pow(1.0 - NdotV, 3.0);
            let baseCyan = vec4<f32>(0.0, 0.85, 1.0, uniforms.alpha * 0.20);
            let rimCyan = vec4<f32>(0.4, 0.96, 1.0, uniforms.alpha * 0.90);
            return mix(baseCyan, rimCyan, rim);
        }

        if (uniforms.isWireframe >= 18.5 && uniforms.isWireframe < 19.5) {
            // Hover Holographic Surface Wash with View-Space Fresnel Rim
            let viewPos3 = vViewPos.xyz;
            var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
            let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
            let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
            var rawN = cross(dX, dY);
            var lenN = length(rawN);
            var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
            if (normal.z < 0.0) { normal = -normal; }
            let viewDir = normalize(-viewPos3);
            let NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            let rim = pow(1.0 - NdotV, 3.0);
            let baseAmber = vec4<f32>(1.0, 0.72, 0.10, uniforms.alpha * 0.20);
            let rimAmber = vec4<f32>(1.0, 0.92, 0.45, uniforms.alpha * 0.90);
            return mix(baseAmber, rimAmber, rim);
        }
        
        // Axes Indicator (2.0, 3.0, 4.0) or Gauges (8.0)
        if ((uniforms.isWireframe >= 1.5 && uniforms.isWireframe < 4.5) || (uniforms.isWireframe >= 7.5 && uniforms.isWireframe < 8.5)) {
            var baseColor = vec4<f32>(0.0, 0.0, 0.0, 1.0);
            if (uniforms.isWireframe < 2.5) {
                baseColor = vec4<f32>(1.0, 0.1, 0.1, 1.0);
            } else if (uniforms.isWireframe < 3.5) {
                baseColor = vec4<f32>(0.1, 1.0, 0.1, 1.0);
            } else if (uniforms.isWireframe < 4.5) {
                baseColor = vec4<f32>(0.2, 0.5, 1.0, 1.0);
            } else if (uniforms.isWireframe >= 7.5) {
                baseColor = vec4<f32>(1.0, 0.66, 0.0, 1.0);
            }
            if (uniforms.enableLighting > 0.5) {
                let viewPos3 = vViewPos.xyz;
                var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
                let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
                let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
                var rawN = cross(dX, dY);
                var lenN = length(rawN);
                var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
                if (normal.z < 0.0) { normal = -normal; }
                let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                let diff = max(dot(normal, lightDir), 0.0);
                let reflectDir = reflect(-lightDir, normal);
                let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
                let ao = computeSurfaceAO(viewPos3, normal);
                let lit = baseColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                return vec4<f32>(lit, baseColor.a);
            }
            return baseColor;
        }

        // Detonator Markers (20.0 = Solid, 21.0 = Wireframe)
        if (uniforms.isWireframe >= 19.5 && uniforms.isWireframe <= 21.5) {
            if (uniforms.isWireframe > 20.5) {
                return vec4<f32>(1.0, 0.35, 0.25, 1.0);
            }
            var baseColor = vec4<f32>(1.0, 0.15, 0.15, uniforms.alpha);
            if (uniforms.enableLighting > 0.5) {
                let viewPos3 = vViewPos.xyz;
                var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
                let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
                let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
                var rawN = cross(dX, dY);
                var lenN = length(rawN);
                var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
                if (normal.z < 0.0) { normal = -normal; }
                let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                let diff = max(dot(normal, lightDir), 0.0);
                let reflectDir = reflect(-lightDir, normal);
                let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
                let ao = computeSurfaceAO(viewPos3, normal);
                let lit = baseColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                return vec4<f32>(lit, baseColor.a);
            }
            return baseColor;
        }

        // Obstacle Surfaces (9.0 = Solid with lighting, 10.0 = Gridlines, 11.0 = Solid unlit)
        if (uniforms.isWireframe >= 8.5 && uniforms.isWireframe <= 11.5) {
            if (uniforms.isWireframe > 9.5 && uniforms.isWireframe < 10.5) {
                // 10.0: Wireframe gridlines
                return vec4<f32>(0.8, 0.8, 0.8, uniforms.alpha * 0.5);
            }
            let val = sliceSize.y;
            let t = getT(val, uniforms.minVal, uniforms.maxVal, uniforms.useLogScale);
            let col = getColormapColor(t, uniforms.colormap);
            var baseColor = vec4<f32>(col, uniforms.alpha);

            if (uniforms.isWireframe < 9.5 && uniforms.enableLighting > 0.5) {
                let viewPos3 = vViewPos.xyz;
                var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
                let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
                let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
                var rawN = cross(dX, dY);
                var lenN = length(rawN);
                var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
                if (normal.z < 0.0) { normal = -normal; }
                let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                let diff = max(dot(normal, lightDir), 0.0);
                let reflectDir = reflect(-lightDir, normal);
                let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
                let ao = computeSurfaceAO(viewPos3, normal);
                let lit = baseColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                return vec4<f32>(lit, baseColor.a);
            } else {
                return baseColor;
            }
        }

        // STL Geometry (5.0 = Solid, 6.0 = Wireframe, 7.0 = Solid + Wireframe)
        if (uniforms.isWireframe >= 4.5 && uniforms.isWireframe < 7.5) {
            let relDomainPos = (vLocalPos - uniforms.domainMin) / max(uniforms.domainExtent, vec3<f32>(1e-6, 1e-6, 1e-6));
            let inStlDomain = (relDomainPos.x >= -1e-4 && relDomainPos.x <= 1.0001 &&
                               relDomainPos.y >= -1e-4 && relDomainPos.y <= 1.0001 &&
                               relDomainPos.z >= -1e-4 && relDomainPos.z <= 1.0001);

            var baseColor = vec4<f32>(0.42, 0.44, 0.48, uniforms.alpha);
            if (uniforms.stlShowResults > 0.5 && inStlDomain) {
                let baseNorm = clamp(relDomainPos, vec3<f32>(0.0), vec3<f32>(1.0));
                let val = textureSampleLevel(uVolumeTexture, uSampler, baseNorm, 0.0).r;
                let t = getT(val, uniforms.stlMinVal, uniforms.stlMaxVal, uniforms.stlLogScale);
                let col = getColormapColor(t, uniforms.stlColormap);
                baseColor = vec4<f32>(col, uniforms.alpha);
            }
            if (sliceSize.y > 0.5) {
                baseColor = vec4<f32>(1.0, 0.2, 0.2, uniforms.alpha * 0.4);
            }
            
            if (uniforms.isWireframe < 5.5) {
                // Solid only (5.0)
                if (baseColor.a <= 0.001) {
                    discard;
                }
                if (uniforms.enableLighting > 0.5) {
                    let viewPos3 = vViewPos.xyz;
                    var dX = dpdx(viewPos3);
                    var dY = dpdy(viewPos3);
                    let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
                    let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
                    var rawNormal = cross(dX, dY);
                    var lenN = length(rawNormal);
                    var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawNormal / lenN, lenN > 1e-4);
                    if (normal.z < 0.0) { normal = -normal; }
                    
                    let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                    let diff = max(abs(dot(normal, lightDir)), 0.25);
                    let reflectDir = reflect(-lightDir, normal);
                    let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
                    let ao = computeSurfaceAO(viewPos3, normal);
                    let lit = baseColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                    return vec4<f32>(lit, baseColor.a);
                } else {
                    return baseColor;
                }
            }

            // Barycentric Wireframe Rendering
            let barycentric = vec3<f32>(texCoord, sliceSize.x);
            let d = abs(dpdx(barycentric)) + abs(dpdy(barycentric));
            let barycentricPixels = barycentric / max(d, vec3<f32>(1e-5, 1e-5, 1e-5));
            let minPixelDist = min(min(barycentricPixels.x, barycentricPixels.y), barycentricPixels.z);
            var lineCoverage = 1.0 - smoothstep(0.2, 0.9, minPixelDist);
            
            if (uniforms.isWireframe < 6.5) {
                // Wireframe only (6.0)
                var wireColor = vec4<f32>(0.15, 0.15, 0.15, 0.95);
                if (uniforms.stlShowResults > 0.5 && inStlDomain) {
                    let baseNorm = clamp(relDomainPos, vec3<f32>(0.0), vec3<f32>(1.0));
                    let val = textureSampleLevel(uVolumeTexture, uSampler, baseNorm, 0.0).r;
                    let col = getColormapColor(getT(val, uniforms.stlMinVal, uniforms.stlMaxVal, uniforms.stlLogScale), uniforms.stlColormap);
                    wireColor = vec4<f32>(col, 0.95);
                } else if (sliceSize.y > 0.5) {
                    wireColor = vec4<f32>(0.8, 0.1, 0.1, 0.95);
                }
                if (lineCoverage < 0.01) { discard; }
                return vec4<f32>(wireColor.rgb, wireColor.a * lineCoverage);
            }
            
            // Solid + Wireframe (7.0)
            if (baseColor.a <= 0.001) {
                if (lineCoverage < 0.01) { discard; }
                var wireColor = vec4<f32>(0.15, 0.15, 0.15, 0.95);
                if (uniforms.stlShowResults > 0.5 && inStlDomain) {
                    let baseNorm = clamp(relDomainPos, vec3<f32>(0.0), vec3<f32>(1.0));
                    let val = textureSampleLevel(uVolumeTexture, uSampler, baseNorm, 0.0).r;
                    let col = getColormapColor(getT(val, uniforms.stlMinVal, uniforms.stlMaxVal, uniforms.stlLogScale), uniforms.stlColormap);
                    wireColor = vec4<f32>(col, 0.95);
                } else if (sliceSize.y > 0.5) {
                    wireColor = vec4<f32>(0.8, 0.1, 0.1, 0.95);
                }
                return vec4<f32>(wireColor.rgb, wireColor.a * lineCoverage);
            }
            var litColor = baseColor;
            if (uniforms.enableLighting > 0.5) {
                let viewPos3 = vViewPos.xyz;
                var dX = dpdx(viewPos3);
                var dY = dpdy(viewPos3);
                let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
                let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
                var rawNormal = cross(dX, dY);
                var lenN = length(rawNormal);
                var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawNormal / lenN, lenN > 1e-4);
                if (normal.z < 0.0) { normal = -normal; }
                let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                let diff = max(abs(dot(normal, lightDir)), 0.25);
                let reflectDir = reflect(-lightDir, normal);
                let spec = pow(max(dot(reflectDir, vec3<f32>(0.0, 0.0, 1.0)), 0.0), 16.0);
                let ao = computeSurfaceAO(viewPos3, normal);
                let lit = baseColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                litColor = vec4<f32>(lit, baseColor.a);
            }
            var darkWireColor = vec4<f32>(0.0, 0.0, 0.0, max(litColor.a, 0.95));
            if (sliceSize.y > 0.5) { darkWireColor = vec4<f32>(0.8, 0.1, 0.1, max(litColor.a, 0.95)); }
            return mix(litColor, darkWireColor, lineCoverage * 0.85);
        }

        // MPM Particles & FEM Solid (14.0 = Direct RGB Vertex / Facet Color)
        if (uniforms.isWireframe >= 13.5 && uniforms.isWireframe < 14.5) {
            return vec4<f32>(texCoord.x, texCoord.y, sliceSize.x, uniforms.alpha);
        }

        // Solid Black (15.0 = FEM Wireframe)
        if (uniforms.isWireframe >= 14.5 && uniforms.isWireframe < 15.5) {
            return vec4<f32>(0.0, 0.0, 0.0, uniforms.alpha);
        }
    }
    var color: vec3<f32>;
    if (uniforms.interpolate < 0.5) {
        let cellUv = (floor(texCoord * sliceSize) + vec2<f32>(0.5, 0.5)) / sliceSize;
        let raw = textureSample(uTexture, uSampler, cellUv).r;
        let t = getT(raw, uniforms.minVal, uniforms.maxVal, uniforms.useLogScale);
        color = getColormapColor(t, i32(uniforms.colormap));
    } else {
        let raw = textureSample(uTexture, uSampler, texCoord).r;
        let t = getT(raw, uniforms.minVal, uniforms.maxVal, uniforms.useLogScale);
        color = getColormapColor(t, i32(uniforms.colormap));
    }

    var finalColor = vec4<f32>(color, uniforms.alpha);

    if (uniforms.enableLighting > 0.5) {
        let viewPos3 = vViewPos.xyz;
        var dX = dpdx(viewPos3); var dY = dpdy(viewPos3);
        let lX = length(dX); if (lX > 1e-12) { dX = dX / lX; }
        let lY = length(dY); if (lY > 1e-12) { dY = dY / lY; }
        var rawN = cross(dX, dY);
        var lenN = length(rawN);
        var normal = select(vec3<f32>(0.0, 0.0, 1.0), rawN / lenN, lenN > 1e-4);
        if (normal.z < 0.0) { normal = -normal; }
        
        let lightDir = normalize(vec3<f32>(0.5, 0.8, 1.0));
        let diff = max(dot(normal, lightDir), 0.0) * 0.7 + max(dot(-normal, lightDir), 0.0) * 0.3;
        
        let reflectDir = reflect(-lightDir, normal);
        let viewDir = normalize(-viewPos3);
        let spec = pow(max(dot(reflectDir, viewDir), 0.0), 32.0);
        
        let ao = computeSurfaceAO(viewPos3, normal);
        let lit = finalColor.rgb * (uniforms.ambientLevel * ao + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
        finalColor = vec4<f32>(lit, finalColor.a);
    }

    if (uniforms.showCellEdges > 0.5) {
        let grid = abs(fract(texCoord * sliceSize - vec2<f32>(0.5, 0.5)) - vec2<f32>(0.5, 0.5));
        let threshold = max(fwidth(texCoord * sliceSize), vec2<f32>(0.003, 0.003));
        let distToEdge = grid / threshold;
        let minDist = min(distToEdge.x, distToEdge.y);
        let isEdge = 1.0 - smoothstep(0.4, 1.4, minDist);
        finalColor = vec4<f32>(mix(finalColor.rgb, vec3<f32>(0.0, 0.0, 0.0), isEdge), finalColor.a);
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
let gpuHighlightLinePipeline: any = null;
let gpuSTLLinePipeline: any = null;
let gpuPointPipeline: any = null;
let gpuParticleBillboardPipeline: any = null;
let gpuMPMParticlesBuffer: any = null;
let gpuMPMParticlesBufferSize: number = 0;
let cachedMPMVertexData: Float32Array | null = null;
let gpuUniformBufferMPM: any = null;
let gpuSampler: any = null;
let gpuSamplerLinear: any = null;
let gpuSamplerNearest: any = null;
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
let lastRequestedWidth: number | null = null;
let lastRequestedHeight: number | null = null;

let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let bboxBuffer: WebGLBuffer | null = null;
let amrTilesBuffer: WebGLBuffer | null = null;
let amrTilesCount = 0;
let gpuAMRTilesBuffer: any = null;
let gpuAMRTilesBufferSize: number = 0;

let sliceGridlinesBuffer: WebGLBuffer | null = null;
let sliceGridlinesCount = 0;
let gpuSliceGridlinesBuffer: any = null;
let gpuSliceGridlinesBufferSize: number = 0;

let amrLeafTilesCache: any[] = [];
let slicesConfigCache: any[] = [];

let ctx2D: OffscreenCanvasRenderingContext2D | null = null;

// Camera / Projection Settings
let projectionMatrix = new Float32Array(16);
let viewMatrix = new Float32Array(16);
let modelMatrix = new Float32Array(16);

let distance = 1.35;
let pitch = 0.42;
let yaw = 2.356;
let targetX = 0.0;
let targetY = 0.0;
let targetZ = 0.0;
let pivotX = 0.0;
let pivotY = 0.0;
let pivotZ = 0.0;
let hasCustomPivot = false;
let usePerspective = true;
let fov = 45.0;
let cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
let cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
let cameraEyeZ = targetZ + distance * Math.sin(pitch);
let hasCFDSolver = false;
let femBoundsInitialized = false;

let cameraChangeTimer: any = null;
function notifyCameraChanged() {
    self.postMessage({
        type: 'cameraChanged',
        data: {
            pitch,
            yaw,
            distance,
            targetX,
            targetY,
            targetZ,
            usePerspective,
            fov
        }
    });
}

function scheduleCameraChangedNotification() {
    if (cameraChangeTimer) clearTimeout(cameraChangeTimer);
    cameraChangeTimer = setTimeout(() => {
        cameraChangeTimer = null;
        notifyCameraChanged();
    }, 150);
}

function rotateVectorAroundAxis(v: number[], axis: number[], angle: number): number[] {
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

// Contour Visualization Configurations
let colormap = 2; // 2=rainbow
let minY = 101325.0;
let maxY = 1000000.0;
let autoScale = true;
let showGrid = true;
let useLogScale = false;
let showCellEdges = false;
let interpolate = false;

// Viewport Background Clear Color (Studio Slate default: #151922)
let clearColor = { r: 0.082, g: 0.098, b: 0.133, a: 1.0 };

// Viewport Picking, Selection & Hover State
let selectedObject: any = null;
let hoveredObject: any = null;
let highlightWireBuffer: WebGLBuffer | null = null;
let hoverWireBuffer: WebGLBuffer | null = null;
let gpuHighlightWireBuffer: any = null;
let gpuHighlightWireBufferSize: number = 0;
let gpuHoverWireBuffer: any = null;
let gpuHoverWireBufferSize: number = 0;
let gpuUniformBufferHighlight: any = null;
let gpuUniformBufferHover: any = null;

let cachedSelectedKey: string | null = null;
let cachedSelectedVerts: Float32Array = new Float32Array(0);
let cachedHoverKey: string | null = null;
let cachedHoverVerts: Float32Array = new Float32Array(0);

let cachedSelectedKeyWebGPU: string | null = null;
let cachedSelectedVertsWebGPU: Float32Array = new Float32Array(0);
let cachedHoverKeyWebGPU: string | null = null;
let cachedHoverVertsWebGPU: Float32Array = new Float32Array(0);

// Cached bounding boxes for CAD geometry, obstacles, FEM, and MPM
let cachedStlAABB: { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } | null = null;
let cachedObsAABB: { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } | null = null;
let cachedFemAABB: { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } | null = null;
let cachedMpmAABB: { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } | null = null;

// WebGL Cached Uniform Locations
let glUniforms: Record<string, WebGLUniformLocation | null> = {};

// STL Geometry Buffers & Settings
let rawSTLVertices: Float32Array | null = null;
let rawSTLSubtractiveFlags: Float32Array | null = null;
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
let stlColormap = 'rainbow';
let stlShowResults = true;
let stlQuantity = 'pressure';
let stlSamplingMode = 'nearest';
let stlAutoScale = true;
let stlLogScale = false;
let stlMinVal = 101325.0;
let stlMaxVal = 1013250.0;
let meshType = 'regular';

let latestVolume3DData: Float32Array | null = null;
let latestVolume3DNx = 64, latestVolume3DNy = 64, latestVolume3DNz = 64;
let stlVolMin = 0.0;
let stlVolMax = 1.0;
let gpuVolume3DTexture: any = null;
let gpuVolume3DTextureView: any = null;
let gpuDummy3DTexture: any = null;
let gpuDummy3DTextureView: any = null;
let cachedVolNx = 0, cachedVolNy = 0, cachedVolNz = 0;

// Bounding Box & Grid Settings
let gridOpacity = 1.0;
let gridMeshlines = true;
let showGridBox = true;
let bboxVertexCount = 24;

// Virtual Gauges Settings
let showGauges = true;
let gaugeSize = 0.03;
let gaugeOpacity = 1.0;
let gaugeQuantity = 'pressure';
let gaugeSolid = true;
let gaugesList: any[] = [];
let gaugesBuffer: WebGLBuffer | null = null;
let gaugesCount = 0;
let gpuGaugesBuffer: any = null;
let gpuGaugesCount = 0;
let gpuUniformBufferGauges: any = null;

// Slices & Viewport Settings
let showSlices = true;

// Obstacles Settings
let showObstacles = false;
let obstaclesGridlines = true;
let obstaclesSolid = true;
let obstaclesLighting = true;
let obstaclesOpacity = 1.0;
let obstaclesQuantity = 'pressure';
let obstaclesColormap = 'rainbow';
let obstaclesAutoScale = true;
let obstaclesLogScale = false;
let obstaclesInterpolate = false;
let obstaclesMinVal = 101325.0;
let obstaclesMaxVal = 1013250.0;

// Obstacles Mesh Buffers
let rawObstacleVertices: Float32Array | null = null;
let rawObstacleCells: Int32Array | null = null;
let obstacleBuffer: WebGLBuffer | null = null;
let obstacleWireIndexBuffer: WebGLBuffer | null = null;
let obstacleTriIndexBuffer: WebGLBuffer | null = null;
let obstacleTriIndexCount = 0;
let obstacleWireIndexCount = 0;
let latestObstaclesData: Float32Array | null = null;

let gpuObstaclesVertexBuffer: any = null;
let gpuObstaclesTriIndexBuffer: any = null;
let gpuObstaclesWireIndexBuffer: any = null;
let gpuUniformBufferObstaclesSolid: any = null;
let gpuUniformBufferObstaclesWire: any = null;
let gpuUniformBufferFEMSolid: any = null;
let gpuUniformBufferFEMWire: any = null;

interface CachedSlice {
    axis: number;
    offset: number;
    w: number;
    h: number;
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
    zmin: number;
    zmax: number;
    level: number;
    is_submesh: boolean;
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
let xmax = 1.0;
let ymax = 1.0;
let zmax = 1.0;
let dx = 0.01;
let dy = 0.01;
let dz = 0.01;
let nx = 64;
let ny = 64;
let nz = 64;

function getDimX(): number {
    if (xmax !== undefined && xmax > xmin) return xmax - xmin;
    if (nx && dx && nx * dx > 0) return nx * dx;
    return 1.0;
}
function getDimY(): number {
    if (ymax !== undefined && ymax > ymin) return ymax - ymin;
    if (ny && (dy || dx) && ny * (dy || dx) > 0) return ny * (dy || dx);
    return 1.0;
}
function getDimZ(): number {
    if (zmax !== undefined && zmax > zmin) return zmax - zmin;
    if (nz && (dz || dx) && nz * (dz || dx) > 0) return nz * (dz || dx);
    return 1.0;
}

// Axes Indicator Buffers
let gpuAxesBuffer: any = null;
let axesBuffer: WebGLBuffer | null = null;

// 2D Overlay Offscreen Canvas for Zero-Lag Axes & Labels
let overlayCanvas: OffscreenCanvas | null = null;
let overlayCtx: OffscreenCanvasRenderingContext2D | null = null;
let devicePixelRatio: number = 1.0;

// Lighting / Shadow / Opacity Configurations
let lightingEnabled = true;
let aoEnabled = true;
let aoRadius = 0.15;
let aoIntensity = 1.2;
let aoBias = 0.005;
let aoSphereImpostor = true;
let specularIntensity = 0.4;
let ambientLevel = 0.3;
let sliceOpacities = [1.0, 1.0, 1.0]; // xy, xz, yz

function canonicalizeQuantity(q: string | undefined | null): string {
    if (!q) return 'pressure';
    const s = q.trim().toLowerCase();
    if (s === 'overpressure' || s === 'peak_overpressure' || s === 'peak_pressure' || s === 'pk_press') return 'peak_overpressure';
    if (s === 'impulse' || s === 'peak_impulse' || s === 'pk_impulse') return 'peak_impulse';
    if (s === 'species1' || s === 'species_1' || s === 'species' || s === 'products' || s === 'detonation_products' || s === 'detonation' || s === 'reacted' || s === 'reacted_gas' || s === 'alpha1' || s === 'alpha_1') return 'species1';
    if (s === 'species2' || s === 'species_2' || s === 'unreacted' || s === 'unreacted_solid' || s === 'solid_he' || s === 'alpha2' || s === 'alpha_2') return 'species2';
    if (s === 'species3' || s === 'species_3' || s === 'air' || s === 'ambient_air' || s === 'alpha3' || s === 'alpha_3') return 'species3';
    if (s === 'plastic_strain' || s === 'plasticstrain' || s === 'eps_p' || s === 'ep' || s === 'fem_strain' || s === 'mpm_strain') return 'plastic_strain';
    if (s === 'vonmises' || s === 'von_mises' || s === 'vm_stress' || s === 'stress' || s === 'fem_stress' || s === 'mpm_stress') return 'vonMises';
    if (s === 'temperature' || s === 'temp' || s === 'fem_temp' || s === 'mpm_temp') return 'temperature';
    if (s === 'displacement' || s === 'disp' || s === 'fem_disp' || s === 'mpm_disp') return 'displacement';
    if (s === 'damage' || s === 'fem_damage' || s === 'mpm_damage') return 'damage';
    if (s === 'has_failed' || s === 'failure' || s === 'failed') return 'has_failed';
    if (s === 'cluster_id' || s === 'cluster' || s === 'fragment_id' || s === 'fragments') return 'cluster_id';
    if (s === 'object_id' || s === 'obj_id' || s === 'object') return 'object_id';
    if (s === 'pressure' || s === 'density' || s === 'velocity' || s === 'energy' || s === 'solid' || s === 'amr_level') return s;
    return s;
}

const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0],
    species_1: [0.0, 1.0],
    species_2: [0.0, 1.0],
    species_3: [0.0, 1.0],
    alpha1: [0.0, 1.0],
    alpha2: [0.0, 1.0],
    alpha3: [0.0, 1.0],
    products: [0.0, 1.0],
    detonation_products: [0.0, 1.0],
    detonation: [0.0, 1.0],
    reacted: [0.0, 1.0],
    unreacted: [0.0, 1.0],
    air: [0.0, 1.0],
    solid: [0.0, 1.0],
    overpressure: [0.0, 101325.0 * 99.0],
    peak_overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0],
    peak_impulse: [0.0, 10000.0],
    plastic_strain: [0.0, 1.0],
    plasticStrain: [0.0, 1.0],
    vonMises: [0.0, 500.0e6],
    von_mises: [0.0, 500.0e6],
    damage: [0.0, 1.0],
    has_failed: [0.0, 1.0],
    cluster_id: [0.0, 50.0],
    object_id: [0.0, 10.0],
    temperature: [300.0, 3000.0],
    displacement: [0.0, 0.1],
    momentOrForce: [0.0, 1000.0]
};

let quantityColormaps: Record<string, string> = {
    pressure: 'rainbow',
    density: 'rainbow',
    velocity: 'rainbow',
    energy: 'rainbow',
    species1: 'rainbow',
    species2: 'rainbow',
    species3: 'rainbow',
    species_1: 'rainbow',
    species_2: 'rainbow',
    species_3: 'rainbow',
    alpha1: 'rainbow',
    alpha2: 'rainbow',
    alpha3: 'rainbow',
    products: 'rainbow',
    detonation_products: 'rainbow',
    detonation: 'rainbow',
    reacted: 'rainbow',
    unreacted: 'rainbow',
    air: 'rainbow',
    solid: 'rainbow',
    overpressure: 'rainbow',
    peak_overpressure: 'rainbow',
    impulse: 'rainbow',
    peak_impulse: 'rainbow',
    plastic_strain: 'rainbow',
    plasticStrain: 'rainbow',
    vonMises: 'rainbow',
    von_mises: 'rainbow',
    damage: 'rainbow',
    has_failed: 'rainbow',
    cluster_id: 'rainbow',
    object_id: 'rainbow',
    temperature: 'rainbow',
    displacement: 'rainbow',
    momentOrForce: 'rainbow'
};

let slicesConfig: any[] = [];
let quantityRanges: Record<string, [number, number]> = {};
let quantityLogScales: Record<string, boolean> = {};
let quantityAutoScales: Record<string, boolean> = {};
let lockQuantityRanges = true;
let stlLockQuantityRange = true;
let obstaclesLockQuantityRange = true;
let mpmLockQuantityRange = true;
let femLockQuantityRange = true;
let beamLockQuantityRange = true;
let focusedSliceIndex = 0;

function getSliceConfig(idx: number): any {
    const slice = cachedSlices[idx];
    if (!slice) return {};
    
    let parentIdx = -1;
    if (!slice.is_submesh) {
        parentIdx = idx;
    } else {
        // Find parent slice with the same axis and offset
        for (let j = 0; j < cachedSlices.length; j++) {
            const p = cachedSlices[j];
            if (!p.is_submesh && p.axis === slice.axis && Math.abs(p.offset - slice.offset) < 1e-4) {
                parentIdx = j;
                break;
            }
        }
    }
    
    if (parentIdx === -1) {
        return {};
    }
    
    // Count how many parent slices exist in cachedSlices before and including parentIdx
    let parentCount = 0;
    for (let j = 0; j <= parentIdx; j++) {
        if (!cachedSlices[j].is_submesh) {
            parentCount++;
        }
    }
    
    const configIdx = parentCount - 1;
    return slicesConfig[configIdx] || {};
}

function getCachedSliceByParentIndex(parentIdx: number): CachedSlice | undefined {
    let parentCount = 0;
    for (let i = 0; i < cachedSlices.length; i++) {
        if (!cachedSlices[i].is_submesh) {
            if (parentCount === parentIdx) {
                return cachedSlices[i];
            }
            parentCount++;
        }
    }
    // Fallback: first parent slice
    for (let i = 0; i < cachedSlices.length; i++) {
        if (!cachedSlices[i].is_submesh) {
            return cachedSlices[i];
        }
    }
    return cachedSlices[0];
}

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
    const ox = 0;
    const oy = 0;
    const oz = 0;

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
        cachedStlAABB = null;
        stlBVH = null;
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

    const count = rawSTLVertices.length / 3;
    const data = new Float32Array(count * 7);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
        const vx = rawSTLVertices[i * 3 + 0];
        const vy = rawSTLVertices[i * 3 + 1];
        const vz = rawSTLVertices[i * 3 + 2];

        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;

        data[i * 7 + 0] = vx;
        data[i * 7 + 1] = vy;
        data[i * 7 + 2] = vz;
        
        // Barycentric coordinates: 
        // Vertex 0: (1, 0, 0), Vertex 1: (0, 1, 0), Vertex 2: (0, 0, 1)
        // Stored as: texCoord = (u, v), sliceSize = (w, subtractiveFlag)
        const triVertexIndex = i % 3;
        if (triVertexIndex === 0) {
            data[i * 7 + 3] = 1.0;
            data[i * 7 + 4] = 0.0;
            data[i * 7 + 5] = 0.0;
        } else if (triVertexIndex === 1) {
            data[i * 7 + 3] = 0.0;
            data[i * 7 + 4] = 1.0;
            data[i * 7 + 5] = 0.0;
        } else {
            data[i * 7 + 3] = 0.0;
            data[i * 7 + 4] = 0.0;
            data[i * 7 + 5] = 1.0;
        }
        // Use the subtractive flag if provided
        data[i * 7 + 6] = (rawSTLSubtractiveFlags && i < rawSTLSubtractiveFlags.length) ? rawSTLSubtractiveFlags[i] : 0.0;
    }

    cachedStlAABB = { minX, maxX, minY, maxY, minZ, maxZ };
    transformedSTLVertices = data;
    stlBVH = buildMeshBVH(rawSTLVertices, 9);

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

let cachedObstacleVertexData: Float32Array | null = null;
let cachedObstaclesMinVal = 0.0;
let cachedObstaclesMaxVal = 1.0;

const stlFinalModelMat = new Float32Array(16);
const stlModelMat = new Float32Array(16);
const obsFinalModelMat = new Float32Array(16);

function updateObstaclesValues(floatData: Float32Array) {
    if (!rawObstacleVertices || rawObstacleVertices.length === 0) return;
    const numFaces = rawObstacleVertices.length / 12;
    if (!cachedObstacleVertexData || cachedObstacleVertexData.length !== numFaces * 4 * 7) {
        updateObstaclesGeometry();
        return;
    }
    for (let f = 0; f < numFaces; ++f) {
        const val = floatData[f] || 0.0;
        const base = f * 28;
        cachedObstacleVertexData[base + 6] = val;
        cachedObstacleVertexData[base + 13] = val;
        cachedObstacleVertexData[base + 20] = val;
        cachedObstacleVertexData[base + 27] = val;
    }
    if (gl && obstacleBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, cachedObstacleVertexData);
    }
    if (isWebGPU && gpuDevice && gpuObstaclesVertexBuffer) {
        gpuDevice.queue.writeBuffer(gpuObstaclesVertexBuffer, 0, cachedObstacleVertexData.buffer);
    }
}

function rebuildObstaclesGL() {
    if (!gl || !rawObstacleVertices || !rawObstacleCells) return;

    let obsMinX = Infinity, obsMinY = Infinity, obsMinZ = Infinity;
    let obsMaxX = -Infinity, obsMaxY = -Infinity, obsMaxZ = -Infinity;
    for (let i = 0; i < rawObstacleVertices.length; i += 3) {
        const vx = rawObstacleVertices[i], vy = rawObstacleVertices[i+1], vz = rawObstacleVertices[i+2];
        if (vx < obsMinX) obsMinX = vx; if (vx > obsMaxX) obsMaxX = vx;
        if (vy < obsMinY) obsMinY = vy; if (vy > obsMaxY) obsMaxY = vy;
        if (vz < obsMinZ) obsMinZ = vz; if (vz > obsMaxZ) obsMaxZ = vz;
    }
    cachedObsAABB = { minX: obsMinX, maxX: obsMaxX, minY: obsMinY, maxY: obsMaxY, minZ: obsMinZ, maxZ: obsMaxZ };

    const numFaces = rawObstacleVertices.length / 12;
    const vertexData = new Float32Array(numFaces * 4 * 7);

    for (let f = 0; f < numFaces; ++f) {
        const val = latestObstaclesData ? latestObstaclesData[f] : 0.0;
        const corners = [
            [0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]
        ];

        for (let v = 0; v < 4; ++v) {
            const vIdx = f * 4 + v;
            const dest = vIdx * 7;

            // position
            vertexData[dest + 0] = rawObstacleVertices[f * 12 + v * 3 + 0];
            vertexData[dest + 1] = rawObstacleVertices[f * 12 + v * 3 + 1];
            vertexData[dest + 2] = rawObstacleVertices[f * 12 + v * 3 + 2];

            // texCoord / barycentric
            vertexData[dest + 3] = corners[v][0];
            vertexData[dest + 4] = corners[v][1];

            // sliceSize
            vertexData[dest + 5] = 0.0;
            vertexData[dest + 6] = val;
        }
    }

    if (!obstacleBuffer) {
        obstacleBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);
    } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);
    }

    const expectedTriIndices = numFaces * 6;
    if (!obstacleTriIndexBuffer || obstacleTriIndexCount !== expectedTriIndices) {
        if (obstacleTriIndexBuffer) {
            gl.deleteBuffer(obstacleTriIndexBuffer);
            obstacleTriIndexBuffer = null;
        }
        obstacleTriIndexBuffer = gl.createBuffer();
        const indices = new Uint32Array(numFaces * 6);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            indices[f * 6 + 0] = v0;
            indices[f * 6 + 1] = v1;
            indices[f * 6 + 2] = v2;

            indices[f * 6 + 3] = v0;
            indices[f * 6 + 4] = v2;
            indices[f * 6 + 5] = v3;
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleTriIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        obstacleTriIndexCount = numFaces * 6;
    }

    const expectedWireIndices = numFaces * 8;
    if (!obstacleWireIndexBuffer || obstacleWireIndexCount !== expectedWireIndices) {
        if (obstacleWireIndexBuffer) {
            gl.deleteBuffer(obstacleWireIndexBuffer);
            obstacleWireIndexBuffer = null;
        }
        obstacleWireIndexBuffer = gl.createBuffer();
        const wireIndices = new Uint32Array(numFaces * 8);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            wireIndices[f * 8 + 0] = v0; wireIndices[f * 8 + 1] = v1;
            wireIndices[f * 8 + 2] = v1; wireIndices[f * 8 + 3] = v2;
            wireIndices[f * 8 + 4] = v2; wireIndices[f * 8 + 5] = v3;
            wireIndices[f * 8 + 6] = v3; wireIndices[f * 8 + 7] = v0;
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleWireIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndices, gl.STATIC_DRAW);
        obstacleWireIndexCount = numFaces * 8;
    }
}

function rebuildObstaclesWebGPU() {
    if (!gpuDevice || !rawObstacleVertices) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < rawObstacleVertices.length; i += 3) {
        const vx = rawObstacleVertices[i], vy = rawObstacleVertices[i+1], vz = rawObstacleVertices[i+2];
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
    }
    cachedObsAABB = { minX, maxX, minY, maxY, minZ, maxZ };

    const numFaces = rawObstacleVertices.length / 12;
    const vertexData = new Float32Array(numFaces * 4 * 7);

    for (let f = 0; f < numFaces; ++f) {
        const val = latestObstaclesData ? latestObstaclesData[f] : 0.0;
        const corners = [
            [0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]
        ];

        for (let v = 0; v < 4; ++v) {
            const vIdx = f * 4 + v;
            const dest = vIdx * 7;

            // position
            vertexData[dest + 0] = rawObstacleVertices[f * 12 + v * 3 + 0];
            vertexData[dest + 1] = rawObstacleVertices[f * 12 + v * 3 + 1];
            vertexData[dest + 2] = rawObstacleVertices[f * 12 + v * 3 + 2];

            // texCoord / barycentric
            vertexData[dest + 3] = corners[v][0];
            vertexData[dest + 4] = corners[v][1];

            // sliceSize
            vertexData[dest + 5] = 0.0;
            vertexData[dest + 6] = val;
        }
    }

    if (gpuObstaclesVertexBuffer && gpuObstaclesVertexBuffer.size === vertexData.byteLength) {
        gpuDevice.queue.writeBuffer(gpuObstaclesVertexBuffer, 0, vertexData.buffer);
    } else {
        if (gpuObstaclesVertexBuffer) gpuObstaclesVertexBuffer.destroy();
        gpuObstaclesVertexBuffer = gpuDevice.createBuffer({
            size: vertexData.byteLength,
            usage: 32 | 8, // VERTEX | COPY_DST
            mappedAtCreation: true
        });
        new Float32Array(gpuObstaclesVertexBuffer.getMappedRange()).set(vertexData);
        gpuObstaclesVertexBuffer.unmap();
    }

    const expectedTriIndices = numFaces * 6;
    if (!gpuObstaclesTriIndexBuffer || obstacleTriIndexCount !== expectedTriIndices) {
        if (gpuObstaclesTriIndexBuffer) {
            gpuObstaclesTriIndexBuffer.destroy();
            gpuObstaclesTriIndexBuffer = null;
        }
        const triIndices = new Uint32Array(numFaces * 6);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            triIndices[f * 6 + 0] = v0;
            triIndices[f * 6 + 1] = v1;
            triIndices[f * 6 + 2] = v2;

            triIndices[f * 6 + 3] = v0;
            triIndices[f * 6 + 4] = v2;
            triIndices[f * 6 + 5] = v3;
        }
        gpuObstaclesTriIndexBuffer = gpuDevice.createBuffer({
            size: triIndices.byteLength,
            usage: 16 | 8,
            mappedAtCreation: true
        });
        new Uint32Array(gpuObstaclesTriIndexBuffer.getMappedRange()).set(triIndices);
        gpuObstaclesTriIndexBuffer.unmap();
        obstacleTriIndexCount = numFaces * 6;
    }

    const expectedWireIndices = numFaces * 8;
    if (!gpuObstaclesWireIndexBuffer || obstacleWireIndexCount !== expectedWireIndices) {
        if (gpuObstaclesWireIndexBuffer) {
            gpuObstaclesWireIndexBuffer.destroy();
            gpuObstaclesWireIndexBuffer = null;
        }
        const wireIndices = new Uint32Array(numFaces * 8);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            wireIndices[f * 8 + 0] = v0; wireIndices[f * 8 + 1] = v1;
            wireIndices[f * 8 + 2] = v1; wireIndices[f * 8 + 3] = v2;
            wireIndices[f * 8 + 4] = v2; wireIndices[f * 8 + 5] = v3;
            wireIndices[f * 8 + 6] = v3; wireIndices[f * 8 + 7] = v0;
        }
        gpuObstaclesWireIndexBuffer = gpuDevice.createBuffer({
            size: wireIndices.byteLength,
            usage: 16 | 8,
            mappedAtCreation: true
        });
        new Uint32Array(gpuObstaclesWireIndexBuffer.getMappedRange()).set(wireIndices);
        gpuObstaclesWireIndexBuffer.unmap();
        obstacleWireIndexCount = numFaces * 8;
    }
}

function updateVolume3DTexture(inNx?: number, inNy?: number, inNz?: number) {
    if (!isWebGPU || !gpuDevice || !latestVolume3DData || latestVolume3DData.length === 0) return;

    const curNx = inNx || nx || 64;
    const curNy = inNy || ny || 64;
    const curNz = inNz || nz || 64;

    if (latestVolume3DData.length !== curNx * curNy * curNz) return;

    if (!gpuVolume3DTexture || cachedVolNx !== curNx || cachedVolNy !== curNy || cachedVolNz !== curNz) {
        if (gpuVolume3DTexture) gpuVolume3DTexture.destroy();
        cachedVolNx = curNx;
        cachedVolNy = curNy;
        cachedVolNz = curNz;
        gpuVolume3DTexture = gpuDevice.createTexture({
            size: { width: curNx, height: curNy, depthOrArrayLayers: curNz },
            dimension: '3d',
            format: 'r32float',
            usage: 4 | 8
        });
        gpuVolume3DTextureView = gpuVolume3DTexture.createView();
    }

    gpuDevice.queue.writeTexture(
        { texture: gpuVolume3DTexture },
        latestVolume3DData.buffer,
        { bytesPerRow: curNx * 4, rowsPerImage: curNy },
        { width: curNx, height: curNy, depthOrArrayLayers: curNz }
    );
}

let glVolume3DTexture: WebGLTexture | null = null;
let cachedGLVolW = 0;
let cachedGLVolH = 0;
let cachedGLVolNz = 0;

function updateWebGL2Volume3DTexture(floatData: Float32Array, w: number, h: number, curNz: number) {
    if (!gl) return;
    if (!glVolume3DTexture) {
        glVolume3DTexture = gl.createTexture();
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, glVolume3DTexture);
    const filter = (stlSamplingMode === 'linear') ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (cachedGLVolW !== w || cachedGLVolH !== h || cachedGLVolNz !== curNz) {
        cachedGLVolW = w;
        cachedGLVolH = h;
        cachedGLVolNz = curNz;
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, w, h, curNz, 0, gl.RED, gl.FLOAT, floatData);
    } else {
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, w, h, curNz, gl.RED, gl.FLOAT, floatData);
    }
    gl.activeTexture(gl.TEXTURE0);
}

let glDummy3DTexture: WebGLTexture | null = null;

function getDummy3DTextureGL(): WebGLTexture {
    if (!glDummy3DTexture && gl) {
        glDummy3DTexture = gl.createTexture();
        if (gl.TEXTURE_3D) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, glDummy3DTexture);
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, 1, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.activeTexture(gl.TEXTURE0);
        }
    }
    return glDummy3DTexture!;
}

function updateObstaclesGeometry() {
    if (!rawObstacleVertices || rawObstacleVertices.length === 0) {
        obstacleBVH = null;
        if (gpuObstaclesVertexBuffer) {
            gpuObstaclesVertexBuffer.destroy();
            gpuObstaclesVertexBuffer = null;
        }
        if (gpuObstaclesTriIndexBuffer) {
            gpuObstaclesTriIndexBuffer.destroy();
            gpuObstaclesTriIndexBuffer = null;
        }
        if (gpuObstaclesWireIndexBuffer) {
            gpuObstaclesWireIndexBuffer.destroy();
            gpuObstaclesWireIndexBuffer = null;
        }
        if (gl) {
            if (obstacleBuffer) {
                gl.deleteBuffer(obstacleBuffer);
                obstacleBuffer = null;
            }
            if (obstacleTriIndexBuffer) {
                gl.deleteBuffer(obstacleTriIndexBuffer);
                obstacleTriIndexBuffer = null;
            }
            if (obstacleWireIndexBuffer) {
                gl.deleteBuffer(obstacleWireIndexBuffer);
                obstacleWireIndexBuffer = null;
            }
        }
        obstacleTriIndexCount = 0;
        obstacleWireIndexCount = 0;
        return;
    }

    if (gl) {
        rebuildObstaclesGL();
    }

    if (isWebGPU && gpuDevice) {
        rebuildObstaclesWebGPU();
    }

    obstacleBVH = buildMeshBVH(rawObstacleVertices, 12);
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
    return cellPixels >= 6.0;
}

interface SliceDataWebGPU {
    axis: number;
    offset: number;
    w: number;
    h: number;
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
    zmin: number;
    zmax: number;
    level: number;
    is_submesh: boolean;
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
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
    zmin: number;
    zmax: number;
    level: number;
    is_submesh: boolean;
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
                            },
                            {
                                binding: 3,
                                visibility: 2, // FRAGMENT
                                texture: { viewDimension: '3d', sampleType: isFilterable ? 'float' : 'unfilterable-float' }
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

                    // Create dedicated highlight line pipeline (always drawn on top, no Z-fighting)
                    gpuHighlightLinePipeline = gpuDevice.createRenderPipeline({
                        layout: pipelineLayout,
                        vertex: {
                            module: shaderModule,
                            entryPoint: 'vs_main',
                            buffers: [{
                                arrayStride: 20,
                                attributes: [
                                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                                    { shaderLocation: 1, offset: 12, format: 'float32x2' },
                                    { shaderLocation: 2, offset: 12, format: 'float32x2' }
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
                            depthWriteEnabled: false,
                            depthCompare: 'always',
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

                    // Create point pipeline for MPM Particles point cloud
                    gpuPointPipeline = gpuDevice.createRenderPipeline({
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
                        primitive: { topology: 'point-list' },
                        multisample: { count: 4 },
                        depthStencil: {
                            depthWriteEnabled: true,
                            depthCompare: 'less-equal',
                            format: 'depth24plus'
                        }
                    });

                    // Create instanced 3D billboard sphere pipeline for MPM Particles
                    gpuParticleBillboardPipeline = gpuDevice.createRenderPipeline({
                        layout: pipelineLayout,
                        vertex: {
                            module: shaderModule,
                            entryPoint: 'vs_particle_billboard',
                            buffers: [{
                                arrayStride: 28,
                                stepMode: 'instance',
                                attributes: [
                                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                                    { shaderLocation: 1, offset: 12, format: 'float32x2' },
                                    { shaderLocation: 2, offset: 20, format: 'float32x2' }
                                ]
                            }]
                        },
                        fragment: {
                            module: shaderModule,
                            entryPoint: 'fs_particle_billboard',
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

                    gpuSamplerLinear = gpuDevice.createSampler({
                        magFilter: isFilterable ? 'linear' : 'nearest',
                        minFilter: isFilterable ? 'linear' : 'nearest'
                    });
                    gpuSamplerNearest = gpuDevice.createSampler({
                        magFilter: 'nearest',
                        minFilter: 'nearest'
                    });
                    gpuSampler = gpuSamplerLinear;

                    // GPUBufferUsage: UNIFORM = 64, COPY_DST = 8
                    gpuUniformBuffer = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                    gpuUniformBufferWF = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                    gpuUniformBufferGauges = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                    gpuSTLUniformSolid = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                    gpuSTLUniformWireframe = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });

                    gpuAxesUniformBuffers = [];
                    for (let a = 0; a < 3; a++) {
                        const buf = gpuDevice.createBuffer({
                            size: 384,
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
                    updateObstaclesGeometry();

                    const dummyTex = gpuDevice.createTexture({
                        size: [1, 1, 1],
                        format: 'r32float',
                        usage: 4 // TEXTURE_BINDING
                    });
                    gpuDummyTextureView = dummyTex.createView();

                    gpuDummy3DTexture = gpuDevice.createTexture({
                        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                        dimension: '3d',
                        format: 'r32float',
                        usage: 4 // TEXTURE_BINDING
                    });
                    gpuDummy3DTextureView = gpuDummy3DTexture.createView();

                    isWebGPU = true;
                    self.postMessage({ type: 'rendererInfo', renderer: 'WebGPU' });
                    console.log("[ViewportWorker] WebGPU Initialized successfully.");
                    return;
                }
            }
        } catch (e: any) {
            console.warn("[ViewportWorker] Failed to initialize WebGPU, falling back to WebGL.", e);
            self.postMessage({ type: 'log', message: "WebGPU Init Warning: " + (e.message || String(e)) });
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

function getSphereVertices(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number[] {
    const verts: number[] = [];
    const rings = 12;
    const sectors = 12;

    const addTri = (p1: number[], p2: number[], p3: number[]) => {
        // Stride 7: x, y, z, u, v, w, h
        verts.push(...p1, 0, 0, 0, 0);
        verts.push(...p2, 0, 0, 0, 0);
        verts.push(...p3, 0, 0, 0, 0);
    };

    const grid: number[][][] = [];
    for (let ring = 0; ring <= rings; ring++) {
        const phi = (ring * Math.PI) / rings;
        const ringVerts: number[][] = [];
        for (let sector = 0; sector <= sectors; sector++) {
            const theta = (sector * 2 * Math.PI) / sectors;
            const x = cx + rx * Math.sin(phi) * Math.cos(theta);
            const y = cy + ry * Math.sin(phi) * Math.sin(theta);
            const z = cz + rz * Math.cos(phi);
            ringVerts.push([x, y, z]);
        }
        grid.push(ringVerts);
    }

    for (let r_idx = 0; r_idx < rings; r_idx++) {
        for (let s = 0; s < sectors; s++) {
            const p00 = grid[r_idx][s];
            const p10 = grid[r_idx+1][s];
            const p01 = grid[r_idx][s+1];
            const p11 = grid[r_idx+1][s+1];

            addTri(p00, p10, p01);
            addTri(p01, p10, p11);
        }
    }
    return verts;
}

function getSphereWireframeVertices(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number[] {
    const verts: number[] = [];
    const addLine = (p1: number[], p2: number[]) => {
        verts.push(...p1, 0, 0);
        verts.push(...p2, 0, 0);
    };

    const segments = 32;

    // XY Ring (at z = cz)
    for (let i = 0; i < segments; i++) {
        const theta1 = (i * 2 * Math.PI) / segments;
        const theta2 = ((i + 1) * 2 * Math.PI) / segments;
        addLine(
            [cx + rx * Math.cos(theta1), cy + ry * Math.sin(theta1), cz],
            [cx + rx * Math.cos(theta2), cy + ry * Math.sin(theta2), cz]
        );
    }

    // XZ Ring (at y = cy)
    for (let i = 0; i < segments; i++) {
        const theta1 = (i * 2 * Math.PI) / segments;
        const theta2 = ((i + 1) * 2 * Math.PI) / segments;
        addLine(
            [cx + rx * Math.cos(theta1), cy, cz + rz * Math.sin(theta1)],
            [cx + rx * Math.cos(theta2), cy, cz + rz * Math.sin(theta2)]
        );
    }

    // YZ Ring (at x = cx)
    for (let i = 0; i < segments; i++) {
        const theta1 = (i * 2 * Math.PI) / segments;
        const theta2 = ((i + 1) * 2 * Math.PI) / segments;
        addLine(
            [cx, cy + ry * Math.cos(theta1), cz + rz * Math.sin(theta1)],
            [cx, cy + ry * Math.cos(theta2), cz + rz * Math.sin(theta2)]
        );
    }

    return verts;
}

function rotatePointEuler(u: number, v: number, w: number, ax: number, ay: number, az: number): [number, number, number] {
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

function getCylinderVertices(cx: number, cy: number, cz: number, r: number, h: number, ax: number, ay: number, az: number, dimX: number, dimY: number, dimZ: number): number[] {
    const verts: number[] = [];
    const segments = 24;
    const halfH = h * 0.5;

    const addTri = (p1: number[], p2: number[], p3: number[]) => {
        verts.push(...p1, 0, 0, 0, 0);
        verts.push(...p2, 0, 0, 0, 0);
        verts.push(...p3, 0, 0, 0, 0);
    };

    const transformPoint = (u: number, v: number, w: number): number[] => {
        const [ru, rv, rw] = rotatePointEuler(u, v, w, ax, ay, az);
        return [
            cx + ru / dimX,
            cy + rv / dimY,
            cz + rw / dimZ
        ];
    };

    const topCircle: number[][] = [];
    const bottomCircle: number[][] = [];

    for (let i = 0; i <= segments; i++) {
        const theta = (i * 2 * Math.PI) / segments;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        topCircle.push(transformPoint(r * cosT, r * sinT, halfH));
        bottomCircle.push(transformPoint(r * cosT, r * sinT, -halfH));
    }

    // Sides
    for (let i = 0; i < segments; i++) {
        const p1 = bottomCircle[i];
        const p2 = bottomCircle[i + 1];
        const p3 = topCircle[i];
        const p4 = topCircle[i + 1];

        addTri(p1, p3, p2);
        addTri(p2, p3, p4);
    }

    // Top Cap
    const topCenter = transformPoint(0, 0, halfH);
    for (let i = 0; i < segments; i++) {
        addTri(topCenter, topCircle[i], topCircle[i + 1]);
    }

    // Bottom Cap
    const bottomCenter = transformPoint(0, 0, -halfH);
    for (let i = 0; i < segments; i++) {
        addTri(bottomCenter, bottomCircle[i + 1], bottomCircle[i]);
    }

    return verts;
}

function getCylinderWireframeVertices(cx: number, cy: number, cz: number, r: number, h: number, ax: number, ay: number, az: number, dimX: number, dimY: number, dimZ: number): number[] {
    const verts: number[] = [];
    const segments = 32;
    const halfH = h * 0.5;

    const addLine = (p1: number[], p2: number[]) => {
        verts.push(...p1, 0, 0);
        verts.push(...p2, 0, 0);
    };

    const transformPoint = (u: number, v: number, w: number): number[] => {
        const [ru, rv, rw] = rotatePointEuler(u, v, w, ax, ay, az);
        return [
            cx + ru / dimX,
            cy + rv / dimY,
            cz + rw / dimZ
        ];
    };

    // Top & Bottom Rings
    const topRing: number[][] = [];
    const bottomRing: number[][] = [];
    for (let i = 0; i < segments; i++) {
        const theta = (i * 2 * Math.PI) / segments;
        topRing.push(transformPoint(r * Math.cos(theta), r * Math.sin(theta), halfH));
        bottomRing.push(transformPoint(r * Math.cos(theta), r * Math.sin(theta), -halfH));
    }

    for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        addLine(topRing[i], topRing[next]);
        addLine(bottomRing[i], bottomRing[next]);
    }

    // 4 Vertical Pillars connecting them
    const pillarAngles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    for (const angle of pillarAngles) {
        const pBot = transformPoint(r * Math.cos(angle), r * Math.sin(angle), -halfH);
        const pTop = transformPoint(r * Math.cos(angle), r * Math.sin(angle), halfH);
        addLine(pBot, pTop);
    }

    return verts;
}

function updateGaugesGeometry() {
    const mult = (gaugeSize > 0) ? gaugeSize : 1.0;
    const cellMeters = (dx && dx > 0) ? dx : 0.01;
    const radiusMeters = mult * cellMeters * 0.5;

    const dimX = getDimX();
    const dimY = getDimY();
    const dimZ = getDimZ();

    const rx = radiusMeters / dimX;
    const ry = radiusMeters / dimY;
    const rz = radiusMeters / dimZ;

    let verts: number[] = [];
    for (const g of gaugesList) {
        const gx = Number(g.x ?? 0.0);
        const gy = Number(g.y ?? 0.0);
        const gz = Number(g.z ?? 0.0);
        const px = normX(gx);
        const py = normY(gy);
        const pz = normZ(gz);

        const sphereVerts = getSphereVertices(px, py, pz, rx, ry, rz);
        verts.push(...sphereVerts);
    }

    if (gl) {
        if (!gaugesBuffer) {
            gaugesBuffer = gl.createBuffer();
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, gaugesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
        gaugesCount = verts.length / 7;
    }

    if (gpuDevice) {
        if (gpuGaugesBuffer) {
            gpuGaugesBuffer.destroy();
            gpuGaugesBuffer = null;
        }
        gpuGaugesCount = verts.length / 7;
        if (verts.length > 0) {
            gpuGaugesBuffer = gpuDevice.createBuffer({
                size: verts.length * 4,
                usage: 8 | 4, // VERTEX | COPY_DST
                mappedAtCreation: true
            });
            new Float32Array(gpuGaugesBuffer.getMappedRange()).set(verts);
            gpuGaugesBuffer.unmap();
        }
    }
}
let chargeData: any = null;
let showCharge: boolean = true;
let chargeSolid: boolean = true;
let chargeWireframe: boolean = true;
let chargeLighting: boolean = true;
let chargeOpacity: number = 0.65;
let chargeColor: string = '#ff3d00';
let chargeBuffer: WebGLBuffer | null = null;
let chargeCount: number = 0;
let chargeWireBuffer: WebGLBuffer | null = null;
let chargeWireCount: number = 0;
let gpuChargeSolidBuffer: any = null;
let gpuChargeSolidBufferSize: number = 0;
let gpuChargeWireBuffer: any = null;
let gpuChargeWireBufferSize: number = 0;
let gpuUniformBufferChargeSolid: any = null;
let gpuUniformBufferChargeWire: any = null;

let detonatorsList: any[] = [];
let showDetonators: boolean = true;
let detonatorSolid: boolean = true;
let detonatorWireframe: boolean = true;
let detonatorLighting: boolean = true;
let detonatorSize: number = 1.0;
let detonatorOpacity: number = 1.0;
let detonatorBuffer: WebGLBuffer | null = null;
let detonatorCount: number = 0;
let detonatorWireBuffer: WebGLBuffer | null = null;
let detonatorWireCount: number = 0;
let gpuDetonatorSolidBuffer: any = null;
let gpuDetonatorSolidBufferSize: number = 0;
let gpuDetonatorWireBuffer: any = null;
let gpuDetonatorWireBufferSize: number = 0;
let gpuUniformBufferDetonatorSolid: any = null;
let gpuUniformBufferDetonatorWire: any = null;

let mpmObjectsData: any[] = [];
let mpmPreviewBuffer: WebGLBuffer | null = null;
let mpmPreviewCount: number = 0;
let gpuMPMPreviewBuffer: any = null;
let gpuMPMPreviewBufferSize: number = 0;

let latestMPMParticlesData: Float32Array | null = null;
let latestMPMFloatsPerParticle: number = 14;
let mpmParticlesBuffer: WebGLBuffer | null = null;
let mpmParticlesCount: number = 0;
let showMPMParticles: boolean = true;
let mpmParticleDiameter: number = 0; // 0 = Auto based on initial mesh spacing (dx / ∛ppc)
let ppc: number = 8;
let latestEmpiricalSpacing: number = 0;
let mpmParticleSize: number = 4.0;
let mpmParticleQuantity: string = 'vonMises';
let mpmParticleColormap: string = 'rainbow';
let mpmParticleAutoScale: boolean = true;
let mpmParticleLogScale: boolean = false;
let mpmParticleOpacity: number = 1.0;
let mpmParticleMinVal: number | undefined = undefined;
let mpmParticleMaxVal: number | undefined = undefined;

let latestFEMNodesData: Float32Array | null = null;
let latestFEMFacetsData: Float32Array | null = null;
let femSolidBuffer: WebGLBuffer | null = null;
let femSolidCount: number = 0;
let femWireframeBuffer: WebGLBuffer | null = null;
let femWireframeCount: number = 0;
let gpuFEMSolidBuffer: any = null;
let gpuFEMSolidBufferSize: number = 0;
let gpuFEMWireframeBuffer: any = null;
let gpuFEMWireframeBufferSize: number = 0;
let cachedFEMSolidVertexData: Float32Array | null = null;
let cachedFEMWireframeVertexData: Float32Array | null = null;

let showFEMMesh: boolean = true;
let femSolid: boolean = true;
let femWireframe: boolean = true;
let femResults: boolean = true;
let femQuantity: string = 'vonMises';
let femColormap: string = 'rainbow';
let femAutoScale: boolean = true;
let femLogScale: boolean = false;
let femOpacity: number = 1.0;
let femMinVal: number | undefined = undefined;
let femMaxVal: number | undefined = undefined;

let showRebar: boolean = true;
let rebarSolid: boolean = true;
let rebarWireframe: boolean = true;
let rebarRadius: number = 0.008;

let showBeams: boolean = true;
let beamSolid: boolean = true;
let beamWireframe: boolean = true;
let beamRadius: number = 0.008;
let beamQuantity: string = 'plasticStrain';
let beamColormap: string = 'rainbow';
let beamAutoScale: boolean = true;
let beamMinVal: number | undefined = undefined;
let beamMaxVal: number | undefined = undefined;
let beamLogScale: boolean = false;
let beamOpacity: number = 1.0;

function getFEMFacetQuantityValue(facetIdx: number, qty: string): number {
    if (!latestFEMFacetsData) return 0;
    const base = facetIdx * 8;
    if (qty === 'vonMises') return latestFEMFacetsData[base + 4];
    if (qty === 'plasticStrain') return latestFEMFacetsData[base + 5];
    if (qty === 'pressure') return latestFEMFacetsData[base + 6];
    if (qty === 'damage') return latestFEMFacetsData[base + 7];
    if (qty === 'velocity') {
        if (!latestFEMNodesData) return 0;
        const n0 = Math.round(latestFEMFacetsData[base + 0]);
        const n1 = Math.round(latestFEMFacetsData[base + 1]);
        const n2 = Math.round(latestFEMFacetsData[base + 2]);
        const n3 = Math.round(latestFEMFacetsData[base + 3]);
        const nTotal = Math.floor(latestFEMNodesData.length / 7);
        const v0 = (n0 >= 0 && n0 < nTotal) ? latestFEMNodesData[n0 * 7 + 6] : 0;
        const v1 = (n1 >= 0 && n1 < nTotal) ? latestFEMNodesData[n1 * 7 + 6] : 0;
        const v2 = (n2 >= 0 && n2 < nTotal) ? latestFEMNodesData[n2 * 7 + 6] : 0;
        const v3 = (n3 >= 0 && n3 < nTotal) ? latestFEMNodesData[n3 * 7 + 6] : 0;
        return (v0 + v1 + v2 + v3) * 0.25;
    }
    return latestFEMFacetsData[base + 4];
}

function getBeamQuantityValue(facetIdx: number, qty: string): number {
    if (!latestFEMFacetsData) return 0;
    const base = facetIdx * 8;
    if (qty === 'plasticStrain') return latestFEMFacetsData[base + 5];
    if (qty === 'vonMises' || qty === 'stress' || qty === 'axialStress') return latestFEMFacetsData[base + 4];
    if (qty === 'momentOrForce' || qty === 'bendingMoment' || qty === 'axialForce' || qty === 'pressure') return latestFEMFacetsData[base + 6];
    if (qty === 'damage' || qty === 'erosion') return latestFEMFacetsData[base + 7];
    if (qty === 'velocity') {
        if (!latestFEMNodesData) return 0;
        const n0 = Math.round(latestFEMFacetsData[base + 0]);
        const n1 = Math.round(latestFEMFacetsData[base + 1]);
        const nTotal = Math.floor(latestFEMNodesData.length / 7);
        const v0 = (n0 >= 0 && n0 < nTotal) ? latestFEMNodesData[n0 * 7 + 6] : 0;
        const v1 = (n1 >= 0 && n1 < nTotal) ? latestFEMNodesData[n1 * 7 + 6] : 0;
        return (v0 + v1) * 0.5;
    }
    return latestFEMFacetsData[base + 5];
}

function updateFEMMeshGeometry(buffer?: ArrayBuffer) {
    if (!gl && (!isWebGPU || !gpuDevice)) {
        self.postMessage({ type: 'frameComplete' });
        return;
    }
    if (buffer) {
        if (buffer.byteLength < 24) {
            self.postMessage({ type: 'frameComplete' });
            return;
        }
        const view = new DataView(buffer);
        const magic = view.getUint32(0, true);
        if (magic !== 0x46454d33) {
            self.postMessage({ type: 'frameComplete' });
            return;
        }
        const time = view.getFloat32(4, true);
        const nNodes = view.getUint32(8, true);
        const nFacets = view.getUint32(12, true);
        const nFloatsPerNode = view.getUint32(16, true);
        const nFloatsPerFacet = view.getUint32(20, true);

        const nodeDataBytes = nNodes * nFloatsPerNode * 4;
        const facetDataBytes = nFacets * nFloatsPerFacet * 4;
        if (24 + nodeDataBytes + facetDataBytes > buffer.byteLength) {
            self.postMessage({ type: 'frameComplete' });
            return;
        }

        latestFEMNodesData = new Float32Array(buffer, 24, nNodes * nFloatsPerNode);
        latestFEMFacetsData = new Float32Array(buffer, 24 + nodeDataBytes, nFacets * nFloatsPerFacet);
    }

    if (!latestFEMNodesData || !latestFEMFacetsData || latestFEMNodesData.length === 0 || latestFEMFacetsData.length === 0) {
        femSolidCount = 0;
        femWireframeCount = 0;
        render();
        return;
    }

    const nNodes = Math.floor(latestFEMNodesData.length / 7);
    const nFacets = Math.floor(latestFEMFacetsData.length / 8);

    // Compute actual spatial bounding box of the FEM nodes
    let femMinX = Infinity, femMaxX = -Infinity;
    let femMinY = Infinity, femMaxY = -Infinity;
    let femMinZ = Infinity, femMaxZ = -Infinity;

    for (let i = 0; i < nNodes; i++) {
        const x = latestFEMNodesData[i * 7 + 0];
        const y = latestFEMNodesData[i * 7 + 1];
        const z = latestFEMNodesData[i * 7 + 2];
        if (isFinite(x) && isFinite(y) && isFinite(z)) {
            if (x < femMinX) femMinX = x;
            if (x > femMaxX) femMaxX = x;
            if (y < femMinY) femMinY = y;
            if (y > femMaxY) femMaxY = y;
            if (z < femMinZ) femMinZ = z;
            if (z > femMaxZ) femMaxZ = z;
        }
    }
    if (isFinite(femMinX) && isFinite(femMaxX)) {
        cachedFemAABB = { minX: femMinX, maxX: femMaxX, minY: femMinY, maxY: femMaxY, minZ: femMinZ, maxZ: femMaxZ };
    } else {
        cachedFemAABB = null;
    }

    // If FEM-only model (no active CFD solver present), initialize spatial bounds ONCE on initial frame load.
    // Do NOT auto-reset camera or bounds on every frame render while the simulation is running!
    if (!hasCFDSolver && !femBoundsInitialized && isFinite(femMinX) && isFinite(femMaxX) && femMaxX > femMinX) {
        xmin = femMinX;
        xmax = femMaxX;
        ymin = femMinY;
        ymax = femMaxY;
        zmin = femMinZ;
        zmax = femMaxZ;
        femBoundsInitialized = true;
        const w = canvasWidth();
        const h = canvasHeight();
        updateMatrices(w, h);
    }

    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
    const sx = 1.0 / sizeX;
    const sy = 1.0 / sizeY;
    const sz = 1.0 / sizeZ;
    const tx = -xmin * sx - 0.5;
    const ty = -ymin * sy - 0.5;
    const tz = -zmin * sz - 0.5;

    let empiricalMin = Infinity;
    let empiricalMax = -Infinity;
    let beamEmpiricalMin = Infinity;
    let beamEmpiricalMax = -Infinity;

    for (let f = 0; f < nFacets; f++) {
        const n2 = Math.round(latestFEMFacetsData[f * 8 + 2]);
        const n3 = Math.round(latestFEMFacetsData[f * 8 + 3]);
        const isLine = (n2 < 0 || n3 < 0);
        if (isLine) {
            const isEroded = (latestFEMFacetsData[f * 8 + 7] > 0.5);
            if (isEroded) continue;

            const val = getBeamQuantityValue(f, beamQuantity);
            if (isFinite(val)) {
                if (val < beamEmpiricalMin) beamEmpiricalMin = val;
                if (val > beamEmpiricalMax) beamEmpiricalMax = val;
            }
        } else {
            const val = getFEMFacetQuantityValue(f, femQuantity);
            if (isFinite(val)) {
                if (val < empiricalMin) empiricalMin = val;
                if (val > empiricalMax) empiricalMax = val;
            }
        }
    }
    if (!isFinite(empiricalMin) || !isFinite(empiricalMax) || empiricalMax <= empiricalMin) {
        empiricalMin = 0.0;
        empiricalMax = 1.0;
    }
    if (!isFinite(beamEmpiricalMin) || !isFinite(beamEmpiricalMax) || beamEmpiricalMax <= beamEmpiricalMin) {
        beamEmpiricalMin = 0.0;
        beamEmpiricalMax = (beamQuantity === 'plasticStrain') ? 0.05 : 1.0;
    }

    self.postMessage({ type: 'femRangeUpdated', min: empiricalMin, max: empiricalMax });
    self.postMessage({ type: 'beamRangeUpdated', min: beamEmpiricalMin, max: beamEmpiricalMax });

    const cFemQ = canonicalizeQuantity(femQuantity);
    const defaultFemRange = quantityRanges[cFemQ] || quantityRanges[femQuantity] || DEFAULT_QUANTITY_RANGES[cFemQ] || DEFAULT_QUANTITY_RANGES[femQuantity] || [0.0, (cFemQ === 'plastic_strain' ? 1.0 : 500000000.0)];
    const isFemAuto = lockQuantityRanges ? ((quantityAutoScales[cFemQ] ?? quantityAutoScales[femQuantity]) !== false) : (femAutoScale !== false);
    let minScalar = femMinVal ?? defaultFemRange[0];
    let maxScalar = femMaxVal ?? defaultFemRange[1];
    if (lockQuantityRanges) {
        minScalar = defaultFemRange[0];
        maxScalar = defaultFemRange[1];
    } else if (isFemAuto) {
        minScalar = empiricalMin;
        maxScalar = empiricalMax;
    }
    const useFemLog = lockQuantityRanges ? (quantityLogScales[cFemQ] ?? quantityLogScales[femQuantity] ?? femLogScale) : femLogScale;
    const effectiveFemCmap = lockQuantityRanges ? (quantityColormaps[cFemQ] || quantityColormaps[femQuantity] || femColormap) : femColormap;

    const cBeamQ = canonicalizeQuantity(beamQuantity);
    const defaultBeamRange = quantityRanges[cBeamQ] || quantityRanges[beamQuantity] || DEFAULT_QUANTITY_RANGES[cBeamQ] || DEFAULT_QUANTITY_RANGES[beamQuantity] || [0.0, (cBeamQ === 'plastic_strain' ? 0.05 : 1000.0)];
    const isBeamAuto = lockQuantityRanges ? ((quantityAutoScales[cBeamQ] ?? quantityAutoScales[beamQuantity]) !== false) : (beamAutoScale !== false);
    let minBeamScalar = beamMinVal ?? defaultBeamRange[0];
    let maxBeamScalar = beamMaxVal ?? defaultBeamRange[1];
    if (lockQuantityRanges) {
        minBeamScalar = defaultBeamRange[0];
        maxBeamScalar = defaultBeamRange[1];
    } else if (isBeamAuto) {
        minBeamScalar = beamEmpiricalMin;
        maxBeamScalar = beamEmpiricalMax;
    }
    const useBeamLog = lockQuantityRanges ? (quantityLogScales[cBeamQ] ?? quantityLogScales[beamQuantity] ?? beamLogScale) : beamLogScale;
    const effectiveBeamCmap = lockQuantityRanges ? (quantityColormaps[cBeamQ] || quantityColormaps[beamQuantity] || beamColormap) : beamColormap;

    const neededSolidFloats = nFacets * 12 * 6;
    const neededWireFloats = nFacets * 8 * 5;

    if (!cachedFEMSolidVertexData || cachedFEMSolidVertexData.length < neededSolidFloats) {
        cachedFEMSolidVertexData = new Float32Array(Math.max(neededSolidFloats, Math.floor(neededSolidFloats * 1.25)));
    }
    if (!cachedFEMWireframeVertexData || cachedFEMWireframeVertexData.length < neededWireFloats) {
        cachedFEMWireframeVertexData = new Float32Array(Math.max(neededWireFloats, Math.floor(neededWireFloats * 1.25)));
    }

    const solidVertexData = cachedFEMSolidVertexData;
    const wireframeVertexData = cachedFEMWireframeVertexData;

    let solidIdx = 0;
    let wireIdx = 0;

    for (let f = 0; f < nFacets; f++) {
        const n0 = Math.round(latestFEMFacetsData[f * 8 + 0]);
        const n1 = Math.round(latestFEMFacetsData[f * 8 + 1]);
        const n2 = Math.round(latestFEMFacetsData[f * 8 + 2]);
        const n3 = Math.round(latestFEMFacetsData[f * 8 + 3]);

        if (n0 < 0 || n0 >= nNodes || n1 < 0 || n1 >= nNodes) {
            continue;
        }

        const isLine = (n2 < 0 || n3 < 0);

        if (!isLine && (n2 >= nNodes || n3 >= nNodes)) {
            continue;
        }

        if (isLine) {
            const isEroded = (latestFEMFacetsData[f * 8 + 7] > 0.5);
            if (isEroded) continue;
        }

        const p0 = [latestFEMNodesData[n0 * 7 + 0] * sx + tx, latestFEMNodesData[n0 * 7 + 1] * sy + ty, latestFEMNodesData[n0 * 7 + 2] * sz + tz];
        const p1 = [latestFEMNodesData[n1 * 7 + 0] * sx + tx, latestFEMNodesData[n1 * 7 + 1] * sy + ty, latestFEMNodesData[n1 * 7 + 2] * sz + tz];

        if (isLine) {
            const isVisible = (showBeams !== false && showRebar !== false);
            if (!isVisible) continue;

            const isSolid = (beamSolid !== false && rebarSolid !== false);
            const isWire = (beamWireframe !== false && rebarWireframe !== false);

            const val = getBeamQuantityValue(f, beamQuantity);
            let normVal = 0.0;
            if (useBeamLog) {
                const logMin = Math.log(Math.max(minBeamScalar, 1e-5));
                const logMax = Math.log(Math.max(maxBeamScalar, 1e-5));
                const logVal = Math.log(Math.max(val, 1e-5));
                normVal = (logVal - logMin) / (Math.max(1e-9, logMax - logMin));
            } else {
                normVal = (val - minBeamScalar) / (Math.max(1e-9, maxBeamScalar - minBeamScalar));
            }
            normVal = Math.max(0.0, Math.min(1.0, normVal));
            const [r, g, b] = sampleColormapRGB(normVal, effectiveBeamCmap);

            if (isWire) {
                // Wireframe: 2-vertex line
                wireframeVertexData[wireIdx++] = p0[0];
                wireframeVertexData[wireIdx++] = p0[1];
                wireframeVertexData[wireIdx++] = p0[2];
                wireframeVertexData[wireIdx++] = 0;
                wireframeVertexData[wireIdx++] = 0;

                wireframeVertexData[wireIdx++] = p1[0];
                wireframeVertexData[wireIdx++] = p1[1];
                wireframeVertexData[wireIdx++] = p1[2];
                wireframeVertexData[wireIdx++] = 0;
                wireframeVertexData[wireIdx++] = 0;
            }

            if (isSolid) {
                // Solid: 3D cross ribbons
                const dx = p1[0] - p0[0];
                const dy = p1[1] - p0[1];
                const dz = p1[2] - p0[2];
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const userRadius = (beamRadius !== undefined && beamRadius > 0) ? beamRadius : ((rebarRadius !== undefined && rebarRadius > 0) ? rebarRadius : 0.008);
                const radius = Math.max(0.002, userRadius * sx);
                if (len > 1e-6) {
                    let nx_dir = 0, ny_dir = 0, nz_dir = 1;
                    if (Math.abs(dz / len) > 0.9) {
                        nx_dir = 1; ny_dir = 0; nz_dir = 0;
                    }
                    let ux = dy * nz_dir - dz * ny_dir;
                    let uy = dz * nx_dir - dx * nz_dir;
                    let uz = dx * ny_dir - dy * nx_dir;
                    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1.0;
                    ux = (ux / uLen) * radius;
                    uy = (uy / uLen) * radius;
                    uz = (uz / uLen) * radius;

                    let vx = (dy * uz - dz * uy) / (radius || 1.0);
                    let vy = (dz * ux - dx * uz) / (radius || 1.0);
                    let vz = (dx * uy - dy * ux) / (radius || 1.0);
                    const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1.0;
                    vx = (vx / vLen) * radius;
                    vy = (vy / vLen) * radius;
                    vz = (vz / vLen) * radius;

                    const a0 = [p0[0] - ux, p0[1] - uy, p0[2] - uz];
                    const a1 = [p0[0] + ux, p0[1] + uy, p0[2] + uz];
                    const a2 = [p1[0] + ux, p1[1] + uy, p1[2] + uz];
                    const a3 = [p1[0] - ux, p1[1] - uy, p1[2] - uz];

                    const ribbon1Verts = [a0, a1, a2, a0, a2, a3];
                    for (let tv = 0; tv < 6; tv++) {
                        const pt = ribbon1Verts[tv];
                        solidVertexData[solidIdx++] = pt[0];
                        solidVertexData[solidIdx++] = pt[1];
                        solidVertexData[solidIdx++] = pt[2];
                        solidVertexData[solidIdx++] = r;
                        solidVertexData[solidIdx++] = g;
                        solidVertexData[solidIdx++] = b;
                    }

                    const b0 = [p0[0] - vx, p0[1] - vy, p0[2] - vz];
                    const b1 = [p0[0] + vx, p0[1] + vy, p0[2] + vz];
                    const b2 = [p1[0] + vx, p1[1] + vy, p1[2] + vz];
                    const b3 = [p1[0] - vx, p1[1] - vy, p1[2] - vz];

                    const ribbon2Verts = [b0, b1, b2, b0, b2, b3];
                    for (let tv = 0; tv < 6; tv++) {
                        const pt = ribbon2Verts[tv];
                        solidVertexData[solidIdx++] = pt[0];
                        solidVertexData[solidIdx++] = pt[1];
                        solidVertexData[solidIdx++] = pt[2];
                        solidVertexData[solidIdx++] = r;
                        solidVertexData[solidIdx++] = g;
                        solidVertexData[solidIdx++] = b;
                    }
                }
            }
            continue;
        }

        if (!showFEMMesh) continue;

        const val = getFEMFacetQuantityValue(f, femQuantity);
        let normVal = 0.0;
        if (useFemLog) {
            const logMin = Math.log(Math.max(minScalar, 1e-5));
            const logMax = Math.log(Math.max(maxScalar, 1e-5));
            const logVal = Math.log(Math.max(val, 1e-5));
            normVal = (logVal - logMin) / (Math.max(1e-9, logMax - logMin));
        } else {
            normVal = (val - minScalar) / (Math.max(1e-9, maxScalar - minScalar));
        }
        normVal = Math.max(0.0, Math.min(1.0, normVal));
        const [r, g, b] = sampleColormapRGB(normVal, effectiveFemCmap);

        const p2 = [latestFEMNodesData[n2 * 7 + 0] * sx + tx, latestFEMNodesData[n2 * 7 + 1] * sy + ty, latestFEMNodesData[n2 * 7 + 2] * sz + tz];
        const p3 = [latestFEMNodesData[n3 * 7 + 0] * sx + tx, latestFEMNodesData[n3 * 7 + 1] * sy + ty, latestFEMNodesData[n3 * 7 + 2] * sz + tz];

        if (femSolid) {
            const triVerts = [p0, p1, p2, p0, p2, p3];
            for (let tv = 0; tv < 6; tv++) {
                const pt = triVerts[tv];
                solidVertexData[solidIdx++] = pt[0];
                solidVertexData[solidIdx++] = pt[1];
                solidVertexData[solidIdx++] = pt[2];
                solidVertexData[solidIdx++] = r;
                solidVertexData[solidIdx++] = g;
                solidVertexData[solidIdx++] = b;
            }
        }

        if (femWireframe) {
            const edgeVerts = [p0, p1, p1, p2, p2, p3, p3, p0];
            for (let ev = 0; ev < 8; ev++) {
                const pt = edgeVerts[ev];
                wireframeVertexData[wireIdx++] = pt[0];
                wireframeVertexData[wireIdx++] = pt[1];
                wireframeVertexData[wireIdx++] = pt[2];
                wireframeVertexData[wireIdx++] = 0;
                wireframeVertexData[wireIdx++] = 0;
            }
        }
    }

    femSolidCount = solidIdx / 6;
    femWireframeCount = wireIdx / 5;

    if (gl) {
        if (!femSolidBuffer) femSolidBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, femSolidBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, solidVertexData.subarray(0, solidIdx), gl.DYNAMIC_DRAW);

        if (!femWireframeBuffer) femWireframeBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, femWireframeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, wireframeVertexData.subarray(0, wireIdx), gl.DYNAMIC_DRAW);
    }
    if (isWebGPU && gpuDevice) {
        const solidBytes = solidIdx * 4;
        if (!gpuFEMSolidBuffer || gpuFEMSolidBufferSize < solidBytes) {
            if (gpuFEMSolidBuffer) gpuFEMSolidBuffer.destroy();
            gpuFEMSolidBufferSize = Math.max(solidBytes, Math.floor(solidBytes * 1.25));
            gpuFEMSolidBuffer = gpuDevice.createBuffer({
                size: gpuFEMSolidBufferSize,
                usage: 32 | 8 // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        if (solidBytes > 0) {
            gpuDevice.queue.writeBuffer(gpuFEMSolidBuffer, 0, solidVertexData.buffer, solidVertexData.byteOffset, solidBytes);
        }

        const wireBytes = wireIdx * 4;
        if (!gpuFEMWireframeBuffer || gpuFEMWireframeBufferSize < wireBytes) {
            if (gpuFEMWireframeBuffer) gpuFEMWireframeBuffer.destroy();
            gpuFEMWireframeBufferSize = Math.max(wireBytes, Math.floor(wireBytes * 1.25));
            gpuFEMWireframeBuffer = gpuDevice.createBuffer({
                size: gpuFEMWireframeBufferSize,
                usage: 32 | 8 // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        if (wireBytes > 0) {
            gpuDevice.queue.writeBuffer(gpuFEMWireframeBuffer, 0, wireframeVertexData.buffer, wireframeVertexData.byteOffset, wireBytes);
        }
    }

    // Dynamically update selection/hover highlights as FEM mesh deforms
    if (selectedObject && (selectedObject.objectType === 'FEMObject3D' || selectedObject.objectType === 'FEMMesh3D' || selectedObject.objectType === 'FEMBeam3D' || selectedObject.objectType === 'FEMRebar3D' || selectedObject.objectType === 'LSDynaImporter3D')) {
        cachedSelectedKey = null;
    }
    if (hoveredObject && (hoveredObject.objectType === 'FEMObject3D' || hoveredObject.objectType === 'FEMMesh3D' || hoveredObject.objectType === 'FEMBeam3D' || hoveredObject.objectType === 'FEMRebar3D' || hoveredObject.objectType === 'LSDynaImporter3D')) {
        cachedHoverKey = null;
    }

    render();
}

function sampleColormapRGB(v: number, cmapName: string): [number, number, number] {
    const val = Math.max(0.0, Math.min(1.0, v));
    switch (cmapName) {
        case 'plasma': {
            const r = Math.min(1.0, Math.pow(val, 0.5));
            const g = Math.pow(val, 2.0) * 0.85;
            const b = Math.cos(val * Math.PI * 0.5);
            return [r, Math.max(0, g), Math.max(0, b)];
        }
        case 'viridis': {
            const r = 0.2 + 0.8 * Math.pow(val, 2);
            const g = Math.sin(val * Math.PI * 0.8);
            const b = 0.5 + 0.5 * Math.cos(val * Math.PI);
            return [Math.max(0, Math.min(1.0, r)), Math.max(0, Math.min(1.0, g)), Math.max(0, Math.min(1.0, b))];
        }
        case 'coolwarm': {
            const r = val;
            const g = 1.0 - Math.abs(val - 0.5) * 2.0;
            const b = 1.0 - val;
            return [r, Math.max(0, g), Math.max(0, b)];
        }
        case 'rainbow':
        case 'jet': {
            const four = 4.0 * val;
            const r = Math.min(1.0, Math.max(0.0, Math.min(four - 1.5, -four + 4.5)));
            const g = Math.min(1.0, Math.max(0.0, Math.min(four - 0.5, -four + 3.5)));
            const b = Math.min(1.0, Math.max(0.0, Math.min(four + 0.5, -four + 2.5)));
            return [r, g, b];
        }
        case 'grayscale': {
            return [val, val, val];
        }
        default: {
            const r = Math.min(1.0, Math.pow(val, 0.5));
            const g = Math.pow(val, 2.0) * 0.85;
            const b = Math.cos(val * Math.PI * 0.5);
            return [r, Math.max(0, g), Math.max(0, b)];
        }
    }
}

function sampleColormapDirect(v: number, cmapName: string, out: Float32Array, offset: number): void {
    let val = Math.max(0.0, Math.min(1.0, v));
    if (!isFinite(val)) val = 0.0;
    switch (cmapName) {
        case 'plasma': {
            out[offset] = Math.min(1.0, Math.pow(val, 0.5));
            out[offset + 1] = Math.max(0, Math.pow(val, 2.0) * 0.85);
            out[offset + 2] = Math.max(0, Math.cos(val * Math.PI * 0.5));
            break;
        }
        case 'viridis': {
            out[offset] = Math.max(0, Math.min(1.0, 0.2 + 0.8 * Math.pow(val, 2)));
            out[offset + 1] = Math.max(0, Math.min(1.0, Math.sin(val * Math.PI * 0.8)));
            out[offset + 2] = Math.max(0, Math.min(1.0, 0.5 + 0.5 * Math.cos(val * Math.PI)));
            break;
        }
        case 'coolwarm': {
            out[offset] = val;
            out[offset + 1] = Math.max(0, 1.0 - Math.abs(val - 0.5) * 2.0);
            out[offset + 2] = Math.max(0, 1.0 - val);
            break;
        }
        case 'rainbow':
        case 'jet': {
            const four = 4.0 * val;
            out[offset] = Math.min(1.0, Math.max(0.0, Math.min(four - 1.5, -four + 4.5)));
            out[offset + 1] = Math.min(1.0, Math.max(0.0, Math.min(four - 0.5, -four + 3.5)));
            out[offset + 2] = Math.min(1.0, Math.max(0.0, Math.min(four + 0.5, -four + 2.5)));
            break;
        }
        case 'grayscale': {
            out[offset] = val;
            out[offset + 1] = val;
            out[offset + 2] = val;
            break;
        }
        default: {
            out[offset] = Math.min(1.0, Math.pow(val, 0.5));
            out[offset + 1] = Math.max(0, Math.pow(val, 2.0) * 0.85);
            out[offset + 2] = Math.max(0, Math.cos(val * Math.PI * 0.5));
            break;
        }
    }
}

function getParticleQuantityValue(data: Float32Array, idx: number, qty: string): number {
    const stride = (data.length % 14 === 0) ? 14 : ((data.length % 13 === 0) ? 13 : (latestMPMFloatsPerParticle || 14));
    const base = idx * stride;
    if (qty === 'vonMises' || qty === 'von_mises') return data[base + 6];
    if (qty === 'plastic_strain' || qty === 'plasticStrain') return data[base + 7];
    if (qty === 'density') return data[base + 8];
    if (qty === 'pressure') return data[base + 9];
    if (qty === 'damage') return data[base + 10];
    if (qty === 'has_failed') return data[base + 11];
    if (qty === 'object_id') return data[base + 12];
    if (qty === 'cluster_id' || qty === 'cluster' || qty === 'fragment' || qty === 'fragments') {
        return (stride >= 14) ? data[base + 13] : data[base + 12];
    }
    if (qty === 'velocity') {
        const vx = data[base + 3], vy = data[base + 4], vz = data[base + 5];
        return Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    return data[base + 6];
}

function updateMPMParticlesGeometry(data?: Float32Array) {
    if (!gl && (!isWebGPU || !gpuDevice)) {
        self.postMessage({ type: 'frameComplete' });
        return;
    }
    if (data) {
        latestMPMParticlesData = data;
    }
    if (!latestMPMParticlesData || latestMPMParticlesData.length === 0) {
        mpmParticlesCount = 0;
        render();
        return;
    }

    const stride = (latestMPMParticlesData.length % 14 === 0) ? 14 : ((latestMPMParticlesData.length % 13 === 0) ? 13 : (latestMPMFloatsPerParticle || 14));
    const nParticles = Math.floor(latestMPMParticlesData.length / stride);
    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
    const sx = 1.0 / sizeX;
    const sy = 1.0 / sizeY;
    const sz = 1.0 / sizeZ;
    const tx = -xmin * sx - 0.5;
    const ty = -ymin * sy - 0.5;
    const tz = -zmin * sz - 0.5;

    let qtyOffset = 6;
    let isVelocity = false;
    let isFragment = false;
    if (mpmParticleQuantity === 'plastic_strain' || mpmParticleQuantity === 'plasticStrain') qtyOffset = 7;
    else if (mpmParticleQuantity === 'density') qtyOffset = 8;
    else if (mpmParticleQuantity === 'pressure') qtyOffset = 9;
    else if (mpmParticleQuantity === 'damage') qtyOffset = 10;
    else if (mpmParticleQuantity === 'has_failed') qtyOffset = 11;
    else if (mpmParticleQuantity === 'object_id') qtyOffset = 12;
    else if (mpmParticleQuantity === 'cluster_id' || mpmParticleQuantity === 'cluster' || mpmParticleQuantity === 'fragment' || mpmParticleQuantity === 'fragments') {
        qtyOffset = (stride >= 14) ? 13 : 12;
        isFragment = true;
    }
    else if (mpmParticleQuantity === 'velocity') isVelocity = true;

    let minScalar = mpmParticleMinVal;
    let maxScalar = mpmParticleMaxVal;

    let empiricalMin = Infinity;
    let empiricalMax = -Infinity;

    for (let i = 0; i < nParticles; i++) {
        const base = i * stride;
        let val = 0.0;
        if (isVelocity) {
            const vx = latestMPMParticlesData[base + 3], vy = latestMPMParticlesData[base + 4], vz = latestMPMParticlesData[base + 5];
            val = Math.sqrt(vx * vx + vy * vy + vz * vz);
        } else {
            val = latestMPMParticlesData[base + qtyOffset];
        }
        if (val < empiricalMin) empiricalMin = val;
        if (val > empiricalMax) empiricalMax = val;
    }

    if (!isFinite(empiricalMin) || !isFinite(empiricalMax) || empiricalMax <= empiricalMin) {
        empiricalMin = 0.0;
        empiricalMax = 1.0;
    }

    self.postMessage({ type: 'mpmRangeUpdated', min: empiricalMin, max: empiricalMax });

    // Compute exact nearest neighbor particle spacing from particle coordinates (only once on initial data)
    if (latestEmpiricalSpacing <= 0) {
        const nSample = Math.min(250, nParticles);
        let minD2 = Infinity;
        for (let i = 0; i < nSample; i++) {
            const x1 = latestMPMParticlesData[i * stride + 0];
            const y1 = latestMPMParticlesData[i * stride + 1];
            const z1 = latestMPMParticlesData[i * stride + 2];
            for (let j = i + 1; j < nSample; j++) {
                const dx_p = x1 - latestMPMParticlesData[j * stride + 0];
                const dy_p = y1 - latestMPMParticlesData[j * stride + 1];
                const dz_p = z1 - latestMPMParticlesData[j * stride + 2];
                const d2 = dx_p * dx_p + dy_p * dy_p + dz_p * dz_p;
                if (d2 > 1e-14 && d2 < minD2) {
                    minD2 = d2;
                }
            }
        }
        if (isFinite(minD2) && minD2 > 0) {
            latestEmpiricalSpacing = Math.sqrt(minD2);
            self.postMessage({ type: 'mpmParticleSpacingUpdated', spacing: latestEmpiricalSpacing });
        }
    }

    const cMpmQ = canonicalizeQuantity(mpmParticleQuantity);
    const defaultMpmRange = quantityRanges[cMpmQ] || quantityRanges[mpmParticleQuantity] || DEFAULT_QUANTITY_RANGES[cMpmQ] || DEFAULT_QUANTITY_RANGES[mpmParticleQuantity] || [0.0, 500000000.0];
    const isMpmAuto = lockQuantityRanges ? ((quantityAutoScales[cMpmQ] ?? quantityAutoScales[mpmParticleQuantity]) !== false) : (mpmParticleAutoScale !== false);
    if (lockQuantityRanges) {
        minScalar = defaultMpmRange[0];
        maxScalar = defaultMpmRange[1];
    } else if (isMpmAuto || minScalar === undefined || maxScalar === undefined) {
        minScalar = empiricalMin;
        maxScalar = empiricalMax;
    }

    const neededFloats = nParticles * 7;
    if (!cachedMPMVertexData || cachedMPMVertexData.length < neededFloats) {
        cachedMPMVertexData = new Float32Array(Math.max(neededFloats, Math.floor(neededFloats * 1.25)));
    }
    const vertexData = cachedMPMVertexData;

    const useLog = lockQuantityRanges ? (quantityLogScales[cMpmQ] ?? quantityLogScales[mpmParticleQuantity] ?? mpmParticleLogScale) : mpmParticleLogScale;
    const logMin = useLog ? Math.log(Math.max(minScalar, 1e-5)) : 0;
    const logMax = useLog ? Math.log(Math.max(maxScalar, 1e-5)) : 0;
    const denom = useLog ? Math.max(1e-9, logMax - logMin) : Math.max(1e-9, maxScalar - minScalar);
    const cmap = lockQuantityRanges ? (quantityColormaps[cMpmQ] || quantityColormaps[mpmParticleQuantity] || mpmParticleColormap) : mpmParticleColormap;

    let mpmMinX = Infinity, mpmMaxX = -Infinity;
    let mpmMinY = Infinity, mpmMaxY = -Infinity;
    let mpmMinZ = Infinity, mpmMaxZ = -Infinity;

    for (let i = 0; i < nParticles; i++) {
        const base = i * stride;
        const px = latestMPMParticlesData[base + 0];
        const py = latestMPMParticlesData[base + 1];
        const pz = latestMPMParticlesData[base + 2];

        if (px < mpmMinX) mpmMinX = px; if (px > mpmMaxX) mpmMaxX = px;
        if (py < mpmMinY) mpmMinY = py; if (py > mpmMaxY) mpmMaxY = py;
        if (pz < mpmMinZ) mpmMinZ = pz; if (pz > mpmMaxZ) mpmMaxZ = pz;

        const vIdx = i * 7;
        vertexData[vIdx + 0] = px * sx + tx;
        vertexData[vIdx + 1] = py * sy + ty;
        vertexData[vIdx + 2] = pz * sz + tz;

        let val = 0.0;
        if (isVelocity) {
            const vx = latestMPMParticlesData[base + 3], vy = latestMPMParticlesData[base + 4], vz = latestMPMParticlesData[base + 5];
            val = Math.sqrt(vx * vx + vy * vy + vz * vz);
        } else {
            val = latestMPMParticlesData[base + qtyOffset];
        }

        if (isFragment) {
            const cid = Math.round(val);
            if (cid <= 0) {
                vertexData[vIdx + 3] = 0.45;
                vertexData[vIdx + 4] = 0.45;
                vertexData[vIdx + 5] = 0.45;
            } else {
                const hue = ((cid * 0.618033988749895) % 1.0) * 360;
                const s = 0.85;
                const l = 0.55;
                const c_val = (1 - Math.abs(2 * l - 1)) * s;
                const x_val = c_val * (1 - Math.abs((hue / 60) % 2 - 1));
                const m_val = l - c_val / 2;
                let r1 = 0, g1 = 0, b1 = 0;
                if (hue < 60) { r1 = c_val; g1 = x_val; b1 = 0; }
                else if (hue < 120) { r1 = x_val; g1 = c_val; b1 = 0; }
                else if (hue < 180) { r1 = 0; g1 = c_val; b1 = x_val; }
                else if (hue < 240) { r1 = 0; g1 = x_val; b1 = c_val; }
                else if (hue < 300) { r1 = x_val; g1 = 0; b1 = c_val; }
                else { r1 = c_val; g1 = 0; b1 = x_val; }
                vertexData[vIdx + 3] = r1 + m_val;
                vertexData[vIdx + 4] = g1 + m_val;
                vertexData[vIdx + 5] = b1 + m_val;
            }
        } else {
            let normVal = 0.0;
            if (useLog) {
                const logVal = Math.log(Math.max(val, 1e-5));
                normVal = (logVal - logMin) / denom;
            } else {
                normVal = (val - minScalar) / denom;
            }

            sampleColormapDirect(normVal, cmap, vertexData, vIdx + 3);
        }
        vertexData[vIdx + 6] = 0.0;
    }

    if (isFinite(mpmMinX) && isFinite(mpmMaxX)) {
        cachedMpmAABB = { minX: mpmMinX, maxX: mpmMaxX, minY: mpmMinY, maxY: mpmMaxY, minZ: mpmMinZ, maxZ: mpmMaxZ };
    } else {
        cachedMpmAABB = null;
    }

    const particleBytes = nParticles * 7 * 4;
    if (gl) {
        if (!mpmParticlesBuffer) mpmParticlesBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData.subarray(0, nParticles * 7), gl.DYNAMIC_DRAW);
    }
    if (isWebGPU && gpuDevice) {
        if (!gpuMPMParticlesBuffer || gpuMPMParticlesBufferSize < particleBytes) {
            if (gpuMPMParticlesBuffer) gpuMPMParticlesBuffer.destroy();
            gpuMPMParticlesBufferSize = Math.max(particleBytes, Math.floor(particleBytes * 1.25));
            gpuMPMParticlesBuffer = gpuDevice.createBuffer({
                size: gpuMPMParticlesBufferSize,
                usage: 32 | 8 // VERTEX | COPY_DST
            });
        }
        if (particleBytes > 0) {
            gpuDevice.queue.writeBuffer(gpuMPMParticlesBuffer, 0, vertexData.buffer, vertexData.byteOffset, particleBytes);
        }
    }
    mpmParticlesCount = nParticles;

    // Dynamically update selection/hover highlights as particles move/deform
    if (selectedObject && (selectedObject.objectType === 'MPMObject3D' || selectedObject.objectType === 'MPMObject2D')) {
        cachedSelectedKey = null;
    }
    if (hoveredObject && (hoveredObject.objectType === 'MPMObject3D' || hoveredObject.objectType === 'MPMObject2D')) {
        cachedHoverKey = null;
    }

    render();
}

function getRotatedBoxVertices(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, ax: number, ay: number, az: number, dimX: number, dimY: number, dimZ: number): number[] {
    const verts: number[] = [];
    const addTri = (p1: number[], p2: number[], p3: number[]) => {
        verts.push(...p1, 0, 0, 0, 0);
        verts.push(...p2, 0, 0, 0, 0);
        verts.push(...p3, 0, 0, 0, 0);
    };

    const transformPoint = (u: number, v: number, w: number): number[] => {
        const [ru, rv, rw] = rotatePointEuler(u, v, w, ax, ay, az);
        return [
            cx + ru / dimX,
            cy + rv / dimY,
            cz + rw / dimZ
        ];
    };

    const hx = lx * 0.5, hy = ly * 0.5, hz = lz * 0.5;
    const c = [
        transformPoint(-hx, -hy, -hz), transformPoint(+hx, -hy, -hz),
        transformPoint(+hx, +hy, -hz), transformPoint(-hx, +hy, -hz),
        transformPoint(-hx, -hy, +hz), transformPoint(+hx, -hy, +hz),
        transformPoint(+hx, +hy, +hz), transformPoint(-hx, +hy, +hz)
    ];

    addTri(c[0], c[2], c[1]); addTri(c[0], c[3], c[2]);
    addTri(c[4], c[5], c[6]); addTri(c[4], c[6], c[7]);
    addTri(c[0], c[1], c[5]); addTri(c[0], c[5], c[4]);
    addTri(c[3], c[6], c[2]); addTri(c[3], c[7], c[6]);
    addTri(c[0], c[4], c[7]); addTri(c[0], c[7], c[3]);
    addTri(c[1], c[2], c[6]); addTri(c[1], c[6], c[5]);

    return verts;
}

function getRotatedBoxWireframeVertices(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, ax: number, ay: number, az: number, dimX: number, dimY: number, dimZ: number): number[] {
    const verts: number[] = [];
    const addLine = (p1: number[], p2: number[]) => {
        verts.push(...p1, 0, 0);
        verts.push(...p2, 0, 0);
    };

    const transformPoint = (u: number, v: number, w: number): number[] => {
        const [ru, rv, rw] = rotatePointEuler(u, v, w, ax, ay, az);
        return [
            cx + ru / dimX,
            cy + rv / dimY,
            cz + rw / dimZ
        ];
    };

    const hx = lx * 0.5, hy = ly * 0.5, hz = lz * 0.5;
    const c = [
        transformPoint(-hx, -hy, -hz), transformPoint(+hx, -hy, -hz),
        transformPoint(+hx, +hy, -hz), transformPoint(-hx, +hy, -hz),
        transformPoint(-hx, -hy, +hz), transformPoint(+hx, -hy, +hz),
        transformPoint(+hx, +hy, +hz), transformPoint(-hx, +hy, +hz)
    ];

    addLine(c[0], c[1]); addLine(c[1], c[2]); addLine(c[2], c[3]); addLine(c[3], c[0]);
    addLine(c[4], c[5]); addLine(c[5], c[6]); addLine(c[6], c[7]); addLine(c[7], c[4]);
    addLine(c[0], c[4]); addLine(c[1], c[5]); addLine(c[2], c[6]); addLine(c[3], c[7]);

    return verts;
}

function updateChargeGeometry() {
    if (!chargeData) {
        chargeCount = 0;
        chargeWireCount = 0;
        return;
    }

    const dimX = getDimX();
    const dimY = getDimY();
    const dimZ = getDimZ();

    const cx = Number(chargeData.x ?? (xmin + dimX * 0.5));
    const cy = Number(chargeData.y ?? (ymin + dimY * 0.5));
    const cz = Number(chargeData.z ?? (zmin + dimZ * 0.5));

    const px = normX(cx);
    const py = normY(cy);
    const pz = normZ(cz);

    const deg2rad = Math.PI / 180.0;
    const ax = Number(chargeData.rot_x ?? 0.0) * deg2rad;
    const ay = Number(chargeData.rot_y ?? 0.0) * deg2rad;
    const az = Number(chargeData.rot_z ?? 0.0) * deg2rad;

    const shape = chargeData.shape || 'Sphere';
    let solidVerts: number[] = [];
    let wireVerts: number[] = [];

    if (shape === 'Block') {
        const lx = Number(chargeData.lx ?? 0.2);
        const ly = Number(chargeData.ly ?? 0.2);
        const lz = Number(chargeData.lz ?? 0.2);
        solidVerts = getRotatedBoxVertices(px, py, pz, lx, ly, lz, ax, ay, az, dimX, dimY, dimZ);
        wireVerts = getRotatedBoxWireframeVertices(px, py, pz, lx, ly, lz, ax, ay, az, dimX, dimY, dimZ);
    } else if (shape === 'Cylinder') {
        const r = Number(chargeData.radius ?? 0.1);
        const h = Number(chargeData.height ?? 0.2);
        solidVerts = getCylinderVertices(px, py, pz, r, h, ax, ay, az, dimX, dimY, dimZ);
        wireVerts = getCylinderWireframeVertices(px, py, pz, r, h, ax, ay, az, dimX, dimY, dimZ);
    } else {
        const r = Number(chargeData.radius ?? 0.1);
        const rx = r / dimX;
        const ry = r / dimY;
        const rz = r / dimZ;
        solidVerts = getSphereVertices(px, py, pz, rx, ry, rz);
        wireVerts = getSphereWireframeVertices(px, py, pz, rx, ry, rz);
    }

    if (gl) {
        if (!chargeBuffer) chargeBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, chargeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(solidVerts), gl.STATIC_DRAW);
        chargeCount = solidVerts.length / 7;

        if (!chargeWireBuffer) chargeWireBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, chargeWireBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wireVerts), gl.STATIC_DRAW);
        chargeWireCount = wireVerts.length / 5;
    }

    if (isWebGPU && gpuDevice) {
        if (solidVerts.length > 0) {
            const solidBytes = solidVerts.length * 4;
            if (!gpuChargeSolidBuffer || gpuChargeSolidBufferSize < solidBytes) {
                if (gpuChargeSolidBuffer) gpuChargeSolidBuffer.destroy();
                gpuChargeSolidBufferSize = solidBytes;
                gpuChargeSolidBuffer = gpuDevice.createBuffer({
                    size: solidBytes,
                    usage: 32 | 8 // VERTEX | COPY_DST
                });
            }
            gpuDevice.queue.writeBuffer(gpuChargeSolidBuffer, 0, new Float32Array(solidVerts));
            chargeCount = solidVerts.length / 7;
        } else {
            chargeCount = 0;
        }

        if (wireVerts.length > 0) {
            const wireBytes = wireVerts.length * 4;
            if (!gpuChargeWireBuffer || gpuChargeWireBufferSize < wireBytes) {
                if (gpuChargeWireBuffer) gpuChargeWireBuffer.destroy();
                gpuChargeWireBufferSize = wireBytes;
                gpuChargeWireBuffer = gpuDevice.createBuffer({
                    size: wireBytes,
                    usage: 32 | 8 // VERTEX | COPY_DST
                });
            }
            gpuDevice.queue.writeBuffer(gpuChargeWireBuffer, 0, new Float32Array(wireVerts));
            chargeWireCount = wireVerts.length / 5;
        } else {
            chargeWireCount = 0;
        }
    }
}

function updateDetonatorGeometry() {
    let items: any[] = [];
    if (detonatorsList && detonatorsList.length > 0) {
        items = detonatorsList;
    } else if (chargeData && (chargeData.det_x !== undefined || chargeData.det_y !== undefined || chargeData.det_z !== undefined)) {
        items = [{
            x: chargeData.det_x,
            y: chargeData.det_y,
            z: chargeData.det_z,
            radius: chargeData.det_radius || 0.02
        }];
    }

    if (items.length === 0) {
        detonatorCount = 0;
        detonatorWireCount = 0;
        return;
    }

    const dimX = getDimX();
    const dimY = getDimY();
    const dimZ = getDimZ();
    const minDim = Math.min(dimX, dimY, dimZ);

    let solidVerts: number[] = [];
    let wireVerts: number[] = [];

    items.forEach((item: any) => {
        const cx = Number(item.x ?? (xmin + dimX * 0.5));
        const cy = Number(item.y ?? (ymin + dimY * 0.5));
        const cz = Number(item.z ?? (zmin + dimZ * 0.5));

        const px = normX(cx);
        const py = normY(cy);
        const pz = normZ(cz);

        const rPhys = Math.max(0.005, Number(item.radius ?? (minDim * 0.035))) * detonatorSize;
        const rx = rPhys / dimX;
        const ry = rPhys / dimY;
        const rz = rPhys / dimZ;

        // Diamond Octahedron Vertices:
        const top = [px, py, pz + rz];
        const btm = [px, py, pz - rz];
        const right = [px + rx, py, pz];
        const left = [px - rx, py, pz];
        const front = [px, py + ry, pz];
        const back = [px, py - ry, pz];

        const addSolidTri = (p1: number[], p2: number[], p3: number[]) => {
            const v1x = p2[0] - p1[0], v1y = p2[1] - p1[1], v1z = p2[2] - p1[2];
            const v2x = p3[0] - p1[0], v2y = p3[1] - p1[1], v2z = p3[2] - p1[2];
            let nx = v1y * v2z - v1z * v2y;
            let ny = v1z * v2x - v1x * v2z;
            let nz = v1x * v2y - v1y * v2x;
            const len = Math.hypot(nx, ny, nz);
            if (len > 1e-6) {
                nx /= len; ny /= len; nz /= len;
            } else {
                nx = 0; ny = 0; nz = 1;
            }
            solidVerts.push(p1[0], p1[1], p1[2], nx, ny, nz, 0);
            solidVerts.push(p2[0], p2[1], p2[2], nx, ny, nz, 0);
            solidVerts.push(p3[0], p3[1], p3[2], nx, ny, nz, 0);
        };

        // Top pyramid (4 faces)
        addSolidTri(top, right, front);
        addSolidTri(top, front, left);
        addSolidTri(top, left, back);
        addSolidTri(top, back, right);

        // Bottom pyramid (4 faces)
        addSolidTri(btm, front, right);
        addSolidTri(btm, left, front);
        addSolidTri(btm, back, left);
        addSolidTri(btm, right, back);

        // Wireframe edges:
        const addWireLine = (p1: number[], p2: number[]) => {
            wireVerts.push(p1[0], p1[1], p1[2], 0, 0);
            wireVerts.push(p2[0], p2[1], p2[2], 0, 0);
        };

        // Octahedron wireframe edges
        addWireLine(top, right);
        addWireLine(top, front);
        addWireLine(top, left);
        addWireLine(top, back);
        addWireLine(btm, right);
        addWireLine(btm, front);
        addWireLine(btm, left);
        addWireLine(btm, back);
        addWireLine(right, front);
        addWireLine(front, left);
        addWireLine(left, back);
        addWireLine(back, right);

        // Horizontal target ring for detonator
        const ringSegments = 24;
        const ringRx = rx * 1.35;
        const ringRy = ry * 1.35;
        for (let s = 0; s < ringSegments; s++) {
            const th1 = (s * 2 * Math.PI) / ringSegments;
            const th2 = ((s + 1) * 2 * Math.PI) / ringSegments;
            const pt1 = [px + ringRx * Math.cos(th1), py + ringRy * Math.sin(th1), pz];
            const pt2 = [px + ringRx * Math.cos(th2), py + ringRy * Math.sin(th2), pz];
            addWireLine(pt1, pt2);
        }
    });

    if (gl) {
        if (!detonatorBuffer) detonatorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, detonatorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(solidVerts), gl.STATIC_DRAW);
        detonatorCount = solidVerts.length / 7;

        if (!detonatorWireBuffer) detonatorWireBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, detonatorWireBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wireVerts), gl.STATIC_DRAW);
        detonatorWireCount = wireVerts.length / 5;
    }

    if (isWebGPU && gpuDevice) {
        if (solidVerts.length > 0) {
            const solidBytes = solidVerts.length * 4;
            if (!gpuDetonatorSolidBuffer || gpuDetonatorSolidBufferSize < solidBytes) {
                if (gpuDetonatorSolidBuffer) gpuDetonatorSolidBuffer.destroy();
                gpuDetonatorSolidBufferSize = solidBytes;
                gpuDetonatorSolidBuffer = gpuDevice.createBuffer({
                    size: solidBytes,
                    usage: 32 | 8 // VERTEX | COPY_DST
                });
            }
            gpuDevice.queue.writeBuffer(gpuDetonatorSolidBuffer, 0, new Float32Array(solidVerts));
            detonatorCount = solidVerts.length / 7;
        } else {
            detonatorCount = 0;
        }

        if (wireVerts.length > 0) {
            const wireBytes = wireVerts.length * 4;
            if (!gpuDetonatorWireBuffer || gpuDetonatorWireBufferSize < wireBytes) {
                if (gpuDetonatorWireBuffer) gpuDetonatorWireBuffer.destroy();
                gpuDetonatorWireBufferSize = wireBytes;
                gpuDetonatorWireBuffer = gpuDevice.createBuffer({
                    size: wireBytes,
                    usage: 32 | 8 // VERTEX | COPY_DST
                });
            }
            gpuDevice.queue.writeBuffer(gpuDetonatorWireBuffer, 0, new Float32Array(wireVerts));
            detonatorWireCount = wireVerts.length / 5;
        } else {
            detonatorWireCount = 0;
        }
    }
}

function updateMPMPreviewGeometry() {
    if (!mpmObjectsData || mpmObjectsData.length === 0) {
        mpmPreviewCount = 0;
        return;
    }

    const dimX = getDimX();
    const dimY = getDimY();
    const dimZ = getDimZ();

    let allVerts: number[] = [];

    for (const obj of mpmObjectsData) {
        const cx = Number(obj.x ?? (xmin + dimX * 0.5));
        const cy = Number(obj.y ?? (ymin + dimY * 0.5));
        const cz = Number(obj.z ?? (zmin + dimZ * 0.5));

        const px = normX(cx);
        const py = normY(cy);
        const pz = normZ(cz);

        const shape = obj.shape || 'Box';
        if (shape === 'Box') {
            const lx = Number(obj.size_x ?? 0.2);
            const ly = Number(obj.size_y ?? 0.2);
            const lz = Number(obj.size_z ?? 0.2);
            const wire = getRotatedBoxWireframeVertices(px, py, pz, lx, ly, lz, 0, 0, 0, dimX, dimY, dimZ);
            allVerts.push(...wire);
        } else if (shape === 'Cylinder') {
            const r = Number(obj.radius ?? 0.1);
            const h = Number(obj.height ?? 0.2);
            const wire = getCylinderWireframeVertices(px, py, pz, r, h, 0, 0, 0, dimX, dimY, dimZ);
            allVerts.push(...wire);
        } else if (shape === 'Sphere') {
            const r = Number(obj.radius ?? 0.1);
            const wire = getSphereWireframeVertices(px, py, pz, r / dimX, r / dimY, r / dimZ);
            allVerts.push(...wire);
        }
    }

    if (gl) {
        if (!mpmPreviewBuffer) mpmPreviewBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, mpmPreviewBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(allVerts), gl.STATIC_DRAW);
        mpmPreviewCount = allVerts.length / 5;
    }

    if (isWebGPU && gpuDevice) {
        if (allVerts.length > 0) {
            const bytes = allVerts.length * 4;
            if (!gpuMPMPreviewBuffer || gpuMPMPreviewBufferSize < bytes) {
                if (gpuMPMPreviewBuffer) gpuMPMPreviewBuffer.destroy();
                gpuMPMPreviewBufferSize = bytes;
                gpuMPMPreviewBuffer = gpuDevice.createBuffer({
                    size: bytes,
                    usage: 32 | 8 // VERTEX | COPY_DST
                });
            }
            gpuDevice.queue.writeBuffer(gpuMPMPreviewBuffer, 0, new Float32Array(allVerts));
            mpmPreviewCount = allVerts.length / 5;
        } else {
            mpmPreviewCount = 0;
        }
    }
}

function normX(x: number): number {
    const dimX = getDimX();
    return (x - xmin) / dimX - 0.5;
}
function normY(y: number): number {
    const dimY = getDimY();
    return (y - ymin) / dimY - 0.5;
}
function normZ(z: number): number {
    const dimZ = getDimZ();
    return (z - zmin) / dimZ - 0.5;
}

function updateAMRTilesGeometry(tiles: any[]) {
    if (!tiles || tiles.length === 0) {
        amrTilesCount = 0;
        return;
    }
    const floatArray = new Float32Array(tiles.length * 12 * 2 * 5);
    let offset = 0;
    for (const t of tiles) {
        const xMin = Number(t.xmin ?? t.x_min ?? 0.0);
        const xMax = Number(t.xmax ?? t.x_max ?? 1.0);
        const yMin = Number(t.ymin ?? t.y_min ?? 0.0);
        const yMax = Number(t.ymax ?? t.y_max ?? 1.0);
        const zMin = Number(t.zmin ?? t.z_min ?? 0.0);
        const zMax = Number(t.zmax ?? t.z_max ?? 1.0);

        const x0 = normX(xMin), x1 = normX(xMax);
        const y0 = normY(yMin), y1 = normY(yMax);
        const z0 = normZ(zMin), z1 = normZ(zMax);

        const edges = [
            x0,y0,z0, x1,y0,z0,  x1,y0,z0, x1,y1,z0,  x1,y1,z0, x0,y1,z0,  x0,y1,z0, x0,y0,z0,
            x0,y0,z1, x1,y0,z1,  x1,y0,z1, x1,y1,z1,  x1,y1,z1, x0,y1,z1,  x0,y1,z1, x0,y0,z1,
            x0,y0,z0, x0,y0,z1,  x1,y0,z0, x1,y0,z1,  x1,y1,z0, x1,y1,z1,  x0,y1,z0, x0,y1,z1
        ];

        for (let i = 0; i < edges.length; i += 3) {
            floatArray[offset++] = edges[i];
            floatArray[offset++] = edges[i+1];
            floatArray[offset++] = edges[i+2];
            floatArray[offset++] = 0.0;
            floatArray[offset++] = 0.0;
        }
    }
    amrTilesCount = tiles.length * 24;

    if (gl) {
        if (!amrTilesBuffer) amrTilesBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, amrTilesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, floatArray, gl.DYNAMIC_DRAW);
    }
    if (gpuDevice) {
        const bytes = floatArray.byteLength;
        if (!gpuAMRTilesBuffer || gpuAMRTilesBufferSize < bytes) {
            if (gpuAMRTilesBuffer) gpuAMRTilesBuffer.destroy();
            gpuAMRTilesBufferSize = Math.max(bytes, Math.floor(bytes * 1.25));
            gpuAMRTilesBuffer = gpuDevice.createBuffer({
                size: gpuAMRTilesBufferSize,
                usage: 0x20 | 0x08 // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        if (bytes > 0) {
            gpuDevice.queue.writeBuffer(gpuAMRTilesBuffer, 0, floatArray.buffer, floatArray.byteOffset, bytes);
        }
    }
}

function updateSliceAMRGridlinesGeometry() {
    if (!slicesConfigCache || slicesConfigCache.length === 0) {
        sliceGridlinesCount = 0;
        return;
    }

    const lineVertices: number[] = [];

    const rootDx = (dx > 0) ? dx : 0.075;
    const rootDy = (dy > 0) ? dy : 0.075;
    const rootDz = (dz > 0) ? dz : 0.075;

    if (amrLeafTilesCache && amrLeafTilesCache.length > 0) {
        for (const slice of slicesConfigCache) {
            if (slice.enabled === false) continue;

            const rawAxis = slice.axis;
            const axis = (rawAxis === 2 || rawAxis === '2' || String(rawAxis).toLowerCase() === 'yz')
                ? 'yz'
                : ((rawAxis === 1 || rawAxis === '1' || String(rawAxis).toLowerCase() === 'xz')
                    ? 'xz'
                    : 'xy');
            const rawOffset = slice.offset ?? 0.0;

            for (const tile of amrLeafTilesCache) {
                const rawTileXMin = Number(tile.xmin ?? tile.x_min ?? 0.0);
                const rawTileXMax = Number(tile.xmax ?? tile.x_max ?? 1.0);
                const rawTileYMin = Number(tile.ymin ?? tile.y_min ?? 0.0);
                const rawTileYMax = Number(tile.ymax ?? tile.y_max ?? 1.0);
                const rawTileZMin = Number(tile.zmin ?? tile.z_min ?? 0.0);
                const rawTileZMax = Number(tile.zmax ?? tile.z_max ?? 1.0);
                const level = Math.max(1, Number(tile.level ?? 1));

                // Snap submesh bounds to root domain grid cell faces so they line up perfectly
                const ix0 = Math.round((rawTileXMin - xmin) / rootDx);
                const ix1 = Math.round((rawTileXMax - xmin) / rootDx);
                const tileXMin = xmin + ix0 * rootDx;
                const tileXMax = xmin + Math.max(ix0 + 1, ix1) * rootDx;

                const jy0 = Math.round((rawTileYMin - ymin) / rootDy);
                const jy1 = Math.round((rawTileYMax - ymin) / rootDy);
                const tileYMin = ymin + jy0 * rootDy;
                const tileYMax = ymin + Math.max(jy0 + 1, jy1) * rootDy;

                const kz0 = Math.round((rawTileZMin - zmin) / rootDz);
                const kz1 = Math.round((rawTileZMax - zmin) / rootDz);
                const tileZMin = zmin + kz0 * rootDz;
                const tileZMax = zmin + Math.max(kz0 + 1, kz1) * rootDz;

                const subDx = rootDx / (1 << level);
                const subDy = rootDy / (1 << level);
                const subDz = rootDz / (1 << level);

                const nxSub = Math.max(1, Math.round((tileXMax - tileXMin) / subDx));
                const nySub = Math.max(1, Math.round((tileYMax - tileYMin) / subDy));
                const nzSub = Math.max(1, Math.round((tileZMax - tileZMin) / subDz));

                if (axis === 'xy') {
                    if (rawOffset < tileZMin - 1e-4 || rawOffset > tileZMax + 1e-4) continue;
                    const x0 = normX(tileXMin), x1 = normX(tileXMax);
                    const y0 = normY(tileYMin), y1 = normY(tileYMax);
                    const z = normZ(rawOffset);

                    for (let i = 0; i <= nxSub; ++i) {
                        const x = x0 + (i / nxSub) * (x1 - x0);
                        lineVertices.push(x, y0, z, 0, 0, x, y1, z, 0, 0);
                    }
                    for (let j = 0; j <= nySub; ++j) {
                        const y = y0 + (j / nySub) * (y1 - y0);
                        lineVertices.push(x0, y, z, 0, 0, x1, y, z, 0, 0);
                    }
                } else if (axis === 'xz') {
                    if (rawOffset < tileYMin - 1e-4 || rawOffset > tileYMax + 1e-4) continue;
                    const x0 = normX(tileXMin), x1 = normX(tileXMax);
                    const z0 = normZ(tileZMin), z1 = normZ(tileZMax);
                    const y = normY(rawOffset);

                    for (let i = 0; i <= nxSub; ++i) {
                        const x = x0 + (i / nxSub) * (x1 - x0);
                        lineVertices.push(x, y, z0, 0, 0, x, y, z1, 0, 0);
                    }
                    for (let k = 0; k <= nzSub; ++k) {
                        const z = z0 + (k / nzSub) * (z1 - z0);
                        lineVertices.push(x0, y, z, 0, 0, x1, y, z, 0, 0);
                    }
                } else if (axis === 'yz') {
                    if (rawOffset < tileXMin - 1e-4 || rawOffset > tileXMax + 1e-4) continue;
                    const y0 = normY(tileYMin), y1 = normY(tileYMax);
                    const z0 = normZ(tileZMin), z1 = normZ(tileZMax);
                    const x = normX(rawOffset);

                    for (let j = 0; j <= nySub; ++j) {
                        const y = y0 + (j / nySub) * (y1 - y0);
                        lineVertices.push(x, y, z0, 0, 0, x, y, z1, 0, 0);
                    }
                    for (let k = 0; k <= nzSub; ++k) {
                        const z = z0 + (k / nzSub) * (z1 - z0);
                        lineVertices.push(x, y0, z, 0, 0, x, y1, z, 0, 0);
                    }
                }
            }
        }
    } else {
        // Draw slice boundary frames and crosshairs for uniform / uninitialized models
        for (const slice of slicesConfigCache) {
            if (slice.enabled === false) continue;
            const rawAxis = slice.axis;
            const axis = (rawAxis === 2 || rawAxis === '2' || String(rawAxis).toLowerCase() === 'yz')
                ? 'yz'
                : ((rawAxis === 1 || rawAxis === '1' || String(rawAxis).toLowerCase() === 'xz')
                    ? 'xz'
                    : 'xy');
            const rawOffset = slice.offset ?? 0.0;

            if (axis === 'xy') {
                const x0 = normX(xmin), x1 = normX(xmax);
                const y0 = normY(ymin), y1 = normY(ymax);
                const z = normZ(rawOffset);

                lineVertices.push(x0, y0, z, 0, 0, x1, y0, z, 0, 0);
                lineVertices.push(x1, y0, z, 0, 0, x1, y1, z, 0, 0);
                lineVertices.push(x1, y1, z, 0, 0, x0, y1, z, 0, 0);
                lineVertices.push(x0, y1, z, 0, 0, x0, y0, z, 0, 0);

                const midY = normY((ymin + ymax) * 0.5);
                const midX = normX((xmin + xmax) * 0.5);
                lineVertices.push(x0, midY, z, 0, 0, x1, midY, z, 0, 0);
                lineVertices.push(midX, y0, z, 0, 0, midX, y1, z, 0, 0);
            } else if (axis === 'xz') {
                const x0 = normX(xmin), x1 = normX(xmax);
                const z0 = normZ(zmin), z1 = normZ(zmax);
                const y = normY(rawOffset);

                lineVertices.push(x0, y, z0, 0, 0, x1, y, z0, 0, 0);
                lineVertices.push(x1, y, z0, 0, 0, x1, y, z1, 0, 0);
                lineVertices.push(x1, y, z1, 0, 0, x0, y, z1, 0, 0);
                lineVertices.push(x0, y, z1, 0, 0, x0, y, z0, 0, 0);

                const midZ = normZ((zmin + zmax) * 0.5);
                const midX = normX((xmin + xmax) * 0.5);
                lineVertices.push(x0, y, midZ, 0, 0, x1, y, midZ, 0, 0);
                lineVertices.push(midX, y, z0, 0, 0, midX, y, z1, 0, 0);
            } else if (axis === 'yz') {
                const y0 = normY(ymin), y1 = normY(ymax);
                const z0 = normZ(zmin), z1 = normZ(zmax);
                const x = normX(rawOffset);

                lineVertices.push(x, y0, z0, 0, 0, x, y1, z0, 0, 0);
                lineVertices.push(x, y1, z0, 0, 0, x, y1, z1, 0, 0);
                lineVertices.push(x, y1, z1, 0, 0, x, y0, z1, 0, 0);
                lineVertices.push(x, y0, z1, 0, 0, x, y0, z0, 0, 0);

                const midZ = normZ((zmin + zmax) * 0.5);
                const midY = normY((ymin + ymax) * 0.5);
                lineVertices.push(x, y0, midZ, 0, 0, x, y1, midZ, 0, 0);
                lineVertices.push(x, midY, z0, 0, 0, x, midY, z1, 0, 0);
            }
        }
    }

    if (lineVertices.length === 0) {
        sliceGridlinesCount = 0;
        return;
    }

    const floatArray = new Float32Array(lineVertices);
    sliceGridlinesCount = floatArray.length / 5;

    if (gl) {
        if (!sliceGridlinesBuffer) sliceGridlinesBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, sliceGridlinesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, floatArray, gl.DYNAMIC_DRAW);
    }
    if (gpuDevice) {
        const bytes = floatArray.byteLength;
        if (!gpuSliceGridlinesBuffer || gpuSliceGridlinesBufferSize < bytes) {
            if (gpuSliceGridlinesBuffer) gpuSliceGridlinesBuffer.destroy();
            gpuSliceGridlinesBufferSize = Math.max(bytes, Math.floor(bytes * 1.25));
            gpuSliceGridlinesBuffer = gpuDevice.createBuffer({
                size: gpuSliceGridlinesBufferSize,
                usage: 0x20 | 0x08 // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        if (bytes > 0) {
            gpuDevice.queue.writeBuffer(gpuSliceGridlinesBuffer, 0, floatArray.buffer, floatArray.byteOffset, bytes);
        }
    }
}

function getBBoxVertices(): Float32Array {
    const verts: number[] = [
        // 1. Domain Bounding Box (12 outline edges = 24 vertices)
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
    ];

    // 2. 3D Studio Ground Grid Plane on Domain Floor (z = -0.5)
    // 10 subdivisions across XY floor (9 internal crosslines in X and Y)
    const divisions = 10;
    for (let i = 1; i < divisions; i++) {
        const c = -0.5 + i / divisions;
        // Lines parallel to X at constant Y
        verts.push(-0.5, c, -0.5, 0, 0);
        verts.push( 0.5, c, -0.5, 0, 0);
        // Lines parallel to Y at constant X
        verts.push(c, -0.5, -0.5, 0, 0);
        verts.push(c,  0.5, -0.5, 0, 0);
    }
    const arr = new Float32Array(verts);
    bboxVertexCount = arr.length / 5;
    return arr;
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

    glUniforms = {
        uTexture: gl.getUniformLocation(program, "uTexture"),
        uVolumeTexture3D: gl.getUniformLocation(program, "uVolumeTexture3D"),
        uStlMatrix: gl.getUniformLocation(program, "uStlMatrix"),
        uProjection: gl.getUniformLocation(program, "uProjection"),
        uView: gl.getUniformLocation(program, "uView"),
        uModel: gl.getUniformLocation(program, "uModel"),
        uAlpha: gl.getUniformLocation(program, "uAlpha"),
        uColormap: gl.getUniformLocation(program, "uColormap"),
        uMin: gl.getUniformLocation(program, "uMin"),
        uMax: gl.getUniformLocation(program, "uMax"),
        uUseLogScale: gl.getUniformLocation(program, "uUseLogScale"),
        uIsAMR: gl.getUniformLocation(program, "uIsAMR"),
        uIsWireframe: gl.getUniformLocation(program, "uIsWireframe"),
        uEnableLighting: gl.getUniformLocation(program, "uEnableLighting"),
        uEnableAO: gl.getUniformLocation(program, "uEnableAO"),
        uAoRadius: gl.getUniformLocation(program, "uAoRadius"),
        uAoIntensity: gl.getUniformLocation(program, "uAoIntensity"),
        uAoBias: gl.getUniformLocation(program, "uAoBias"),
        uAoSphereImpostor: gl.getUniformLocation(program, "uAoSphereImpostor"),
        uAmbientLevel: gl.getUniformLocation(program, "uAmbientLevel"),
        uSpecularLevel: gl.getUniformLocation(program, "uSpecularLevel"),
        uStlShowResults: gl.getUniformLocation(program, "uStlShowResults"),
        uStlColormap: gl.getUniformLocation(program, "uStlColormap"),
        uDomainMin: gl.getUniformLocation(program, "uDomainMin"),
        uDomainExtent: gl.getUniformLocation(program, "uDomainExtent"),
        uDx: gl.getUniformLocation(program, "uDx"),
        uStlMin: gl.getUniformLocation(program, "uStlMin"),
        uStlMax: gl.getUniformLocation(program, "uStlMax"),
        uStlLogScale: gl.getUniformLocation(program, "uStlLogScale"),
        uShowCellEdges: gl.getUniformLocation(program, "uShowCellEdges"),
        uInterpolate: gl.getUniformLocation(program, "uInterpolate"),
        uParticleSize: gl.getUniformLocation(program, "uParticleSize"),
        uParticleDiameter: gl.getUniformLocation(program, "uParticleDiameter"),
        uViewportHeight: gl.getUniformLocation(program, "uViewportHeight"),
        uAxis: gl.getUniformLocation(program, "uAxis"),
        uIsSubmesh: gl.getUniformLocation(program, "uIsSubmesh"),
        uNumSubmeshMasks: gl.getUniformLocation(program, "uNumSubmeshMasks"),
        uSubmeshMasks: gl.getUniformLocation(program, "uSubmeshMasks")
    };

    if (glUniforms.uTexture) {
        gl.uniform1i(glUniforms.uTexture, 0);
    }
    if (glUniforms.uVolumeTexture3D) {
        gl.uniform1i(glUniforms.uVolumeTexture3D, 1);
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
    const dimX = getDimX();
    const dimY = getDimY();
    const dimZ = getDimZ();

    let sx = 0;
    let sy = 0;
    let sz = 0;

    if (axis === 0) { // XY
        sz = normZ(offset);
    } else if (axis === 1) { // XZ
        sy = normY(offset);
    } else { // YZ
        sx = normX(offset);
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
    const zNear = Math.max(1e-5, Math.min(0.05, distance * 0.1));
    const zFar = 1000.0;

    // Model matrix (Scaling)
    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
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
    let eye = [cameraEyeX, cameraEyeY, cameraEyeZ];
    let center = [targetX, targetY, targetZ];
    let up = [0, 0, 1]; // Z is up

    let z = normalize(subtract(eye, center));
    // If z is parallel to up [0,0,1] or [0,0,-1] (looking straight along Z axis)
    if (Math.abs(z[0]) < 1e-3 && Math.abs(z[1]) < 1e-3) {
        up = z[2] >= 0 ? [0, 1, 0] : [0, -1, 0];
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
        // Orthographic projection based on distance matching perspective FOV
        let scale = distance * Math.tan((fov * Math.PI / 180) / 2);
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

function getSliceGeometry(
    axis: number,
    offset: number,
    w: number,
    h: number,
    x0?: number,
    x1?: number,
    y0?: number,
    y1?: number,
    z0?: number,
    z1?: number,
    level: number = 0
) {
    const xMinVal = x0 !== undefined ? x0 : xmin;
    const xMaxVal = x1 !== undefined ? x1 : (xmin + getDimX());
    const yMinVal = y0 !== undefined ? y0 : ymin;
    const yMaxVal = y1 !== undefined ? y1 : (ymin + getDimY());
    const zMinVal = z0 !== undefined ? z0 : zmin;
    const zMaxVal = z1 !== undefined ? z1 : (zmin + getDimZ());

    const nx0 = normX(xMinVal);
    const nx1 = normX(xMaxVal);
    const ny0 = normY(yMinVal);
    const ny1 = normY(yMaxVal);
    const nz0 = normZ(zMinVal);
    const nz1 = normZ(zMaxVal);

    const zEpsilon = 1e-5 * level;

    if (axis === 0) { // XY
        const z = normZ(offset) + zEpsilon;
        return new Float32Array([
            nx0, ny0, z,  0, 0,  w, h,
            nx1, ny0, z,  1, 0,  w, h,
            nx1, ny1, z,  1, 1,  w, h,
            nx0, ny0, z,  0, 0,  w, h,
            nx1, ny1, z,  1, 1,  w, h,
            nx0, ny1, z,  0, 1,  w, h
        ]);
    } else if (axis === 1) { // XZ
        const y = normY(offset) + zEpsilon;
        return new Float32Array([
            nx0, y, nz0,  0, 0,  w, h,
            nx1, y, nz0,  1, 0,  w, h,
            nx1, y, nz1,  1, 1,  w, h,
            nx0, y, nz0,  0, 0,  w, h,
            nx1, y, nz1,  1, 1,  w, h,
            nx0, y, nz1,  0, 1,  w, h
        ]);
    } else { // YZ
        const x = normX(offset) + zEpsilon;
        return new Float32Array([
            x, ny0, nz0,  0, 0,  w, h,
            x, ny1, nz0,  1, 0,  w, h,
            x, ny1, nz1,  1, 1,  w, h,
            x, ny0, nz0,  0, 0,  w, h,
            x, ny1, nz1,  1, 1,  w, h,
            x, ny0, nz1,  0, 1,  w, h
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

function recomputeActiveRanges() {
    // 1. Aggregate dynamic extents per quantity across all active representations (Slices, Obstacles, STL CAD)
    const qtyDynamicExtents: Record<string, { min: number, max: number, posMin: number, hasData: boolean }> = {};
    const recordQtyVal = (rawQ: string, val: number) => {
        if (!isFinite(val)) return;
        const q = canonicalizeQuantity(rawQ);
        if (!qtyDynamicExtents[q]) {
            qtyDynamicExtents[q] = { min: val, max: val, posMin: val > 0 ? val : Infinity, hasData: true };
        } else {
            const ext = qtyDynamicExtents[q];
            if (val < ext.min) ext.min = val;
            if (val > ext.max) ext.max = val;
            if (val > 0 && val < ext.posMin) ext.posMin = val;
            ext.hasData = true;
        }
    };

    // Aggregate from all active slices
    for (let i = 0; i < cachedSlices.length; i++) {
        const slice = cachedSlices[i];
        const config = getSliceConfig(i);
        const qty = config.quantities?.[0] || 'pressure';
        for (let j = 0; j < slice.data.length; j++) {
            recordQtyVal(qty, slice.data[j]);
        }
    }

    // Aggregate from Obstacles
    if (showObstacles && latestObstaclesData && latestObstaclesData.length > 0) {
        const obsQ = obstaclesQuantity || 'pressure';
        for (let i = 0; i < latestObstaclesData.length; i++) {
            recordQtyVal(obsQ, latestObstaclesData[i]);
        }
    }

    // Aggregate from STL CAD Geometry
    if (showSTL && latestVolume3DData && latestVolume3DData.length > 0) {
        const stlQ = stlQuantity || 'pressure';
        const vLen = latestVolume3DData.length;
        const stride = vLen > 65536 ? Math.floor(vLen / 32768) : 1;
        for (let k = 0; k < vLen; k += stride) {
            const val = latestVolume3DData[k];
            if (isFinite(val)) {
                recordQtyVal(stlQ, val);
            }
        }
    }

    // If lockQuantityRanges is enabled, update unified quantityRanges for any quantity with active dynamic data
    let quantityRangesModified = false;
    for (const [rawQ, ext] of Object.entries(qtyDynamicExtents)) {
        const q = canonicalizeQuantity(rawQ);
        const isAuto = (quantityAutoScales[q] ?? quantityAutoScales[rawQ]) !== false;
        if (ext.hasData && ext.min < ext.max && (ext.max - ext.min) > Math.max(1e-4 * Math.abs(ext.max), 1e-4)) {
            if (lockQuantityRanges && isAuto) {
                let rangeMin = ext.min;
                let rangeMax = ext.max;
                const isLog = (quantityLogScales[q] ?? quantityLogScales[rawQ]) === true || (q === 'peak_overpressure' || q === 'energy');
                if (isLog && rangeMin <= 0 && rangeMax > 0) {
                    const dynamicFloor = rangeMax / 1000000.0;
                    rangeMin = (isFinite(ext.posMin) && ext.posMin > dynamicFloor) ? ext.posMin : dynamicFloor;
                }
                quantityRanges[q] = [rangeMin, rangeMax];
                quantityRanges[rawQ] = [rangeMin, rangeMax];
                if (q === 'peak_overpressure') quantityRanges['overpressure'] = [rangeMin, rangeMax];
                if (q === 'peak_impulse') quantityRanges['impulse'] = [rangeMin, rangeMax];
                if (q === 'plastic_strain') quantityRanges['plasticStrain'] = [rangeMin, rangeMax];
                if (q === 'vonMises') quantityRanges['von_mises'] = [rangeMin, rangeMax];
                quantityRangesModified = true;
            }
        }
    }
    if (quantityRangesModified) {
        self.postMessage({ type: 'quantityRangesUpdated', ranges: quantityRanges });
    }

    // Assign slice-specific ranges and configs
    const sliceRanges: { min: number, max: number }[] = [];
    for (let i = 0; i < cachedSlices.length; i++) {
        const slice = cachedSlices[i];
        const config = getSliceConfig(i);
        const rawQty = config.quantities?.[0] || 'pressure';
        const qty = canonicalizeQuantity(rawQty);
        const sliceIsLocked = lockQuantityRanges && (config.lock_quantity_range !== false);
        const sliceAutoScale = sliceIsLocked 
            ? ((quantityAutoScales[qty] ?? quantityAutoScales[rawQty]) !== false) 
            : (config.auto_scale !== false);
        const colormapVal = sliceIsLocked
            ? (quantityColormaps[qty] || quantityColormaps[rawQty] || config.colormap || 'rainbow')
            : (config.colormap || quantityColormaps[qty] || quantityColormaps[rawQty] || 'rainbow');
        const interpVal = config.interpolate === true;
        
        let sliceMin = Infinity;
        let sliceMax = -Infinity;
        let slicePosMin = Infinity;
        for (let j = 0; j < slice.data.length; j++) {
            const v = slice.data[j];
            if (isFinite(v)) {
                if (v < sliceMin) sliceMin = v;
                if (v > sliceMax) sliceMax = v;
                if (v > 0 && v < slicePosMin) slicePosMin = v;
            }
        }
        const logVal = sliceIsLocked
            ? (quantityLogScales[qty] ?? quantityLogScales[rawQty] ?? (config.log_scale === true))
            : (config.log_scale === true || (config.log_scale !== false && sliceMax > 0 && sliceMin > 0 && (sliceMax / sliceMin > 50.0)));

        let sliceMinY = minY;
        let sliceMaxY = maxY;

        const isFraction = qty === 'species1' || qty === 'species2' || qty === 'species3' || qty === 'solid' || qty === 'plastic_strain' || qty === 'damage' || qty === 'has_failed';
        const defaultRange = config.min_val !== undefined && config.max_val !== undefined
            ? [config.min_val, config.max_val]
            : (quantityRanges[qty] || quantityRanges[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || DEFAULT_QUANTITY_RANGES[rawQty] || [0.0, 1.0]);

        const hasDynamicRange = (sliceMax - sliceMin) > Math.max(1e-4 * Math.abs(sliceMax), 1e-4);
        if (sliceIsLocked) {
            const unified = quantityRanges[qty] || quantityRanges[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || DEFAULT_QUANTITY_RANGES[rawQty] || [0.0, 1.0];
            sliceMinY = unified[0];
            sliceMaxY = unified[1];
        } else if (sliceAutoScale) {
            if (sliceMin < sliceMax && hasDynamicRange) {
                if (isFraction && sliceMax <= 1e-4) {
                    sliceMinY = defaultRange[0];
                    sliceMaxY = defaultRange[1];
                } else if (logVal && sliceMax > 0) {
                    const dynamicFloor = sliceMax / 1000000.0;
                    const effMin = (isFinite(slicePosMin) && slicePosMin > dynamicFloor) ? slicePosMin : dynamicFloor;
                    sliceMinY = effMin;
                    sliceMaxY = sliceMax;
                } else {
                    sliceMinY = sliceMin;
                    sliceMaxY = sliceMax;
                }
            } else {
                sliceMinY = defaultRange[0];
                sliceMaxY = defaultRange[1];
            }
        } else {
            sliceMinY = defaultRange[0];
            sliceMaxY = defaultRange[1];
        }

        slice.minY = sliceMinY;
        slice.maxY = sliceMaxY;
        slice.colormap = colormapVal;
        slice.useLogScale = logVal;
        slice.interpolate = interpVal;

        if (isWebGPU && activeSlicesWebGPU[i]) {
            activeSlicesWebGPU[i].minY = sliceMinY;
            activeSlicesWebGPU[i].maxY = sliceMaxY;
            activeSlicesWebGPU[i].colormap = colormapVal;
            activeSlicesWebGPU[i].useLogScale = logVal;
            activeSlicesWebGPU[i].interpolate = interpVal;
        }
        if (gl && activeSlicesWebGL[i]) {
            activeSlicesWebGL[i].minY = sliceMinY;
            activeSlicesWebGL[i].maxY = sliceMaxY;
            activeSlicesWebGL[i].colormap = colormapVal;
            activeSlicesWebGL[i].useLogScale = logVal;
            activeSlicesWebGL[i].interpolate = interpVal;
        }

        sliceRanges.push({ min: sliceMinY, max: sliceMaxY });
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
        const focusedConfig = slicesConfig[focusedSliceIndex] || slicesConfig[0] || {};
        const focusedRawQty = focusedConfig.quantities?.[0] || 'pressure';
        const focusedQty = canonicalizeQuantity(focusedRawQty);
        const focusedIsFraction = focusedQty === 'species1' || focusedQty === 'species2' || focusedQty === 'species3' || focusedQty === 'solid' || focusedQty === 'plastic_strain' || focusedQty === 'damage' || focusedQty === 'has_failed';
        const focusedDefaultRange = focusedConfig.min_val !== undefined && focusedConfig.max_val !== undefined
            ? [focusedConfig.min_val, focusedConfig.max_val]
            : (quantityRanges[focusedQty] || quantityRanges[focusedRawQty] || DEFAULT_QUANTITY_RANGES[focusedQty] || DEFAULT_QUANTITY_RANGES[focusedRawQty] || [0.0, 1.0]);

        const focusedHasDynamicRange = (sliceMax - sliceMin) > Math.max(1e-4 * Math.abs(sliceMax), 1e-4);
        if (lockQuantityRanges) {
            const unified = quantityRanges[focusedQty] || quantityRanges[focusedRawQty] || DEFAULT_QUANTITY_RANGES[focusedQty] || DEFAULT_QUANTITY_RANGES[focusedRawQty] || [0.0, 1.0];
            self.postMessage({ type: 'currentRange', min: unified[0], max: unified[1] });
        } else if (sliceMin < sliceMax && focusedHasDynamicRange && (!focusedIsFraction || sliceMax > 1e-4)) {
            self.postMessage({ type: 'currentRange', min: sliceMin, max: sliceMax });
        } else {
            self.postMessage({ type: 'currentRange', min: focusedDefaultRange[0], max: focusedDefaultRange[1] });
        }
    }
}

function handleFrame(buffer: ArrayBuffer) {
    if (buffer.byteLength < 16) {
        self.postMessage({ type: 'log', message: `handleFrame failed: buffer size too small (${buffer.byteLength})` });
        self.postMessage({ type: 'frameComplete' });
        return;
    }
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);

    if (magic === 0x46454d33) { // "FEM3"
        updateFEMMeshGeometry(buffer);
        return;
    }

    if (magic === 0x4d504d33) { // "MPM3"
        const numParticles = view.getUint32(8, true);
        if (numParticles === 0) {
            latestMPMParticlesData = null;
            mpmParticlesCount = 0;
            if (gl && mpmParticlesBuffer) {
                gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
            }
            render();
            return;
        }
        const floatsPerParticle = view.getUint32(12, true);
        latestMPMFloatsPerParticle = floatsPerParticle || 14;
        const particleDataStart = 16;
        const totalFloats = numParticles * floatsPerParticle;
        const availableFloats = Math.floor((buffer.byteLength - particleDataStart) / 4);
        const count = Math.min(totalFloats, availableFloats);
        const floatData = new Float32Array(buffer, particleDataStart, count);
        updateMPMParticlesGeometry(floatData);
        return;
    }

    if (magic !== 0x43494c53) {
        self.postMessage({ type: 'frameComplete' });
        return; // "SLIC"
    }

    const time = view.getFloat32(4, true);
    const numSlices = view.getUint32(8, true);

    // Populate cachedSlices
    cachedSlices = [];
    let cacheOffset = 12;
    for (let i = 0; i < numSlices; i++) {
        if (cacheOffset + 48 > buffer.byteLength) break;
        const axis = view.getUint32(cacheOffset, true);
        const zOff = view.getFloat32(cacheOffset + 4, true);
        const w = view.getUint32(cacheOffset + 8, true);
        const h = view.getUint32(cacheOffset + 12, true);
        const xminVal = view.getFloat32(cacheOffset + 16, true);
        const xmaxVal = view.getFloat32(cacheOffset + 20, true);
        const yminVal = view.getFloat32(cacheOffset + 24, true);
        const ymaxVal = view.getFloat32(cacheOffset + 28, true);
        const zminVal = view.getFloat32(cacheOffset + 32, true);
        const zmaxVal = view.getFloat32(cacheOffset + 36, true);
        const level = view.getUint32(cacheOffset + 40, true);
        const isSubmesh = view.getUint32(cacheOffset + 44, true) !== 0;

        const dataStart = cacheOffset + 48;
        let numElements = w * h;
        let volNz = nz || 64;
        if (axis === 4) {
            volNz = (Math.round(zOff) > 0) ? Math.round(zOff) : (nz || 64);
            numElements = w * h * volNz;
        }
        const availableBytes = Math.max(0, buffer.byteLength - dataStart);
        const availableElements = Math.floor(availableBytes / 4);
        const actualElements = Math.min(numElements, availableElements);
        const floatData = new Float32Array(buffer, dataStart, actualElements);

        const useAxis = axis;
        const useOffset = zOff;

        if (useAxis === 3) {
            latestObstaclesData = new Float32Array(floatData);
            let oMin = Infinity, oMax = -Infinity;
            const oLen = latestObstaclesData.length;
            const stride = oLen > 65536 ? Math.floor(oLen / 32768) : 1;
            for (let i = 0; i < oLen; i += stride) {
                const v = latestObstaclesData[i];
                if (isFinite(v)) {
                    if (v < oMin) oMin = v;
                    if (v > oMax) oMax = v;
                }
            }
            if (isFinite(oMin) && isFinite(oMax) && oMax > oMin) {
                cachedObstaclesMinVal = oMin;
                cachedObstaclesMaxVal = oMax;
                self.postMessage({ type: 'obstaclesRangeUpdated', min: oMin, max: oMax });
            }
            updateObstaclesValues(latestObstaclesData);
        } else if (useAxis === 4) {
            latestVolume3DData = new Float32Array(floatData);
            latestVolume3DNx = w;
            latestVolume3DNy = h;
            latestVolume3DNz = volNz;
            let vMin = Infinity;
            let vMax = -Infinity;
            const vLen = latestVolume3DData.length;
            const stride = vLen > 65536 ? Math.floor(vLen / 32768) : 1;
            for (let k = 0; k < vLen; k += stride) {
                const val = latestVolume3DData[k];
                if (isFinite(val)) {
                    if (val < vMin) vMin = val;
                    if (val > vMax) vMax = val;
                }
            }
            if (isFinite(vMin) && isFinite(vMax) && vMax > vMin) {
                stlVolMin = vMin;
                stlVolMax = vMax;
                self.postMessage({ type: 'stlRangeUpdated', min: vMin, max: vMax });
            }
            updateVolume3DTexture(w, h, volNz);
            updateWebGL2Volume3DTexture(latestVolume3DData, w, h, volNz);
        } else {
            cachedSlices.push({
                axis: useAxis,
                offset: useOffset,
                w,
                h,
                xmin: xminVal,
                xmax: xmaxVal,
                ymin: yminVal,
                ymax: ymaxVal,
                zmin: zminVal,
                zmax: zmaxVal,
                level,
                is_submesh: isSubmesh,
                data: new Float32Array(floatData)
            });
        }
        cacheOffset = dataStart + (actualElements * 4);
    }

    recomputeActiveRanges();

    if (is2DFallback) {
        activeSlices2D = cachedSlices;
        render();
        return;
    }
    // We clear slices on size changes or if configuration changes
    let sizeChanged = false;
    // We will clear the maps if sizeChanged is detected via setConfig or when cachedSlices.length doesn't match active count
    const activeCount = Object.keys(activeSlicesWebGPU).length;
    if (activeCount !== cachedSlices.length) {
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
            const geo = getSliceGeometry(axis, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level);

            if (activeSlicesWebGPU[i]) {
                slice = activeSlicesWebGPU[i];
                let recreateBindGroup = false;
                if (slice.w !== w || slice.h !== h || slice.interpolate !== sliceObj.interpolate) {
                    if (slice.w !== w || slice.h !== h) {
                        slice.gpuTexture.destroy();
                        slice.gpuTexture = gpuDevice.createTexture({
                            size: [w, h, 1],
                            format: 'r32float',
                            usage: 4 | 2
                        });
                        slice.gpuTextureView = slice.gpuTexture.createView();
                        slice.w = w; slice.h = h;
                    }
                    recreateBindGroup = true;
                }

                if (recreateBindGroup) {
                    if (!gpuSliceUniformBuffers[i]) {
                        gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                            size: 384,
                            usage: 64 | 8
                        });
                    }
                    const sampler = (sliceObj.interpolate === false) ? gpuSamplerNearest : gpuSamplerLinear;
                    slice.bindGroup = gpuDevice.createBindGroup({
                        layout: bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                            { binding: 1, resource: slice.gpuTextureView },
                            { binding: 2, resource: sampler! },
                            { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
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
                slice.xmin = sliceObj.xmin;
                slice.xmax = sliceObj.xmax;
                slice.ymin = sliceObj.ymin;
                slice.ymax = sliceObj.ymax;
                slice.zmin = sliceObj.zmin;
                slice.zmax = sliceObj.zmax;
                slice.level = sliceObj.level;
                slice.is_submesh = sliceObj.is_submesh;
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
                        size: 384,
                        usage: 64 | 8
                    });
                }

                const sampler = (sliceObj.interpolate === false) ? gpuSamplerNearest : gpuSamplerLinear;
                const bindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                        { binding: 1, resource: texView },
                        { binding: 2, resource: sampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                slice = {
                    axis,
                    offset: zOff,
                    w,
                    h,
                    xmin: sliceObj.xmin,
                    xmax: sliceObj.xmax,
                    ymin: sliceObj.ymin,
                    ymax: sliceObj.ymax,
                    zmin: sliceObj.zmin,
                    zmax: sliceObj.zmax,
                    level: sliceObj.level,
                    is_submesh: sliceObj.is_submesh,
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
                activeSlicesWebGPU[i] = slice;
            }
        });
        render();
        return;
    }

    // WebGL frame processing
    if (!gl) {
        self.postMessage({ type: 'frameComplete' });
        return;
    }
    const activeGl = gl;
    activeGl.activeTexture(activeGl.TEXTURE0);

    if (Object.keys(activeSlicesWebGL).length !== cachedSlices.length) {
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

            const filter = (sliceObj.interpolate === false) ? activeGl.NEAREST : (hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_S, activeGl.CLAMP_TO_EDGE);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_T, activeGl.CLAMP_TO_EDGE);

            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, slice.buffer);
            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level), activeGl.STATIC_DRAW);

            slice.axis = axis;
            slice.offset = zOff;
            slice.w = w;
            slice.h = h;
            slice.xmin = sliceObj.xmin;
            slice.xmax = sliceObj.xmax;
            slice.ymin = sliceObj.ymin;
            slice.ymax = sliceObj.ymax;
            slice.zmin = sliceObj.zmin;
            slice.zmax = sliceObj.zmax;
            slice.level = sliceObj.level;
            slice.is_submesh = sliceObj.is_submesh;
            slice.opacity = opacity;
            slice.minY = sliceObj.minY;
            slice.maxY = sliceObj.maxY;
            slice.colormap = sliceObj.colormap;
            slice.useLogScale = sliceObj.useLogScale;
            slice.interpolate = sliceObj.interpolate;
        } else {
            const tex = activeGl.createTexture()!;
            activeGl.bindTexture(activeGl.TEXTURE_2D, tex);
            const filter = (sliceObj.interpolate === false) ? activeGl.NEAREST : (hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_S, activeGl.CLAMP_TO_EDGE);
            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_T, activeGl.CLAMP_TO_EDGE);
            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

            const buf = activeGl.createBuffer()!;
            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, buf);
            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axis, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level), activeGl.STATIC_DRAW);

            slice = {
                axis,
                offset: zOff,
                w,
                h,
                xmin: sliceObj.xmin,
                xmax: sliceObj.xmax,
                ymin: sliceObj.ymin,
                ymax: sliceObj.ymax,
                zmin: sliceObj.zmin,
                zmax: sliceObj.zmax,
                level: sliceObj.level,
                is_submesh: sliceObj.is_submesh,
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
            activeSlicesWebGL[i] = slice;
        }
    });
    render();
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

function invertMatrix4(m: Float32Array): Float32Array | null {
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

function getRayFromScreen(mouseX: number, mouseY: number, width: number, height: number): { origin: number[], dir: number[] } | null {
    if (width <= 0 || height <= 0) return null;
    const ndcX = (mouseX / width) * 2.0 - 1.0;
    const ndcY = 1.0 - (mouseY / height) * 2.0;

    const pv = multiplyMatrices(projectionMatrix, viewMatrix);
    const invPV = invertMatrix4(pv);
    if (!invPV) return null;

    function unproject(x: number, y: number, z: number): number[] {
        const w = invPV![3]*x + invPV![7]*y + invPV![11]*z + invPV![15] || 1.0;
        return [
            (invPV![0]*x + invPV![4]*y + invPV![8]*z + invPV![12]) / w,
            (invPV![1]*x + invPV![5]*y + invPV![9]*z + invPV![13]) / w,
            (invPV![2]*x + invPV![6]*y + invPV![10]*z + invPV![14]) / w
        ];
    }

    if (usePerspective) {
        // In perspective projection, ray starts directly at camera eye and passes through unprojected screen coordinate
        const eyePt = [cameraEyeX, cameraEyeY, cameraEyeZ];
        const farPt = unproject(ndcX, ndcY, 1.0);
        const dir = normalize(subtract(farPt, eyePt));
        return { origin: eyePt, dir };
    } else {
        // In orthographic projection, ray starts at near plane and travels parallel to camera view axis
        const nearNdcZ = (isWebGPU && gpuDevice) ? 0.0 : -1.0;
        const nearPt = unproject(ndcX, ndcY, nearNdcZ);
        const farPt = unproject(ndcX, ndcY, 1.0);
        const dir = normalize(subtract(farPt, nearPt));
        return { origin: nearPt, dir };
    }
}

function rayTriangleIntersect(
    O: number[], D: number[],
    V0: number[], V1: number[], V2: number[]
): number | null {
    const EPSILON = 1e-7;
    const e1 = [V1[0] - V0[0], V1[1] - V0[1], V1[2] - V0[2]];
    const e2 = [V2[0] - V0[0], V2[1] - V0[1], V2[2] - V0[2]];

    const h = cross(D, e2);
    const a = e1[0]*h[0] + e1[1]*h[1] + e1[2]*h[2];

    if (a > -EPSILON && a < EPSILON) return null;

    const f = 1.0 / a;
    const s = [O[0] - V0[0], O[1] - V0[1], O[2] - V0[2]];
    const u = f * (s[0]*h[0] + s[1]*h[1] + s[2]*h[2]);

    if (u < 0.0 || u > 1.0) return null;

    const q = cross(s, e1);
    const v = f * (D[0]*q[0] + D[1]*q[1] + D[2]*q[2]);

    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * (e2[0]*q[0] + e2[1]*q[1] + e2[2]*q[2]);
    if (t > EPSILON) return t;
    return null;
}

function rayTriangleIntersectCoords(
    Ox: number, Oy: number, Oz: number,
    Dx: number, Dy: number, Dz: number,
    v0x: number, v0y: number, v0z: number,
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number
): number | null {
    const EPSILON = 1e-7;
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

    const hx = Dy * e2z - Dz * e2y;
    const hy = Dz * e2x - Dx * e2z;
    const hz = Dx * e2y - Dy * e2x;
    const a = e1x * hx + e1y * hy + e1z * hz;

    if (a > -EPSILON && a < EPSILON) return null;

    const f = 1.0 / a;
    const sx = Ox - v0x, sy = Oy - v0y, sz = Oz - v0z;
    const u = f * (sx * hx + sy * hy + sz * hz);

    if (u < 0.0 || u > 1.0) return null;

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (Dx * qx + Dy * qy + Dz * qz);

    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    if (t > EPSILON) return t;
    return null;
}

function raySphereIntersectCoords(
    Ox: number, Oy: number, Oz: number,
    Dx: number, Dy: number, Dz: number,
    cx: number, cy: number, cz: number,
    radius: number
): number | null {
    const ocx = Ox - cx, ocy = Oy - cy, ocz = Oz - cz;
    const b = ocx * Dx + ocy * Dy + ocz * Dz;
    const c = (ocx * ocx + ocy * ocy + ocz * ocz) - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const sqrtDisc = Math.sqrt(discriminant);
    let t = -b - sqrtDisc;
    if (t > 1e-5) return t;
    t = -b + sqrtDisc;
    if (t > 1e-5) return t;
    return null;
}

function raySphereIntersect(
    O: number[], D: number[],
    center: number[], radius: number
): number | null {
    return raySphereIntersectCoords(O[0], O[1], O[2], D[0], D[1], D[2], center[0], center[1], center[2], radius);
}

function rayCylinderIntersect(O: number[], D: number[], center: number[], R: number, H: number): number | null {
    const cx = center[0], cy = center[1], cz = center[2];
    const dx = O[0] - cx, dy = O[1] - cy;
    
    // Infinite cylinder intersection in XY plane:
    const A = D[0] * D[0] + D[1] * D[1];
    const B = 2 * (D[0] * dx + D[1] * dy);
    const C = dx * dx + dy * dy - R * R;
    
    let tMin = Infinity;
    
    if (A > 1e-8) {
        const disc = B * B - 4 * A * C;
        if (disc >= 0) {
            const sqrtDisc = Math.sqrt(disc);
            const t1 = (-B - sqrtDisc) / (2 * A);
            const t2 = (-B + sqrtDisc) / (2 * A);
            
            for (const t of [t1, t2]) {
                if (t > 1e-4) {
                    const z = O[2] + t * D[2];
                    if (Math.abs(z - cz) <= H) {
                        if (t < tMin) tMin = t;
                    }
                }
            }
        }
    }
    
    // Caps intersection (z = cz - H and z = cz + H)
    if (Math.abs(D[2]) > 1e-8) {
        const tBottom = (cz - H - O[2]) / D[2];
        if (tBottom > 1e-4 && tBottom < tMin) {
            const x = O[0] + tBottom * D[0];
            const y = O[1] + tBottom * D[1];
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R) {
                tMin = tBottom;
            }
        }
        
        const tTop = (cz + H - O[2]) / D[2];
        if (tTop > 1e-4 && tTop < tMin) {
            const x = O[0] + tTop * D[0];
            const y = O[1] + tTop * D[1];
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R) {
                tMin = tTop;
            }
        }
    }
    
    return tMin === Infinity ? null : tMin;
}

function rayBoxIntersect(
    O: number[], D: number[],
    boxMin: number[], boxMax: number[]
): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;

    for (let i = 0; i < 3; i++) {
        if (Math.abs(D[i]) < 1e-8) {
            if (O[i] < boxMin[i] || O[i] > boxMax[i]) return null;
        } else {
            const invD = 1.0 / D[i];
            let t1 = (boxMin[i] - O[i]) * invD;
            let t2 = (boxMax[i] - O[i]) * invD;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
    }
    if (tmax < 1e-5) return null;
    return tmin > 1e-5 ? tmin : tmax;
}

interface MeshBVH {
    nodeBounds: Float32Array; // 6 floats per node: minX, minY, minZ, maxX, maxY, maxZ
    nodeData: Int32Array;     // 4 ints per node: [leftChild, rightChild, primStart, primCount]
    primIndices: Uint32Array; // permutation array of primitive indices
    nodeCount: number;
}

let stlBVH: MeshBVH | null = null;
let obstacleBVH: MeshBVH | null = null;
const bvhTraversalStack = new Int32Array(512);

function buildMeshBVH(vertices: Float32Array | null, floatsPerPrim: 9 | 12): MeshBVH | null {
    if (!vertices || vertices.length < floatsPerPrim) return null;

    const numPrims = Math.floor(vertices.length / floatsPerPrim);
    if (numPrims === 0) return null;

    const centroids = new Float32Array(numPrims * 3);
    const primBounds = new Float32Array(numPrims * 6);
    const primIndices = new Uint32Array(numPrims);

    const numVerts = (floatsPerPrim === 9) ? 3 : 4;
    const invNumVerts = 1.0 / numVerts;

    for (let i = 0; i < numPrims; i++) {
        primIndices[i] = i;
        const base = i * floatsPerPrim;
        let minX = vertices[base + 0], maxX = vertices[base + 0];
        let minY = vertices[base + 1], maxY = vertices[base + 1];
        let minZ = vertices[base + 2], maxZ = vertices[base + 2];
        let sumX = vertices[base + 0], sumY = vertices[base + 1], sumZ = vertices[base + 2];

        for (let v = 1; v < numVerts; v++) {
            const vx = vertices[base + v * 3 + 0];
            const vy = vertices[base + v * 3 + 1];
            const vz = vertices[base + v * 3 + 2];
            if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
            if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
            sumX += vx; sumY += vy; sumZ += vz;
        }

        centroids[i * 3 + 0] = sumX * invNumVerts;
        centroids[i * 3 + 1] = sumY * invNumVerts;
        centroids[i * 3 + 2] = sumZ * invNumVerts;

        primBounds[i * 6 + 0] = minX; primBounds[i * 6 + 1] = minY; primBounds[i * 6 + 2] = minZ;
        primBounds[i * 6 + 3] = maxX; primBounds[i * 6 + 4] = maxY; primBounds[i * 6 + 5] = maxZ;
    }

    const maxNodes = Math.max(512, numPrims * 2 + 2);
    const nodeBounds = new Float32Array(maxNodes * 6);
    const nodeData = new Int32Array(maxNodes * 4);
    let nodeCount = 0;

    function buildNode(start: number, count: number, depth: number): number {
        const nodeIdx = nodeCount++;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
        let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;

        for (let i = 0; i < count; i++) {
            const pIdx = primIndices[start + i];
            const pb = pIdx * 6;
            if (primBounds[pb + 0] < minX) minX = primBounds[pb + 0];
            if (primBounds[pb + 1] < minY) minY = primBounds[pb + 1];
            if (primBounds[pb + 2] < minZ) minZ = primBounds[pb + 2];
            if (primBounds[pb + 3] > maxX) maxX = primBounds[pb + 3];
            if (primBounds[pb + 4] > maxY) maxY = primBounds[pb + 4];
            if (primBounds[pb + 5] > maxZ) maxZ = primBounds[pb + 5];

            const cx = centroids[pIdx * 3 + 0];
            const cy = centroids[pIdx * 3 + 1];
            const cz = centroids[pIdx * 3 + 2];
            if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
            if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
            if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz;
        }

        const nb = nodeIdx * 6;
        nodeBounds[nb + 0] = minX; nodeBounds[nb + 1] = minY; nodeBounds[nb + 2] = minZ;
        nodeBounds[nb + 3] = maxX; nodeBounds[nb + 4] = maxY; nodeBounds[nb + 5] = maxZ;

        if (count <= 6 || depth >= 22) {
            nodeData[nodeIdx * 4 + 0] = -1;
            nodeData[nodeIdx * 4 + 1] = -1;
            nodeData[nodeIdx * 4 + 2] = start;
            nodeData[nodeIdx * 4 + 3] = count;
            return nodeIdx;
        }

        const extentX = cMaxX - cMinX;
        const extentY = cMaxY - cMinY;
        const extentZ = cMaxZ - cMinZ;
        let splitAxis = 0;
        let splitPos = (cMinX + cMaxX) * 0.5;

        if (extentY > extentX && extentY > extentZ) {
            splitAxis = 1;
            splitPos = (cMinY + cMaxY) * 0.5;
        } else if (extentZ > extentX && extentZ > extentY) {
            splitAxis = 2;
            splitPos = (cMinZ + cMaxZ) * 0.5;
        }

        let i = start;
        let j = start + count - 1;
        while (i <= j) {
            const pIdx = primIndices[i];
            const cVal = centroids[pIdx * 3 + splitAxis];
            if (cVal < splitPos) {
                i++;
            } else {
                const temp = primIndices[i];
                primIndices[i] = primIndices[j];
                primIndices[j] = temp;
                j--;
            }
        }

        let leftCount = i - start;
        if (leftCount === 0 || leftCount === count) {
            leftCount = Math.floor(count / 2);
        }

        const leftChild = buildNode(start, leftCount, depth + 1);
        const rightChild = buildNode(start + leftCount, count - leftCount, depth + 1);

        nodeData[nodeIdx * 4 + 0] = leftChild;
        nodeData[nodeIdx * 4 + 1] = rightChild;
        nodeData[nodeIdx * 4 + 2] = start;
        nodeData[nodeIdx * 4 + 3] = 0;
        return nodeIdx;
    }

    buildNode(0, numPrims, 0);

    return {
        nodeBounds: nodeBounds.subarray(0, nodeCount * 6),
        nodeData: nodeData.subarray(0, nodeCount * 4),
        primIndices,
        nodeCount
    };
}

function rayBoxIntersectCoords(
    Ox: number, Oy: number, Oz: number,
    invDx: number, invDy: number, invDz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number
): number | null {
    let tmin = -Infinity, tmax = Infinity;

    const t1x = (minX - Ox) * invDx;
    const t2x = (maxX - Ox) * invDx;
    tmin = Math.max(tmin, Math.min(t1x, t2x));
    tmax = Math.min(tmax, Math.max(t1x, t2x));

    const t1y = (minY - Oy) * invDy;
    const t2y = (maxY - Oy) * invDy;
    tmin = Math.max(tmin, Math.min(t1y, t2y));
    tmax = Math.min(tmax, Math.max(t1y, t2y));

    const t1z = (minZ - Oz) * invDz;
    const t2z = (maxZ - Oz) * invDz;
    tmin = Math.max(tmin, Math.min(t1z, t2z));
    tmax = Math.min(tmax, Math.max(t1z, t2z));

    if (tmax < 0 || tmin > tmax) return null;
    return tmin >= 0 ? tmin : 0;
}

function raycastBVH(
    bvh: MeshBVH,
    vertices: Float32Array,
    floatsPerPrim: 9 | 12,
    Ox: number, Oy: number, Oz: number,
    Dx: number, Dy: number, Dz: number,
    maxT: number
): number | null {
    const invDx = 1.0 / (Math.abs(Dx) > 1e-9 ? Dx : (Dx < 0 ? -1e-9 : 1e-9));
    const invDy = 1.0 / (Math.abs(Dy) > 1e-9 ? Dy : (Dy < 0 ? -1e-9 : 1e-9));
    const invDz = 1.0 / (Math.abs(Dz) > 1e-9 ? Dz : (Dz < 0 ? -1e-9 : 1e-9));

    let bestT = maxT;
    let stackPtr = 0;
    bvhTraversalStack[stackPtr++] = 0;

    const nodeBounds = bvh.nodeBounds;
    const nodeData = bvh.nodeData;
    const primIndices = bvh.primIndices;

    while (stackPtr > 0) {
        const nodeIdx = bvhTraversalStack[--stackPtr];
        const nb = nodeIdx * 6;
        const boxT = rayBoxIntersectCoords(
            Ox, Oy, Oz, invDx, invDy, invDz,
            nodeBounds[nb + 0], nodeBounds[nb + 1], nodeBounds[nb + 2],
            nodeBounds[nb + 3], nodeBounds[nb + 4], nodeBounds[nb + 5]
        );

        if (boxT === null || boxT >= bestT) continue;

        const count = nodeData[nodeIdx * 4 + 3];
        if (count > 0) {
            const first = nodeData[nodeIdx * 4 + 2];
            for (let i = 0; i < count; i++) {
                const pIdx = primIndices[first + i];
                const base = pIdx * floatsPerPrim;

                const v0x = vertices[base + 0], v0y = vertices[base + 1], v0z = vertices[base + 2];
                const v1x = vertices[base + 3], v1y = vertices[base + 4], v1z = vertices[base + 5];
                const v2x = vertices[base + 6], v2y = vertices[base + 7], v2z = vertices[base + 8];

                const t1 = rayTriangleIntersectCoords(Ox, Oy, Oz, Dx, Dy, Dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z)
                        || rayTriangleIntersectCoords(Ox, Oy, Oz, Dx, Dy, Dz, v0x, v0y, v0z, v2x, v2y, v2z, v1x, v1y, v1z);
                if (t1 !== null && t1 > 1e-4 && t1 < bestT) {
                    bestT = t1;
                }

                if (floatsPerPrim === 12) {
                    const v3x = vertices[base + 9], v3y = vertices[base + 10], v3z = vertices[base + 11];
                    const t2 = rayTriangleIntersectCoords(Ox, Oy, Oz, Dx, Dy, Dz, v0x, v0y, v0z, v2x, v2y, v2z, v3x, v3y, v3z)
                            || rayTriangleIntersectCoords(Ox, Oy, Oz, Dx, Dy, Dz, v0x, v0y, v0z, v3x, v3y, v3z, v2x, v2y, v2z);
                    if (t2 !== null && t2 > 1e-4 && t2 < bestT) {
                        bestT = t2;
                    }
                }
            }
        } else {
            const leftChild = nodeData[nodeIdx * 4 + 0];
            const rightChild = nodeData[nodeIdx * 4 + 1];
            if (leftChild >= 0) bvhTraversalStack[stackPtr++] = leftChild;
            if (rightChild >= 0) bvhTraversalStack[stackPtr++] = rightChild;
        }
    }

    return bestT < maxT ? bestT : null;
}

function distToSegment2D(
    px: number, py: number,
    x0: number, y0: number,
    x1: number, y1: number
): { dist: number, t: number } {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return { dist: Math.hypot(px - x0, py - y0), t: 0 };
    }
    let t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x0 + t * dx;
    const projY = y0 + t * dy;
    return { dist: Math.hypot(px - projX, py - projY), t };
}

function testWireframeEdge(
    v0: number[], v1: number[],
    mvp: Float32Array,
    mouseX: number, mouseY: number,
    width: number, height: number,
    cameraEye: number[],
    maxPixelDist: number = 8.0
): { hitPoint: number[], camDist: number } | null {
    const p0 = projectPoint(v0, mvp, width, height);
    const p1 = projectPoint(v1, mvp, width, height);

    if (p0.w <= 0.01 && p1.w <= 0.01) return null;

    const res = distToSegment2D(mouseX, mouseY, p0.x, p0.y, p1.x, p1.y);
    if (res.dist <= maxPixelDist) {
        const hitPoint = [
            (1.0 - res.t) * v0[0] + res.t * v1[0],
            (1.0 - res.t) * v0[1] + res.t * v1[1],
            (1.0 - res.t) * v0[2] + res.t * v1[2]
        ];
        const camDist = Math.hypot(hitPoint[0] - cameraEye[0], hitPoint[1] - cameraEye[1], hitPoint[2] - cameraEye[2]);
        return { hitPoint, camDist };
    }
    return null;
}

function handleSetRotationCenterFromClick(mouseX: number, mouseY: number, width: number, height: number, screenX?: number, screenY?: number) {
    const hit = raycastScene(mouseX, mouseY, width, height);
    let hitPoint: number[] | null = null;
    let hitLabel = "Selected Point";
    let hitObj: any = null;

    if (hit && hit.hitPoint) {
        hitPoint = hit.hitPoint;
        hitLabel = hit.label || hit.objectType || "Object Surface";
        hitObj = hit;
    } else {
        // Fallback: Check if ray intersects domain bounding box
        const ray = getRayFromScreen(mouseX, mouseY, width, height);
        if (ray) {
            const O = ray.origin;
            const D = ray.dir;
            const sizeX = getDimX();
            const sizeY = getDimY();
            const sizeZ = getDimZ();
            const maxSize = Math.max(sizeX, sizeY, sizeZ);
            const sX = sizeX / maxSize;
            const sY = sizeY / maxSize;
            const sZ = sizeZ / maxSize;
            const domainMin = [-0.5 * sX, -0.5 * sY, -0.5 * sZ];
            const domainMax = [ 0.5 * sX,  0.5 * sY,  0.5 * sZ];
            const tBox = rayBoxIntersect(O, D, domainMin, domainMax);
            if (tBox !== null && tBox > 1e-4) {
                hitPoint = [O[0] + tBox * D[0], O[1] + tBox * D[1], O[2] + tBox * D[2]];
                hitLabel = "Domain Boundary";
            }
        }
    }

    if (hitPoint) {
        pivotX = hitPoint[0];
        pivotY = hitPoint[1];
        pivotZ = hitPoint[2];
        hasCustomPivot = true;

        // NOTE: We do NOT change targetX, targetY, targetZ or distance or pitch or yaw!
        // The view framing and center of view in the viewport remain completely unchanged.

        if (hitObj) {
            selectedObject = hitObj;
            self.postMessage({
                type: 'objectPicked',
                data: {
                    hit: true,
                    ...hitObj,
                    screenX: screenX ?? 0,
                    screenY: screenY ?? 0,
                    button: 0
                }
            });
        }

        self.postMessage({
            type: 'rotationCenterSet',
            data: {
                x: pivotX,
                y: pivotY,
                z: pivotZ,
                label: hitLabel
            }
        });

        requestRender();
    }
}

function buildComponentHighlightGeometry(obj: any): Float32Array {
    if (!obj || !obj.objectType) return new Float32Array(0);
    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();

    const lines: number[] = [];

    function addLine(p1: number[], p2: number[]) {
        lines.push(p1[0], p1[1], p1[2], 0.0, 0.0);
        lines.push(p2[0], p2[1], p2[2], 0.0, 0.0);
    }

    function physToNorm(x: number, y: number, z: number): number[] {
        return [
            normX(x),
            normY(y),
            normZ(z)
        ];
    }

    function addCornerBrackets(bMin: number[], bMax: number[], bracketFraction: number = 0.18) {
        const x0 = bMin[0], y0 = bMin[1], z0 = bMin[2];
        const x1 = bMax[0], y1 = bMax[1], z1 = bMax[2];
        const dx = (x1 - x0) * bracketFraction;
        const dy = (y1 - y0) * bracketFraction;
        const dz = (z1 - z0) * bracketFraction;

        const xs = [x0, x1];
        const ys = [y0, y1];
        const zs = [z0, z1];

        for (let ix = 0; ix < 2; ix++) {
            const x = xs[ix];
            const dirX = ix === 0 ? 1 : -1;
            for (let iy = 0; iy < 2; iy++) {
                const y = ys[iy];
                const dirY = iy === 0 ? 1 : -1;
                for (let iz = 0; iz < 2; iz++) {
                    const z = zs[iz];
                    const dirZ = iz === 0 ? 1 : -1;

                    // 3 orthogonal bracket arms radiating from the corner
                    addLine([x, y, z], [x + dirX * dx, y, z]);
                    addLine([x, y, z], [x, y + dirY * dy, z]);
                    addLine([x, y, z], [x, y, z + dirZ * dz]);
                }
            }
        }
    }

    function addCircleRing(center: number[], radiusMeters: number, normalAxis: number, segments: number = 48) {
        let prev: number[] | null = null;
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const ca = Math.cos(angle) * radiusMeters;
            const sa = Math.sin(angle) * radiusMeters;
            let pt: number[];
            if (normalAxis === 0) { // X normal (YZ plane)
                pt = [center[0], center[1] + ca / sizeY, center[2] + sa / sizeZ];
            } else if (normalAxis === 1) { // Y normal (XZ plane)
                pt = [center[0] + ca / sizeX, center[1], center[2] + sa / sizeZ];
            } else { // Z normal (XY plane)
                pt = [center[0] + ca / sizeX, center[1] + sa / sizeY, center[2]];
            }
            if (prev) {
                addLine(prev, pt);
            }
            prev = pt;
        }
    }

    function addCleanCylinderWireframe(center: number[], radiusMeters: number, heightMeters: number, normalAxis: number = 2, segments: number = 48, numGenerators: number = 12) {
        const halfH = heightMeters * 0.5;
        let topCenter: number[], botCenter: number[];

        if (normalAxis === 0) { // X-axis cylinder
            topCenter = [center[0] + halfH / sizeX, center[1], center[2]];
            botCenter = [center[0] - halfH / sizeX, center[1], center[2]];
            addCircleRing(topCenter, radiusMeters, 0, segments);
            addCircleRing(botCenter, radiusMeters, 0, segments);

            for (let i = 0; i < numGenerators; i++) {
                const angle = (i / numGenerators) * Math.PI * 2;
                const cy = (Math.cos(angle) * radiusMeters) / sizeY;
                const cz = (Math.sin(angle) * radiusMeters) / sizeZ;
                addLine([topCenter[0], topCenter[1] + cy, topCenter[2] + cz], [botCenter[0], botCenter[1] + cy, botCenter[2] + cz]);
            }
        } else if (normalAxis === 1) { // Y-axis cylinder
            topCenter = [center[0], center[1] + halfH / sizeY, center[2]];
            botCenter = [center[0], center[1] - halfH / sizeY, center[2]];
            addCircleRing(topCenter, radiusMeters, 1, segments);
            addCircleRing(botCenter, radiusMeters, 1, segments);

            for (let i = 0; i < numGenerators; i++) {
                const angle = (i / numGenerators) * Math.PI * 2;
                const cx = (Math.cos(angle) * radiusMeters) / sizeX;
                const cz = (Math.sin(angle) * radiusMeters) / sizeZ;
                addLine([topCenter[0] + cx, topCenter[1], topCenter[2] + cz], [botCenter[0] + cx, botCenter[1], botCenter[2] + cz]);
            }
        } else { // Z-axis cylinder (standard)
            topCenter = [center[0], center[1], center[2] + halfH / sizeZ];
            botCenter = [center[0], center[1], center[2] - halfH / sizeZ];
            addCircleRing(topCenter, radiusMeters, 2, segments);
            addCircleRing(botCenter, radiusMeters, 2, segments);

            for (let i = 0; i < numGenerators; i++) {
                const angle = (i / numGenerators) * Math.PI * 2;
                const cx = (Math.cos(angle) * radiusMeters) / sizeX;
                const cy = (Math.sin(angle) * radiusMeters) / sizeY;
                addLine([topCenter[0] + cx, topCenter[1] + cy, topCenter[2]], [botCenter[0] + cx, botCenter[1] + cy, botCenter[2]]);
            }
        }
    }

    function addCleanSphereWireframe(center: number[], radiusMeters: number, segments: number = 48) {
        addCircleRing(center, radiusMeters, 0, segments); // YZ
        addCircleRing(center, radiusMeters, 1, segments); // XZ
        addCircleRing(center, radiusMeters, 2, segments); // XY
        // Extra latitude rings for volumetric depth
        const r45 = radiusMeters * Math.SQRT1_2;
        const offZ = (radiusMeters * Math.SQRT1_2) / sizeZ;
        addCircleRing([center[0], center[1], center[2] + offZ], r45, 2, 36);
        addCircleRing([center[0], center[1], center[2] - offZ], r45, 2, 36);
    }

    function addCleanBoxWireframe(bMin: number[], bMax: number[]) {
        const x0 = bMin[0], y0 = bMin[1], z0 = bMin[2];
        const x1 = bMax[0], y1 = bMax[1], z1 = bMax[2];

        // 12 boundary edges of the box
        addLine([x0, y0, z0], [x1, y0, z0]);
        addLine([x1, y0, z0], [x1, y1, z0]);
        addLine([x1, y1, z0], [x0, y1, z0]);
        addLine([x0, y1, z0], [x0, y0, z0]);

        addLine([x0, y0, z1], [x1, y0, z1]);
        addLine([x1, y0, z1], [x1, y1, z1]);
        addLine([x1, y1, z1], [x0, y1, z1]);
        addLine([x0, y1, z1], [x0, y0, z1]);

        addLine([x0, y0, z0], [x0, y0, z1]);
        addLine([x1, y0, z0], [x1, y0, z1]);
        addLine([x1, y1, z0], [x1, y1, z1]);
        addLine([x0, y1, z0], [x0, y1, z1]);
    }

    function addMPMParticleHighlights(targetObjIdx: number): boolean {
        if (!latestMPMParticlesData || latestMPMParticlesData.length === 0) return false;
        const stride = (latestMPMParticlesData.length % 14 === 0) ? 14 : ((latestMPMParticlesData.length % 13 === 0) ? 13 : (latestMPMFloatsPerParticle || 14));
        const nParticles = Math.floor(latestMPMParticlesData.length / stride);
        if (nParticles === 0) return false;

        const pPerDim = Math.max(1, Math.round(Math.cbrt(ppc || 8)));
        const autoDiam = (latestEmpiricalSpacing > 0) ? (latestEmpiricalSpacing * 0.8) : (((dx || 0.001) / pPerDim) * 0.8);
        const pDiam = (mpmParticleDiameter !== undefined && mpmParticleDiameter > 0) ? mpmParticleDiameter : autoDiam;
        const halfD = Math.max(1e-5, pDiam * 0.65);
        const rNormX = halfD / sizeX;
        const rNormY = halfD / sizeY;
        const rNormZ = halfD / sizeZ;

        const hasMultipleObjects = (mpmObjectsData && mpmObjectsData.length > 1);
        const targetStr1 = String(targetObjIdx);
        const targetStr2 = String(targetObjIdx + 1);

        let matched = 0;
        const step = nParticles > 20000 ? Math.ceil(nParticles / 10000) : 1;

        for (let i = 0; i < nParticles; i += step) {
            const base = i * stride;
            if (hasMultipleObjects) {
                const pObjId = latestMPMParticlesData[base + 12] !== undefined ? String(Math.round(latestMPMParticlesData[base + 12])) : undefined;
                if (pObjId !== undefined && pObjId !== targetStr1 && pObjId !== targetStr2) {
                    continue;
                }
            }

            const px = latestMPMParticlesData[base + 0];
            const py = latestMPMParticlesData[base + 1];
            const pz = latestMPMParticlesData[base + 2];
            const nx = normX(px);
            const ny = normY(py);
            const nz = normZ(pz);

            // Draw tight perimeter circle ring directly on each active particle
            const segs = 8;
            let prev: number[] | null = null;
            for (let s = 0; s <= segs; s++) {
                const ang = (s / segs) * Math.PI * 2;
                const ca = Math.cos(ang) * rNormX * 1.15;
                const sa = Math.sin(ang) * rNormY * 1.15;
                const pt = [nx + ca, ny + sa, nz];
                if (prev) addLine(prev, pt);
                prev = pt;
            }

            // Crosshair tick marks on particle
            addLine([nx - rNormX * 1.2, ny, nz], [nx + rNormX * 1.2, ny, nz]);
            addLine([nx, ny - rNormY * 1.2, nz], [nx, ny + rNormY * 1.2, nz]);
            addLine([nx, ny, nz - rNormZ * 1.2], [nx, ny, nz + rNormZ * 1.2]);
            matched++;
        }

        return matched > 0;
    }

    function addFEMMeshHighlights(): boolean {
        if (!latestFEMNodesData || !latestFEMFacetsData || latestFEMNodesData.length === 0 || latestFEMFacetsData.length === 0) return false;
        const nNodes = Math.floor(latestFEMNodesData.length / 7);
        const nFacets = Math.floor(latestFEMFacetsData.length / 8);
        if (nNodes === 0 || nFacets === 0) return false;

        // Extract unique exterior boundary edges across all non-eroded facets
        const edgeMap = new Map<number, { n0: number, n1: number, count: number }>();

        function registerEdge(na: number, nb: number) {
            if (na < 0 || nb < 0 || na >= nNodes || nb >= nNodes) return;
            const minN = na < nb ? na : nb;
            const maxN = na < nb ? nb : na;
            const key = minN * 10000000 + maxN;
            const existing = edgeMap.get(key);
            if (existing) {
                existing.count++;
            } else {
                edgeMap.set(key, { n0: minN, n1: maxN, count: 1 });
            }
        }

        for (let f = 0; f < nFacets; f++) {
            const base = f * 8;
            const isEroded = (latestFEMFacetsData[base + 7] > 0.5 || latestFEMFacetsData[base + 5] > 0.5);
            if (isEroded) continue;
            const n0 = Math.round(latestFEMFacetsData[base + 0]);
            const n1 = Math.round(latestFEMFacetsData[base + 1]);
            const n2 = Math.round(latestFEMFacetsData[base + 2]);
            const n3 = Math.round(latestFEMFacetsData[base + 3]);

            if (n2 < 0 || n3 < 0) {
                // Line / Beam / Rebar element
                registerEdge(n0, n1);
            } else if (n3 < 0) {
                // Triangle
                registerEdge(n0, n1);
                registerEdge(n1, n2);
                registerEdge(n2, n0);
            } else {
                // Quad
                registerEdge(n0, n1);
                registerEdge(n1, n2);
                registerEdge(n2, n3);
                registerEdge(n3, n0);
            }
        }

        let edgeCount = 0;
        for (const edge of edgeMap.values()) {
            const p0 = physToNorm(latestFEMNodesData[edge.n0 * 7 + 0], latestFEMNodesData[edge.n0 * 7 + 1], latestFEMNodesData[edge.n0 * 7 + 2]);
            const p1 = physToNorm(latestFEMNodesData[edge.n1 * 7 + 0], latestFEMNodesData[edge.n1 * 7 + 1], latestFEMNodesData[edge.n1 * 7 + 2]);
            addLine(p0, p1);
            edgeCount++;
        }

        return edgeCount > 0;
    }

    const { objectType, objectId, sliceIndex, gaugeIndex } = obj;

    if (objectType === 'Slice' || objectType === 'Slice3D') {
        const idx = sliceIndex ?? 0;
        const slice = (idx >= 0 && cachedSlices && idx < cachedSlices.length)
            ? cachedSlices[idx]
            : (slicesConfigCache && slicesConfigCache[idx] ? slicesConfigCache[idx] : null);
        const axis = (slice?.axis === 'yz' || slice?.axis === 2 || String(slice?.axis).toLowerCase() === 'yz') ? 2 : ((slice?.axis === 'xz' || slice?.axis === 1 || String(slice?.axis).toLowerCase() === 'xz') ? 1 : 0);
        const offset = Number(slice?.offset ?? (axis === 0 ? (zmin + sizeZ * 0.5) : axis === 1 ? (ymin + sizeY * 0.5) : (xmin + sizeX * 0.5)));

        const x0 = slice?.xmin !== undefined ? normX(slice.xmin) : -0.5;
        const x1 = slice?.xmax !== undefined ? normX(slice.xmax) : 0.5;
        const y0 = slice?.ymin !== undefined ? normY(slice.ymin) : -0.5;
        const y1 = slice?.ymax !== undefined ? normY(slice.ymax) : 0.5;
        const z0 = slice?.zmin !== undefined ? normZ(slice.zmin) : -0.5;
        const z1 = slice?.zmax !== undefined ? normZ(slice.zmax) : 0.5;

        let v0: number[], v1: number[], v2: number[], v3: number[];
        let normal: number[];
        if (axis === 0) { // XY plane (Normal Z)
            const z = normZ(offset);
            v0 = [x0, y0, z];
            v1 = [x1, y0, z];
            v2 = [x1, y1, z];
            v3 = [x0, y1, z];
            normal = [0, 0, 1];
        } else if (axis === 1) { // XZ plane (Normal Y)
            const y = normY(offset);
            v0 = [x0, y, z0];
            v1 = [x1, y, z0];
            v2 = [x1, y, z1];
            v3 = [x0, y, z1];
            normal = [0, 1, 0];
        } else { // YZ plane (Normal X)
            const x = normX(offset);
            v0 = [x, y0, z0];
            v1 = [x, y1, z0];
            v2 = [x, y1, z1];
            v3 = [x, y0, z1];
            normal = [1, 0, 0];
        }

        // Perimeter frame directly on the slice plane
        addLine(v0, v1); addLine(v1, v2); addLine(v2, v3); addLine(v3, v0);

        // 4 Corner L-Brackets for crisp CAD silhouette reticles
        const cornerFrac = 0.12;
        const e01 = [v1[0] - v0[0], v1[0] - v0[0] !== 0 ? v1[1] - v0[1] : v1[1] - v0[1], v1[2] - v0[2]];
        const e12 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
        const e23 = [v3[0] - v2[0], v3[1] - v2[1], v3[2] - v2[2]];
        const e30 = [v0[0] - v3[0], v0[1] - v3[1], v0[2] - v3[2]];

        addLine(v0, [v0[0] + e01[0] * cornerFrac, v0[1] + e01[1] * cornerFrac, v0[2] + e01[2] * cornerFrac]);
        addLine(v0, [v0[0] - e30[0] * cornerFrac, v0[1] - e30[1] * cornerFrac, v0[2] - e30[2] * cornerFrac]);

        addLine(v1, [v1[0] - e01[0] * cornerFrac, v1[1] - e01[1] * cornerFrac, v1[2] - e01[2] * cornerFrac]);
        addLine(v1, [v1[0] + e12[0] * cornerFrac, v1[1] + e12[1] * cornerFrac, v1[2] + e12[2] * cornerFrac]);

        addLine(v2, [v2[0] - e12[0] * cornerFrac, v2[1] - e12[1] * cornerFrac, v2[2] - e12[2] * cornerFrac]);
        addLine(v2, [v2[0] + e23[0] * cornerFrac, v2[1] + e23[1] * cornerFrac, v2[2] + e23[2] * cornerFrac]);

        addLine(v3, [v3[0] - e23[0] * cornerFrac, v3[1] - e23[1] * cornerFrac, v3[2] - e23[2] * cornerFrac]);
        addLine(v3, [v3[0] + e30[0] * cornerFrac, v3[1] + e30[1] * cornerFrac, v3[2] + e30[2] * cornerFrac]);

        // Center crosshair and normal vector pointer
        const cx = (v0[0] + v1[0] + v2[0] + v3[0]) * 0.25;
        const cy = (v0[1] + v1[1] + v2[1] + v3[1]) * 0.25;
        const cz = (v0[2] + v1[2] + v2[2] + v3[2]) * 0.25;
        const center = [cx, cy, cz];
        const reticleFrac = 0.05;
        addLine([cx - e01[0] * reticleFrac, cy - e01[1] * reticleFrac, cz - e01[2] * reticleFrac], [cx + e01[0] * reticleFrac, cy + e01[1] * reticleFrac, cz + e01[2] * reticleFrac]);
        addLine([cx - e12[0] * reticleFrac, cy - e12[1] * reticleFrac, cz - e12[2] * reticleFrac], [cx + e12[0] * reticleFrac, cy + e12[1] * reticleFrac, cz + e12[2] * reticleFrac]);

        const nLen = 0.10;
        const nTip = [cx + normal[0] * nLen, cy + normal[1] * nLen, cz + normal[2] * nLen];
        addLine(center, nTip);

    } else if (objectType === 'Charge3D' || objectType === 'Charge' || objectType === 'ExplosiveMaterial' || objectType === 'Charge2D') {
        const cx = Number(obj.charge_x ?? obj.pos_x ?? obj.x ?? chargeData?.x ?? (xmin + sizeX * 0.5));
        const cy = Number(obj.charge_y ?? obj.pos_y ?? obj.y ?? chargeData?.y ?? (ymin + sizeY * 0.5));
        const cz = Number(obj.charge_z ?? obj.pos_z ?? obj.z ?? chargeData?.z ?? (zmin + sizeZ * 0.5));
        const center = physToNorm(cx, cy, cz);
        const shape = obj.shape || obj.shape_type || obj.charge_shape || chargeData?.shape || 'Sphere';

        if (shape === 'Block' || shape === 'Box') {
            const lx = Number(obj.charge_lx ?? obj.size_x ?? obj.lx ?? chargeData?.lx ?? 0.2);
            const ly = Number(obj.charge_ly ?? obj.size_y ?? obj.ly ?? chargeData?.ly ?? 0.2);
            const lz = Number(obj.charge_lz ?? obj.size_z ?? obj.lz ?? chargeData?.lz ?? 0.2);
            const deg2rad = Math.PI / 180.0;
            const ax = Number(obj.charge_rot_x ?? obj.rot_x ?? chargeData?.rot_x ?? 0.0) * deg2rad;
            const ay = Number(obj.charge_rot_y ?? obj.rot_y ?? chargeData?.rot_y ?? 0.0) * deg2rad;
            const az = Number(obj.charge_rot_z ?? obj.rot_z ?? chargeData?.rot_z ?? 0.0) * deg2rad;
            if (ax === 0 && ay === 0 && az === 0) {
                const boxMin = [
                    center[0] - (lx * 0.5) / sizeX,
                    center[1] - (ly * 0.5) / sizeY,
                    center[2] - (lz * 0.5) / sizeZ
                ];
                const boxMax = [
                    center[0] + (lx * 0.5) / sizeX,
                    center[1] + (ly * 0.5) / sizeY,
                    center[2] + (lz * 0.5) / sizeZ
                ];
                addCleanBoxWireframe(boxMin, boxMax);
            } else {
                const wire = getRotatedBoxWireframeVertices(center[0], center[1], center[2], lx, ly, lz, ax, ay, az, sizeX, sizeY, sizeZ);
                lines.push(...wire);
            }
        } else if (shape === 'Cylinder') {
            const r = Number(obj.charge_radius ?? obj.radius ?? chargeData?.radius ?? 0.1);
            const h = Number(obj.charge_height ?? obj.height ?? chargeData?.height ?? 0.2);
            addCleanCylinderWireframe(center, r, h, 2, 48, 12);
        } else {
            const r = Number(obj.charge_radius ?? obj.radius ?? chargeData?.radius ?? 0.1);
            addCleanSphereWireframe(center, r, 48);
        }
    } else if (objectType === 'DetonatorLocation3D' || objectType === 'Detonator') {
        const dxCoord = Number(obj.det_x ?? obj.pos_x ?? obj.x ?? chargeData?.det_x ?? (xmin + sizeX * 0.5));
        const dyCoord = Number(obj.det_y ?? obj.pos_y ?? obj.y ?? chargeData?.det_y ?? (ymin + sizeY * 0.5));
        const dzCoord = Number(obj.det_z ?? obj.pos_z ?? obj.z ?? chargeData?.det_z ?? (zmin + sizeZ * 0.5));
        const center = physToNorm(dxCoord, dyCoord, dzCoord);
        const dPhys = Math.max(0.002, Math.min(sizeX, sizeY, sizeZ) * 0.035);
        const dxNorm = dPhys / sizeX;
        const dyNorm = dPhys / sizeY;
        const dzNorm = dPhys / sizeZ;

        // Clean 3D Diamond Octahedron
        const top = [center[0], center[1], center[2] + dzNorm];
        const bot = [center[0], center[1], center[2] - dzNorm];
        const px = [center[0] + dxNorm, center[1], center[2]];
        const nx = [center[0] - dxNorm, center[1], center[2]];
        const py = [center[0], center[1] + dyNorm, center[2]];
        const ny = [center[0], center[1] - dyNorm, center[2]];
        addLine(top, px); addLine(top, nx); addLine(top, py); addLine(top, ny);
        addLine(bot, px); addLine(bot, nx); addLine(bot, py); addLine(bot, ny);
        addLine(px, py); addLine(py, nx); addLine(nx, ny); addLine(ny, px);

        // Horizontal compass ring
        addCircleRing(center, dPhys * 1.3, 2, 32);

        // Ground drop-line down to floor z = -0.5
        const floorPt = [center[0], center[1], -0.5];
        addLine(center, floorPt);
        // Small ground target diamond at floor
        const grNormX = dxNorm * 0.5;
        const grNormY = dyNorm * 0.5;
        addLine([floorPt[0] + grNormX, floorPt[1], -0.5], [floorPt[0], floorPt[1] + grNormY, -0.5]);
        addLine([floorPt[0], floorPt[1] + grNormY, -0.5], [floorPt[0] - grNormX, floorPt[1], -0.5]);
        addLine([floorPt[0] - grNormX, floorPt[1], -0.5], [floorPt[0], floorPt[1] - grNormY, -0.5]);
        addLine([floorPt[0], floorPt[1] - grNormY, -0.5], [floorPt[0] + grNormX, floorPt[1], -0.5]);

    } else if (objectType === 'VirtualGauges3D' || objectType === 'VirtualGauges' || objectType === 'PressureGauge' || objectType === 'VirtualGauge') {
        let gx = Number(obj.x ?? (xmin + sizeX * 0.5));
        let gy = Number(obj.y ?? (ymin + sizeY * 0.5));
        let gz = Number(obj.z ?? (zmin + sizeZ * 0.5));
        if (gaugesList && gaugesList.length > 0) {
            const g = (gaugeIndex !== undefined && gaugesList[gaugeIndex]) ? gaugesList[gaugeIndex] : (objectId ? gaugesList.find((x: any) => x.id === objectId) : gaugesList[0]);
            if (g) {
                gx = Number(g.x ?? gx);
                gy = Number(g.y ?? gy);
                gz = Number(g.z ?? gz);
            }
        }
        const center = physToNorm(gx, gy, gz);
        const mult = (gaugeSize > 0) ? gaugeSize : 1.0;
        const cellMeters = (dx && dx > 0) ? dx : 0.01;
        const rPhysical = mult * cellMeters * 0.5;

        // Clean probe sphere
        addCleanSphereWireframe(center, rPhysical, 32);
        // Ground drop-line down to floor z = -0.5
        const floorPt = [center[0], center[1], -0.5];
        addLine(center, floorPt);
        addCircleRing(floorPt, rPhysical * 0.7, 2, 24);

    } else if (objectType === 'MPMObject3D' || objectType === 'MPMObject2D') {
        const objIndex = (objectId !== undefined && mpmObjectsData)
            ? mpmObjectsData.findIndex((o: any) => o.id === objectId || String(o.id) === String(objectId))
            : -1;
        const objDef = (objIndex >= 0 && mpmObjectsData)
            ? mpmObjectsData[objIndex]
            : ((objectId !== undefined && !isNaN(Number(objectId)) && mpmObjectsData && mpmObjectsData[Math.round(Number(objectId))])
                ? mpmObjectsData[Math.round(Number(objectId))]
                : (mpmObjectsData && mpmObjectsData.length > 0 ? mpmObjectsData[0] : null));

        // When particles exist during simulation, highlight the moving/deforming particles directly!
        let particlesHighlighted = false;
        if (latestMPMParticlesData && latestMPMParticlesData.length > 0) {
            particlesHighlighted = addMPMParticleHighlights(objIndex >= 0 ? objIndex : 0);
        }

        // When uninitialized (step 0), highlight the exact CAD geometry wireframe directly on the object surface
        if (!particlesHighlighted) {
            const shape = obj.shape || obj.shape_type || objDef?.shape || objDef?.shape_type || 'Box';
            const cx = Number(obj.pos_x ?? obj.x ?? objDef?.pos_x ?? objDef?.x ?? (xmin + sizeX * 0.5));
            const cy = Number(obj.pos_y ?? obj.y ?? objDef?.pos_y ?? objDef?.y ?? (ymin + sizeY * 0.5));
            const cz = Number(obj.pos_z ?? obj.z ?? objDef?.pos_z ?? objDef?.z ?? (zmin + sizeZ * 0.5));
            const r = Number(obj.radius ?? objDef?.radius ?? 0.1);
            const h = Number(obj.height ?? objDef?.height ?? 0.2);
            const lx = Number(obj.size_x ?? obj.lx ?? objDef?.size_x ?? 0.2);
            const ly = Number(obj.size_y ?? obj.ly ?? objDef?.size_y ?? 0.2);
            const lz = Number(obj.size_z ?? obj.lz ?? objDef?.size_z ?? 0.2);

            const center = physToNorm(cx, cy, cz);

            if (shape === 'Cylinder') {
                addCleanCylinderWireframe(center, r, h, 2, 48, 16);
            } else if (shape === 'Sphere' || shape === 'Circle') {
                addCleanSphereWireframe(center, r, 48);
            } else if (shape === 'STL' && rawSTLVertices && rawSTLVertices.length >= 9) {
                const numTris = Math.floor(rawSTLVertices.length / 9);
                const step = numTris > 12000 ? Math.ceil(numTris / 8000) : 1;
                for (let t = 0; t < numTris; t += step) {
                    const b = t * 9;
                    const p0 = physToNorm(rawSTLVertices[b + 0], rawSTLVertices[b + 1], rawSTLVertices[b + 2]);
                    const p1 = physToNorm(rawSTLVertices[b + 3], rawSTLVertices[b + 4], rawSTLVertices[b + 5]);
                    const p2 = physToNorm(rawSTLVertices[b + 6], rawSTLVertices[b + 7], rawSTLVertices[b + 8]);
                    addLine(p0, p1); addLine(p1, p2); addLine(p2, p0);
                }
            } else {
                const boxMin = [
                    center[0] - (lx * 0.5) / sizeX,
                    center[1] - (ly * 0.5) / sizeY,
                    center[2] - (lz * 0.5) / sizeZ
                ];
                const boxMax = [
                    center[0] + (lx * 0.5) / sizeX,
                    center[1] + (ly * 0.5) / sizeY,
                    center[2] + (lz * 0.5) / sizeZ
                ];
                addCleanBoxWireframe(boxMin, boxMax);
            }
        }
    } else if (objectType === 'FEMObject3D' || objectType === 'FEMMesh3D' || objectType === 'FEMBeam3D' || objectType === 'FEMRebar3D' || objectType === 'LSDynaImporter3D') {
        // When FEM mesh exists during simulation, highlight deformed element edges directly!
        let femMeshHighlighted = false;
        if (latestFEMNodesData && latestFEMFacetsData && latestFEMNodesData.length > 0 && latestFEMFacetsData.length > 0) {
            femMeshHighlighted = addFEMMeshHighlights();
        }

        if (!femMeshHighlighted) {
            const shape = obj.shape || obj.shape_type || obj.mesh_source || 'Box';
            const cx = Number(obj.pos_x ?? obj.x ?? (xmin + sizeX * 0.5));
            const cy = Number(obj.pos_y ?? obj.y ?? (ymin + sizeY * 0.5));
            const cz = Number(obj.pos_z ?? obj.z ?? (zmin + sizeZ * 0.5));
            const r = Number(obj.radius ?? 0.1);
            const h = Number(obj.height ?? 0.2);
            const lx = Number(obj.size_x ?? obj.lx ?? 0.2);
            const ly = Number(obj.size_y ?? obj.ly ?? 0.2);
            const lz = Number(obj.size_z ?? obj.lz ?? 0.2);
            const center = physToNorm(cx, cy, cz);

            if (shape === 'Cylinder' || shape === 'Cylinder Generator') {
                addCleanCylinderWireframe(center, r, h, 2, 48, 16);
            } else if (shape === 'Sphere') {
                addCleanSphereWireframe(center, r, 48);
            } else {
                const boxMin = [
                    center[0] - (lx * 0.5) / sizeX,
                    center[1] - (ly * 0.5) / sizeY,
                    center[2] - (lz * 0.5) / sizeZ
                ];
                const boxMax = [
                    center[0] + (lx * 0.5) / sizeX,
                    center[1] + (ly * 0.5) / sizeY,
                    center[2] + (lz * 0.5) / sizeZ
                ];
                addCleanBoxWireframe(boxMin, boxMax);
            }
        }
    } else if (objectType === 'STLGeometry') {
        // STL 3D mesh surface is highlighted with holographic Fresnel rim in renderObjectSurfaceHighlight
        // No bounding box wireframes
    } else if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
        const shape = obj.shape || obj.shape_type || 'Box';
        const cx = Number(obj.pos_x ?? obj.x ?? (xmin + sizeX * 0.5));
        const cy = Number(obj.pos_y ?? obj.y ?? (ymin + sizeY * 0.5));
        const cz = Number(obj.pos_z ?? obj.z ?? (zmin + sizeZ * 0.5));
        const center = physToNorm(cx, cy, cz);
        if (shape === 'Cylinder') {
            const r = Number(obj.radius ?? 0.1);
            const h = Number(obj.height ?? 0.2);
            addCleanCylinderWireframe(center, r, h, 2, 48, 16);
        } else if (shape === 'Sphere') {
            const r = Number(obj.radius ?? 0.1);
            addCleanSphereWireframe(center, r, 48);
        } else if (!rawObstacleVertices || rawObstacleVertices.length === 0) {
            const lx = Number(obj.size_x ?? obj.lx ?? 0.2);
            const ly = Number(obj.size_y ?? obj.ly ?? 0.2);
            const lz = Number(obj.size_z ?? obj.lz ?? 0.2);
            const boxMin = [
                center[0] - (lx * 0.5) / sizeX,
                center[1] - (ly * 0.5) / sizeY,
                center[2] - (lz * 0.5) / sizeZ
            ];
            const boxMax = [
                center[0] + (lx * 0.5) / sizeX,
                center[1] + (ly * 0.5) / sizeY,
                center[2] + (lz * 0.5) / sizeZ
            ];
            addCleanBoxWireframe(boxMin, boxMax);
        }
    } else if (
        objectType === 'DomainMesh3D' ||
        objectType === 'DomainMesh' ||
        objectType === 'CFDSolver3D' ||
        objectType === 'MPMDomain3D' ||
        objectType === 'MPMDomain' ||
        objectType === 'FEMDomain3D' ||
        objectType === 'FSICoupler3D' ||
        objectType === 'FEMFSICoupler3D'
    ) {
        // Coordinate axis origin triad at [x0, y0, z0] = [-0.5, -0.5, -0.5]
        const origin = [-0.5, -0.5, -0.5];
        const axisLen = 0.25;
        addLine(origin, [origin[0] + axisLen, origin[1], origin[2]]);
        addLine(origin, [origin[0], origin[1] + axisLen, origin[2]]);
        addLine(origin, [origin[0], origin[1], origin[2] + axisLen]);

        // Small origin anchor cube at the base coordinate origin
        const oBox = 0.02;
        addCleanBoxWireframe(
            [origin[0], origin[1], origin[2]],
            [origin[0] + oBox, origin[1] + oBox, origin[2] + oBox]
        );
    }

    return new Float32Array(lines);
}

function raycastScene(mouseX: number, mouseY: number, width: number, height: number) {
    const ray = getRayFromScreen(mouseX, mouseY, width, height);
    if (!ray) return null;

    const O = ray.origin;
    const D = ray.dir;

    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
    const maxSize = Math.max(sizeX, sizeY, sizeZ);
    const sX = sizeX / maxSize;
    const sY = sizeY / maxSize;
    const sZ = sizeZ / maxSize;

    function physToWorld(x: number, y: number, z: number): number[] {
        return [
            normX(x) * sX,
            normY(y) * sY,
            normZ(z) * sZ
        ];
    }

    // =========================================================================
    // PASS 1: Discrete 3D Physical Entities (Gauges, Detonator, Obstacles, STL, Charges, MPM, FEM)
    // 3D physical solids ALWAYS take precedence over 2D planar cutting slices!
    // =========================================================================
    let solidHit: {
        t: number;
        hitPoint: number[];
        objectType: string;
        objectId?: string;
        sliceIndex?: number;
        gaugeIndex?: number;
        label?: string;
    } | null = null;
    let minSolidT = Infinity;

    // 1. Virtual Sensor Gauges (Point Probes)
    if (showGauges && gaugesList && gaugesList.length > 0) {
        const mult = (gaugeSize > 0) ? gaugeSize : 1.0;
        const cellMeters = (dx && dx > 0) ? dx : 0.01;
        const radiusMeters = mult * cellMeters * 0.5;
        const rWorld = Math.max(radiusMeters / maxSize, 0.015);

        gaugesList.forEach((g: any, gIdx: number) => {
            const gx = Number(g.x ?? 0.0);
            const gy = Number(g.y ?? 0.0);
            const gz = Number(g.z ?? 0.0);
            const center = physToWorld(gx, gy, gz);
            const t = raySphereIntersect(O, D, center, rWorld);
            if (t !== null && t > 1e-4 && t < minSolidT) {
                minSolidT = t;
                solidHit = {
                    t,
                    hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                    objectType: 'VirtualGauges3D',
                    objectId: g.id || `gauge_${gIdx}`,
                    gaugeIndex: gIdx,
                    label: `Gauge ${g.id || '#' + (gIdx + 1)}`
                };
            }
        });
    }

    // 2. Detonator Location Points
    if (showDetonators) {
        if (detonatorsList && detonatorsList.length > 0) {
            detonatorsList.forEach((d: any, dIdx: number) => {
                const dxCoord = Number(d.x ?? (xmin + sizeX * 0.5));
                const dyCoord = Number(d.y ?? (ymin + sizeY * 0.5));
                const dzCoord = Number(d.z ?? (zmin + sizeZ * 0.5));
                const center = physToWorld(dxCoord, dyCoord, dzCoord);
                const dRadius = Number(d.radius ?? 0.01);
                const rWorld = Math.max(dRadius / maxSize, 0.02 * detonatorSize);
                const t = raySphereIntersect(O, D, center, rWorld);
                if (t !== null && t > 1e-4 && t < minSolidT) {
                    minSolidT = t;
                    solidHit = {
                        t,
                        hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                        objectType: 'DetonatorLocation3D',
                        objectId: d.id || `det_${dIdx}`,
                        label: `Detonator ${d.id || '#' + (dIdx + 1)}`
                    };
                }
            });
        } else if (chargeData && (chargeData.det_x !== undefined || chargeData.det_y !== undefined || chargeData.det_z !== undefined)) {
            const dxCoord = Number(chargeData.det_x ?? (xmin + sizeX * 0.5));
            const dyCoord = Number(chargeData.det_y ?? (ymin + sizeY * 0.5));
            const dzCoord = Number(chargeData.det_z ?? (zmin + sizeZ * 0.5));
            const center = physToWorld(dxCoord, dyCoord, dzCoord);
            const t = raySphereIntersect(O, D, center, 0.02 * detonatorSize);
            if (t !== null && t > 1e-4 && t < minSolidT) {
                minSolidT = t;
                solidHit = {
                    t,
                    hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                    objectType: 'DetonatorLocation3D',
                    label: 'Detonator Core'
                };
            }
        }
    }

    // 3. Explosive Charge
    if (showCharge && chargeData) {
        const cx = Number(chargeData.x ?? (xmin + sizeX * 0.5));
        const cy = Number(chargeData.y ?? (ymin + sizeY * 0.5));
        const cz = Number(chargeData.z ?? (zmin + sizeZ * 0.5));
        const center = physToWorld(cx, cy, cz);
        const shape = chargeData.shape || 'Sphere';

        if (shape === 'Block') {
            const lx = Number(chargeData.lx ?? 0.2);
            const ly = Number(chargeData.ly ?? 0.2);
            const lz = Number(chargeData.lz ?? 0.2);
            const boxMin = [
                center[0] - (lx * 0.5) / maxSize,
                center[1] - (ly * 0.5) / maxSize,
                center[2] - (lz * 0.5) / maxSize
            ];
            const boxMax = [
                center[0] + (lx * 0.5) / maxSize,
                center[1] + (ly * 0.5) / maxSize,
                center[2] + (lz * 0.5) / maxSize
            ];
            const t = rayBoxIntersect(O, D, boxMin, boxMax);
            if (t !== null && t > 1e-4 && t < minSolidT) {
                minSolidT = t;
                solidHit = {
                    t,
                    hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                    objectType: 'Charge3D',
                    label: 'Explosive Charge (Block)'
                };
            }
        } else if (shape === 'Cylinder') {
            const r = Number(chargeData.radius ?? 0.1);
            const h = Number(chargeData.height ?? 0.2);
            const rWorld = r / maxSize;
            const hWorld = (h * 0.5) / maxSize;
            const t = rayCylinderIntersect(O, D, center, rWorld, hWorld);
            if (t !== null && t > 1e-4 && t < minSolidT) {
                minSolidT = t;
                solidHit = {
                    t,
                    hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                    objectType: 'Charge3D',
                    label: 'Explosive Charge (Cylinder)'
                };
            }
        } else {
            const r = Number(chargeData.radius ?? 0.1);
            const rWorld = Math.max(r / maxSize, 0.01);
            const t = raySphereIntersect(O, D, center, rWorld);
            if (t !== null && t > 1e-4 && t < minSolidT) {
                minSolidT = t;
                solidHit = {
                    t,
                    hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                    objectType: 'Charge3D',
                    label: 'Explosive Charge (Sphere)'
                };
            }
        }
    }

    // Convert World-Space Ray to Physical-Space Coordinates for Direct Mesh Intersection
    const O_phys_x = O[0] * maxSize + (xmin + sizeX * 0.5);
    const O_phys_y = O[1] * maxSize + (ymin + sizeY * 0.5);
    const O_phys_z = O[2] * maxSize + (zmin + sizeZ * 0.5);
    const D_phys_x = D[0];
    const D_phys_y = D[1];
    const D_phys_z = D[2];

    // 4. Immersed Obstacles (Stairstepped / Voxelized Boundary Mesh with Spatial BVH)
    if (showObstacles && rawObstacleVertices && rawObstacleVertices.length >= 12) {
        if (!obstacleBVH) {
            obstacleBVH = buildMeshBVH(rawObstacleVertices, 12);
        }
        if (obstacleBVH) {
            const tPhys = raycastBVH(
                obstacleBVH, rawObstacleVertices, 12,
                O_phys_x, O_phys_y, O_phys_z,
                D_phys_x, D_phys_y, D_phys_z,
                minSolidT * maxSize
            );
            if (tPhys !== null) {
                const tWorld = tPhys / maxSize;
                if (tWorld > 1e-4 && tWorld < minSolidT) {
                    minSolidT = tWorld;
                    solidHit = {
                        t: tWorld,
                        hitPoint: [O[0] + tWorld * D[0], O[1] + tWorld * D[1], O[2] + tWorld * D[2]],
                        objectType: 'Obstacle',
                        objectId: 'obstacle_mesh',
                        label: 'Immersed Obstacle'
                    };
                }
            }
        }
    }

    // 5. STL Solid CAD Mesh (Spatial BVH with Exact Triangle Intersection)
    if (showSTL && rawSTLVertices && rawSTLVertices.length >= 9) {
        if (!stlBVH) {
            stlBVH = buildMeshBVH(rawSTLVertices, 9);
        }
        if (stlBVH) {
            const tPhys = raycastBVH(
                stlBVH, rawSTLVertices, 9,
                O_phys_x, O_phys_y, O_phys_z,
                D_phys_x, D_phys_y, D_phys_z,
                minSolidT * maxSize
            );
            if (tPhys !== null) {
                const tWorld = tPhys / maxSize;
                if (tWorld > 1e-4 && tWorld < minSolidT) {
                    minSolidT = tWorld;
                    solidHit = {
                        t: tWorld,
                        hitPoint: [O[0] + tWorld * D[0], O[1] + tWorld * D[1], O[2] + tWorld * D[2]],
                        objectType: 'STLGeometry',
                        label: 'CAD Geometry (STL)'
                    };
                }
            }
        }
    }

    // 6. FEM Structural Elements (Exact Facet Intersection)
    if ((showFEMMesh || showRebar || showBeams) && latestFEMNodesData && latestFEMNodesData.length > 0 && cachedFemAABB) {
        const wFemMin = physToWorld(cachedFemAABB.minX, cachedFemAABB.minY, cachedFemAABB.minZ);
        const wFemMax = physToWorld(cachedFemAABB.maxX, cachedFemAABB.maxY, cachedFemAABB.maxZ);
        const tBox = rayBoxIntersect(O, D, wFemMin, wFemMax);

        if (tBox !== null) {
            const nNodes = Math.floor(latestFEMNodesData.length / 7);
            if (latestFEMFacetsData && latestFEMFacetsData.length > 0) {
                const nFacets = Math.floor(latestFEMFacetsData.length / 8);
                for (let f = 0; f < nFacets; f++) {
                    const n0 = Math.round(latestFEMFacetsData[f * 8 + 0]);
                    const n1 = Math.round(latestFEMFacetsData[f * 8 + 1]);
                    const n2 = Math.round(latestFEMFacetsData[f * 8 + 2]);
                    const n3 = Math.round(latestFEMFacetsData[f * 8 + 3]);
                    if (n0 < 0 || n0 >= nNodes || n1 < 0 || n1 >= nNodes || n2 < 0 || n2 >= nNodes) continue;

                    const v0x = latestFEMNodesData[n0 * 7 + 0];
                    const v0y = latestFEMNodesData[n0 * 7 + 1];
                    const v0z = latestFEMNodesData[n0 * 7 + 2];
                    const v1x = latestFEMNodesData[n1 * 7 + 0];
                    const v1y = latestFEMNodesData[n1 * 7 + 1];
                    const v1z = latestFEMNodesData[n1 * 7 + 2];
                    const v2x = latestFEMNodesData[n2 * 7 + 0];
                    const v2y = latestFEMNodesData[n2 * 7 + 1];
                    const v2z = latestFEMNodesData[n2 * 7 + 2];

                    const t1 = rayTriangleIntersectCoords(O_phys_x, O_phys_y, O_phys_z, D_phys_x, D_phys_y, D_phys_z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z)
                            || rayTriangleIntersectCoords(O_phys_x, O_phys_y, O_phys_z, D_phys_x, D_phys_y, D_phys_z, v0x, v0y, v0z, v2x, v2y, v2z, v1x, v1y, v1z);
                    if (t1 !== null) {
                        const tWorld = t1 / maxSize;
                        if (tWorld > 1e-4 && tWorld < minSolidT) {
                            minSolidT = tWorld;
                            solidHit = {
                                t: tWorld,
                                hitPoint: [O[0] + tWorld * D[0], O[1] + tWorld * D[1], O[2] + tWorld * D[2]],
                                objectType: 'FEMObject3D',
                                label: 'FEM Solid Structure'
                            };
                        }
                    }

                    if (n3 >= 0 && n3 < nNodes) {
                        const v3x = latestFEMNodesData[n3 * 7 + 0];
                        const v3y = latestFEMNodesData[n3 * 7 + 1];
                        const v3z = latestFEMNodesData[n3 * 7 + 2];
                        const t2 = rayTriangleIntersectCoords(O_phys_x, O_phys_y, O_phys_z, D_phys_x, D_phys_y, D_phys_z, v0x, v0y, v0z, v2x, v2y, v2z, v3x, v3y, v3z)
                                || rayTriangleIntersectCoords(O_phys_x, O_phys_y, O_phys_z, D_phys_x, D_phys_y, D_phys_z, v0x, v0y, v0z, v3x, v3y, v3z, v2x, v2y, v2z);
                        if (t2 !== null) {
                            const tWorld = t2 / maxSize;
                            if (tWorld > 1e-4 && tWorld < minSolidT) {
                                minSolidT = tWorld;
                                solidHit = {
                                    t: tWorld,
                                    hitPoint: [O[0] + tWorld * D[0], O[1] + tWorld * D[1], O[2] + tWorld * D[2]],
                                    objectType: 'FEMObject3D',
                                    label: 'FEM Solid Structure'
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    // 7. MPM Particles & Bodies
    if (showMPMParticles && latestMPMParticlesData && latestMPMParticlesData.length > 0 && cachedMpmAABB) {
        const wMpmMin = physToWorld(cachedMpmAABB.minX, cachedMpmAABB.minY, cachedMpmAABB.minZ);
        const wMpmMax = physToWorld(cachedMpmAABB.maxX, cachedMpmAABB.maxY, cachedMpmAABB.maxZ);
        const tBox = rayBoxIntersect(O, D, wMpmMin, wMpmMax);
        if (tBox !== null && tBox > 1e-4 && tBox < minSolidT) {
            minSolidT = tBox;
            const matchedObj = (mpmObjectsData && mpmObjectsData.length > 0) ? mpmObjectsData[0] : null;
            solidHit = {
                t: tBox,
                hitPoint: [O[0] + tBox * D[0], O[1] + tBox * D[1], O[2] + tBox * D[2]],
                objectType: 'MPMObject3D',
                objectId: matchedObj ? matchedObj.id : undefined,
                label: matchedObj ? (matchedObj.label || matchedObj.id || 'MPM Object') : 'MPM Particle Body'
            };
        }
    }

    // 8. Configured / Uninitialized MPM Objects
    if (showMPMParticles && mpmObjectsData && mpmObjectsData.length > 0 && (!latestMPMParticlesData || latestMPMParticlesData.length === 0)) {
        mpmObjectsData.forEach((obj: any, idx: number) => {
            const cx = Number(obj.x ?? (xmin + sizeX * 0.5));
            const cy = Number(obj.y ?? (ymin + sizeY * 0.5));
            const cz = Number(obj.z ?? (zmin + sizeZ * 0.5));
            const center = physToWorld(cx, cy, cz);
            const shape = obj.shape || 'Box';
            if (shape === 'Cylinder') {
                const r = Number(obj.radius ?? 0.1);
                const h = Number(obj.height ?? 0.2);
                const rWorld = r / maxSize;
                const hWorld = (h * 0.5) / maxSize;
                const t = rayCylinderIntersect(O, D, center, rWorld, hWorld);
                if (t !== null && t > 1e-4 && t < minSolidT) {
                    minSolidT = t;
                    solidHit = {
                        t,
                        hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                        objectType: 'MPMObject3D',
                        objectId: obj.id || `mpm_${idx}`,
                        label: `MPM Cylinder (${obj.id || '#' + (idx + 1)})`
                    };
                }
            } else if (shape === 'Sphere') {
                const r = Number(obj.radius ?? 0.1);
                const rWorld = Math.max(r / maxSize, 0.015);
                const t = raySphereIntersectCoords(O[0], O[1], O[2], D[0], D[1], D[2], center[0], center[1], center[2], rWorld);
                if (t !== null && t > 1e-4 && t < minSolidT) {
                    minSolidT = t;
                    solidHit = {
                        t,
                        hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                        objectType: 'MPMObject3D',
                        objectId: obj.id || `mpm_${idx}`,
                        label: `MPM Sphere (${obj.id || '#' + (idx + 1)})`
                    };
                }
            } else {
                const lx = Number(obj.size_x ?? 0.2);
                const ly = Number(obj.size_y ?? 0.2);
                const lz = Number(obj.size_z ?? 0.2);
                const boxMin = [
                    center[0] - (lx * 0.5) / maxSize,
                    center[1] - (ly * 0.5) / maxSize,
                    center[2] - (lz * 0.5) / maxSize
                ];
                const boxMax = [
                    center[0] + (lx * 0.5) / maxSize,
                    center[1] + (ly * 0.5) / maxSize,
                    center[2] + (lz * 0.5) / maxSize
                ];
                const t = rayBoxIntersect(O, D, boxMin, boxMax);
                if (t !== null && t > 1e-4 && t < minSolidT) {
                    minSolidT = t;
                    solidHit = {
                        t,
                        hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                        objectType: 'MPMObject3D',
                        objectId: obj.id || `mpm_${idx}`,
                        label: `MPM Box (${obj.id || '#' + (idx + 1)})`
                    };
                }
            }
        });
    }

    // IF ANY 3D PHYSICAL ENTITY WAS HIT, RETURN IT DIRECTLY!
    // Slices MUST NOT intercept or override clicks on solid bodies!
    if (solidHit) {
        return solidHit;
    }

    // =========================================================================
    // PASS 2: 2D Planar Slices (Cross-Section CFD Field Quads)
    // Only evaluated when clicking on the open fluid field where no 3D entity exists!
    // =========================================================================
    if (showSlices !== false) {
        const allSlices = (cachedSlices && cachedSlices.length > 0)
            ? cachedSlices
            : Object.values(activeSlicesWebGL).map(s => ({
                axis: s.axis,
                offset: s.offset,
                index: s.index
            }));

        if (allSlices && allSlices.length > 0) {
            let sliceHit: any = null;
            let minSliceT = Infinity;

            allSlices.forEach((slice: any, idx: number) => {
                const sliceIndex = slice.index !== undefined ? slice.index : idx;
                const cfg = getSliceConfig(sliceIndex);
                if (cfg && cfg.enabled === false) return;
                const axis = (slice.axis === 'yz' || slice.axis === 2 || String(slice.axis).toLowerCase() === 'yz') ? 2 : ((slice.axis === 'xz' || slice.axis === 1 || String(slice.axis).toLowerCase() === 'xz') ? 1 : 0);
                const offset = Number(slice.offset ?? (axis === 0 ? (zmin + sizeZ * 0.5) : axis === 1 ? (ymin + sizeY * 0.5) : (xmin + sizeX * 0.5)));

                let v0: number[], v1: number[], v2: number[], v3: number[];
                if (axis === 0) {
                    const wz = normZ(offset) * sZ;
                    v0 = [-0.5 * sX, -0.5 * sY, wz];
                    v1 = [ 0.5 * sX, -0.5 * sY, wz];
                    v2 = [ 0.5 * sX,  0.5 * sY, wz];
                    v3 = [-0.5 * sX,  0.5 * sY, wz];
                } else if (axis === 1) {
                    const wy = normY(offset) * sY;
                    v0 = [-0.5 * sX, wy, -0.5 * sZ];
                    v1 = [ 0.5 * sX, wy, -0.5 * sZ];
                    v2 = [ 0.5 * sX, wy,  0.5 * sZ];
                    v3 = [-0.5 * sX, wy,  0.5 * sZ];
                } else {
                    const wx = normX(offset) * sX;
                    v0 = [wx, -0.5 * sY, -0.5 * sZ];
                    v1 = [wx,  0.5 * sY, -0.5 * sZ];
                    v2 = [wx,  0.5 * sY,  0.5 * sZ];
                    v3 = [wx, -0.5 * sY,  0.5 * sZ];
                }

                const tCandidates = [
                    rayTriangleIntersect(O, D, v0, v1, v2),
                    rayTriangleIntersect(O, D, v0, v2, v3),
                    rayTriangleIntersect(O, D, v0, v2, v1),
                    rayTriangleIntersect(O, D, v0, v3, v2)
                ].filter((t): t is number => t !== null && t > 1e-4);

                for (const t of tCandidates) {
                    if (t < minSliceT) {
                        minSliceT = t;
                        sliceHit = {
                            t,
                            hitPoint: [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]],
                            objectType: 'Slice',
                            sliceIndex: sliceIndex,
                            label: `Slice #${sliceIndex} (${axis === 2 ? 'X-Normal' : axis === 1 ? 'Y-Normal' : 'Z-Normal'})`
                        };
                    }
                }
            });

            if (sliceHit) {
                return sliceHit;
            }
        }
    }

    return null;
}

function handlePickObject(mouseX: number, mouseY: number, width: number, height: number, button: number, screenX: number, screenY: number) {
    const bestHit = raycastScene(mouseX, mouseY, width, height);

    if (bestHit) {
        selectedObject = bestHit;
        self.postMessage({
            type: 'objectPicked',
            data: {
                hit: true,
                ...bestHit,
                screenX,
                screenY,
                button
            }
        });
    } else {
        selectedObject = null;
        self.postMessage({
            type: 'objectPicked',
            data: {
                hit: false,
                screenX,
                screenY,
                button
            }
        });
    }
    requestRender();
}

function handleHoverObject(mouseX: number, mouseY: number, width: number, height: number, screenX: number, screenY: number, clear?: boolean) {
    if (clear) {
        if (hoveredObject !== null) {
            hoveredObject = null;
            self.postMessage({ type: 'objectHovered', data: { hit: false } });
            requestRender();
        }
        return;
    }

    const bestHit = raycastScene(mouseX, mouseY, width, height);
    const hitKey = bestHit ? `${bestHit.objectType}_${bestHit.sliceIndex}_${bestHit.objectId}_${bestHit.gaugeIndex}` : null;
    const prevKey = hoveredObject ? `${hoveredObject.objectType}_${hoveredObject.sliceIndex}_${hoveredObject.objectId}_${hoveredObject.gaugeIndex}` : null;

    if (hitKey !== prevKey) {
        hoveredObject = bestHit;
        if (bestHit) {
            self.postMessage({
                type: 'objectHovered',
                data: {
                    hit: true,
                    ...bestHit,
                    screenX,
                    screenY
                }
            });
        } else {
            self.postMessage({ type: 'objectHovered', data: { hit: false } });
        }
        requestRender();
    }
}

function setSelectedObject(data: any) {
    if (data && data.objectType) {
        selectedObject = { ...data };
    } else {
        selectedObject = null;
    }
    requestRender();
}

function setHoveredObject(data: any) {
    if (data && data.objectType) {
        hoveredObject = { ...data };
    } else {
        hoveredObject = null;
    }
    requestRender();
}

function projectPoint(v: number[], mvp: Float32Array, width: number, height: number): { x: number, y: number, w: number } {
    const x = v[0], y = v[1], z = v[2];
    const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] || 1;
    const px = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
    const py = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
    return {
        x: (px * 0.5 + 0.5) * width,
        y: (1.0 - (py * 0.5 + 0.5)) * height,
        w
    };
}

function render2D() {
    if (!ctx2D) return;
    const canvas = ctx2D.canvas;
    const width = canvas.width;
    const height = canvas.height;

    const r255 = Math.round((clearColor.r ?? 0.082) * 255);
    const g255 = Math.round((clearColor.g ?? 0.098) * 255);
    const b255 = Math.round((clearColor.b ?? 0.133) * 255);
    ctx2D.fillStyle = `rgb(${r255}, ${g255}, ${b255})`;
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

    const enabledSlices2D = activeSlices2D.filter((s, idx) => {
        const cfg = getSliceConfig(idx);
        return !cfg || cfg.enabled !== false;
    });
    if (enabledSlices2D.length > 0) {
        const slice = enabledSlices2D[0];
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
            } else if (colormap === 0) { // Plasma
                r = Math.round(t * 1.5 * 255);
                g = Math.round(t * t * 255);
                b = Math.round((1.0 - t) * 255);
            } else { // Rainbow (default, colormap === 2)
                const four = 4.0 * t;
                r = Math.min(255, Math.max(0, Math.round(255 * Math.min(four - 1.5, -four + 4.5))));
                g = Math.min(255, Math.max(0, Math.round(255 * Math.min(four - 0.5, -four + 3.5))));
                b = Math.min(255, Math.max(0, Math.round(255 * Math.min(four + 0.5, -four + 2.5))));
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

    if (showGauges && gaugesList && gaugesList.length > 0) {
        const dimX = getDimX();
        const dimY = getDimY();
        const dimZ = getDimZ();
        ctx2D.fillStyle = "#ffaa00";
        ctx2D.strokeStyle = "#ffaa00";
        ctx2D.lineWidth = 2;
        for (const g of gaugesList) {
            const gx = Number(g.x ?? 0.5);
            const gy = Number(g.y ?? 0.5);
            const gz = Number(g.z ?? 0.5);
            const px = normX(gx);
            const py = normY(gy);
            const pz = normZ(gz);
            const pt = projectPoint([px, py, pz], mvp, width, height);

            ctx2D.beginPath();
            ctx2D.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
            ctx2D.fill();
            
            ctx2D.fillStyle = "#ffffff";
            ctx2D.font = "bold 9px sans-serif";
            ctx2D.fillText(g.id || g.name || "", pt.x + 8, pt.y - 4);
            ctx2D.fillStyle = "#ffaa00";
        }
        drawOverlayTicks();
    }
}

function render() {
    renderPending = false;
    const w = canvasWidth();
    const h = canvasHeight();
    updateMatrices(w, h);

    if (is2DFallback) {
        render2D();
        return;
    }

    if (isWebGPU && gpuDevice && gpuContext) {
        // Build uniforms data float buffer (80 floats / 320 bytes)
        const uniformData = new Float32Array(80);
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
        uniformData[60] = 0.0;
        uniformData[61] = 0.0;
        uniformData[62] = dx;
        uniformData[63] = 0.0;
        uniformData[64] = 1.0;
        uniformData[65] = 0.0;
        uniformData[66] = aoRadius;
        uniformData[67] = aoIntensity;
        uniformData[68] = xmin;
        uniformData[69] = ymin;
        uniformData[70] = zmin;
        uniformData[71] = aoBias;
        uniformData[72] = getDimX();
        uniformData[73] = getDimY();
        uniformData[74] = getDimZ();
        uniformData[75] = aoSphereImpostor ? 1.0 : 0.0;
        uniformData[76] = w;
        uniformData[77] = h;

        gpuDevice.queue.writeBuffer(gpuUniformBuffer!, 0, uniformData.buffer);

        // Prepare wireframe uniform data (sets isWireframe = 1.0)
        const uniformDataWF = new Float32Array(uniformData);
        uniformDataWF[53] = 1.0;
        gpuDevice.queue.writeBuffer(gpuUniformBufferWF!, 0, uniformDataWF.buffer);

        const commandEncoder = gpuDevice.createCommandEncoder();
        const textureView = gpuContext.getCurrentTexture().createView();
        
        const canvasW = canvasWidth();
        const canvasH = canvasHeight();
        if (!cachedMsaaColorTexture || cachedWidth !== canvasW || cachedHeight !== canvasH) {
            if (cachedMsaaColorTexture) cachedMsaaColorTexture.destroy();
            if (cachedDepthTexture) cachedDepthTexture.destroy();

            cachedWidth = canvasW;
            cachedHeight = canvasH;

            const format = nav.gpu.getPreferredCanvasFormat();
            cachedMsaaColorTexture = gpuDevice.createTexture({
                size: [canvasW, canvasH],
                sampleCount: 4,
                format: format,
                usage: 16 // RENDER_ATTACHMENT
            });
            cachedMsaaColorView = cachedMsaaColorTexture.createView();

            cachedDepthTexture = gpuDevice.createTexture({
                size: [canvasW, canvasH],
                format: 'depth24plus',
                usage: 16, // RENDER_ATTACHMENT
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
                clearValue: clearColor,
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
                    { binding: 1, resource: gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            passEncoder.setPipeline(gpuLinePipeline);
            passEncoder.setBindGroup(0, bboxBindGroup);
            passEncoder.setVertexBuffer(0, gpuBBoxBuffer);
            passEncoder.draw(bboxVertexCount, 1, 0, 0);
            
            if (gpuAMRTilesBuffer && amrTilesCount > 0) {
                passEncoder.setVertexBuffer(0, gpuAMRTilesBuffer);
                passEncoder.draw(amrTilesCount, 1, 0, 0);
            }
            if (gpuSliceGridlinesBuffer && sliceGridlinesCount > 0) {
                passEncoder.setVertexBuffer(0, gpuSliceGridlinesBuffer);
                passEncoder.draw(sliceGridlinesCount, 1, 0, 0);
            }
        }        // Draw STL Geometry in WebGPU
        let stlDrawnThisFrameWebGPU = false;
        const drawSTLWebGPU = () => {
            if (stlDrawnThisFrameWebGPU) return;
            if (!showSTL || !gpuSTLBuffer || !transformedSTLVertices || transformedSTLVertices.length === 0) return;
            const count = transformedSTLVertices.length / 7;
            if (count === 0) return;

            if (!gpuSTLUniformSolid && gpuDevice) {
                gpuSTLUniformSolid = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }
            if (!gpuSTLUniformWireframe && gpuDevice) {
                gpuSTLUniformWireframe = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }

            const sizeX = getDimX();
            const sizeY = getDimY();
            const sizeZ = getDimZ();
            const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
            const invMax = 1.0 / maxSize;
            const cx = xmin + sizeX * 0.5;
            const cy = ymin + sizeY * 0.5;
            const cz = zmin + sizeZ * 0.5;

            const stlFinalModel = new Float32Array([
                invMax, 0, 0, 0,
                0, invMax, 0, 0,
                0, 0, invMax, 0,
                -cx * invMax, -cy * invMax, -cz * invMax, 1
            ]);

            const cStlQ = canonicalizeQuantity(stlQuantity);
            const defaultStlRange = quantityRanges[cStlQ] || quantityRanges[stlQuantity] || DEFAULT_QUANTITY_RANGES[cStlQ] || DEFAULT_QUANTITY_RANGES[stlQuantity] || [0.0, 1.0];
            const stlIsLocked = lockQuantityRanges && (stlLockQuantityRange !== false);
            const effectiveStlAuto = stlIsLocked ? ((quantityAutoScales[cStlQ] ?? quantityAutoScales[stlQuantity]) !== false) : (stlAutoScale !== false);
            let finalStlMin = defaultStlRange[0];
            let finalStlMax = defaultStlRange[1];
            if (stlIsLocked) {
                finalStlMin = defaultStlRange[0];
                finalStlMax = defaultStlRange[1];
            } else if (effectiveStlAuto) {
                if (isFinite(stlVolMin) && isFinite(stlVolMax) && stlVolMax > stlVolMin) {
                    finalStlMin = stlVolMin;
                    finalStlMax = stlVolMax;
                }
            } else {
                finalStlMin = stlMinVal ?? defaultStlRange[0];
                finalStlMax = stlMaxVal ?? defaultStlRange[1];
            }

            const effectiveStlCmap = stlIsLocked ? (quantityColormaps[cStlQ] || quantityColormaps[stlQuantity] || stlColormap) : stlColormap;
            const effectiveStlLog = stlIsLocked ? (quantityLogScales[cStlQ] ?? quantityLogScales[stlQuantity] ?? stlLogScale) : stlLogScale;
            const stlSampler = (stlSamplingMode === 'linear') ? (gpuSamplerLinear || gpuSampler) : (gpuSamplerNearest || gpuSampler);

            if (stlSolids && stlOpacity > 0.001 && (gpuPipeline || gpuSlicePipeline)) {
                stlDrawnThisFrameWebGPU = true;
                const uSolid = new Float32Array(uniformData);
                uSolid.set(stlFinalModel, 32);
                uSolid[48] = stlOpacity;
                uSolid[53] = stlWireframe ? 7.0 : 5.0; // 7.0 for Solid + Wireframe, 5.0 for Solid only
                uSolid[60] = stlShowResults ? 1.0 : 0.0;
                uSolid[61] = getColormapIndex(effectiveStlCmap);
                uSolid[62] = dx || 0.01;
                uSolid[63] = finalStlMin;
                uSolid[64] = finalStlMax;
                uSolid[65] = effectiveStlLog ? 1.0 : 0.0;
                uSolid[68] = xmin; uSolid[69] = ymin; uSolid[70] = zmin;
                uSolid[72] = sizeX; uSolid[73] = sizeY; uSolid[74] = sizeZ;
                gpuDevice.queue.writeBuffer(gpuSTLUniformSolid, 0, uSolid.buffer);

                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformSolid } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: stlSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                const pipelineToUse = (stlOpacity < 0.999 && gpuSlicePipeline) ? gpuSlicePipeline : (gpuPipeline || gpuSlicePipeline);
                passEncoder.setPipeline(pipelineToUse);
                passEncoder.setBindGroup(0, solidBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.draw(count);
            } else if (stlWireframe && gpuPipeline) {
                stlDrawnThisFrameWebGPU = true;
                const uWire = new Float32Array(uniformData);
                uWire.set(stlFinalModel, 32);
                uWire[48] = 0.0;
                uWire[53] = 6.0; // 6.0 for Wireframe only
                uWire[60] = stlShowResults ? 1.0 : 0.0;
                uWire[61] = getColormapIndex(effectiveStlCmap);
                uWire[62] = dx || 0.01;
                uWire[63] = finalStlMin;
                uWire[64] = finalStlMax;
                uWire[65] = effectiveStlLog ? 1.0 : 0.0;
                uWire[68] = xmin; uWire[69] = ymin; uWire[70] = zmin;
                uWire[72] = sizeX; uWire[73] = sizeY; uWire[74] = sizeZ;
                gpuDevice.queue.writeBuffer(gpuSTLUniformWireframe, 0, uWire.buffer);

                const wireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformWireframe } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: stlSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuPipeline);
                passEncoder.setBindGroup(0, wireBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.draw(count);
            }
        };

        if (stlOpacity >= 0.999) {
            drawSTLWebGPU();
        }

        // Draw Gauges in WebGPU
        if (showGauges && gpuGaugesBuffer && gpuGaugesCount > 0 && gpuPipeline && gpuUniformBufferGauges) {
            const uGauges = new Float32Array(uniformData);
            uGauges[48] = 1.0; // alpha = 1.0
            uGauges[53] = 8.0; // set isWireframe to 8.0 (gauges mode)
            gpuDevice.queue.writeBuffer(gpuUniformBufferGauges, 0, uGauges.buffer);

            const gaugesBindGroup = gpuDevice.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpuUniformBufferGauges } },
                    { binding: 1, resource: gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            passEncoder.setPipeline(gpuPipeline);
            passEncoder.setBindGroup(0, gaugesBindGroup);
            passEncoder.setVertexBuffer(0, gpuGaugesBuffer);
            passEncoder.draw(gpuGaugesCount);
        }

        // Draw Obstacles in WebGPU
        if (showObstacles && gpuObstaclesVertexBuffer && obstacleTriIndexCount > 0 && (gpuPipeline || gpuSlicePipeline)) {
            if (!gpuUniformBufferObstaclesSolid) {
                gpuUniformBufferObstaclesSolid = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }
            if (!gpuUniformBufferObstaclesWire) {
                gpuUniformBufferObstaclesWire = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }

            const sizeX = getDimX();
            const sizeY = getDimY();
            const sizeZ = getDimZ();
            const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
            const invMax = 1.0 / maxSize;
            const cx = xmin + sizeX * 0.5;
            const cy = ymin + sizeY * 0.5;
            const cz = zmin + sizeZ * 0.5;

            const obsFinalModel = new Float32Array([
                invMax, 0, 0, 0,
                0, invMax, 0, 0,
                0, 0, invMax, 0,
                -cx * invMax, -cy * invMax, -cz * invMax, 1
            ]);

            let obsMin = obstaclesMinVal;
            let obsMax = obstaclesMaxVal;
            const cObsQ = canonicalizeQuantity(obstaclesQuantity);
            const defaultObsRange = quantityRanges[cObsQ] || quantityRanges[obstaclesQuantity] || DEFAULT_QUANTITY_RANGES[cObsQ] || DEFAULT_QUANTITY_RANGES[obstaclesQuantity] || [0.0, 1.0];
            const effectiveObsAuto = lockQuantityRanges ? ((quantityAutoScales[cObsQ] ?? quantityAutoScales[obstaclesQuantity]) !== false) : (obstaclesAutoScale !== false);
            if (lockQuantityRanges) {
                obsMin = defaultObsRange[0];
                obsMax = defaultObsRange[1];
            } else if (effectiveObsAuto) {
                if (isFinite(cachedObstaclesMinVal) && isFinite(cachedObstaclesMaxVal) && cachedObstaclesMaxVal > cachedObstaclesMinVal) {
                    obsMin = cachedObstaclesMinVal;
                    obsMax = cachedObstaclesMaxVal;
                } else {
                    obsMin = defaultObsRange[0];
                    obsMax = defaultObsRange[1];
                }
            } else {
                obsMin = obstaclesMinVal ?? defaultObsRange[0];
                obsMax = obstaclesMaxVal ?? defaultObsRange[1];
            }

            const effectiveObsCmap = lockQuantityRanges ? (quantityColormaps[cObsQ] || quantityColormaps[obstaclesQuantity] || obstaclesColormap) : obstaclesColormap;
            const effectiveObsLog = lockQuantityRanges ? (quantityLogScales[cObsQ] ?? quantityLogScales[obstaclesQuantity] ?? obstaclesLogScale) : obstaclesLogScale;

            // Write solid uniforms
            const uSolid = new Float32Array(uniformData);
            uSolid.set(obsFinalModel, 32);
            uSolid[48] = obstaclesOpacity;
            uSolid[49] = getColormapIndex(effectiveObsCmap);
            uSolid[50] = obsMin;
            uSolid[51] = obsMax;
            uSolid[52] = effectiveObsLog ? 1.0 : 0.0;
            uSolid[53] = obstaclesLighting ? 9.0 : 11.0;
            gpuDevice.queue.writeBuffer(gpuUniformBufferObstaclesSolid, 0, uSolid.buffer);

            // Write wireframe uniforms
            const uWire = new Float32Array(uniformData);
            uWire.set(obsFinalModel, 32);
            uWire[48] = 1.0;
            uWire[49] = getColormapIndex(effectiveObsCmap);
            uWire[50] = obsMin;
            uWire[51] = obsMax;
            uWire[52] = effectiveObsLog ? 1.0 : 0.0;
            uWire[53] = 10.0;
            gpuDevice.queue.writeBuffer(gpuUniformBufferObstaclesWire, 0, uWire.buffer);

            // Draw Solid Pass
            if (obstaclesOpacity > 0.0 && gpuObstaclesTriIndexBuffer) {
                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferObstaclesSolid } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                const pipelineToUse = (obstaclesOpacity < 0.999 && gpuSlicePipeline) ? gpuSlicePipeline : gpuPipeline;
                passEncoder.setPipeline(pipelineToUse);
                passEncoder.setBindGroup(0, solidBindGroup);
                passEncoder.setVertexBuffer(0, gpuObstaclesVertexBuffer);
                passEncoder.setIndexBuffer(gpuObstaclesTriIndexBuffer, 'uint32');
                passEncoder.drawIndexed(obstacleTriIndexCount);
            }

            // Draw Wireframe Pass
            if (obstaclesGridlines && gpuObstaclesWireIndexBuffer && gpuLinePipeline) {
                const wireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferObstaclesWire } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuLinePipeline);
                passEncoder.setBindGroup(0, wireBindGroup);
                passEncoder.setVertexBuffer(0, gpuObstaclesVertexBuffer);
                passEncoder.setIndexBuffer(gpuObstaclesWireIndexBuffer, 'uint32');
                passEncoder.drawIndexed(obstacleWireIndexCount);
            }
        }

        // Draw 3D MPM Particles (Instanced Billboard Spheres or Point Cloud) in WebGPU
        if (showMPMParticles && gpuMPMParticlesBuffer && mpmParticlesCount > 0 && (gpuParticleBillboardPipeline || gpuPointPipeline)) {
            if (!gpuUniformBufferMPM) {
                gpuUniformBufferMPM = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }
            const uMPM = new Float32Array(uniformData);
            uMPM[48] = mpmParticleOpacity;
            uMPM[53] = 14.0; // 14.0 for MPM particles
            const maxSize = Math.max(getDimX(), getDimY(), getDimZ()) || 1.0;
            const pPerDim = Math.max(1, Math.round(Math.cbrt(ppc || 8)));
            const autoDiam = (latestEmpiricalSpacing > 0) ? (latestEmpiricalSpacing * 0.8) : (((dx || 0.001) / pPerDim) * 0.8);
            const pDiam = (mpmParticleDiameter !== undefined && mpmParticleDiameter > 0)
                ? mpmParticleDiameter
                : autoDiam;
            const viewRadius = (pDiam * 0.5) / maxSize;
            uMPM[54] = Math.max(0.00005, viewRadius); // particle radius in view space
            gpuDevice.queue.writeBuffer(gpuUniformBufferMPM, 0, uMPM.buffer);

            const mpmBindGroup = gpuDevice.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpuUniformBufferMPM } },
                    { binding: 1, resource: gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            if (gpuParticleBillboardPipeline) {
                passEncoder.setPipeline(gpuParticleBillboardPipeline);
                passEncoder.setBindGroup(0, mpmBindGroup);
                passEncoder.setVertexBuffer(0, gpuMPMParticlesBuffer);
                passEncoder.draw(6, mpmParticlesCount, 0, 0);
            } else if (gpuPointPipeline) {
                passEncoder.setPipeline(gpuPointPipeline);
                passEncoder.setBindGroup(0, mpmBindGroup);
                passEncoder.setVertexBuffer(0, gpuMPMParticlesBuffer);
                passEncoder.draw(mpmParticlesCount);
            }
        }

        // Draw 3D FEM Mesh in WebGPU
        if (showFEMMesh || showRebar || showBeams) {
            if (!gpuUniformBufferFEMSolid) {
                gpuUniformBufferFEMSolid = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }
            if (!gpuUniformBufferFEMWire) {
                gpuUniformBufferFEMWire = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }

            if ((femSolid || beamSolid || rebarSolid) && gpuFEMSolidBuffer && femSolidCount > 0 && (gpuPipeline || gpuSlicePipeline)) {
                const uSolid = new Float32Array(uniformData);
                uSolid[48] = femOpacity;
                uSolid[53] = 14.0; // FEM Solid colored by facet quantity
                gpuDevice.queue.writeBuffer(gpuUniformBufferFEMSolid, 0, uSolid.buffer);

                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferFEMSolid } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                const pipelineToUse = (femOpacity < 0.999 && gpuSlicePipeline) ? gpuSlicePipeline : gpuPipeline;
                passEncoder.setPipeline(pipelineToUse);
                passEncoder.setBindGroup(0, solidBindGroup);
                passEncoder.setVertexBuffer(0, gpuFEMSolidBuffer);
                passEncoder.draw(femSolidCount);
            }

            if ((femWireframe || beamWireframe || rebarWireframe) && gpuFEMWireframeBuffer && femWireframeCount > 0 && gpuLinePipeline) {
                const uWire = new Float32Array(uniformData);
                uWire[48] = 1.0;
                uWire[53] = 15.0; // FEM Wireframe (Always Solid Black)
                gpuDevice.queue.writeBuffer(gpuUniformBufferFEMWire, 0, uWire.buffer);

                const wireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferFEMWire } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuLinePipeline);
                passEncoder.setBindGroup(0, wireBindGroup);
                passEncoder.setVertexBuffer(0, gpuFEMWireframeBuffer);
                passEncoder.draw(femWireframeCount);
            }
        }

        // Draw Charge in WebGPU
        if (showCharge && (chargeSolid || chargeWireframe)) {
            if (chargeSolid && gpuChargeSolidBuffer && chargeCount > 0 && (gpuPipeline || gpuSlicePipeline)) {
                if (!gpuUniformBufferChargeSolid) {
                    gpuUniformBufferChargeSolid = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uCharge = new Float32Array(uniformData);
                uCharge[48] = chargeOpacity;
                uCharge[53] = 13.0; // Charge Solid mode
                gpuDevice.queue.writeBuffer(gpuUniformBufferChargeSolid, 0, uCharge.buffer);

                const chargeBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferChargeSolid } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                const pipelineToUse = (chargeOpacity < 0.999 && gpuSlicePipeline) ? gpuSlicePipeline : gpuPipeline;
                passEncoder.setPipeline(pipelineToUse);
                passEncoder.setBindGroup(0, chargeBindGroup);
                passEncoder.setVertexBuffer(0, gpuChargeSolidBuffer);
                passEncoder.draw(chargeCount);
            }

            if (chargeWireframe && gpuChargeWireBuffer && chargeWireCount > 0 && gpuLinePipeline) {
                if (!gpuUniformBufferChargeWire) {
                    gpuUniformBufferChargeWire = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uChargeWire = new Float32Array(uniformData);
                uChargeWire[48] = 1.0;
                uChargeWire[53] = 13.0; // Charge Wireframe mode
                gpuDevice.queue.writeBuffer(gpuUniformBufferChargeWire, 0, uChargeWire.buffer);

                const chargeWireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferChargeWire } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuLinePipeline);
                passEncoder.setBindGroup(0, chargeWireBindGroup);
                passEncoder.setVertexBuffer(0, gpuChargeWireBuffer);
                passEncoder.draw(chargeWireCount);
            }
        }

        // Draw Detonator Markers in WebGPU
        if (showDetonators && (detonatorSolid || detonatorWireframe)) {
            if (detonatorSolid && gpuDetonatorSolidBuffer && detonatorCount > 0 && (gpuPipeline || gpuSlicePipeline)) {
                if (!gpuUniformBufferDetonatorSolid) {
                    gpuUniformBufferDetonatorSolid = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uDet = new Float32Array(uniformData);
                uDet[48] = detonatorOpacity;
                uDet[53] = 20.0; // Detonator Solid mode
                gpuDevice.queue.writeBuffer(gpuUniformBufferDetonatorSolid, 0, uDet.buffer);

                const detBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferDetonatorSolid } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                const pipelineToUse = (detonatorOpacity < 0.999 && gpuSlicePipeline) ? gpuSlicePipeline : gpuPipeline;
                passEncoder.setPipeline(pipelineToUse);
                passEncoder.setBindGroup(0, detBindGroup);
                passEncoder.setVertexBuffer(0, gpuDetonatorSolidBuffer);
                passEncoder.draw(detonatorCount);
            }

            if (detonatorWireframe && gpuDetonatorWireBuffer && detonatorWireCount > 0 && gpuLinePipeline) {
                if (!gpuUniformBufferDetonatorWire) {
                    gpuUniformBufferDetonatorWire = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uDetWire = new Float32Array(uniformData);
                uDetWire[48] = 1.0;
                uDetWire[53] = 21.0; // Detonator Wireframe mode
                gpuDevice.queue.writeBuffer(gpuUniformBufferDetonatorWire, 0, uDetWire.buffer);

                const detWireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferDetonatorWire } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuLinePipeline);
                passEncoder.setBindGroup(0, detWireBindGroup);
                passEncoder.setVertexBuffer(0, gpuDetonatorWireBuffer);
                passEncoder.draw(detonatorWireCount);
            }
        }

        // Draw Uninitialized MPM Object Wireframes in WebGPU
        if (showMPMParticles && mpmParticlesCount === 0 && gpuMPMPreviewBuffer && mpmPreviewCount > 0 && gpuLinePipeline) {
            if (!gpuUniformBufferMPM) {
                gpuUniformBufferMPM = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }
            const uMPM = new Float32Array(uniformData);
            uMPM[48] = 0.9;
            uMPM[53] = 16.0; // Vibrant Electric Cyan Wireframe
            gpuDevice.queue.writeBuffer(gpuUniformBufferMPM, 0, uMPM.buffer);

            const mpmBindGroup = gpuDevice.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpuUniformBufferMPM } },
                    { binding: 1, resource: gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            passEncoder.setPipeline(gpuLinePipeline);
            passEncoder.setBindGroup(0, mpmBindGroup);
            passEncoder.setVertexBuffer(0, gpuMPMPreviewBuffer);
            passEncoder.draw(mpmPreviewCount);
        }

        // 2. Draw Slices
        const slicesArray = (showSlices !== false) ? Object.values(activeSlicesWebGPU).filter(s => {
            const cfg = getSliceConfig(s.index);
            return !cfg || cfg.enabled !== false;
        }) : [];
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
                            size: 384,
                            usage: 64 | 8
                        });
                        slice.bindGroup = gpuDevice.createBindGroup({
                            layout: bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: gpuSliceUniformBuffers[slice.index] } },
                                { binding: 1, resource: slice.gpuTextureView },
                                { binding: 2, resource: gpuSampler! },
                                { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                            ]
                        });
                    }
                    const sliceUniformData = new Float32Array(uniformData);
                    sliceUniformData[48] = 1.0;
                    sliceUniformData[49] = getColormapIndex(slice.colormap);
                    sliceUniformData[50] = slice.minY ?? minY;
                    sliceUniformData[51] = slice.maxY ?? maxY;
                    sliceUniformData[52] = slice.useLogScale ? 1.0 : 0.0;
                    sliceUniformData[54] = (meshType === 'amr') ? 0.0 : (showCellEdges ? 1.0 : 0.0);
                    sliceUniformData[55] = slice.interpolate ? 1.0 : 0.0;
                    gpuDevice.queue.writeBuffer(gpuSliceUniformBuffers[slice.index], 0, sliceUniformData.buffer);

                    passEncoder.setBindGroup(0, slice.bindGroup);
                    passEncoder.setVertexBuffer(0, slice.vertexBuffer);
                    passEncoder.draw(6);
                });
            }

            // Transparent STL pass (if opacity < 0.999, rendered after opaque slices)
            if (stlOpacity < 0.999) {
                drawSTLWebGPU();
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
                            size: 384,
                            usage: 64 | 8
                        });
                        slice.bindGroup = gpuDevice.createBindGroup({
                            layout: bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: gpuSliceUniformBuffers[slice.index] } },
                                { binding: 1, resource: slice.gpuTextureView },
                                { binding: 2, resource: gpuSampler! },
                                { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                            ]
                        });
                    }
                    const sliceUniformData = new Float32Array(uniformData);
                    sliceUniformData[48] = slice.opacity;
                    sliceUniformData[49] = getColormapIndex(slice.colormap);
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

        // Transparent STL fallback if no slices were active
        if (stlOpacity < 0.999) {
            drawSTLWebGPU();
        }

        // Draw Primary Selection Highlight in WebGPU (Electric Cyan #00f0ff, Mode 16.0)
        if (selectedObject && gpuLinePipeline) {
            const selectedKey = `${selectedObject.objectType}_${selectedObject.sliceIndex}_${selectedObject.objectId}_${selectedObject.gaugeIndex}_${selectedObject.x}_${selectedObject.y}_${selectedObject.z}_${selectedObject.radius}_${selectedObject.height}_${selectedObject.size_x}_${selectedObject.size_y}_${selectedObject.size_z}_${selectedObject.shape}_${selectedObject.rot_x}_${selectedObject.rot_y}_${selectedObject.rot_z}`;
            if (cachedSelectedKeyWebGPU !== selectedKey) {
                cachedSelectedKeyWebGPU = selectedKey;
                cachedSelectedVertsWebGPU = buildComponentHighlightGeometry(selectedObject);
                if (cachedSelectedVertsWebGPU.length > 0) {
                    const bytes = cachedSelectedVertsWebGPU.byteLength;
                    if (!gpuHighlightWireBuffer || gpuHighlightWireBufferSize < bytes) {
                        if (gpuHighlightWireBuffer) gpuHighlightWireBuffer.destroy();
                        gpuHighlightWireBufferSize = Math.max(bytes, Math.floor(bytes * 1.25));
                        gpuHighlightWireBuffer = gpuDevice.createBuffer({
                            size: gpuHighlightWireBufferSize,
                            usage: 0x20 | 0x08 // VERTEX | COPY_DST
                        });
                    }
                    gpuDevice.queue.writeBuffer(gpuHighlightWireBuffer, 0, cachedSelectedVertsWebGPU.buffer, cachedSelectedVertsWebGPU.byteOffset, bytes);
                }
            }
            if (cachedSelectedVertsWebGPU && cachedSelectedVertsWebGPU.length > 0 && gpuHighlightWireBuffer) {
                if (!gpuUniformBufferHighlight) {
                    gpuUniformBufferHighlight = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uHighlight = new Float32Array(uniformData);
                uHighlight[48] = 1.0;
                uHighlight[53] = 16.0; // Selection mode (Electric Cyan)
                gpuDevice.queue.writeBuffer(gpuUniformBufferHighlight, 0, uHighlight.buffer);

                const highlightBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferHighlight } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuHighlightLinePipeline || gpuLinePipeline);
                passEncoder.setBindGroup(0, highlightBindGroup);
                passEncoder.setVertexBuffer(0, gpuHighlightWireBuffer);
                passEncoder.draw(cachedSelectedVertsWebGPU.length / 5);
            }
        } else {
            cachedSelectedKeyWebGPU = null;
        }

        // Draw Hover Emphasis in WebGPU (Amber / Gold #fbbf24, Mode 17.0)
        if (hoveredObject && (!selectedObject || selectedObject.objectType !== hoveredObject.objectType || selectedObject.sliceIndex !== hoveredObject.sliceIndex || selectedObject.objectId !== hoveredObject.objectId || selectedObject.gaugeIndex !== hoveredObject.gaugeIndex) && (gpuHighlightLinePipeline || gpuLinePipeline)) {
            const hoverKey = `${hoveredObject.objectType}_${hoveredObject.sliceIndex}_${hoveredObject.objectId}_${hoveredObject.gaugeIndex}_${hoveredObject.x}_${hoveredObject.y}_${hoveredObject.z}_${hoveredObject.radius}_${hoveredObject.height}_${hoveredObject.size_x}_${hoveredObject.size_y}_${hoveredObject.size_z}_${hoveredObject.shape}_${hoveredObject.rot_x}_${hoveredObject.rot_y}_${hoveredObject.rot_z}`;
            if (cachedHoverKeyWebGPU !== hoverKey) {
                cachedHoverKeyWebGPU = hoverKey;
                cachedHoverVertsWebGPU = buildComponentHighlightGeometry(hoveredObject);
                if (cachedHoverVertsWebGPU.length > 0) {
                    const bytes = cachedHoverVertsWebGPU.byteLength;
                    if (!gpuHoverWireBuffer || gpuHoverWireBufferSize < bytes) {
                        if (gpuHoverWireBuffer) gpuHoverWireBuffer.destroy();
                        gpuHoverWireBufferSize = Math.max(bytes, Math.floor(bytes * 1.25));
                        gpuHoverWireBuffer = gpuDevice.createBuffer({
                            size: gpuHoverWireBufferSize,
                            usage: 0x20 | 0x08 // VERTEX | COPY_DST
                        });
                    }
                    gpuDevice.queue.writeBuffer(gpuHoverWireBuffer, 0, cachedHoverVertsWebGPU.buffer, cachedHoverVertsWebGPU.byteOffset, bytes);
                }
            }
            if (cachedHoverVertsWebGPU && cachedHoverVertsWebGPU.length > 0 && gpuHoverWireBuffer) {
                if (!gpuUniformBufferHover) {
                    gpuUniformBufferHover = gpuDevice.createBuffer({
                        size: 384,
                        usage: 64 | 8
                    });
                }
                const uHover = new Float32Array(uniformData);
                uHover[48] = 0.95;
                uHover[53] = 17.0; // Hover mode (Amber/Gold)
                gpuDevice.queue.writeBuffer(gpuUniformBufferHover, 0, uHover.buffer);

                const hoverBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferHover } },
                        { binding: 1, resource: gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuHighlightLinePipeline || gpuLinePipeline);
                passEncoder.setBindGroup(0, hoverBindGroup);
                passEncoder.setVertexBuffer(0, gpuHoverWireBuffer);
                passEncoder.draw(cachedHoverVertsWebGPU.length / 5);
            }
        } else {
            cachedHoverKeyWebGPU = null;
        }

        let gpuUniformBufferHighlightSurface: any = null;

        function renderObjectSurfaceHighlightWebGPU(pEnc: any, targetObj: any, highlightMode: number) {
            if (!gpuDevice || !pEnc || !targetObj || !targetObj.objectType) return;
            const { objectType } = targetObj;

            if (!gpuUniformBufferHighlightSurface) {
                gpuUniformBufferHighlightSurface = gpuDevice.createBuffer({
                    size: 384,
                    usage: 64 | 8
                });
            }

            const uHighlightSurface = new Float32Array(uniformData);
            uHighlightSurface[48] = 1.0;
            uHighlightSurface[53] = highlightMode; // 18.0 = Selection Cyan, 19.0 = Hover Amber
            gpuDevice.queue.writeBuffer(gpuUniformBufferHighlightSurface, 0, uHighlightSurface.buffer);

            const highlightSurfaceBindGroup = gpuDevice.createBindGroup({
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gpuUniformBufferHighlightSurface } },
                    { binding: 1, resource: gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            const pipelineToUse = gpuSlicePipeline || gpuPipeline;
            if (!pipelineToUse) return;

            if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
                if (gpuObstaclesVertexBuffer && gpuObstaclesTriIndexBuffer && obstacleTriIndexCount > 0) {
                    pEnc.setPipeline(pipelineToUse);
                    pEnc.setBindGroup(0, highlightSurfaceBindGroup);
                    pEnc.setVertexBuffer(0, gpuObstaclesVertexBuffer);
                    pEnc.setIndexBuffer(gpuObstaclesTriIndexBuffer, 'uint32');
                    pEnc.drawIndexed(obstacleTriIndexCount);
                }
            } else if (objectType === 'STLGeometry') {
                if (gpuSTLBuffer && transformedSTLVertices && transformedSTLVertices.length > 0) {
                    const count = transformedSTLVertices.length / 7;
                    pEnc.setPipeline(pipelineToUse);
                    pEnc.setBindGroup(0, highlightSurfaceBindGroup);
                    pEnc.setVertexBuffer(0, gpuSTLBuffer);
                    pEnc.draw(count);
                }
            } else if (objectType === 'FEMObject3D' || objectType === 'FEMMesh3D' || objectType === 'FEMBeam3D' || objectType === 'FEMRebar3D' || objectType === 'LSDynaImporter3D') {
                if (gpuFEMSolidBuffer && femSolidCount > 0) {
                    pEnc.setPipeline(pipelineToUse);
                    pEnc.setBindGroup(0, highlightSurfaceBindGroup);
                    pEnc.setVertexBuffer(0, gpuFEMSolidBuffer);
                    pEnc.draw(femSolidCount);
                }
            } else if (objectType === 'Charge3D' || objectType === 'Charge' || objectType === 'ExplosiveMaterial' || objectType === 'Charge2D') {
                if (gpuChargeSolidBuffer && chargeCount > 0) {
                    pEnc.setPipeline(pipelineToUse);
                    pEnc.setBindGroup(0, highlightSurfaceBindGroup);
                    pEnc.setVertexBuffer(0, gpuChargeSolidBuffer);
                    pEnc.draw(chargeCount);
                }
            } else if (objectType === 'VirtualGauges3D' || objectType === 'VirtualGauges' || objectType === 'PressureGauge' || objectType === 'VirtualGauge') {
                if (gpuGaugesBuffer && gaugesCount > 0) {
                    pEnc.setPipeline(pipelineToUse);
                    pEnc.setBindGroup(0, highlightSurfaceBindGroup);
                    pEnc.setVertexBuffer(0, gpuGaugesBuffer);
                    pEnc.draw(gaugesCount);
                }
            }
        }

        // Draw Solid Surface Holographic Fresnel Rim Highlights
        if (selectedObject) {
            renderObjectSurfaceHighlightWebGPU(passEncoder, selectedObject, 18.0);
        }
        if (hoveredObject && (!selectedObject || selectedObject.objectType !== hoveredObject.objectType || selectedObject.sliceIndex !== hoveredObject.sliceIndex || selectedObject.objectId !== hoveredObject.objectId || selectedObject.gaugeIndex !== hoveredObject.gaugeIndex)) {
            renderObjectSurfaceHighlightWebGPU(passEncoder, hoveredObject, 19.0);
        }

        passEncoder.end();
        gpuDevice.queue.submit([commandEncoder.finish()]);
        sendFrameMatrixMessage();
        return;
    }

    // WebGL fallback rendering
    if (!gl || !program) return;
    gl.clearColor(clearColor.r, clearColor.g, clearColor.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(program);
    if (glUniforms.uTexture) gl.uniform1i(glUniforms.uTexture, 0);
    if (glUniforms.uVolumeTexture3D) gl.uniform1i(glUniforms.uVolumeTexture3D, 1);

    if (gl.TEXTURE_3D) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, glVolume3DTexture || getDummy3DTextureGL());
        gl.activeTexture(gl.TEXTURE0);
    }

    const identityMat = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    if (glUniforms.uStlMatrix) gl.uniformMatrix4fv(glUniforms.uStlMatrix, false, identityMat);

    const uIsWF = glUniforms.uIsWireframe;
    const uAlpha = glUniforms.uAlpha;
    const uModel = glUniforms.uModel;
    const uMin = glUniforms.uMin;
    const uMax = glUniforms.uMax;
    const uColormap = glUniforms.uColormap;
    const uUseLog = glUniforms.uUseLogScale;

    if (glUniforms.uProjection) gl.uniformMatrix4fv(glUniforms.uProjection, false, projectionMatrix);
    if (uColormap) gl.uniform1i(uColormap, colormap);
    if (uMin) gl.uniform1f(uMin, minY);
    if (uMax) gl.uniform1f(uMax, maxY);
    if (uUseLog) gl.uniform1i(uUseLog, useLogScale ? 1 : 0);
    if (glUniforms.uIsAMR) gl.uniform1i(glUniforms.uIsAMR, meshType === 'amr' ? 1 : 0);
    if (glUniforms.uView) gl.uniformMatrix4fv(glUniforms.uView, false, viewMatrix);
    if (uModel) gl.uniformMatrix4fv(uModel, false, modelMatrix);
    if (uAlpha) gl.uniform1f(uAlpha, 1.0); // Will be overwritten per slice

    if (glUniforms.uEnableLighting) gl.uniform1i(glUniforms.uEnableLighting, lightingEnabled ? 1 : 0);
    if (glUniforms.uEnableAO) gl.uniform1i(glUniforms.uEnableAO, aoEnabled ? 1 : 0);
    if (glUniforms.uAoRadius) gl.uniform1f(glUniforms.uAoRadius, aoRadius);
    if (glUniforms.uAoIntensity) gl.uniform1f(glUniforms.uAoIntensity, aoIntensity);
    if (glUniforms.uAoBias) gl.uniform1f(glUniforms.uAoBias, aoBias);
    if (glUniforms.uAoSphereImpostor) gl.uniform1i(glUniforms.uAoSphereImpostor, aoSphereImpostor ? 1 : 0);
    if (glUniforms.uAmbientLevel) gl.uniform1f(glUniforms.uAmbientLevel, ambientLevel);
    if (glUniforms.uSpecularLevel) gl.uniform1f(glUniforms.uSpecularLevel, specularIntensity);

    // Draw BBox
    if (showGrid && bboxBuffer) {
        if (uIsWF) gl.uniform1i(uIsWF, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, bboxBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.drawArrays(gl.LINES, 0, bboxVertexCount);
    }

    if (amrTilesBuffer && amrTilesCount > 0) {
        if (uIsWF) gl.uniform1i(uIsWF, 10);
        gl.bindBuffer(gl.ARRAY_BUFFER, amrTilesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.drawArrays(gl.LINES, 0, amrTilesCount);
    }

    // Draw STL Geometry fallback in WebGL
    let stlDrawnThisFrameWebGL = false;
    const drawSTLWebGL = () => {
        if (stlDrawnThisFrameWebGL) return;
        if (!gl || !showSTL || !stlBuffer || !transformedSTLVertices || transformedSTLVertices.length === 0) return;
        const activeGl = gl;
        const count = transformedSTLVertices.length / 7;
        if (count === 0) return;

        const sizeX = getDimX();
        const sizeY = getDimY();
        const sizeZ = getDimZ();
        const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
        const invMax = 1.0 / maxSize;
        const cx = xmin + sizeX * 0.5;
        const cy = ymin + sizeY * 0.5;
        const cz = zmin + sizeZ * 0.5;

        stlFinalModelMat.set([
            invMax, 0, 0, 0,
            0, invMax, 0, 0,
            0, 0, invMax, 0,
            -cx * invMax, -cy * invMax, -cz * invMax, 1
        ]);
        if (uModel) activeGl.uniformMatrix4fv(uModel, false, stlFinalModelMat);

        const sx = 1.0 / sizeX;
        const sy = 1.0 / sizeY;
        const sz = 1.0 / sizeZ;
        const tx = -xmin * sx - 0.5;
        const ty = -ymin * sy - 0.5;
        const tz = -zmin * sz - 0.5;
        stlModelMat.set([
            sx, 0, 0, 0,
            0, sy, 0, 0,
            0, 0, sz, 0,
            tx, ty, tz, 1
        ]);
        if (glUniforms.uStlMatrix) activeGl.uniformMatrix4fv(glUniforms.uStlMatrix, false, stlModelMat);

        activeGl.bindBuffer(activeGl.ARRAY_BUFFER, stlBuffer);
        activeGl.vertexAttribPointer(0, 3, activeGl.FLOAT, false, 28, 0);
        activeGl.enableVertexAttribArray(0);
        activeGl.vertexAttribPointer(1, 2, activeGl.FLOAT, false, 28, 12);
        activeGl.enableVertexAttribArray(1);
        activeGl.vertexAttribPointer(2, 2, activeGl.FLOAT, false, 28, 20);
        activeGl.enableVertexAttribArray(2);
        if (glVolume3DTexture && activeGl.TEXTURE_3D) {
            activeGl.activeTexture(activeGl.TEXTURE1);
            activeGl.bindTexture(activeGl.TEXTURE_3D, glVolume3DTexture);
            const filter = (stlSamplingMode === 'linear') ? activeGl.LINEAR : activeGl.NEAREST;
            activeGl.texParameteri(activeGl.TEXTURE_3D, activeGl.TEXTURE_MIN_FILTER, filter);
            activeGl.texParameteri(activeGl.TEXTURE_3D, activeGl.TEXTURE_MAG_FILTER, filter);
            
            if (glUniforms.uVolumeTexture3D) activeGl.uniform1i(glUniforms.uVolumeTexture3D, 1);
        }
        
        const cStlQ = canonicalizeQuantity(stlQuantity);
        const stlIsLocked = lockQuantityRanges && (stlLockQuantityRange !== false);
        const effectiveStlCmap = stlIsLocked ? (quantityColormaps[cStlQ] || quantityColormaps[stlQuantity] || stlColormap) : stlColormap;
        const effectiveStlLog = stlIsLocked ? (quantityLogScales[cStlQ] ?? quantityLogScales[stlQuantity] ?? stlLogScale) : stlLogScale;
        const effectiveStlAuto = stlIsLocked ? ((quantityAutoScales[cStlQ] ?? quantityAutoScales[stlQuantity]) !== false) : (stlAutoScale !== false);
        
        if (glUniforms.uStlShowResults) activeGl.uniform1i(glUniforms.uStlShowResults, stlShowResults ? 1 : 0);
        if (glUniforms.uStlColormap) activeGl.uniform1i(glUniforms.uStlColormap, getColormapIndex(effectiveStlCmap));
        if (glUniforms.uDomainMin) activeGl.uniform3f(glUniforms.uDomainMin, xmin, ymin, zmin);
        if (glUniforms.uDomainExtent) activeGl.uniform3f(glUniforms.uDomainExtent, sizeX, sizeY, sizeZ);
        if (glUniforms.uDx) activeGl.uniform1f(glUniforms.uDx, dx || 0.01);

        const defaultStlRange = quantityRanges[cStlQ] || quantityRanges[stlQuantity] || DEFAULT_QUANTITY_RANGES[cStlQ] || DEFAULT_QUANTITY_RANGES[stlQuantity] || [0.0, 1.0];
        let finalStlMin = defaultStlRange[0];
        let finalStlMax = defaultStlRange[1];
        if (stlIsLocked) {
            finalStlMin = defaultStlRange[0];
            finalStlMax = defaultStlRange[1];
        } else if (effectiveStlAuto) {
            if (isFinite(stlVolMin) && isFinite(stlVolMax) && stlVolMax > stlVolMin) {
                finalStlMin = stlVolMin;
                finalStlMax = stlVolMax;
            }
        } else {
            finalStlMin = stlMinVal ?? defaultStlRange[0];
            finalStlMax = stlMaxVal ?? defaultStlRange[1];
        }

        if (glUniforms.uStlMin) activeGl.uniform1f(glUniforms.uStlMin, finalStlMin);
        if (glUniforms.uStlMax) activeGl.uniform1f(glUniforms.uStlMax, finalStlMax);
        if (glUniforms.uStlLogScale) activeGl.uniform1i(glUniforms.uStlLogScale, effectiveStlLog ? 1 : 0);

        if (stlSolids && stlOpacity > 0.001) {
            stlDrawnThisFrameWebGL = true;
            const isTransparent = stlOpacity < 0.999;
            if (isTransparent) activeGl.depthMask(false);
            if (uIsWF) activeGl.uniform1i(uIsWF, stlWireframe ? 7 : 5); // 7 = Solid + Wireframe, 5 = Solid only
            if (uAlpha) activeGl.uniform1f(uAlpha, stlOpacity);
            activeGl.drawArrays(activeGl.TRIANGLES, 0, count);
            if (isTransparent) activeGl.depthMask(true);
        } else if (stlWireframe) {
            stlDrawnThisFrameWebGL = true;
            activeGl.depthMask(false);
            if (uIsWF) activeGl.uniform1i(uIsWF, 6); // 6 = Wireframe only
            if (uAlpha) activeGl.uniform1f(uAlpha, 0.0);
            activeGl.drawArrays(activeGl.TRIANGLES, 0, count);
            activeGl.depthMask(true);
        }

        // Restore base model matrix for slices and reset uStlMatrix
        if (uModel) activeGl.uniformMatrix4fv(uModel, false, modelMatrix);
        if (glUniforms.uStlMatrix) activeGl.uniformMatrix4fv(glUniforms.uStlMatrix, false, identityMat);
    };

    if (stlOpacity >= 0.999) {
        drawSTLWebGL();
    }

    // Draw Gauges in WebGL fallback
    if (showGauges && gaugesBuffer && gaugesCount > 0) {
        if (uIsWF) gl.uniform1i(uIsWF, 8); // uIsWireframe = 8 (Gauges color & solid mode)
        if (uAlpha) gl.uniform1f(uAlpha, 1.0);
        gl.bindBuffer(gl.ARRAY_BUFFER, gaugesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);
        gl.drawArrays(gl.TRIANGLES, 0, gaugesCount);
    }

    // Draw Obstacle Surfaces in WebGL fallback
    if (showObstacles && obstacleBuffer && obstacleTriIndexCount > 0) {
        const sizeX = getDimX();
        const sizeY = getDimY();
        const sizeZ = getDimZ();
        const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
        const invMax = 1.0 / maxSize;
        const cx = xmin + sizeX * 0.5;
        const cy = ymin + sizeY * 0.5;
        const cz = zmin + sizeZ * 0.5;

        obsFinalModelMat.set([
            invMax, 0, 0, 0,
            0, invMax, 0, 0,
            0, 0, invMax, 0,
            -cx * invMax, -cy * invMax, -cz * invMax, 1
        ]);
        if (uModel) gl.uniformMatrix4fv(uModel, false, obsFinalModelMat);

        gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);

        const cObsQ = canonicalizeQuantity(obstaclesQuantity);
        let obsMin = obstaclesMinVal;
        let obsMax = obstaclesMaxVal;
        const defaultObsRange = quantityRanges[cObsQ] || quantityRanges[obstaclesQuantity] || DEFAULT_QUANTITY_RANGES[cObsQ] || DEFAULT_QUANTITY_RANGES[obstaclesQuantity] || [0.0, 1.0];
        const effectiveObsAuto = lockQuantityRanges ? ((quantityAutoScales[cObsQ] ?? quantityAutoScales[obstaclesQuantity]) !== false) : (obstaclesAutoScale !== false);
        if (lockQuantityRanges) {
            obsMin = defaultObsRange[0];
            obsMax = defaultObsRange[1];
        } else if (effectiveObsAuto) {
            if (isFinite(cachedObstaclesMinVal) && isFinite(cachedObstaclesMaxVal) && cachedObstaclesMaxVal > cachedObstaclesMinVal) {
                obsMin = cachedObstaclesMinVal;
                obsMax = cachedObstaclesMaxVal;
            } else {
                obsMin = defaultObsRange[0];
                obsMax = defaultObsRange[1];
            }
        } else {
            obsMin = obstaclesMinVal ?? defaultObsRange[0];
            obsMax = obstaclesMaxVal ?? defaultObsRange[1];
        }

        const effectiveObsCmap = lockQuantityRanges ? (quantityColormaps[cObsQ] || quantityColormaps[obstaclesQuantity] || obstaclesColormap) : obstaclesColormap;
        const effectiveObsLog = lockQuantityRanges ? (quantityLogScales[cObsQ] ?? quantityLogScales[obstaclesQuantity] ?? obstaclesLogScale) : obstaclesLogScale;

        // Solid pass
        if (obstaclesOpacity > 0.001) {
            const isTransparentObs = obstaclesOpacity < 0.999;
            if (isTransparentObs) gl.depthMask(false);
            if (uIsWF) gl.uniform1i(uIsWF, obstaclesLighting ? 9 : 11);
            if (uAlpha) gl.uniform1f(uAlpha, obstaclesOpacity);
            if (glUniforms.uColormap) gl.uniform1i(glUniforms.uColormap, getColormapIndex(effectiveObsCmap));
            if (glUniforms.uMin) gl.uniform1f(glUniforms.uMin, obsMin);
            if (glUniforms.uMax) gl.uniform1f(glUniforms.uMax, obsMax);
            if (glUniforms.uUseLogScale) gl.uniform1i(glUniforms.uUseLogScale, effectiveObsLog ? 1.0 : 0.0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleTriIndexBuffer);
            gl.drawElements(gl.TRIANGLES, obstacleTriIndexCount, gl.UNSIGNED_INT, 0);
            if (isTransparentObs) gl.depthMask(true);
        }

        // Gridlines pass
        if (obstaclesGridlines) {
            if (uIsWF) gl.uniform1i(uIsWF, 10);
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleWireIndexBuffer);
            gl.drawElements(gl.LINES, obstacleWireIndexCount, gl.UNSIGNED_INT, 0);
        }

        // Restore base model matrix
        if (uModel) gl.uniformMatrix4fv(uModel, false, modelMatrix);
        if (glUniforms.uStlMatrix) gl.uniformMatrix4fv(glUniforms.uStlMatrix, false, identityMat);
    }

    if (uIsWF) gl.uniform1i(uIsWF, 0);
    if (glUniforms.uShowCellEdges) {
        gl.uniform1i(glUniforms.uShowCellEdges, (meshType === 'amr') ? 0 : (shouldShowCellEdges() ? 1 : 0));
    }
    if (glUniforms.uInterpolate) {
        gl.uniform1i(glUniforms.uInterpolate, interpolate ? 1 : 0);
    }

    const getSliceProperties = (slice: SliceDataWebGL) => {
        let colormapVal = slice.colormap;
        let useLogScaleVal = slice.useLogScale;
        let interpolateVal = slice.interpolate;
        let minYVal = slice.minY;
        let maxYVal = slice.maxY;
        let opacityVal = slice.opacity;

        if (slice.is_submesh) {
            const parent = Object.values(activeSlicesWebGL).find(p => !p.is_submesh && p.axis === slice.axis && Math.abs(p.offset - slice.offset) < 1e-4);
            if (parent) {
                colormapVal = parent.colormap;
                useLogScaleVal = parent.useLogScale;
                interpolateVal = parent.interpolate;
                minYVal = parent.minY;
                maxYVal = parent.maxY;
                opacityVal = parent.opacity;
            }
        }
        return {
            colormap: colormapVal,
            useLogScale: useLogScaleVal,
            interpolate: interpolateVal,
            minY: minYVal,
            maxY: maxYVal,
            opacity: opacityVal
        };
    };

    const getSubmeshMasks = (slice: SliceDataWebGL) => {
        const masks: number[] = [];
        let numMasks = 0;
        slicesArrayWebGL.forEach(other => {
            if (other.is_submesh && other.axis === slice.axis && Math.abs(other.offset - slice.offset) < 1e-4 && other.level > (slice.level || 0)) {
                let min1 = 0, max1 = 0, min2 = 0, max2 = 0;
                if (slice.axis === 0) { // XY
                    min1 = normX(other.xmin); max1 = normX(other.xmax);
                    min2 = normY(other.ymin); max2 = normY(other.ymax);
                } else if (slice.axis === 1) { // XZ
                    min1 = normX(other.xmin); max1 = normX(other.xmax);
                    min2 = normZ(other.zmin); max2 = normZ(other.zmax);
                } else { // YZ
                    min1 = normY(other.ymin); max1 = normY(other.ymax);
                    min2 = normZ(other.zmin); max2 = normZ(other.zmax);
                }
                masks.push(min1, max1, min2, max2);
                numMasks++;
            }
        });
        return { masks: masks.slice(0, 128), numMasks: Math.min(numMasks, 32) };
    };

    const slicesArrayWebGL = (showSlices !== false) ? Object.values(activeSlicesWebGL).filter(s => {
        const cfg = getSliceConfig(s.index);
        return !cfg || cfg.enabled !== false;
    }) : [];

    if (slicesArrayWebGL.length > 0) {
        const opaqueSlices = slicesArrayWebGL.filter(s => {
            const props = getSliceProperties(s);
            return props.opacity >= 0.999;
        });
        const transparentSlices = slicesArrayWebGL.filter(s => {
            const props = getSliceProperties(s);
            return props.opacity < 0.999;
        });

        // Pass 1: Opaque Slices (depth write enabled)
        opaqueSlices.forEach(slice => {
            const props = getSliceProperties(slice);

            if (uIsWF) gl!.uniform1i(uIsWF, 0);
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

            if (uMin) gl!.uniform1f(uMin, props.minY ?? minY);
            if (uMax) gl!.uniform1f(uMax, props.maxY ?? maxY);
            if (uColormap) gl!.uniform1i(uColormap, getColormapIndex(props.colormap));
            if (uUseLog) gl!.uniform1i(uUseLog, props.useLogScale ? 1 : 0);
            if (glUniforms.uInterpolate) gl!.uniform1i(glUniforms.uInterpolate, props.interpolate ? 1 : 0);
            if (uAlpha) gl!.uniform1f(uAlpha, 1.0);

            // Set submesh mask uniforms
            if (glUniforms.uAxis) gl!.uniform1i(glUniforms.uAxis, slice.axis);
            if (glUniforms.uIsSubmesh) gl!.uniform1i(glUniforms.uIsSubmesh, slice.is_submesh ? 1 : 0);
            const { masks, numMasks } = getSubmeshMasks(slice);
            if (glUniforms.uNumSubmeshMasks) gl!.uniform1i(glUniforms.uNumSubmeshMasks, numMasks);
            if (glUniforms.uSubmeshMasks && numMasks > 0) {
                gl!.uniform4fv(glUniforms.uSubmeshMasks, new Float32Array(masks));
            }

            gl!.drawArrays(gl!.TRIANGLES, 0, 6);
        });

        // Transparent STL pass (if opacity < 0.999, rendered after opaque slices)
        if (stlOpacity < 0.999) {
            drawSTLWebGL();
        }

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
                const props = getSliceProperties(slice);

                if (uIsWF) gl!.uniform1i(uIsWF, 0);
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

                if (uMin) gl!.uniform1f(uMin, props.minY ?? minY);
                if (uMax) gl!.uniform1f(uMax, props.maxY ?? maxY);
                if (uColormap) gl!.uniform1i(uColormap, getColormapIndex(props.colormap));
                if (uUseLog) gl!.uniform1i(uUseLog, props.useLogScale ? 1 : 0);
                if (glUniforms.uInterpolate) gl!.uniform1i(glUniforms.uInterpolate, props.interpolate ? 1 : 0);
                if (uAlpha) gl!.uniform1f(uAlpha, props.opacity);

                // Set submesh mask uniforms
                if (glUniforms.uAxis) gl!.uniform1i(glUniforms.uAxis, slice.axis);
                if (glUniforms.uIsSubmesh) gl!.uniform1i(glUniforms.uIsSubmesh, slice.is_submesh ? 1 : 0);
                const { masks, numMasks } = getSubmeshMasks(slice);
                if (glUniforms.uNumSubmeshMasks) gl!.uniform1i(glUniforms.uNumSubmeshMasks, numMasks);
                if (glUniforms.uSubmeshMasks && numMasks > 0) {
                    gl!.uniform4fv(glUniforms.uSubmeshMasks, new Float32Array(masks));
                }

                gl!.drawArrays(gl!.TRIANGLES, 0, 6);
            });

            gl.depthMask(true);
        }

        if (sliceGridlinesBuffer && sliceGridlinesCount > 0) {
            gl.depthMask(false);
            if (uIsWF) gl.uniform1i(uIsWF, 10);
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, sliceGridlinesBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, sliceGridlinesCount);
            gl.depthMask(true);
        }
    }

    // Transparent STL fallback if no slices were active
    if (stlOpacity < 0.999) {
        drawSTLWebGL();
    }

    // Draw 3D MPM Particles Point Cloud
    if (showMPMParticles && mpmParticlesBuffer && mpmParticlesCount > 0) {
        if (uIsWF) gl.uniform1i(uIsWF, 14);
        if (uAlpha) gl.uniform1f(uAlpha, mpmParticleOpacity);
        if (glUniforms.uParticleSize) gl.uniform1f(glUniforms.uParticleSize, mpmParticleSize || 4.0);
        const maxSize = Math.max(getDimX(), getDimY(), getDimZ()) || 1.0;
        const pPerDim = Math.max(1, Math.round(Math.cbrt(ppc || 8)));
        const autoDiam = (latestEmpiricalSpacing > 0) ? (latestEmpiricalSpacing * 0.8) : (((dx || 0.001) / pPerDim) * 0.8);
        const pDiam = (mpmParticleDiameter !== undefined && mpmParticleDiameter > 0) ? mpmParticleDiameter : autoDiam;
        const viewDiam = (pDiam > 0 && maxSize > 0) ? (pDiam / maxSize) : 0.0;
        if (glUniforms.uParticleDiameter) gl.uniform1f(glUniforms.uParticleDiameter, viewDiam);
        if (glUniforms.uViewportHeight) gl.uniform1f(glUniforms.uViewportHeight, canvasHeight());

        gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);  // position (x, y, z)
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12); // texCoord = (r, g)
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20); // sliceSize = (b, 0)
        gl.enableVertexAttribArray(2);
        gl.drawArrays(gl.POINTS, 0, mpmParticlesCount);
    }

    // Draw 3D FEM Mesh (Solid Surface & Wireframe Edges)
    if (showFEMMesh || showRebar || showBeams) {
        if ((femSolid || beamSolid || rebarSolid) && femSolidBuffer && femSolidCount > 0) {
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(1.0, 1.0);
            if (uIsWF) gl.uniform1i(uIsWF, 14);
            if (uAlpha) gl.uniform1f(uAlpha, femOpacity);
            gl.bindBuffer(gl.ARRAY_BUFFER, femSolidBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);  // position (x, y, z)
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12); // (r, g)
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20); // (b)
            gl.enableVertexAttribArray(2);
            gl.drawArrays(gl.TRIANGLES, 0, femSolidCount);
            gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        if ((femWireframe || beamWireframe || rebarWireframe) && femWireframeBuffer && femWireframeCount > 0) {
            if (uIsWF) gl.uniform1i(uIsWF, 15);
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, femWireframeBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, femWireframeCount);
        }
    }

    // Draw Charge Geometry
    if (showCharge) {
        if (chargeSolid && chargeBuffer && chargeCount > 0) {
            if (uIsWF) gl.uniform1i(uIsWF, 13);
            if (uAlpha) gl.uniform1f(uAlpha, chargeOpacity);
            gl.bindBuffer(gl.ARRAY_BUFFER, chargeBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
            gl.enableVertexAttribArray(2);
            gl.drawArrays(gl.TRIANGLES, 0, chargeCount);
        }
        if (chargeWireframe && chargeWireBuffer && chargeWireCount > 0) {
            if (uIsWF) gl.uniform1i(uIsWF, 13);
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, chargeWireBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, chargeWireCount);
        }
    }

    // Draw Detonator Markers in WebGL
    if (showDetonators) {
        if (detonatorSolid && detonatorBuffer && detonatorCount > 0) {
            if (uIsWF) gl.uniform1i(uIsWF, 20); // 20 = Detonator Solid
            if (uAlpha) gl.uniform1f(uAlpha, detonatorOpacity);
            gl.bindBuffer(gl.ARRAY_BUFFER, detonatorBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
            gl.enableVertexAttribArray(2);
            gl.drawArrays(gl.TRIANGLES, 0, detonatorCount);
        }
        if (detonatorWireframe && detonatorWireBuffer && detonatorWireCount > 0) {
            if (uIsWF) gl.uniform1i(uIsWF, 21); // 21 = Detonator Wireframe
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, detonatorWireBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, detonatorWireCount);
        }
    }

    // Draw Uninitialized MPM Object Wireframes in WebGL
    if (showMPMParticles && mpmParticlesCount === 0 && mpmPreviewBuffer && mpmPreviewCount > 0) {
        if (uIsWF) gl.uniform1i(uIsWF, 16); // Vibrant Electric Cyan
        if (uAlpha) gl.uniform1f(uAlpha, 0.9);
        gl.bindBuffer(gl.ARRAY_BUFFER, mpmPreviewBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.drawArrays(gl.LINES, 0, mpmPreviewCount);
    }

    // Draw Primary Selection Highlight (Electric Cyan Frame & Accents)
    if (selectedObject) {
        const selectedKey = `${selectedObject.objectType}_${selectedObject.sliceIndex}_${selectedObject.objectId}_${selectedObject.gaugeIndex}_${selectedObject.x}_${selectedObject.y}_${selectedObject.z}_${selectedObject.radius}_${selectedObject.height}_${selectedObject.size_x}_${selectedObject.size_y}_${selectedObject.size_z}_${selectedObject.shape}_${selectedObject.rot_x}_${selectedObject.rot_y}_${selectedObject.rot_z}`;
        if (cachedSelectedKey !== selectedKey) {
            cachedSelectedKey = selectedKey;
            cachedSelectedVerts = buildComponentHighlightGeometry(selectedObject);
            if (cachedSelectedVerts.length > 0) {
                if (!highlightWireBuffer) highlightWireBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, highlightWireBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, cachedSelectedVerts, gl.DYNAMIC_DRAW);
            }
        }
        if (cachedSelectedVerts.length > 0 && highlightWireBuffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, highlightWireBuffer);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            if (uIsWF) gl.uniform1i(uIsWF, 16); // 16 = Selection Highlight (Electric Cyan #00f0ff)
            if (uAlpha) gl.uniform1f(uAlpha, 1.0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, cachedSelectedVerts.length / 5);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
        }
    } else {
        cachedSelectedKey = null;
    }

    // Draw Hover Emphasis (Amber / Gold Accent)
    if (hoveredObject && (!selectedObject || selectedObject.objectType !== hoveredObject.objectType || selectedObject.sliceIndex !== hoveredObject.sliceIndex || selectedObject.objectId !== hoveredObject.objectId || selectedObject.gaugeIndex !== hoveredObject.gaugeIndex)) {
        const hoverKey = `${hoveredObject.objectType}_${hoveredObject.sliceIndex}_${hoveredObject.objectId}_${hoveredObject.gaugeIndex}_${hoveredObject.x}_${hoveredObject.y}_${hoveredObject.z}_${hoveredObject.radius}_${hoveredObject.height}_${hoveredObject.size_x}_${hoveredObject.size_y}_${hoveredObject.size_z}_${hoveredObject.shape}_${hoveredObject.rot_x}_${hoveredObject.rot_y}_${hoveredObject.rot_z}`;
        if (cachedHoverKey !== hoverKey) {
            cachedHoverKey = hoverKey;
            cachedHoverVerts = buildComponentHighlightGeometry(hoveredObject);
            if (cachedHoverVerts.length > 0) {
                if (!hoverWireBuffer) hoverWireBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, hoverWireBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, cachedHoverVerts, gl.DYNAMIC_DRAW);
            }
        }
        if (cachedHoverVerts.length > 0 && hoverWireBuffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, hoverWireBuffer);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            if (uIsWF) gl.uniform1i(uIsWF, 17); // 17 = Hover Emphasis (Amber #fbbf24)
            if (uAlpha) gl.uniform1f(uAlpha, 0.9);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, cachedHoverVerts.length / 5);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
        }
    } else {
        cachedHoverKey = null;
    }

    function renderObjectSurfaceHighlightWebGL(targetObj: any, highlightMode: number) {
        if (!gl || !targetObj || !targetObj.objectType) return;
        const { objectType } = targetObj;

        if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
            if (obstacleBuffer && obstacleTriIndexCount > 0) {
                const sizeX = getDimX();
                const sizeY = getDimY();
                const sizeZ = getDimZ();
                const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
                const invMax = 1.0 / maxSize;
                const cx = xmin + sizeX * 0.5;
                const cy = ymin + sizeY * 0.5;
                const cz = zmin + sizeZ * 0.5;

                obsFinalModelMat.set([
                    invMax, 0, 0, 0,
                    0, invMax, 0, 0,
                    0, 0, invMax, 0,
                    -cx * invMax, -cy * invMax, -cz * invMax, 1
                ]);
                if (uModel) gl.uniformMatrix4fv(uModel, false, obsFinalModelMat);

                gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
                gl.enableVertexAttribArray(2);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                if (uIsWF) gl.uniform1i(uIsWF, highlightMode); // 18 = Selection Cyan, 19 = Hover Amber
                if (uAlpha) gl.uniform1f(uAlpha, 1.0);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleTriIndexBuffer);
                gl.drawElements(gl.TRIANGLES, obstacleTriIndexCount, gl.UNSIGNED_INT, 0);
                gl.depthMask(true);

                if (uModel) gl.uniformMatrix4fv(uModel, false, modelMatrix);
            }
        } else if (objectType === 'STLGeometry') {
            if (stlBuffer && transformedSTLVertices && transformedSTLVertices.length > 0) {
                const count = transformedSTLVertices.length / 7;
                const sizeX = getDimX();
                const sizeY = getDimY();
                const sizeZ = getDimZ();
                const maxSize = Math.max(sizeX, sizeY, sizeZ) || 1.0;
                const invMax = 1.0 / maxSize;
                const cx = xmin + sizeX * 0.5;
                const cy = ymin + sizeY * 0.5;
                const cz = zmin + sizeZ * 0.5;

                stlFinalModelMat.set([
                    invMax, 0, 0, 0,
                    0, invMax, 0, 0,
                    0, 0, invMax, 0,
                    -cx * invMax, -cy * invMax, -cz * invMax, 1
                ]);
                if (uModel) gl.uniformMatrix4fv(uModel, false, stlFinalModelMat);

                gl.bindBuffer(gl.ARRAY_BUFFER, stlBuffer);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
                gl.enableVertexAttribArray(2);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                if (uIsWF) gl.uniform1i(uIsWF, highlightMode);
                if (uAlpha) gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, 0, count);
                gl.depthMask(true);

                if (uModel) gl.uniformMatrix4fv(uModel, false, modelMatrix);
            }
        } else if (objectType === 'FEMObject3D' || objectType === 'FEMMesh3D' || objectType === 'FEMBeam3D' || objectType === 'FEMRebar3D' || objectType === 'LSDynaImporter3D') {
            if (femSolidBuffer && femSolidCount > 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, femSolidBuffer);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
                gl.enableVertexAttribArray(2);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                if (uIsWF) gl.uniform1i(uIsWF, highlightMode);
                if (uAlpha) gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, 0, femSolidCount);
                gl.depthMask(true);
            }
        } else if (objectType === 'Charge3D' || objectType === 'Charge' || objectType === 'ExplosiveMaterial' || objectType === 'Charge2D') {
            if (chargeBuffer && chargeCount > 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, chargeBuffer);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
                gl.enableVertexAttribArray(2);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                if (uIsWF) gl.uniform1i(uIsWF, highlightMode);
                if (uAlpha) gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, 0, chargeCount);
                gl.depthMask(true);
            }
        } else if (objectType === 'VirtualGauges3D' || objectType === 'VirtualGauges' || objectType === 'PressureGauge' || objectType === 'VirtualGauge') {
            if (gaugesBuffer && gaugesCount > 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, gaugesBuffer);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
                gl.enableVertexAttribArray(2);

                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                if (uIsWF) gl.uniform1i(uIsWF, highlightMode);
                if (uAlpha) gl.uniform1f(uAlpha, 1.0);
                gl.drawArrays(gl.TRIANGLES, 0, gaugesCount);
                gl.depthMask(true);
            }
        }
    }

    // Draw Solid Surface Holographic Fresnel Rim Highlights
    if (selectedObject) {
        renderObjectSurfaceHighlightWebGL(selectedObject, 18);
    }
    if (hoveredObject && (!selectedObject || selectedObject.objectType !== hoveredObject.objectType || selectedObject.sliceIndex !== hoveredObject.sliceIndex || selectedObject.objectId !== hoveredObject.objectId || selectedObject.gaugeIndex !== hoveredObject.gaugeIndex)) {
        renderObjectSurfaceHighlightWebGL(hoveredObject, 19);
    }

    if (gl) gl.flush();
    drawOverlayTicks();
    sendFrameMatrixMessage();
}

function getTickInterval(minVal: number, maxVal: number, targetTicks: number = 5): { major: number, minor: number } {
    const range = maxVal - minVal;
    if (range <= 0) return { major: 1, minor: 0.1 };
    
    const rawStep = range / targetTicks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    
    let step = magnitude;
    if (normalized >= 5) {
        step = 5 * magnitude;
    } else if (normalized >= 2) {
        step = 2 * magnitude;
    }
    
    return {
        major: step,
        minor: step / 5
    };
}

function formatTickValue(val: number, step: number): string {
    if (Math.abs(val) > 0.0001 && Math.abs(val) < 0.001) {
        return val.toExponential(1);
    }
    if (Math.abs(val) < 1e-4 || Math.abs(val) >= 1e5) {
        return val.toExponential(2);
    }
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    return val.toFixed(decimals);
}

function drawOverlayTicks(): void {
    if (!overlayCanvas || !overlayCtx) return;
    const ctx = overlayCtx;
    const width = overlayCanvas.width;
    const height = overlayCanvas.height;

    ctx.clearRect(0, 0, width, height);

    if (!showGrid && !showGridBox) return;

    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();

    if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) return;

    const mvp = multiplyMatrices(projectionMatrix, multiplyMatrices(viewMatrix, modelMatrix));

    const project = (x: number, y: number, z: number) => {
        const bx = (x - xmin) / sizeX - 0.5;
        const by = (y - ymin) / sizeY - 0.5;
        const bz = (z - zmin) / sizeZ - 0.5;
        const mx = bx;
        const my = by;
        const mz = bz;

        const w = mvp[3] * mx + mvp[7] * my + mvp[11] * mz + mvp[15] || 1;
        const screenX = (mvp[0] * mx + mvp[4] * my + mvp[8] * mz + mvp[12]) / w;
        const screenY = (mvp[1] * mx + mvp[5] * my + mvp[9] * mz + mvp[13]) / w;

        return {
            x: (screenX * 0.5 + 0.5) * width,
            y: (1.0 - (screenY * 0.5 + 0.5)) * height,
            w
        };
    };

    const centerProj = project((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2);
    if (centerProj.w < 0.1) return;

    const dpr = devicePixelRatio || 1;
    const depthScale = Math.max(0.5, Math.min(1.4, 2.0 / centerProj.w));
    const scale = depthScale * dpr;

    const fontSize = Math.round(10 * scale);
    ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;

    const axes = [
        {
            name: 'X',
            color: '#ff5555',
            min: xmin,
            max: xmax,
            offsetDir: [0, -1, 0],
            pointAt: (val: number) => [val, ymin, zmin],
            labelSuffix: 'm'
        },
        {
            name: 'Y',
            color: '#55ff55',
            min: ymin,
            max: ymax,
            offsetDir: [1, 0, 0],
            pointAt: (val: number) => [xmax, val, zmin],
            labelSuffix: 'm'
        },
        {
            name: 'Z',
            color: '#55aaff',
            min: zmin,
            max: zmax,
            offsetDir: [-1, 0, 0],
            pointAt: (val: number) => [xmin, ymin, val],
            labelSuffix: 'm'
        }
    ];

    const dx_physical = (xmax - xmin) * 0.05;
    const dy_physical = (ymax - ymin) * 0.05;
    const dz_physical = (zmax - zmin) * 0.05;

    for (const axis of axes) {
        const pStart = project(axis.pointAt(axis.min)[0], axis.pointAt(axis.min)[1], axis.pointAt(axis.min)[2]);
        const pEnd = project(axis.pointAt(axis.max)[0], axis.pointAt(axis.max)[1], axis.pointAt(axis.max)[2]);
        const screenLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
        const targetTicks = Math.max(2, Math.min(5, Math.floor(screenLen / (90 * dpr))));

        const { major, minor } = getTickInterval(axis.min, axis.max, targetTicks);
        
        let tickVal = Math.ceil(axis.min / major) * major;
        const limit = axis.max + major * 1e-5;

        let lastLabelPos: { x: number, y: number } | null = null;

        while (tickVal <= limit) {
            const val = tickVal;
            const clampedVal = Math.max(axis.min, Math.min(axis.max, val));
            const [ax, ay, az] = axis.pointAt(clampedVal);
            
            const pBase = project(ax, ay, az);
            if (pBase.w < 0.1) {
                tickVal += major;
                continue;
            }

            const ox = ax + axis.offsetDir[0] * dx_physical;
            const oy = ay + axis.offsetDir[1] * dy_physical;
            const oz = az + axis.offsetDir[2] * dz_physical;
            const pOff = project(ox, oy, oz);

            if (pOff.w < 0.1) {
                tickVal += major;
                continue;
            }

            let dx = pOff.x - pBase.x;
            let dy = pOff.y - pBase.y;
            let len = Math.sqrt(dx * dx + dy * dy);
            let ux = 0;
            let uy = 1;
            if (len > 0.001) {
                ux = dx / len;
                uy = dy / len;
            }

            const L_major = 8 * scale;
            const L_label = 16 * scale;

            const pTickEnd = {
                x: pBase.x + ux * L_major,
                y: pBase.y + uy * L_major
            };

            const pLabelPos = {
                x: pBase.x + ux * L_label,
                y: pBase.y + uy * L_label
            };

            ctx.beginPath();
            ctx.moveTo(pBase.x, pBase.y);
            ctx.lineTo(pTickEnd.x, pTickEnd.y);
            ctx.strokeStyle = axis.color;
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();

            let skipLabel = false;
            if (lastLabelPos) {
                const dist = Math.hypot(pLabelPos.x - lastLabelPos.x, pLabelPos.y - lastLabelPos.y);
                if (dist < 45 * dpr) {
                    skipLabel = true;
                }
            }

            if (!skipLabel) {
                ctx.fillStyle = '#ffffff';
                
                if (ux > 0.3) ctx.textAlign = 'left';
                else if (ux < -0.3) ctx.textAlign = 'right';
                else ctx.textAlign = 'center';

                if (uy > 0.3) ctx.textBaseline = 'top';
                else if (uy < -0.3) ctx.textBaseline = 'bottom';
                else ctx.textBaseline = 'middle';

                const displayVal = formatTickValue(clampedVal, major);
                ctx.fillText(`${displayVal}${axis.labelSuffix}`, pLabelPos.x, pLabelPos.y);
                lastLabelPos = { x: pLabelPos.x, y: pLabelPos.y };
            }

            tickVal += major;
        }

        if (minor > 0 && screenLen > 160 * dpr) {
            let minorVal = Math.ceil(axis.min / minor) * minor;
            const minorLimit = axis.max + minor * 1e-5;
            while (minorVal <= minorLimit) {
                const nearestMajor = Math.round(minorVal / major) * major;
                if (Math.abs(minorVal - nearestMajor) < minor * 0.1) {
                    minorVal += minor;
                    continue;
                }

                const clampedVal = Math.max(axis.min, Math.min(axis.max, minorVal));
                const [ax, ay, az] = axis.pointAt(clampedVal);
                const pBase = project(ax, ay, az);
                if (pBase.w < 0.1) {
                    minorVal += minor;
                    continue;
                }

                const ox = ax + axis.offsetDir[0] * dx_physical;
                const oy = ay + axis.offsetDir[1] * dy_physical;
                const oz = az + axis.offsetDir[2] * dz_physical;
                const pOff = project(ox, oy, oz);
                if (pOff.w < 0.1) {
                    minorVal += minor;
                    continue;
                }

                let dx = pOff.x - pBase.x;
                let dy = pOff.y - pBase.y;
                let len = Math.sqrt(dx * dx + dy * dy);
                let ux = 0;
                let uy = 1;
                if (len > 0.001) {
                    ux = dx / len;
                    uy = dy / len;
                }

                const L_minor = 4 * scale;
                const pTickEnd = {
                    x: pBase.x + ux * L_minor,
                    y: pBase.y + uy * L_minor
                };

                ctx.beginPath();
                ctx.moveTo(pBase.x, pBase.y);
                ctx.lineTo(pTickEnd.x, pTickEnd.y);
                ctx.strokeStyle = axis.color;
                ctx.lineWidth = 1.0 * dpr;
                ctx.stroke();

                minorVal += minor;
            }
        }
    }
}

function sendFrameMatrixMessage() {
    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
    const maxSize = Math.max(sizeX, sizeY, sizeZ);
    const sX = sizeX / maxSize;
    const sY = sizeY / maxSize;
    const sZ = sizeZ / maxSize;
    const mvp = multiplyMatrices(projectionMatrix, multiplyMatrices(viewMatrix, modelMatrix));
    self.postMessage({
        type: 'renderFrame',
        data: {
            mvp: Array.from(mvp),
            xmin,
            xmax,
            ymin,
            ymax,
            zmin,
            zmax,
            sX,
            sY,
            sZ,
            showGridBox,
            showGrid
        }
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

let renderPending = false;
function requestRender(): void {
    if (renderPending) return;
    renderPending = true;
    const schedule = (typeof self.requestAnimationFrame === 'function')
        ? self.requestAnimationFrame.bind(self)
        : (cb: () => void) => setTimeout(cb, 0);
    schedule(() => {
        renderPending = false;
        const w = canvasWidth();
        const h = canvasHeight();
        updateMatrices(w, h);
        render();
    });
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
            
            // Apply the final dimensions to the initialized context
            const finalW = lastRequestedWidth !== null ? lastRequestedWidth : w;
            const finalH = lastRequestedHeight !== null ? lastRequestedHeight : h;
            if (is2DFallback && ctx2D) {
                ctx2D.canvas.width = finalW;
                ctx2D.canvas.height = finalH;
            } else if (gpuContext && gpuDevice) {
                const canvas = gpuContext.canvas as OffscreenCanvas;
                canvas.width = finalW;
                canvas.height = finalH;
                const prefFormat = nav && nav.gpu ? nav.gpu.getPreferredCanvasFormat() : 'bgra8unorm';
                gpuContext.configure({
                    device: gpuDevice,
                    format: prefFormat,
                    alphaMode: 'opaque'
                });
            } else if (gl) {
                gl.canvas.width = finalW;
                gl.canvas.height = finalH;
                gl.viewport(0, 0, finalW, finalH);
            }
            if (data.overlayCanvas) {
                overlayCanvas = data.overlayCanvas as OffscreenCanvas;
                overlayCtx = overlayCanvas.getContext('2d');
                overlayCanvas.width = finalW;
                overlayCanvas.height = finalH;
            }
            if (data.dpr !== undefined) {
                devicePixelRatio = data.dpr;
            }
            updateMatrices(finalW, finalH);
            render();
        } else if (type === "setSTLGeometry") {
            rawSTLVertices = data.vertices;
            rawSTLSubtractiveFlags = data.subtractive_flags;
            updateSTLGeometry();
            requestRender();
        } else if (type === "setObstaclesGeometry") {
            rawObstacleVertices = data.vertices;
            rawObstacleCells = data.cells;
            if (gl) {
                if (obstacleTriIndexBuffer) {
                    gl.deleteBuffer(obstacleTriIndexBuffer);
                    obstacleTriIndexBuffer = null;
                }
                if (obstacleWireIndexBuffer) {
                    gl.deleteBuffer(obstacleWireIndexBuffer);
                    obstacleWireIndexBuffer = null;
                }
            }
            if (isWebGPU && gpuDevice) {
                if (gpuObstaclesTriIndexBuffer) {
                    gpuObstaclesTriIndexBuffer.destroy();
                    gpuObstaclesTriIndexBuffer = null;
                }
                if (gpuObstaclesWireIndexBuffer) {
                    gpuObstaclesWireIndexBuffer.destroy();
                    gpuObstaclesWireIndexBuffer = null;
                }
            }
            updateObstaclesGeometry();
            requestRender();
        } else if (type === "resize") {
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            lastRequestedWidth = w;
            lastRequestedHeight = h;
            if (data.dpr !== undefined) {
                devicePixelRatio = data.dpr;
            }
            if (overlayCanvas) {
                overlayCanvas.width = w;
                overlayCanvas.height = h;
            }
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
                const zoomFactor = Math.exp(data.dy * 0.0015);
                if (hasCustomPivot) {
                    const newEyeX = pivotX + (cameraEyeX - pivotX) * zoomFactor;
                    const newEyeY = pivotY + (cameraEyeY - pivotY) * zoomFactor;
                    const newEyeZ = pivotZ + (cameraEyeZ - pivotZ) * zoomFactor;

                    const newTargetX = pivotX + (targetX - pivotX) * zoomFactor;
                    const newTargetY = pivotY + (targetY - pivotY) * zoomFactor;
                    const newTargetZ = pivotZ + (targetZ - pivotZ) * zoomFactor;

                    const newDist = Math.hypot(newEyeX - newTargetX, newEyeY - newTargetY, newEyeZ - newTargetZ);
                    if (newDist >= 0.0001 && newDist <= 10000.0) {
                        cameraEyeX = newEyeX;
                        cameraEyeY = newEyeY;
                        cameraEyeZ = newEyeZ;
                        targetX = newTargetX;
                        targetY = newTargetY;
                        targetZ = newTargetZ;
                        distance = newDist;

                        const diff = subtract([cameraEyeX, cameraEyeY, cameraEyeZ], [targetX, targetY, targetZ]);
                        if (distance > 1e-6) {
                            pitch = Math.asin(Math.max(-1, Math.min(1, diff[2] / distance)));
                            yaw = Math.atan2(diff[0], diff[1]);
                        }
                    }
                } else {
                    distance = Math.max(0.0001, Math.min(10000.0, distance * zoomFactor));
                    cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
                    cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
                    cameraEyeZ = targetZ + distance * Math.sin(pitch);
                }
            }
            if (data.drx !== undefined || data.dry !== undefined) {
                const drx = data.drx || 0; // vertical mouse delta (positive = down, negative = up)
                const dry = data.dry || 0; // horizontal mouse delta (positive = right, negative = left)
                const dYaw = dry * 0.008;
                const dPitch = drx * 0.008;

                if (hasCustomPivot) {
                    const P = [pivotX, pivotY, pivotZ];
                    const E = [cameraEyeX, cameraEyeY, cameraEyeZ];
                    const T = [targetX, targetY, targetZ];

                    // 1. Yaw rotation around world Z axis passing through P
                    if (dYaw !== 0) {
                        const angleY = -dYaw;
                        const cosY = Math.cos(angleY);
                        const sinY = Math.sin(angleY);

                        const dxE = E[0] - P[0];
                        const dyE = E[1] - P[1];
                        E[0] = P[0] + (dxE * cosY - dyE * sinY);
                        E[1] = P[1] + (dxE * sinY + dyE * cosY);

                        const dxT = T[0] - P[0];
                        const dyT = T[1] - P[1];
                        T[0] = P[0] + (dxT * cosY - dyT * sinY);
                        T[1] = P[1] + (dxT * sinY + dyT * cosY);
                    }

                    // 2. Pitch rotation around camera right axis passing through P
                    if (dPitch !== 0) {
                        const forward = normalize(subtract(T, E));
                        let up = [0, 0, 1];
                        if (Math.abs(forward[0]) < 1e-4 && Math.abs(forward[1]) < 1e-4) {
                            up = [0, 1, 0];
                        }
                        const camRight = normalize(cross(forward, up));

                        // Clamp pitch to avoid gimbal flip through poles
                        const vEye = subtract(E, P);
                        const rEye = Math.hypot(vEye[0], vEye[1], vEye[2]);
                        let actualPitch = -dPitch;
                        if (rEye > 1e-6) {
                            const testRot = rotateVectorAroundAxis(vEye, camRight, -dPitch);
                            const elev = Math.asin(Math.max(-1, Math.min(1, testRot[2] / rEye)));
                            if (elev > Math.PI / 2 - 0.01 || elev < -Math.PI / 2 + 0.01) {
                                const targetElev = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, elev));
                                const currentElev = Math.asin(Math.max(-1, Math.min(1, vEye[2] / rEye)));
                                actualPitch = targetElev - currentElev;
                            }
                        }

                        if (Math.abs(actualPitch) > 1e-7) {
                            const relE = rotateVectorAroundAxis([E[0] - P[0], E[1] - P[1], E[2] - P[2]], camRight, actualPitch);
                            const relT = rotateVectorAroundAxis([T[0] - P[0], T[1] - P[1], T[2] - P[2]], camRight, actualPitch);
                            E[0] = P[0] + relE[0];
                            E[1] = P[1] + relE[1];
                            E[2] = P[2] + relE[2];
                            T[0] = P[0] + relT[0];
                            T[1] = P[1] + relT[1];
                            T[2] = P[2] + relT[2];
                        }
                    }

                    cameraEyeX = E[0];
                    cameraEyeY = E[1];
                    cameraEyeZ = E[2];
                    targetX = T[0];
                    targetY = T[1];
                    targetZ = T[2];

                    const diff = subtract(E, T);
                    distance = Math.hypot(diff[0], diff[1], diff[2]);
                    if (distance > 1e-6) {
                        pitch = Math.asin(Math.max(-1, Math.min(1, diff[2] / distance)));
                        yaw = Math.atan2(diff[0], diff[1]);
                    }
                } else {
                    pitch += dPitch;
                    pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
                    yaw += dYaw;
                    cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
                    cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
                    cameraEyeZ = targetZ + distance * Math.sin(pitch);
                }
            }
            if (data.dpx !== undefined || data.dpy !== undefined) {
                // Pan in camera plane
                let z = [
                    Math.cos(pitch) * Math.sin(yaw),
                    Math.cos(pitch) * Math.cos(yaw),
                    Math.sin(pitch)
                ];
                let up = [0, 0, 1];
                if (Math.abs(z[0]) < 1e-4 && Math.abs(z[1]) < 1e-4) {
                    up = [0, 1, 0];
                }
                let x = normalize(cross(up, z));
                let y = cross(z, x);

                let dpx = data.dpx || 0;
                let dpy = data.dpy || 0;
                let panSpeed = distance * 0.002;

                const shiftX = (x[0] * -dpx + y[0] * dpy) * panSpeed;
                const shiftY = (x[1] * -dpx + y[1] * dpy) * panSpeed;
                const shiftZ = (x[2] * -dpx + y[2] * dpy) * panSpeed;

                targetX += shiftX;
                targetY += shiftY;
                targetZ += shiftZ;
                cameraEyeX += shiftX;
                cameraEyeY += shiftY;
                cameraEyeZ += shiftZ;

                if (hasCustomPivot) {
                    pivotX += shiftX;
                    pivotY += shiftY;
                    pivotZ += shiftZ;
                }
            }
            const w = canvasWidth();
            const h = canvasHeight();
            updateMatrices(w, h);
            render();
            scheduleCameraChangedNotification();
        } else if (type === "setRotationCenterFromClick") {
            const w = canvasWidth();
            const h = canvasHeight();
            handleSetRotationCenterFromClick(data.mouseX, data.mouseY, w, h, data.screenX, data.screenY);
        } else if (type === "pickObject") {
            const w = canvasWidth();
            const h = canvasHeight();
            handlePickObject(data.mouseX, data.mouseY, w, h, data.button, data.screenX, data.screenY);
        } else if (type === "hoverObject") {
            const w = canvasWidth();
            const h = canvasHeight();
            handleHoverObject(data.mouseX, data.mouseY, w, h, data.screenX, data.screenY, data.clear);
        } else if (type === "setSelectedObject") {
            setSelectedObject(data);
        } else if (type === "setHoveredObject") {
            setHoveredObject(data);
        } else if (type === "setView") {
            if (data.pitch !== undefined) pitch = data.pitch;
            if (data.yaw !== undefined) yaw = data.yaw;
            if (data.distance !== undefined) distance = data.distance;
            if (data.targetX !== undefined) targetX = data.targetX;
            if (data.targetY !== undefined) targetY = data.targetY;
            if (data.targetZ !== undefined) targetZ = data.targetZ;
            if (data.usePerspective !== undefined) usePerspective = data.usePerspective;
            if (data.fov !== undefined) fov = data.fov;
            hasCustomPivot = false;
            pivotX = targetX;
            pivotY = targetY;
            pivotZ = targetZ;
            cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
            cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
            cameraEyeZ = targetZ + distance * Math.sin(pitch);
            const w = canvasWidth();
            const h = canvasHeight();
            updateMatrices(w, h);
            render();
            scheduleCameraChangedNotification();
        } else if (type === "resetView") {
            pitch = 0.42;
            yaw = 2.356;
            distance = 1.35;
            targetX = 0.0;
            targetY = 0.0;
            targetZ = 0.0;
            hasCustomPivot = false;
            pivotX = 0.0;
            pivotY = 0.0;
            pivotZ = 0.0;
            cameraEyeX = targetX + distance * Math.cos(pitch) * Math.sin(yaw);
            cameraEyeY = targetY + distance * Math.cos(pitch) * Math.cos(yaw);
            cameraEyeZ = targetZ + distance * Math.sin(pitch);
            const w = canvasWidth();
            const h = canvasHeight();
            updateMatrices(w, h);
            render();
            scheduleCameraChangedNotification();
        } else if (type === "resetSimulationData") {
            latestMPMParticlesData = null;
            mpmParticlesCount = 0;
            latestEmpiricalSpacing = 0;
            latestFEMNodesData = null;
            latestFEMFacetsData = null;
            femSolidCount = 0;
            femWireframeCount = 0;
            cachedSlices = [];
            Object.values(activeSlicesWebGL).forEach(s => {
                if (gl) {
                    if (s.texture) gl.deleteTexture(s.texture);
                    if (s.buffer) gl.deleteBuffer(s.buffer);
                }
            });
            activeSlicesWebGL = {};
            Object.values(activeSlicesWebGPU).forEach(s => {
                if (s.gpuTexture) s.gpuTexture.destroy();
                if (s.vertexBuffer) s.vertexBuffer.destroy();
            });
            activeSlicesWebGPU = {};
            femBoundsInitialized = false;
            if (gl) {
                if (femSolidBuffer) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, femSolidBuffer);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
                }
                if (femWireframeBuffer) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, femWireframeBuffer);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
                }
                if (mpmParticlesBuffer) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
                }
            }
            requestRender();
        } else if (type === "frame") {
            try {
                handleFrame(data.buffer);
            } catch (err: any) {
                self.postMessage({ type: 'error', message: err.message || String(err) });
            }
        } else if (type === "setConfig") {
            if (data.clearColor !== undefined && typeof data.clearColor === 'object') {
                clearColor.r = Number(data.clearColor.r ?? clearColor.r);
                clearColor.g = Number(data.clearColor.g ?? clearColor.g);
                clearColor.b = Number(data.clearColor.b ?? clearColor.b);
                clearColor.a = 1.0;
            }
            if (data.hasCFDSolver !== undefined) hasCFDSolver = data.hasCFDSolver;
            if (data.colormap !== undefined) {
                colormap = getColormapIndex(data.colormap);
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
            let boundsChanged = false;
            if (data.xmin !== undefined && data.xmin !== xmin) { xmin = data.xmin; boundsChanged = true; }
            if (data.xmax !== undefined && data.xmax !== xmax) { xmax = data.xmax; boundsChanged = true; }
            if (data.ymin !== undefined && data.ymin !== ymin) { ymin = data.ymin; boundsChanged = true; }
            if (data.ymax !== undefined && data.ymax !== ymax) { ymax = data.ymax; boundsChanged = true; }
            if (data.zmin !== undefined && data.zmin !== zmin) { zmin = data.zmin; boundsChanged = true; }
            if (data.zmax !== undefined && data.zmax !== zmax) { zmax = data.zmax; boundsChanged = true; }
            if (data.dx !== undefined && data.dx !== dx) { dx = data.dx; boundsChanged = true; }
            if (data.dy !== undefined && data.dy !== dy) { dy = data.dy; boundsChanged = true; }
            if (data.dz !== undefined && data.dz !== dz) { dz = data.dz; boundsChanged = true; }
            if (data.nx !== undefined && data.nx !== nx) { nx = data.nx; boundsChanged = true; }
            if (data.ny !== undefined && data.ny !== ny) { ny = data.ny; boundsChanged = true; }
            if (data.nz !== undefined && data.nz !== nz) { nz = data.nz; boundsChanged = true; }
            let matricesNeedUpdate = false;
            if (data.usePerspective !== undefined && data.usePerspective !== usePerspective) {
                usePerspective = data.usePerspective;
                matricesNeedUpdate = true;
            }
            if (data.fov !== undefined && data.fov !== fov) {
                fov = data.fov;
                matricesNeedUpdate = true;
            }
            if (data.lightingEnabled !== undefined) lightingEnabled = data.lightingEnabled;
            if (data.aoEnabled !== undefined) aoEnabled = data.aoEnabled;
            if (data.ambientOcclusion !== undefined) aoEnabled = data.ambientOcclusion;
            if (data.aoRadius !== undefined) aoRadius = Number(data.aoRadius);
            if (data.aoIntensity !== undefined) aoIntensity = Number(data.aoIntensity);
            if (data.aoBias !== undefined) aoBias = Number(data.aoBias);
            if (data.aoSphereImpostor !== undefined) aoSphereImpostor = Boolean(data.aoSphereImpostor);
            if (data.specularIntensity !== undefined) specularIntensity = data.specularIntensity;
            if (data.ambientLevel !== undefined) ambientLevel = data.ambientLevel;
            if (data.quantityColormaps !== undefined) {
                for (const [k, v] of Object.entries(data.quantityColormaps)) {
                    const ck = canonicalizeQuantity(k);
                    quantityColormaps[ck] = v as string;
                    quantityColormaps[k] = v as string;
                }
                if (cachedSlices.length > 0) {
                    cachedSlices.forEach((sliceObj, i) => {
                        const config = getSliceConfig(i);
                        const rawQ = config?.quantities?.[0] || 'pressure';
                        const cQ = canonicalizeQuantity(rawQ);
                        sliceObj.colormap = quantityColormaps[cQ] || quantityColormaps[rawQ] || config?.colormap || 'rainbow';
                    });
                }
            }
            if (data.quantityRanges !== undefined) {
                for (const [k, v] of Object.entries(data.quantityRanges)) {
                    const ck = canonicalizeQuantity(k);
                    quantityRanges[ck] = v as [number, number];
                    quantityRanges[k] = v as [number, number];
                }
            }
            const incomingLogs = data.quantityLogScales || data.quantity_log_scales;
            if (incomingLogs !== undefined) {
                for (const [k, v] of Object.entries(incomingLogs)) {
                    const ck = canonicalizeQuantity(k);
                    quantityLogScales[ck] = Boolean(v);
                    quantityLogScales[k] = Boolean(v);
                }
            }
            const incomingAutos = data.quantityAutoScales || data.quantity_auto_scales;
            if (incomingAutos !== undefined) {
                for (const [k, v] of Object.entries(incomingAutos)) {
                    const ck = canonicalizeQuantity(k);
                    quantityAutoScales[ck] = Boolean(v);
                    quantityAutoScales[k] = Boolean(v);
                }
            }
            if (data.lockQuantityRanges !== undefined) lockQuantityRanges = Boolean(data.lockQuantityRanges);
            if (data.lock_quantity_ranges !== undefined) lockQuantityRanges = Boolean(data.lock_quantity_ranges);
            if (data.stlLockQuantityRange !== undefined) stlLockQuantityRange = Boolean(data.stlLockQuantityRange);
            if (data.stl_lock_quantity_range !== undefined) stlLockQuantityRange = Boolean(data.stl_lock_quantity_range);
            if (data.obstaclesLockQuantityRange !== undefined) obstaclesLockQuantityRange = Boolean(data.obstaclesLockQuantityRange);
            if (data.obstacles_lock_quantity_range !== undefined) obstaclesLockQuantityRange = Boolean(data.obstacles_lock_quantity_range);
            if (data.mpmLockQuantityRange !== undefined) mpmLockQuantityRange = Boolean(data.mpmLockQuantityRange);
            if (data.mpm_lock_quantity_range !== undefined) mpmLockQuantityRange = Boolean(data.mpm_lock_quantity_range);
            if (data.femLockQuantityRange !== undefined) femLockQuantityRange = Boolean(data.femLockQuantityRange);
            if (data.fem_lock_quantity_range !== undefined) femLockQuantityRange = Boolean(data.fem_lock_quantity_range);
            if (data.beamLockQuantityRange !== undefined) beamLockQuantityRange = Boolean(data.beamLockQuantityRange);
            if (data.beam_lock_quantity_range !== undefined) beamLockQuantityRange = Boolean(data.beam_lock_quantity_range);
            if (data.sliceOpacities !== undefined) sliceOpacities = data.sliceOpacities;

            if (data.showSlices !== undefined) showSlices = data.showSlices;
            if (data.show_slices !== undefined) showSlices = data.show_slices;
            if (data.showObstacles !== undefined) showObstacles = data.showObstacles;
            if (data.show_obstacles !== undefined) showObstacles = data.show_obstacles;
            if (data.showSTL !== undefined) showSTL = data.showSTL;
            if (data.show_stl !== undefined) showSTL = data.show_stl;
            if (data.obstaclesGridlines !== undefined) obstaclesGridlines = data.obstaclesGridlines;
            if (data.obstaclesSolid !== undefined) obstaclesSolid = data.obstaclesSolid;
            if (data.obstaclesLighting !== undefined) obstaclesLighting = data.obstaclesLighting;
            if (data.obstaclesOpacity !== undefined) obstaclesOpacity = data.obstaclesOpacity;
            if (data.obstaclesQuantity !== undefined) obstaclesQuantity = data.obstaclesQuantity;
            if (data.obstaclesColormap !== undefined) obstaclesColormap = data.obstaclesColormap;
            if (data.obstaclesAutoScale !== undefined) obstaclesAutoScale = data.obstaclesAutoScale;
            if (data.obstaclesLogScale !== undefined) obstaclesLogScale = data.obstaclesLogScale;
            if (data.obstaclesInterpolate !== undefined) obstaclesInterpolate = data.obstaclesInterpolate;
            if (data.obstaclesMinVal !== undefined) obstaclesMinVal = data.obstaclesMinVal;
            if (data.obstaclesMaxVal !== undefined) obstaclesMaxVal = data.obstaclesMaxVal;

            if (data.meshType !== undefined) meshType = data.meshType;
            if (data.gridOpacity !== undefined) gridOpacity = data.gridOpacity;
            if (data.gridMeshlines !== undefined) gridMeshlines = data.gridMeshlines;
            if (data.showGridBox !== undefined) showGridBox = data.showGridBox;
            if (data.slices !== undefined) {
                slicesConfig = data.slices;
                slicesConfigCache = data.slices;
                updateSliceAMRGridlinesGeometry();
            }
            if (data.amr_leaf_tiles !== undefined) {
                amrLeafTilesCache = data.amr_leaf_tiles;
                updateAMRTilesGeometry(data.amr_leaf_tiles);
            }
            if (data.submeshes !== undefined) {
                const submeshTiles = data.submeshes.map((s: any) => ({
                    xmin: s.x,
                    xmax: s.x + s.size_x,
                    ymin: s.y,
                    ymax: s.y + s.size_y,
                    zmin: s.z,
                    zmax: s.z + s.size_z,
                    level: s.level
                }));
                amrLeafTilesCache = submeshTiles;
                updateAMRTilesGeometry(submeshTiles);
                updateSliceAMRGridlinesGeometry();
            }

            if (data.stlColormap !== undefined) stlColormap = data.stlColormap;
            if (data.stlShowResults !== undefined) stlShowResults = data.stlShowResults;
            if (data.stlQuantity !== undefined) stlQuantity = data.stlQuantity;
            if (data.stlSamplingMode !== undefined) stlSamplingMode = data.stlSamplingMode;

            let gaugesChanged = false;
            if (data.showGauges !== undefined) showGauges = data.showGauges;
            if (data.gaugeOpacity !== undefined) gaugeOpacity = data.gaugeOpacity;

            let femChanged = false;
            if (data.showFEMMesh !== undefined) { showFEMMesh = data.showFEMMesh; femChanged = true; }
            if (data.femSolid !== undefined) { femSolid = data.femSolid; femChanged = true; }
            if (data.femWireframe !== undefined) { femWireframe = data.femWireframe; femChanged = true; }
            if (data.femResults !== undefined) femResults = data.femResults;
            if (data.showRebar !== undefined) { showRebar = data.showRebar; femChanged = true; }
            if (data.rebarSolid !== undefined) { rebarSolid = data.rebarSolid; femChanged = true; }
            if (data.rebarWireframe !== undefined) { rebarWireframe = data.rebarWireframe; femChanged = true; }
            if (data.rebarRadius !== undefined) { rebarRadius = data.rebarRadius; femChanged = true; }

            if (data.showBeams !== undefined) { showBeams = data.showBeams; femChanged = true; }
            if (data.beamSolid !== undefined) { beamSolid = data.beamSolid; femChanged = true; }
            if (data.beamWireframe !== undefined) { beamWireframe = data.beamWireframe; femChanged = true; }
            if (data.beamRadius !== undefined) { beamRadius = data.beamRadius; femChanged = true; }
            if (data.beamQuantity !== undefined) {
                if (beamQuantity !== data.beamQuantity) {
                    beamQuantity = data.beamQuantity;
                    beamAutoScale = true;
                }
                femChanged = true;
            }
            if (data.beamColormap !== undefined) {
                beamColormap = data.beamColormap;
                femChanged = true;
            }
            if (data.beamAutoScale !== undefined) {
                beamAutoScale = data.beamAutoScale;
                femChanged = true;
            }
            if (data.beamLogScale !== undefined) {
                beamLogScale = data.beamLogScale;
                femChanged = true;
            }
            if (data.beamMinVal !== undefined) {
                beamMinVal = data.beamMinVal;
                femChanged = true;
            }
            if (data.beamMaxVal !== undefined) {
                beamMaxVal = data.beamMaxVal;
                femChanged = true;
            }
            if (data.beamOpacity !== undefined) {
                beamOpacity = data.beamOpacity;
            }

            if (data.femQuantity !== undefined) {
                if (femQuantity !== data.femQuantity) {
                    femQuantity = data.femQuantity;
                    femAutoScale = true;
                }
                femChanged = true;
            }
            if (data.femColormap !== undefined) {
                femColormap = data.femColormap;
                femChanged = true;
            }
            if (data.femAutoScale !== undefined) {
                femAutoScale = data.femAutoScale;
                femChanged = true;
            }
            if (data.femLogScale !== undefined) {
                femLogScale = data.femLogScale;
                femChanged = true;
            }
            if (data.femMinVal !== undefined) {
                femMinVal = data.femMinVal;
                femChanged = true;
            }
            if (data.femMaxVal !== undefined) {
                femMaxVal = data.femMaxVal;
                femChanged = true;
            }
            if (data.femOpacity !== undefined) {
                femOpacity = data.femOpacity;
            }
            if (femChanged) {
                updateFEMMeshGeometry();
            }
            if (data.gaugeQuantity !== undefined) gaugeQuantity = data.gaugeQuantity;
            if (data.gaugeSolid !== undefined) gaugeSolid = data.gaugeSolid;
            if (data.gaugeSize !== undefined) {
                gaugeSize = data.gaugeSize;
                gaugesChanged = true;
            }
            if (data.gauges !== undefined) {
                gaugesList = data.gauges;
                gaugesChanged = true;
            }
            if (data.showCharge !== undefined) showCharge = data.showCharge;
            if (data.chargeSolid !== undefined) chargeSolid = data.chargeSolid;
            if (data.chargeWireframe !== undefined) chargeWireframe = data.chargeWireframe;
            if (data.chargeLighting !== undefined) chargeLighting = data.chargeLighting;
            if (data.chargeOpacity !== undefined) chargeOpacity = data.chargeOpacity;
            if (data.chargeColor !== undefined) chargeColor = data.chargeColor;
            if (data.charge !== undefined) {
                chargeData = data.charge;
                updateChargeGeometry();
                updateDetonatorGeometry();
            }

            let detonatorsChanged = false;
            if (data.showDetonators !== undefined) { showDetonators = data.showDetonators; detonatorsChanged = true; }
            if (data.detonatorSolid !== undefined) { detonatorSolid = data.detonatorSolid; detonatorsChanged = true; }
            if (data.detonatorWireframe !== undefined) { detonatorWireframe = data.detonatorWireframe; detonatorsChanged = true; }
            if (data.detonatorLighting !== undefined) { detonatorLighting = data.detonatorLighting; detonatorsChanged = true; }
            if (data.detonatorSize !== undefined) { detonatorSize = data.detonatorSize; detonatorsChanged = true; }
            if (data.detonatorOpacity !== undefined) { detonatorOpacity = data.detonatorOpacity; detonatorsChanged = true; }
            if (data.detonators !== undefined) {
                detonatorsList = data.detonators;
                detonatorsChanged = true;
            }
            if (detonatorsChanged) {
                updateDetonatorGeometry();
            }

            let mpmChanged = false;
            let mpmRenderNeeded = false;
            if (data.ppc !== undefined) ppc = data.ppc;
            if (data.showMPMParticles !== undefined) { showMPMParticles = data.showMPMParticles; mpmRenderNeeded = true; }
            if (data.mpmParticleDiameter !== undefined) { mpmParticleDiameter = data.mpmParticleDiameter; mpmRenderNeeded = true; }
            if (data.mpmParticleSize !== undefined) { mpmParticleSize = data.mpmParticleSize; mpmRenderNeeded = true; }
            if (data.mpmParticleOpacity !== undefined) { mpmParticleOpacity = data.mpmParticleOpacity; mpmRenderNeeded = true; }
            if (data.mpmParticleQuantity !== undefined) {
                if (mpmParticleQuantity !== data.mpmParticleQuantity) {
                    mpmParticleQuantity = data.mpmParticleQuantity;
                    mpmParticleAutoScale = true;
                }
                mpmChanged = true;
            }
            if (data.mpmParticleColormap !== undefined) {
                mpmParticleColormap = data.mpmParticleColormap;
                mpmChanged = true;
            }
            if (data.mpmParticleAutoScale !== undefined) {
                mpmParticleAutoScale = data.mpmParticleAutoScale;
                mpmChanged = true;
            }
            if (data.mpmParticleLogScale !== undefined) {
                mpmParticleLogScale = data.mpmParticleLogScale;
                mpmChanged = true;
            }
            if (data.mpmParticleMinVal !== undefined) {
                mpmParticleMinVal = data.mpmParticleMinVal;
                mpmChanged = true;
            }
            if (data.mpmParticleMaxVal !== undefined) {
                mpmParticleMaxVal = data.mpmParticleMaxVal;
                mpmChanged = true;
            }
            if (data.mpmObjects !== undefined) {
                mpmObjectsData = data.mpmObjects;
                updateMPMPreviewGeometry();
                requestRender();
            }
            if (mpmChanged) {
                updateMPMParticlesGeometry();
            } else if (mpmRenderNeeded) {
                requestRender();
            }

            if (boundsChanged) {
                gaugesChanged = true;
                updateMatrices(canvasWidth(), canvasHeight());
                updateChargeGeometry();
                updateDetonatorGeometry();
                updateMPMPreviewGeometry();
            }
            if (gaugesChanged) {
                updateGaugesGeometry();
            }
            if (data.slices !== undefined) {
                slicesConfig = data.slices;
                
                // If cachedSlices exists (from simulation frames), update or trim
                if (cachedSlices.length > 0) {
                    const parentSlices = cachedSlices.filter(s => !s.is_submesh);
                    const submeshSlices = cachedSlices.filter(s => s.is_submesh);

                    if (parentSlices.length > slicesConfig.length) {
                        // Destroy resources for slices that are being deleted
                        for (let i = slicesConfig.length; i < parentSlices.length; i++) {
                            const origIdx = cachedSlices.indexOf(parentSlices[i]);
                            if (origIdx !== -1) {
                                if (isWebGPU && activeSlicesWebGPU[origIdx]) {
                                    activeSlicesWebGPU[origIdx].gpuTexture.destroy();
                                    activeSlicesWebGPU[origIdx].vertexBuffer.destroy();
                                    delete activeSlicesWebGPU[origIdx];
                                }
                                if (gl && activeSlicesWebGL[origIdx]) {
                                    gl.deleteTexture(activeSlicesWebGL[origIdx].texture);
                                    gl.deleteBuffer(activeSlicesWebGL[origIdx].buffer);
                                    delete activeSlicesWebGL[origIdx];
                                }
                            }
                        }
                        parentSlices.splice(slicesConfig.length);
                    }

                    cachedSlices = [...parentSlices, ...submeshSlices];
                }
                
                // Now, update cachedSlices configurations in-place (including axis and offset)
                cachedSlices.forEach((sliceObj, i) => {
                    const config = getSliceConfig(i);
                    if (!config) return;
                    const targetAxis = config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2;
                    sliceObj.axis = targetAxis;
                    sliceObj.offset = Number(config.offset ?? sliceObj.offset);
                    sliceObj.minY = config.min_val ?? sliceObj.minY;
                    sliceObj.maxY = config.max_val ?? sliceObj.maxY;
                    sliceObj.colormap = config.colormap || 'rainbow';
                    sliceObj.useLogScale = config.log_scale === true;
                    sliceObj.interpolate = config.interpolate === true;
                });

                // Update active slices (WebGL / WebGPU) immediately so they are in sync!
                if (isWebGPU && gpuDevice) {
                    cachedSlices.forEach((sliceObj, i) => {
                        const axis = sliceObj.axis;
                        const zOff = sliceObj.offset;
                        const w = sliceObj.w;
                        const h = sliceObj.h;
                        const floatData = sliceObj.data;
                        const config = getSliceConfig(i);
                        const opacity = config && config.opacity !== undefined ? config.opacity : 1.0;
                        const geo = getSliceGeometry(axis, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level);

                        if (activeSlicesWebGPU[i]) {
                            const slice = activeSlicesWebGPU[i];
                            let recreateBindGroup = false;
                            if (slice.w !== w || slice.h !== h || slice.interpolate !== sliceObj.interpolate) {
                                if (slice.w !== w || slice.h !== h) {
                                    slice.gpuTexture.destroy();
                                    slice.gpuTexture = gpuDevice.createTexture({
                                        size: [w, h, 1],
                                        format: 'r32float',
                                        usage: 4 | 2
                                    });
                                    slice.gpuTextureView = slice.gpuTexture.createView();
                                    slice.w = w; slice.h = h;
                                }
                                recreateBindGroup = true;
                            }

                            if (recreateBindGroup) {
                                if (!gpuSliceUniformBuffers[i]) {
                                    gpuSliceUniformBuffers[i] = gpuDevice.createBuffer({
                                        size: 384,
                                        usage: 64 | 8
                                    });
                                }
                                const sampler = (sliceObj.interpolate === false) ? gpuSamplerNearest : gpuSamplerLinear;
                                slice.bindGroup = gpuDevice.createBindGroup({
                                    layout: bindGroupLayout,
                                    entries: [
                                        { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                                        { binding: 1, resource: slice.gpuTextureView },
                                        { binding: 2, resource: sampler! },
                                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
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
                            slice.xmin = sliceObj.xmin !== undefined ? sliceObj.xmin : xmin;
                            slice.xmax = sliceObj.xmax !== undefined ? sliceObj.xmax : (xmin + getDimX());
                            slice.ymin = sliceObj.ymin !== undefined ? sliceObj.ymin : ymin;
                            slice.ymax = sliceObj.ymax !== undefined ? sliceObj.ymax : (ymin + getDimY());
                            slice.zmin = sliceObj.zmin !== undefined ? sliceObj.zmin : zmin;
                            slice.zmax = sliceObj.zmax !== undefined ? sliceObj.zmax : (zmin + getDimZ());
                            slice.level = sliceObj.level !== undefined ? sliceObj.level : 0;
                            slice.is_submesh = sliceObj.is_submesh === true;
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
                                    size: 384,
                                    usage: 64 | 8
                                });
                            }

                            const sampler = (sliceObj.interpolate === false) ? gpuSamplerNearest : gpuSamplerLinear;
                            const bindGroup = gpuDevice.createBindGroup({
                                layout: bindGroupLayout,
                                entries: [
                                    { binding: 0, resource: { buffer: gpuSliceUniformBuffers[i] } },
                                    { binding: 1, resource: texView },
                                    { binding: 2, resource: sampler! },
                                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                                ]
                            });

                            activeSlicesWebGPU[i] = {
                                axis,
                                offset: zOff,
                                w,
                                h,
                                xmin: sliceObj.xmin !== undefined ? sliceObj.xmin : xmin,
                                xmax: sliceObj.xmax !== undefined ? sliceObj.xmax : (xmin + getDimX()),
                                ymin: sliceObj.ymin !== undefined ? sliceObj.ymin : ymin,
                                ymax: sliceObj.ymax !== undefined ? sliceObj.ymax : (ymin + getDimY()),
                                zmin: sliceObj.zmin !== undefined ? sliceObj.zmin : zmin,
                                zmax: sliceObj.zmax !== undefined ? sliceObj.zmax : (zmin + getDimZ()),
                                level: sliceObj.level !== undefined ? sliceObj.level : 0,
                                is_submesh: sliceObj.is_submesh === true,
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
                        const config = getSliceConfig(i);
                        const opacity = config && config.opacity !== undefined ? config.opacity : 1.0;
                        const axisNum = axis;

                        if (activeSlicesWebGL[i]) {
                            const slice = activeSlicesWebGL[i];
                            activeGl.bindTexture(activeGl.TEXTURE_2D, slice.texture);
                            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

                            const filter = (sliceObj.interpolate === false) ? activeGl.NEAREST : (hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);

                            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, slice.buffer);
                            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axisNum, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level), activeGl.STATIC_DRAW);

                            slice.axis = axisNum;
                            slice.offset = zOff;
                            slice.w = w;
                            slice.h = h;
                            slice.xmin = sliceObj.xmin !== undefined ? sliceObj.xmin : xmin;
                            slice.xmax = sliceObj.xmax !== undefined ? sliceObj.xmax : (xmin + getDimX());
                            slice.ymin = sliceObj.ymin !== undefined ? sliceObj.ymin : ymin;
                            slice.ymax = sliceObj.ymax !== undefined ? sliceObj.ymax : (ymin + getDimY());
                            slice.zmin = sliceObj.zmin !== undefined ? sliceObj.zmin : zmin;
                            slice.zmax = sliceObj.zmax !== undefined ? sliceObj.zmax : (zmin + getDimZ());
                            slice.level = sliceObj.level !== undefined ? sliceObj.level : 0;
                            slice.is_submesh = sliceObj.is_submesh === true;
                            slice.opacity = opacity;
                            slice.minY = sliceObj.minY;
                            slice.maxY = sliceObj.maxY;
                            slice.colormap = sliceObj.colormap;
                            slice.useLogScale = sliceObj.useLogScale;
                            slice.interpolate = sliceObj.interpolate;
                        } else {
                            const tex = activeGl.createTexture()!;
                            activeGl.bindTexture(activeGl.TEXTURE_2D, tex);
                            const filter = (sliceObj.interpolate === false) ? activeGl.NEAREST : (hasFloatLinear ? activeGl.LINEAR : activeGl.NEAREST);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MIN_FILTER, filter);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_MAG_FILTER, filter);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_S, activeGl.CLAMP_TO_EDGE);
                            activeGl.texParameteri(activeGl.TEXTURE_2D, activeGl.TEXTURE_WRAP_T, activeGl.CLAMP_TO_EDGE);
                            activeGl.texImage2D(activeGl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, activeGl.FLOAT, floatData);

                            const buf = activeGl.createBuffer()!;
                            activeGl.bindBuffer(activeGl.ARRAY_BUFFER, buf);
                            activeGl.bufferData(activeGl.ARRAY_BUFFER, getSliceGeometry(axisNum, zOff, w, h, sliceObj.xmin, sliceObj.xmax, sliceObj.ymin, sliceObj.ymax, sliceObj.zmin, sliceObj.zmax, sliceObj.level), activeGl.STATIC_DRAW);

                            activeSlicesWebGL[i] = {
                                axis: axisNum,
                                offset: zOff,
                                w,
                                h,
                                xmin: sliceObj.xmin !== undefined ? sliceObj.xmin : xmin,
                                xmax: sliceObj.xmax !== undefined ? sliceObj.xmax : (xmin + getDimX()),
                                ymin: sliceObj.ymin !== undefined ? sliceObj.ymin : ymin,
                                ymax: sliceObj.ymax !== undefined ? sliceObj.ymax : (ymin + getDimY()),
                                zmin: sliceObj.zmin !== undefined ? sliceObj.zmin : zmin,
                                zmax: sliceObj.zmax !== undefined ? sliceObj.zmax : (zmin + getDimZ()),
                                level: sliceObj.level !== undefined ? sliceObj.level : 0,
                                is_submesh: sliceObj.is_submesh === true,
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
            if (data.show_stl !== undefined) showSTL = data.show_stl;
            if (data.stlWireframe !== undefined) stlWireframe = data.stlWireframe;
            if (data.stl_wireframe !== undefined) stlWireframe = data.stl_wireframe;
            if (data.stlSolids !== undefined) stlSolids = data.stlSolids;
            if (data.stl_solids !== undefined) stlSolids = data.stl_solids;
            if (data.stlOpacity !== undefined) stlOpacity = Number(data.stlOpacity);
            if (data.stl_opacity !== undefined) stlOpacity = Number(data.stl_opacity);
            if (data.stlColormap !== undefined) stlColormap = data.stlColormap;
            if (data.stl_colormap !== undefined) stlColormap = data.stl_colormap;
            if (data.stlShowResults !== undefined) stlShowResults = data.stlShowResults;
            if (data.stl_show_results !== undefined) stlShowResults = data.stl_show_results;
            if (data.stlQuantity !== undefined) stlQuantity = data.stlQuantity;
            if (data.stl_quantity !== undefined) stlQuantity = data.stl_quantity;
            if (data.stlSamplingMode !== undefined) stlSamplingMode = data.stlSamplingMode;
            if (data.stl_sampling_mode !== undefined) stlSamplingMode = data.stl_sampling_mode;
            if (data.stlAutoScale !== undefined) stlAutoScale = data.stlAutoScale;
            if (data.stl_auto_scale !== undefined) stlAutoScale = data.stl_auto_scale;
            if (data.stlLogScale !== undefined) stlLogScale = data.stlLogScale;
            if (data.stl_log_scale !== undefined) stlLogScale = data.stl_log_scale;
            if (data.stlMinVal !== undefined) stlMinVal = data.stlMinVal;
            if (data.stl_min_val !== undefined) stlMinVal = data.stl_min_val;
            if (data.stlMaxVal !== undefined) stlMaxVal = data.stlMaxVal;
            if (data.stl_max_val !== undefined) stlMaxVal = data.stl_max_val;

            // Recalculate range immediately using cached frame data
            if (cachedSlices.length > 0) {
                recomputeActiveRanges();
            }

            if (matricesNeedUpdate) {
                updateMatrices(canvasWidth(), canvasHeight());
            }
            updateAxesGeometry();
            requestRender();
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
                    requestRender();
                }
            }
        } else if (type === "scaleObstaclesToCurrent") {
            let obsMin = Infinity;
            let obsMax = -Infinity;
            if (latestObstaclesData && latestObstaclesData.length > 0) {
                for (let i = 0; i < latestObstaclesData.length; i++) {
                    const v = latestObstaclesData[i];
                    if (isFinite(v)) {
                        if (v < obsMin) obsMin = v;
                        if (v > obsMax) obsMax = v;
                    }
                }
            }
            if (obsMin < obsMax && isFinite(obsMin) && isFinite(obsMax)) {
                obstaclesMinVal = obsMin;
                obstaclesMaxVal = obsMax;
                obstaclesAutoScale = false;
                self.postMessage({ type: 'obstaclesRangeUpdated', min: obsMin, max: obsMax });
                requestRender();
            }
        } else if (type === "scaleStlToCurrent") {
            let stlMin = Infinity;
            let stlMax = -Infinity;
            if (latestVolume3DData && latestVolume3DData.length > 0) {
                for (let k = 0; k < latestVolume3DData.length; k++) {
                    const val = latestVolume3DData[k];
                    if (isFinite(val)) {
                        if (val < stlMin) stlMin = val;
                        if (val > stlMax) stlMax = val;
                    }
                }
            }
            if (stlMin < stlMax && isFinite(stlMin) && isFinite(stlMax)) {
                stlMinVal = stlMin;
                stlMaxVal = stlMax;
                stlAutoScale = false;
                self.postMessage({ type: 'stlRangeUpdated', min: stlMin, max: stlMax });
                requestRender();
            }
        }
    } catch (err: any) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
