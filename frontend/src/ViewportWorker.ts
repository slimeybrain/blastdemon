// ViewportWorker.ts
export {};

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
    gl_PointSize = uParticleSize > 0.0 ? uParticleSize : 4.0;
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
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 2) return colormap_rainbow(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    return colormap_plasma(t);
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

        if (uIsWireframe == 14) {
            outColor = vec4(vTexCoord.x, vTexCoord.y, vSliceSize.x, uAlpha);
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
                vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
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
            if (uStlShowResults && inStlDomain && uIsWireframe <= 7) {
                vec3 baseNorm = clamp(relDomainPos, vec3(0.0), vec3(1.0));
                vec3 dWx = dFdx(vWorldPos); vec3 dWy = dFdy(vWorldPos);
                float lWx = length(dWx); if (lWx > 1e-12) dWx /= lWx;
                float lWy = length(dWy); if (lWy > 1e-12) dWy /= lWy;
                vec3 boxNormal = normalize(cross(dWx, dWy));
                vec3 normNormal = boxNormal / max(uDomainExtent, vec3(1e-6));
                float stepDist = (uDx > 1e-6) ? uDx : 0.01;

                float bestVal = texture(uVolumeTexture3D, baseNorm).r;
                float maxDev = abs(bestVal - uStlMin);

                for (int step_idx = 1; step_idx <= 8; step_idx++) {
                    float dist = float(step_idx) * 0.5 * stepDist;

                    vec3 posOut = clamp(baseNorm + dist * normNormal, vec3(0.0), vec3(1.0));
                    float vOut = texture(uVolumeTexture3D, posOut).r;
                    float devOut = abs(vOut - uStlMin);
                    if (devOut > maxDev) {
                        maxDev = devOut;
                        bestVal = vOut;
                    }

                    vec3 posIn = clamp(baseNorm - dist * normNormal, vec3(0.0), vec3(1.0));
                    float vIn = texture(uVolumeTexture3D, posIn).r;
                    float devIn = abs(vIn - uStlMin);
                    if (devIn > maxDev) {
                        maxDev = devIn;
                        bestVal = vIn;
                    }
                }

                float t = getT(bestVal, uStlMin, uStlMax, uStlLogScale);
                vec3 col = getColormapColor(t, uStlColormap);
                baseColor = vec4(col, uAlpha);
            }
            if (uIsWireframe == 8) {
                baseColor = vec4(1.0, 0.66, 0.0, 1.0);
            } else if (vSliceSize.y > 0.5) {
                baseColor = vec4(1.0, 0.2, 0.2, uAlpha * 0.4);
            }
            
            if (uIsWireframe == 5 || uIsWireframe == 8) {
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
                    vec3 dWx = dFdx(vWorldPos); vec3 dWy = dFdy(vWorldPos);
                    float lWx = length(dWx); if (lWx > 1e-12) dWx /= lWx;
                    float lWy = length(dWy); if (lWy > 1e-12) dWy /= lWy;
                    vec3 boxNormal = normalize(cross(dWx, dWy));
                    vec3 normNormal = boxNormal / max(uDomainExtent, vec3(1e-6));
                    float stepDist = (uDx > 1e-6) ? uDx : 0.01;

                    float bestVal = texture(uVolumeTexture3D, baseNorm).r;
                    float maxDev = abs(bestVal - uStlMin);

                    for (int step_idx = 1; step_idx <= 8; step_idx++) {
                        float dist = float(step_idx) * 0.5 * stepDist;

                        vec3 posOut = clamp(baseNorm + dist * normNormal, vec3(0.0), vec3(1.0));
                        float vOut = texture(uVolumeTexture3D, posOut).r;
                        float devOut = abs(vOut - uStlMin);
                        if (devOut > maxDev) { maxDev = devOut; bestVal = vOut; }

                        vec3 posIn = clamp(baseNorm - dist * normNormal, vec3(0.0), vec3(1.0));
                        float vIn = texture(uVolumeTexture3D, posIn).r;
                        float devIn = abs(vIn - uStlMin);
                        if (devIn > maxDev) { maxDev = devIn; bestVal = vIn; }
                    }

                    vec3 col = getColormapColor(getT(bestVal, uStlMin, uStlMax, uStlLogScale), uStlColormap);
                    wireColor = vec4(col, 0.95);
                } else if (vSliceSize.y > 0.5) {
                    wireColor = vec4(0.8, 0.1, 0.1, 0.95);
                }
                if (lineCoverage < 0.01) discard;
                outColor = vec4(wireColor.rgb, wireColor.a * lineCoverage);
                return;
            }
            
            if (uIsWireframe == 7) {
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
                    float ao = 1.0;
                    if (uEnableAO) {
                        ao = pow(max(abs(normal.z), 0.2), 0.5);
                    }
                    vec3 lit = baseColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
                    litColor = vec4(lit * ao, baseColor.a);
                } else {
                    litColor = baseColor;
                }
                vec4 darkWireColor = vec4(0.0, 0.0, 0.0, litColor.a);
                if (vSliceSize.y > 0.5) darkWireColor = vec4(0.8, 0.1, 0.1, litColor.a);
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
        
        float ao = 1.0;
        
        vec3 lit = finalColor.rgb * (uAmbientLevel + 0.7 * diff) + vec3(1.0) * (uSpecularLevel * spec);
        finalColor = vec4(lit * ao, finalColor.a);
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
void main() {
    vLocalPos = position;
    vWorldPos = position;
    vBoxPos = (uStlMatrix * vec4(position, 1.0)).xyz;
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
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 2) return colormap_rainbow(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    return colormap_plasma(t);
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

        if (uIsWireframe == 14) {
            outColor = vec4(vTexCoord.x, vTexCoord.y, vSliceSize.x, uAlpha);
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
                vec4 darkWireColor = vec4(0.0, 0.0, 0.0, litColor.a);
                if (vSliceSize.y > 0.5) darkWireColor = vec4(0.8, 0.1, 0.1, litColor.a);
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
    dummy1: f32,
    dummy2: f32,
    domainMin: vec3<f32>,
    dummy3: f32,
    domainExtent: vec3<f32>,
    dummy4: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var uVolumeTexture: texture_3d<f32>;

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
    if (c == 1) { return colormap_viridis(t); }
    if (c == 2) { return colormap_rainbow(t); }
    if (c == 3) { return colormap_coolwarm(t); }
    if (c == 4) { return colormap_cividis(t); }
    if (c == 5) { return colormap_grayscale(t); }
    return colormap_plasma(t);
}

fn getT(raw: f32, minVal: f32, maxVal: f32, useLogScale: f32) -> f32 {
    var t: f32 = 0.0;
    var denom = maxVal - minVal;
    if (denom < 1e-5) {
        denom = 1e-5;
    }
    if (useLogScale > 0.5) {
        let logMin = log(max(minVal, 1e-5));
        let logMax = log(max(maxVal, 1e-5));
        let logVal = log(max(raw, 1e-5));
        var logDenom = logMax - logMin;
        if (logDenom < 1e-5) {
            logDenom = 1e-5;
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
                var ao = 1.0;
                if (uniforms.enableAO > 0.5) {
                    ao = pow(max(normal.z, 0.0), 0.5);
                }
                let lit = baseColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                return vec4<f32>(lit * ao, baseColor.a);
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

        // STL Geometry (5.0 = Solid, 6.0 = Wireframe, 7.0 = Solid + Wireframe)
        if (uniforms.isWireframe >= 4.5 && uniforms.isWireframe < 7.5) {
            let relDomainPos = (vWorldPos - uniforms.domainMin) / max(uniforms.domainExtent, vec3<f32>(1e-6, 1e-6, 1e-6));
            let inStlDomain = (relDomainPos.x >= -1e-4 && relDomainPos.x <= 1.0001 &&
                               relDomainPos.y >= -1e-4 && relDomainPos.y <= 1.0001 &&
                               relDomainPos.z >= -1e-4 && relDomainPos.z <= 1.0001);

            var baseColor = vec4<f32>(0.42, 0.44, 0.48, uniforms.alpha);
            if (uniforms.stlShowResults > 0.5 && inStlDomain) {
                let baseNorm = clamp(relDomainPos, vec3<f32>(0.0), vec3<f32>(1.0));
                var dW_x = dpdx(vWorldPos);
                var dW_y = dpdy(vWorldPos);
                let lWx = length(dW_x); if (lWx > 1e-12) { dW_x = dW_x / lWx; }
                let lWy = length(dW_y); if (lWy > 1e-12) { dW_y = dW_y / lWy; }
                let rawLocalN = cross(dW_x, dW_y);
                let lenLocalN = length(rawLocalN);
                let localNormal = select(vec3<f32>(0.0, 0.0, 1.0), rawLocalN / lenLocalN, lenLocalN > 1e-4);
                let normNormal = localNormal / max(uniforms.domainExtent, vec3<f32>(1e-6, 1e-6, 1e-6));
                let stepDist = select(0.01, uniforms.dx, uniforms.dx > 1e-6);

                var bestVal = textureSampleLevel(uVolumeTexture, uSampler, baseNorm, 0.0).r;
                var maxDev = abs(bestVal - uniforms.stlMinVal);

                // Probe along BOTH +normNormal and -normNormal up to 8 steps (4.0 cell sizes)
                for (var step_idx = 1; step_idx <= 8; step_idx++) {
                    let dist = f32(step_idx) * 0.5 * stepDist;

                    let posOut = clamp(baseNorm + dist * normNormal, vec3<f32>(0.0), vec3<f32>(1.0));
                    let vOut = textureSampleLevel(uVolumeTexture, uSampler, posOut, 0.0).r;
                    let devOut = abs(vOut - uniforms.stlMinVal);
                    if (devOut > maxDev) {
                        maxDev = devOut;
                        bestVal = vOut;
                    }

                    let posIn = clamp(baseNorm - dist * normNormal, vec3<f32>(0.0), vec3<f32>(1.0));
                    let vIn = textureSampleLevel(uVolumeTexture, uSampler, posIn, 0.0).r;
                    let devIn = abs(vIn - uniforms.stlMinVal);
                    if (devIn > maxDev) {
                        maxDev = devIn;
                        bestVal = vIn;
                    }
                }

                let t = getT(bestVal, uniforms.stlMinVal, uniforms.stlMaxVal, uniforms.stlLogScale);
                let col = getColormapColor(t, uniforms.stlColormap);
                baseColor = vec4<f32>(col, uniforms.alpha);
            }
            if (sliceSize.y > 0.5) {
                baseColor = vec4<f32>(1.0, 0.2, 0.2, uniforms.alpha * 0.4);
            }
            
            if (uniforms.isWireframe < 5.5) {
                // Solid only (5.0)
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
                    var ao = 1.0;
                    if (uniforms.enableAO > 0.5) {
                        ao = pow(max(abs(normal.z), 0.2), 0.5);
                    }
                    let lit = baseColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                    return vec4<f32>(lit * ao, baseColor.a);
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
                    var dW_x = dpdx(vWorldPos);
                    var dW_y = dpdy(vWorldPos);
                    let lWx = length(dW_x); if (lWx > 1e-12) { dW_x = dW_x / lWx; }
                    let lWy = length(dW_y); if (lWy > 1e-12) { dW_y = dW_y / lWy; }
                    let rawLocalN = cross(dW_x, dW_y);
                    let lenLocalN = length(rawLocalN);
                    let localNormal = select(vec3<f32>(0.0, 0.0, 1.0), rawLocalN / lenLocalN, lenLocalN > 1e-4);
                    let normNormal = localNormal / max(uniforms.domainExtent, vec3<f32>(1e-6, 1e-6, 1e-6));
                    let stepDist = select(0.01, uniforms.dx, uniforms.dx > 1e-6);

                    var bestVal = textureSampleLevel(uVolumeTexture, uSampler, baseNorm, 0.0).r;
                    var maxDev = abs(bestVal - uniforms.stlMinVal);

                    for (var step_idx = 1; step_idx <= 8; step_idx++) {
                        let dist = f32(step_idx) * 0.5 * stepDist;

                        let posOut = clamp(baseNorm + dist * normNormal, vec3<f32>(0.0), vec3<f32>(1.0));
                        let vOut = textureSampleLevel(uVolumeTexture, uSampler, posOut, 0.0).r;
                        let devOut = abs(vOut - uniforms.stlMinVal);
                        if (devOut > maxDev) { maxDev = devOut; bestVal = vOut; }

                        let posIn = clamp(baseNorm - dist * normNormal, vec3<f32>(0.0), vec3<f32>(1.0));
                        let vIn = textureSampleLevel(uVolumeTexture, uSampler, posIn, 0.0).r;
                        let devIn = abs(vIn - uniforms.stlMinVal);
                        if (devIn > maxDev) { maxDev = devIn; bestVal = vIn; }
                    }

                    let t = getT(bestVal, uniforms.stlMinVal, uniforms.stlMaxVal, uniforms.stlLogScale);
                    let col = getColormapColor(t, uniforms.stlColormap);
                    wireColor = vec4<f32>(col, 0.95);
                } else if (sliceSize.y > 0.5) {
                    wireColor = vec4<f32>(0.8, 0.1, 0.1, 0.95);
                }
                if (lineCoverage < 0.01) { discard; }
                return vec4<f32>(wireColor.rgb, wireColor.a * lineCoverage);
            }
            
            // Solid + Wireframe (7.0)
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
                var ao = 1.0;
                if (uniforms.enableAO > 0.5) {
                    ao = pow(max(abs(normal.z), 0.2), 0.5);
                }
                let lit = baseColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
                litColor = vec4<f32>(lit * ao, baseColor.a);
            }
            var darkWireColor = vec4<f32>(0.0, 0.0, 0.0, litColor.a);
            if (sliceSize.y > 0.5) { darkWireColor = vec4<f32>(0.8, 0.1, 0.1, litColor.a); }
            return mix(litColor, darkWireColor, lineCoverage * 0.85);
        }
    }
    var color: vec3<f32>;
    if (uniforms.interpolate < 0.5) {
        let cellUv = (floor(texCoord * sliceSize) + vec2<f32>(0.5, 0.5)) / sliceSize;
        let raw = textureSample(uTexture, uSampler, cellUv).r;
        let t = getT(raw, uniforms.minVal, uniforms.maxVal, uniforms.useLogScale > 0.5);
        color = getColormapColor(t, i32(uniforms.colormap));
    } else {
        let raw = textureSample(uTexture, uSampler, texCoord).r;
        let t = getT(raw, uniforms.minVal, uniforms.maxVal, uniforms.useLogScale > 0.5);
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
        
        var ao = 1.0;
        
        let lit = finalColor.rgb * (uniforms.ambientLevel + 0.7 * diff) + vec3<f32>(1.0) * (uniforms.specularLevel * spec);
        finalColor = vec4<f32>(lit * ao, finalColor.a);
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
let gpuSTLLinePipeline: any = null;
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

let sliceGridlinesBuffer: WebGLBuffer | null = null;
let sliceGridlinesCount = 0;
let gpuSliceGridlinesBuffer: any = null;

let amrLeafTilesCache: any[] = [];
let slicesConfigCache: any[] = [];

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
let stlColormap = 'plasma';
let stlShowResults = true;
let stlQuantity = 'pressure';
let stlSamplingMode = 'nearest';
let stlAutoScale = true;
let stlLogScale = false;
let stlMinVal = 101325.0;
let stlMaxVal = 1013250.0;
let meshType = 'regular';

let latestVolume3DData: Float32Array | null = null;
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

// Obstacles Settings
let showObstacles = false;
let obstaclesGridlines = true;
let obstaclesSolid = true;
let obstaclesLighting = true;
let obstaclesOpacity = 1.0;
let obstaclesQuantity = 'pressure';
let obstaclesColormap = 'plasma';
let obstaclesAutoScale = true;
let obstaclesLogScale = false;
let obstaclesInterpolate = true;
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

let quantityColormaps: Record<string, string> = {
    pressure: 'plasma',
    density: 'viridis',
    velocity: 'rainbow',
    energy: 'inferno',
    species1: 'magma',
    species2: 'coolwarm',
    species3: 'plasma',
    solid: 'grayscale',
    overpressure: 'inferno',
    impulse: 'thermal'
};

let slicesConfig: any[] = [];
let quantityRanges: Record<string, [number, number]> = {};
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

    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();

    const count = rawSTLVertices.length / 3;
    const data = new Float32Array(count * 7);

    for (let i = 0; i < count; i++) {
        data[i * 7 + 0] = rawSTLVertices[i * 3 + 0];
        data[i * 7 + 1] = rawSTLVertices[i * 3 + 1];
        data[i * 7 + 2] = rawSTLVertices[i * 3 + 2];
        
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

function rebuildObstaclesGL() {
    if (!gl || !rawObstacleVertices || !rawObstacleCells) return;

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
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    if (!obstacleTriIndexBuffer) {
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

    if (!obstacleWireIndexBuffer) {
        obstacleWireIndexBuffer = gl.createBuffer();
        const indices = new Uint32Array(numFaces * 8);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            indices[f * 8 + 0] = v0; indices[f * 8 + 1] = v1;
            indices[f * 8 + 2] = v1; indices[f * 8 + 3] = v2;
            indices[f * 8 + 4] = v2; indices[f * 8 + 5] = v3;
            indices[f * 8 + 6] = v3; indices[f * 8 + 7] = v0;
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleWireIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        obstacleWireIndexCount = numFaces * 8;
    }
}

function rebuildObstaclesWebGPU() {
    if (!gpuDevice || !rawObstacleVertices) return;

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

    if (gpuObstaclesVertexBuffer) gpuObstaclesVertexBuffer.destroy();
    gpuObstaclesVertexBuffer = gpuDevice.createBuffer({
        size: vertexData.byteLength,
        usage: 32 | 8,
        mappedAtCreation: true
    });
    new Float32Array(gpuObstaclesVertexBuffer.getMappedRange()).set(vertexData);
    gpuObstaclesVertexBuffer.unmap();

    if (!gpuObstaclesTriIndexBuffer) {
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
        gpuObstaclesTriIndexBuffer = gpuDevice.createBuffer({
            size: indices.byteLength,
            usage: 16 | 8,
            mappedAtCreation: true
        });
        new Uint32Array(gpuObstaclesTriIndexBuffer.getMappedRange()).set(indices);
        gpuObstaclesTriIndexBuffer.unmap();
        obstacleTriIndexCount = numFaces * 6;
    }

    if (!gpuObstaclesWireIndexBuffer) {
        const indices = new Uint32Array(numFaces * 8);
        for (let f = 0; f < numFaces; ++f) {
            const v0 = f * 4 + 0;
            const v1 = f * 4 + 1;
            const v2 = f * 4 + 2;
            const v3 = f * 4 + 3;

            indices[f * 8 + 0] = v0; indices[f * 8 + 1] = v1;
            indices[f * 8 + 2] = v1; indices[f * 8 + 3] = v2;
            indices[f * 8 + 4] = v2; indices[f * 8 + 5] = v3;
            indices[f * 8 + 6] = v3; indices[f * 8 + 7] = v0;
        }
        gpuObstaclesWireIndexBuffer = gpuDevice.createBuffer({
            size: indices.byteLength,
            usage: 16 | 8,
            mappedAtCreation: true
        });
        new Uint32Array(gpuObstaclesWireIndexBuffer.getMappedRange()).set(indices);
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

function updateWebGL2Volume3DTexture(floatData: Float32Array, w: number, h: number, curNz: number) {
    if (!gl) return;
    if (!glVolume3DTexture) {
        glVolume3DTexture = gl.createTexture();
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, glVolume3DTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const filter = (stlSamplingMode === 'linear') ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R32F,
        w,
        h,
        curNz,
        0,
        gl.RED,
        gl.FLOAT,
        floatData
    );
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

function getCylinderVertices(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number[] {
    const verts: number[] = [];
    const segments = 24;

    const addTri = (p1: number[], p2: number[], p3: number[]) => {
        verts.push(...p1, 0, 0, 0, 0);
        verts.push(...p2, 0, 0, 0, 0);
        verts.push(...p3, 0, 0, 0, 0);
    };

    const topCircle: number[][] = [];
    const bottomCircle: number[][] = [];

    for (let i = 0; i <= segments; i++) {
        const theta = (i * 2 * Math.PI) / segments;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        topCircle.push([cx + rx * cosT, cy + ry * sinT, cz + rz]);
        bottomCircle.push([cx + rx * cosT, cy + ry * sinT, cz - rz]);
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
    const topCenter = [cx, cy, cz + rz];
    for (let i = 0; i < segments; i++) {
        addTri(topCenter, topCircle[i], topCircle[i + 1]);
    }

    // Bottom Cap
    const bottomCenter = [cx, cy, cz - rz];
    for (let i = 0; i < segments; i++) {
        addTri(bottomCenter, bottomCircle[i + 1], bottomCircle[i]);
    }

    return verts;
}

function getCylinderWireframeVertices(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number[] {
    const verts: number[] = [];
    const segments = 32;

    const addLine = (p1: number[], p2: number[]) => {
        verts.push(...p1, 0, 0);
        verts.push(...p2, 0, 0);
    };

    // Top Ring (at z = cz + rz)
    for (let i = 0; i < segments; i++) {
        const theta1 = (i * 2 * Math.PI) / segments;
        const theta2 = ((i + 1) * 2 * Math.PI) / segments;
        addLine(
            [cx + rx * Math.cos(theta1), cy + ry * Math.sin(theta1), cz + rz],
            [cx + rx * Math.cos(theta2), cy + ry * Math.sin(theta2), cz + rz]
        );
    }

    // Bottom Ring (at z = cz - rz)
    for (let i = 0; i < segments; i++) {
        const theta1 = (i * 2 * Math.PI) / segments;
        const theta2 = ((i + 1) * 2 * Math.PI) / segments;
        addLine(
            [cx + rx * Math.cos(theta1), cy + ry * Math.sin(theta1), cz - rz],
            [cx + rx * Math.cos(theta2), cy + ry * Math.sin(theta2), cz - rz]
        );
    }

    // 4 Vertical Pillars connecting them
    const angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    for (const angle of angles) {
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        addLine(
            [cx + rx * cosA, cy + ry * sinA, cz - rz],
            [cx + rx * cosA, cy + ry * sinA, cz + rz]
        );
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

let latestMPMParticlesData: Float32Array | null = null;
let mpmParticlesBuffer: WebGLBuffer | null = null;
let mpmParticlesCount: number = 0;
let showMPMParticles: boolean = true;
let mpmParticleSize: number = 4.0;
let mpmParticleQuantity: string = 'vonMises';
let mpmParticleColormap: string = 'plasma';
let mpmParticleAutoScale: boolean = true;
let mpmParticleMinVal: number | undefined = undefined;
let mpmParticleMaxVal: number | undefined = undefined;

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

function getParticleQuantityValue(data: Float32Array, idx: number, qty: string): number {
    const base = idx * 10;
    if (qty === 'vonMises' || qty === 'von_mises') return data[base + 6];
    if (qty === 'plastic_strain') return data[base + 7];
    if (qty === 'density') return data[base + 8];
    if (qty === 'pressure') return data[base + 9];
    if (qty === 'velocity') {
        const vx = data[base + 3], vy = data[base + 4], vz = data[base + 5];
        return Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    return data[base + 6];
}

function updateMPMParticlesGeometry(data?: Float32Array) {
    if (!gl) {
        self.postMessage({ type: 'log', message: 'updateMPMParticlesGeometry failed: gl is null' });
        return;
    }
    if (data) {
        latestMPMParticlesData = data;
    }
    if (!latestMPMParticlesData || latestMPMParticlesData.length === 0) {
        mpmParticlesCount = 0;
        self.postMessage({ type: 'log', message: 'updateMPMParticlesGeometry failed: no latestMPMParticlesData' });
        return;
    }

    const nParticles = Math.floor(latestMPMParticlesData.length / 10);
    const sizeX = getDimX();
    const sizeY = getDimY();
    const sizeZ = getDimZ();
    const sx = 1.0 / sizeX;
    const sy = 1.0 / sizeY;
    const sz = 1.0 / sizeZ;
    const tx = -xmin * sx - 0.5;
    const ty = -ymin * sy - 0.5;
    const tz = -zmin * sz - 0.5;

    self.postMessage({
        type: 'log',
        message: `updateMPMParticlesGeometry: nParticles = ${nParticles}, size = [${sizeX}, ${sizeY}, ${sizeZ}], min = [${xmin}, ${ymin}, ${zmin}], show = ${showMPMParticles}`
    });

    let minScalar = mpmParticleMinVal;
    let maxScalar = mpmParticleMaxVal;
    if (mpmParticleAutoScale || minScalar === undefined || maxScalar === undefined) {
        minScalar = Infinity;
        maxScalar = -Infinity;
        for (let i = 0; i < nParticles; i++) {
            const val = getParticleQuantityValue(latestMPMParticlesData, i, mpmParticleQuantity);
            if (val < minScalar) minScalar = val;
            if (val > maxScalar) maxScalar = val;
        }
        if (!isFinite(minScalar) || !isFinite(maxScalar) || maxScalar <= minScalar) {
            minScalar = 0.0;
            maxScalar = 1.0;
        }
    }

    const range = Math.max(1e-9, maxScalar - minScalar);
    const vertexData = new Float32Array(nParticles * 6);

    for (let i = 0; i < nParticles; i++) {
        const px = latestMPMParticlesData[i * 10 + 0];
        const py = latestMPMParticlesData[i * 10 + 1];
        const pz = latestMPMParticlesData[i * 10 + 2];

        const wx = px * sx + tx;
        const wy = py * sy + ty;
        const wz = pz * sz + tz;

        const val = getParticleQuantityValue(latestMPMParticlesData, i, mpmParticleQuantity);
        const normVal = (val - minScalar) / range;
        const [r, g, b] = sampleColormapRGB(normVal, mpmParticleColormap);

        const vIdx = i * 6;
        vertexData[vIdx + 0] = wx;
        vertexData[vIdx + 1] = wy;
        vertexData[vIdx + 2] = wz;
        vertexData[vIdx + 3] = r;
        vertexData[vIdx + 4] = g;
        vertexData[vIdx + 5] = b;
    }

    if (!mpmParticlesBuffer) mpmParticlesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);
    mpmParticlesCount = nParticles;
}

function getBoxVertices(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
    const verts: number[] = [];
    const addTri = (p1: number[], p2: number[], p3: number[]) => {
        verts.push(...p1, 0, 0, 0, 0);
        verts.push(...p2, 0, 0, 0, 0);
        verts.push(...p3, 0, 0, 0, 0);
    };

    const c = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
    ];

    addTri(c[0], c[2], c[1]); addTri(c[0], c[3], c[2]);
    addTri(c[4], c[5], c[6]); addTri(c[4], c[6], c[7]);
    addTri(c[0], c[1], c[5]); addTri(c[0], c[5], c[4]);
    addTri(c[3], c[6], c[2]); addTri(c[3], c[7], c[6]);
    addTri(c[0], c[4], c[7]); addTri(c[0], c[7], c[3]);
    addTri(c[1], c[2], c[6]); addTri(c[1], c[6], c[5]);

    return verts;
}

function getBoxWireframeVertices(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
    const verts: number[] = [];
    const addLine = (p1: number[], p2: number[]) => {
        verts.push(...p1, 0, 0);
        verts.push(...p2, 0, 0);
    };

    const c = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
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
    const maxSize = Math.max(dimX, dimY, dimZ);

    const cx = Number(chargeData.x ?? (xmin + dimX * 0.5));
    const cy = Number(chargeData.y ?? (ymin + dimY * 0.5));
    const cz = Number(chargeData.z ?? (zmin + dimZ * 0.5));

    const px = normX(cx);
    const py = normY(cy);
    const pz = normZ(cz);

    const shape = chargeData.shape || 'Sphere';
    let solidVerts: number[] = [];
    let wireVerts: number[] = [];

if (shape === 'Block') {
    // Preserve original aspect ratios using per‑axis domain sizes
    const lx = Number(chargeData.lx ?? 0.2);
    const ly = Number(chargeData.ly ?? 0.2);
    const lz = Number(chargeData.lz ?? 0.2);
    const x0 = px - (lx * 0.5) / dimX;
    const x1 = px + (lx * 0.5) / dimX;
    const y0 = py - (ly * 0.5) / dimY;
    const y1 = py + (ly * 0.5) / dimY;
    const z0 = pz - (lz * 0.5) / dimZ;
    const z1 = pz + (lz * 0.5) / dimZ;
    solidVerts = getBoxVertices(x0, x1, y0, y1, z0, z1);
    wireVerts = getBoxWireframeVertices(x0, x1, y0, y1, z0, z1);
} else if (shape === 'Cylinder') {
    const r = Number(chargeData.radius ?? 0.1);
    const h = Number(chargeData.height ?? 0.2);
    // Use per‑axis scaling for radius and height
    const rx = r / dimX;
    const ry = r / dimY;
    const rz = (h * 0.5) / dimZ;
    solidVerts = getCylinderVertices(px, py, pz, rx, ry, rz);
    wireVerts = getCylinderWireframeVertices(px, py, pz, rx, ry, rz);
} else {
    // Sphere: scale radius per-axis so it renders as a true sphere in world space
    // regardless of non-cubic domain aspect ratios
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
        if (gpuAMRTilesBuffer) gpuAMRTilesBuffer.destroy();
        gpuAMRTilesBuffer = gpuDevice.createBuffer({
            size: floatArray.byteLength,
            usage: 0x20 | 0x08, // GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            mappedAtCreation: true
        });
        new Float32Array(gpuAMRTilesBuffer.getMappedRange()).set(floatArray);
        gpuAMRTilesBuffer.unmap();
    }
}

function updateSliceAMRGridlinesGeometry() {
    if (!amrLeafTilesCache || amrLeafTilesCache.length === 0 || !slicesConfigCache || slicesConfigCache.length === 0) {
        sliceGridlinesCount = 0;
        return;
    }

    const lineVertices: number[] = [];

    const rootDx = (dx > 0) ? dx : 0.075;
    const rootDy = (dy > 0) ? dy : 0.075;
    const rootDz = (dz > 0) ? dz : 0.075;

    for (const slice of slicesConfigCache) {
        if (slice.enabled === false) continue;

        const axis = slice.axis || 'xy';
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
        if (gpuSliceGridlinesBuffer) gpuSliceGridlinesBuffer.destroy();
        gpuSliceGridlinesBuffer = gpuDevice.createBuffer({
            size: floatArray.byteLength,
            usage: 0x20 | 0x08,
            mappedAtCreation: true
        });
        new Float32Array(gpuSliceGridlinesBuffer.getMappedRange()).set(floatArray);
        gpuSliceGridlinesBuffer.unmap();
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
    const uVolTexLoc = gl.getUniformLocation(program, "uVolumeTexture3D");
    if (uVolTexLoc !== null) {
        gl.uniform1i(uVolTexLoc, 1);
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

function handleFrame(buffer: ArrayBuffer) {
    if (buffer.byteLength < 16) {
        self.postMessage({ type: 'log', message: `handleFrame failed: buffer size too small (${buffer.byteLength})` });
        return;
    }
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);

    if (magic === 0x4d504d33) { // "MPM3"
        const numParticles = view.getUint32(8, true);
        const floatsPerParticle = view.getUint32(12, true);
        const particleDataStart = 16;
        const totalFloats = numParticles * floatsPerParticle;
        const availableFloats = Math.floor((buffer.byteLength - particleDataStart) / 4);
        const count = Math.min(totalFloats, availableFloats);
        self.postMessage({ type: 'log', message: `handleFrame: numParticles = ${numParticles}, floatsPerParticle = ${floatsPerParticle}, count = ${count}` });
        const floatData = new Float32Array(buffer, particleDataStart, count);
        updateMPMParticlesGeometry(floatData);
        return;
    }

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
            updateObstaclesGeometry();
        } else if (useAxis === 4) {
            latestVolume3DData = new Float32Array(floatData);
            let vMin = Infinity;
            let vMax = -Infinity;
            for (let k = 0; k < latestVolume3DData.length; k++) {
                const val = latestVolume3DData[k];
                if (isFinite(val)) {
                    if (val < vMin) vMin = val;
                    if (val > vMax) vMax = val;
                }
            }
            if (isFinite(vMin) && isFinite(vMax) && vMax > vMin) {
                stlVolMin = vMin;
                stlVolMax = vMax;
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

    // Assign slice-specific ranges and configs
    const sliceRanges: { min: number, max: number }[] = [];
    for (let i = 0; i < cachedSlices.length; i++) {
        const slice = cachedSlices[i];
        const config = getSliceConfig(i);
        const qty = config.quantities?.[0] || 'pressure';
        const sliceAutoScale = config.auto_scale !== false;
        const colormapVal = quantityColormaps[qty] || config.colormap || 'plasma';
        const interpVal = config.interpolate !== false;
        
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
        const logVal = config.log_scale === true || (config.log_scale !== false && sliceMax > 0 && sliceMin > 0 && (sliceMax / sliceMin > 50.0));

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
    const focusedSlice = getCachedSliceByParentIndex(focusedSliceIndex);
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
        return;
    }

    // WebGL frame processing
    if (!gl) return;
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

    const nearPt = unproject(ndcX, ndcY, -1.0);
    const farPt = unproject(ndcX, ndcY, 1.0);

    const dir = normalize([farPt[0] - nearPt[0], farPt[1] - nearPt[1], farPt[2] - nearPt[2]]);
    return { origin: nearPt, dir };
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

function raySphereIntersect(
    O: number[], D: number[],
    center: number[], radius: number
): number | null {
    const oc = [O[0] - center[0], O[1] - center[1], O[2] - center[2]];
    const b = oc[0]*D[0] + oc[1]*D[1] + oc[2]*D[2];
    const c = (oc[0]*oc[0] + oc[1]*oc[1] + oc[2]*oc[2]) - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const sqrtDisc = Math.sqrt(discriminant);
    let t = -b - sqrtDisc;
    if (t > 1e-5) return t;
    t = -b + sqrtDisc;
    if (t > 1e-5) return t;
    return null;
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

function handleSetRotationCenterFromClick(mouseX: number, mouseY: number, width: number, height: number) {
    const ray = getRayFromScreen(mouseX, mouseY, width, height);
    if (!ray) return;

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

    const eye = [cameraEyeX, cameraEyeY, cameraEyeZ];
    const mvp = multiplyMatrices(projectionMatrix, multiplyMatrices(viewMatrix, modelMatrix));

    let bestHit: number[] | null = null;
    let minTSolid = Infinity;

    // --- PHASE 1: TEST SOLID SURFACES DIRECTLY UNDER CLICK ---

    // 1. STL Solid Mesh
    const isSTLSolid = showSTL && stlSolids && (stlOpacity > 0.01 || !stlWireframe);
    if (isSTLSolid && rawSTLVertices && rawSTLVertices.length >= 9) {
        let stlMinX = Infinity, stlMinY = Infinity, stlMinZ = Infinity;
        let stlMaxX = -Infinity, stlMaxY = -Infinity, stlMaxZ = -Infinity;
        for (let i = 0; i < rawSTLVertices.length; i += 3) {
            const vx = rawSTLVertices[i], vy = rawSTLVertices[i+1], vz = rawSTLVertices[i+2];
            if (vx < stlMinX) stlMinX = vx; if (vx > stlMaxX) stlMaxX = vx;
            if (vy < stlMinY) stlMinY = vy; if (vy > stlMaxY) stlMaxY = vy;
            if (vz < stlMinZ) stlMinZ = vz; if (vz > stlMaxZ) stlMaxZ = vz;
        }
        const wStlMin = physToWorld(stlMinX, stlMinY, stlMinZ);
        const wStlMax = physToWorld(stlMaxX, stlMaxY, stlMaxZ);

        if (rayBoxIntersect(O, D, wStlMin, wStlMax) !== null) {
            const numTris = Math.floor(rawSTLVertices.length / 9);
            for (let i = 0; i < numTris; i++) {
                const idx = i * 9;
                const v0 = physToWorld(rawSTLVertices[idx], rawSTLVertices[idx+1], rawSTLVertices[idx+2]);
                const v1 = physToWorld(rawSTLVertices[idx+3], rawSTLVertices[idx+4], rawSTLVertices[idx+5]);
                const v2 = physToWorld(rawSTLVertices[idx+6], rawSTLVertices[idx+7], rawSTLVertices[idx+8]);

                const t = rayTriangleIntersect(O, D, v0, v1, v2);
                if (t !== null && t > 1e-4 && t < minTSolid) {
                    minTSolid = t;
                    bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
                }
            }
        }
    }

    // 2. Obstacles Solid Mesh
    const isObsSolid = showObstacles && obstaclesSolid && obstaclesOpacity > 0.01;
    if (isObsSolid && rawObstacleVertices && rawObstacleVertices.length >= 12) {
        let obsMinX = Infinity, obsMinY = Infinity, obsMinZ = Infinity;
        let obsMaxX = -Infinity, obsMaxY = -Infinity, obsMaxZ = -Infinity;
        for (let i = 0; i < rawObstacleVertices.length; i += 3) {
            const vx = rawObstacleVertices[i], vy = rawObstacleVertices[i+1], vz = rawObstacleVertices[i+2];
            if (vx < obsMinX) obsMinX = vx; if (vx > obsMaxX) obsMaxX = vx;
            if (vy < obsMinY) obsMinY = vy; if (vy > obsMaxY) obsMaxY = vy;
            if (vz < obsMinZ) obsMinZ = vz; if (vz > obsMaxZ) obsMaxZ = vz;
        }
        const wObsMin = physToWorld(obsMinX, obsMinY, obsMinZ);
        const wObsMax = physToWorld(obsMaxX, obsMaxY, obsMaxZ);

        if (rayBoxIntersect(O, D, wObsMin, wObsMax) !== null) {
            const numFaces = Math.floor(rawObstacleVertices.length / 12);
            for (let f = 0; f < numFaces; f++) {
                const base = f * 12;
                const v0 = physToWorld(rawObstacleVertices[base], rawObstacleVertices[base+1], rawObstacleVertices[base+2]);
                const v1 = physToWorld(rawObstacleVertices[base+3], rawObstacleVertices[base+4], rawObstacleVertices[base+5]);
                const v2 = physToWorld(rawObstacleVertices[base+6], rawObstacleVertices[base+7], rawObstacleVertices[base+8]);
                const v3 = physToWorld(rawObstacleVertices[base+9], rawObstacleVertices[base+10], rawObstacleVertices[base+11]);

                let t1 = rayTriangleIntersect(O, D, v0, v1, v2);
                if (t1 !== null && t1 > 1e-4 && t1 < minTSolid) {
                    minTSolid = t1;
                    bestHit = [O[0] + t1 * D[0], O[1] + t1 * D[1], O[2] + t1 * D[2]];
                }
                let t2 = rayTriangleIntersect(O, D, v0, v2, v3);
                if (t2 !== null && t2 > 1e-4 && t2 < minTSolid) {
                    minTSolid = t2;
                    bestHit = [O[0] + t2 * D[0], O[1] + t2 * D[1], O[2] + t2 * D[2]];
                }
            }
        }
    }

    // 3. Slices (Solid)
    if (cachedSlices && cachedSlices.length > 0) {
        cachedSlices.forEach((slice, idx) => {
            const cfg = getSliceConfig(idx);
            if (cfg && cfg.enabled === false) return;
            const opacity = cfg && cfg.opacity !== undefined ? cfg.opacity : 1.0;
            if (opacity <= 0.01) return;

            const axis = slice.axis;
            const offset = slice.offset;

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

            let t1 = rayTriangleIntersect(O, D, v0, v1, v2);
            if (t1 !== null && t1 > 1e-4 && t1 < minTSolid) {
                minTSolid = t1;
                bestHit = [O[0] + t1 * D[0], O[1] + t1 * D[1], O[2] + t1 * D[2]];
            }
            let t2 = rayTriangleIntersect(O, D, v0, v2, v3);
            if (t2 !== null && t2 > 1e-4 && t2 < minTSolid) {
                minTSolid = t2;
                bestHit = [O[0] + t2 * D[0], O[1] + t2 * D[1], O[2] + t2 * D[2]];
            }
        });
    }

    // 4. Virtual Gauges (Solid)
    if (showGauges && gaugeSolid && gaugeOpacity > 0.01 && gaugesList && gaugesList.length > 0) {
        const mult = (gaugeSize > 0) ? gaugeSize : 1.0;
        const cellMeters = (dx && dx > 0) ? dx : 0.01;
        const radiusMeters = mult * cellMeters * 0.5;
        const rWorld = radiusMeters / maxSize;

        for (const g of gaugesList) {
            const gx = Number(g.x ?? 0.0);
            const gy = Number(g.y ?? 0.0);
            const gz = Number(g.z ?? 0.0);
            const center = physToWorld(gx, gy, gz);

            const t = raySphereIntersect(O, D, center, Math.max(rWorld, 0.005));
            if (t !== null && t > 1e-4 && t < minTSolid) {
                minTSolid = t;
                bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
            }
        }
    }

    // 5. Charge Geometry (Solid)
    if (showCharge && chargeSolid && chargeOpacity > 0.01 && chargeData) {
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
            if (t !== null && t > 1e-4 && t < minTSolid) {
                minTSolid = t;
                bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
            }
        } else if (shape === 'Cylinder') {
            const r = Number(chargeData.radius ?? 0.1);
            const h = Number(chargeData.height ?? 0.2);
            const rWorld = r / maxSize;
            const hWorld = (h * 0.5) / maxSize;
            const t = rayCylinderIntersect(O, D, center, rWorld, hWorld);
            if (t !== null && t > 1e-4 && t < minTSolid) {
                minTSolid = t;
                bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
            }
        } else {
            const r = Number(chargeData.radius ?? 0.1);
            const rWorld = r / maxSize;
            const t = raySphereIntersect(O, D, center, Math.max(rWorld, 0.005));
            if (t !== null && t > 1e-4 && t < minTSolid) {
                minTSolid = t;
                bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
            }
        }
    }

    // 6. Domain Bounding Box (Solid if gridOpacity > 0.01 and showGridBox)
    if (showGridBox && gridOpacity > 0.01) {
        const domainMin = [-0.5 * sX, -0.5 * sY, -0.5 * sZ];
        const domainMax = [ 0.5 * sX,  0.5 * sY,  0.5 * sZ];
        const t = rayBoxIntersect(O, D, domainMin, domainMax);
        if (t !== null && t > 1e-4 && t < minTSolid) {
            minTSolid = t;
            bestHit = [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
        }
    }

    // --- PHASE 2: WIREFRAME EDGE HIT TEST (ONLY IF NO SOLID HIT DIRECTLY UNDER CLICK) ---
    if (!bestHit) {
        let minEdgeCamDist = Infinity;

        // STL Wireframe Edges
        if (showSTL && stlWireframe && rawSTLVertices && rawSTLVertices.length >= 9) {
            const numTris = Math.floor(rawSTLVertices.length / 9);
            for (let i = 0; i < numTris; i++) {
                const idx = i * 9;
                const v0 = physToWorld(rawSTLVertices[idx], rawSTLVertices[idx+1], rawSTLVertices[idx+2]);
                const v1 = physToWorld(rawSTLVertices[idx+3], rawSTLVertices[idx+4], rawSTLVertices[idx+5]);
                const v2 = physToWorld(rawSTLVertices[idx+6], rawSTLVertices[idx+7], rawSTLVertices[idx+8]);

                const e1 = testWireframeEdge(v0, v1, mvp, mouseX, mouseY, width, height, eye);
                if (e1 && e1.camDist < minEdgeCamDist) { minEdgeCamDist = e1.camDist; bestHit = e1.hitPoint; }

                const e2 = testWireframeEdge(v1, v2, mvp, mouseX, mouseY, width, height, eye);
                if (e2 && e2.camDist < minEdgeCamDist) { minEdgeCamDist = e2.camDist; bestHit = e2.hitPoint; }

                const e3 = testWireframeEdge(v2, v0, mvp, mouseX, mouseY, width, height, eye);
                if (e3 && e3.camDist < minEdgeCamDist) { minEdgeCamDist = e3.camDist; bestHit = e3.hitPoint; }
            }
        }

        // Obstacles Wireframe Edges
        if (showObstacles && obstaclesGridlines && rawObstacleVertices && rawObstacleVertices.length >= 12) {
            const numFaces = Math.floor(rawObstacleVertices.length / 12);
            for (let f = 0; f < numFaces; f++) {
                const base = f * 12;
                const v0 = physToWorld(rawObstacleVertices[base], rawObstacleVertices[base+1], rawObstacleVertices[base+2]);
                const v1 = physToWorld(rawObstacleVertices[base+3], rawObstacleVertices[base+4], rawObstacleVertices[base+5]);
                const v2 = physToWorld(rawObstacleVertices[base+6], rawObstacleVertices[base+7], rawObstacleVertices[base+8]);
                const v3 = physToWorld(rawObstacleVertices[base+9], rawObstacleVertices[base+10], rawObstacleVertices[base+11]);

                const edges = [[v0, v1], [v1, v2], [v2, v3], [v3, v0]];
                for (const edge of edges) {
                    const eRes = testWireframeEdge(edge[0], edge[1], mvp, mouseX, mouseY, width, height, eye);
                    if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
                }
            }
        }

        // Charge Wireframe Edges
        if (showCharge && chargeWireframe && chargeData) {
            const cx = Number(chargeData.x ?? (xmin + sizeX * 0.5));
            const cy = Number(chargeData.y ?? (ymin + sizeY * 0.5));
            const cz = Number(chargeData.z ?? (zmin + sizeZ * 0.5));
            const center = physToWorld(cx, cy, cz);
            const shape = chargeData.shape || 'Sphere';

            if (shape === 'Block') {
                const lx = Number(chargeData.lx ?? 0.2);
                const ly = Number(chargeData.ly ?? 0.2);
                const lz = Number(chargeData.lz ?? 0.2);

                const x0 = center[0] - (lx * 0.5) / maxSize;
                const x1 = center[0] + (lx * 0.5) / maxSize;
                const y0 = center[1] - (ly * 0.5) / maxSize;
                const y1 = center[1] + (ly * 0.5) / maxSize;
                const z0 = center[2] - (lz * 0.5) / maxSize;
                const z1 = center[2] + (lz * 0.5) / maxSize;

                const boxCorners = [
                    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
                ];
                const boxEdges = [
                    [0,1], [1,2], [2,3], [3,0],
                    [4,5], [5,6], [6,7], [7,4],
                    [0,4], [1,5], [2,6], [3,7]
                ];
                for (const [eA, eB] of boxEdges) {
                    const eRes = testWireframeEdge(boxCorners[eA], boxCorners[eB], mvp, mouseX, mouseY, width, height, eye);
                    if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
                }
            } else if (shape === 'Cylinder') {
                const r = Number(chargeData.radius ?? 0.1);
                const h = Number(chargeData.height ?? 0.2);
                const rx = r / maxSize;
                const ry = r / maxSize;
                const rz = (h * 0.5) / maxSize;

                const segments = 32;
                const topRing: number[][] = [];
                const bottomRing: number[][] = [];
                for (let i = 0; i < segments; i++) {
                    const theta = (i * 2 * Math.PI) / segments;
                    topRing.push([center[0] + rx * Math.cos(theta), center[1] + ry * Math.sin(theta), center[2] + rz]);
                    bottomRing.push([center[0] + rx * Math.cos(theta), center[1] + ry * Math.sin(theta), center[2] - rz]);
                }

                for (let i = 0; i < segments; i++) {
                    const p1t = topRing[i];
                    const p2t = topRing[(i + 1) % segments];
                    const eResT = testWireframeEdge(p1t, p2t, mvp, mouseX, mouseY, width, height, eye);
                    if (eResT && eResT.camDist < minEdgeCamDist) { minEdgeCamDist = eResT.camDist; bestHit = eResT.hitPoint; }

                    const p1b = bottomRing[i];
                    const p2b = bottomRing[(i + 1) % segments];
                    const eResB = testWireframeEdge(p1b, p2b, mvp, mouseX, mouseY, width, height, eye);
                    if (eResB && eResB.camDist < minEdgeCamDist) { minEdgeCamDist = eResB.camDist; bestHit = eResB.hitPoint; }
                }

                const angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
                for (const angle of angles) {
                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);
                    const pBottom = [center[0] + rx * cosA, center[1] + ry * sinA, center[2] - rz];
                    const pTop = [center[0] + rx * cosA, center[1] + ry * sinA, center[2] + rz];
                    const eResP = testWireframeEdge(pBottom, pTop, mvp, mouseX, mouseY, width, height, eye);
                    if (eResP && eResP.camDist < minEdgeCamDist) { minEdgeCamDist = eResP.camDist; bestHit = eResP.hitPoint; }
                }
            } else {
                const r = Number(chargeData.radius ?? 0.1);
                const rx = r / maxSize;
                const ry = r / maxSize;
                const rz = r / maxSize;
                const segments = 32;

                // XY Ring
                let prevXY = [center[0] + rx, center[1], center[2]];
                for (let i = 1; i <= segments; i++) {
                    const theta = (i * 2 * Math.PI) / segments;
                    const currXY = [center[0] + rx * Math.cos(theta), center[1] + ry * Math.sin(theta), center[2]];
                    const eRes = testWireframeEdge(prevXY, currXY, mvp, mouseX, mouseY, width, height, eye);
                    if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
                    prevXY = currXY;
                }

                // XZ Ring
                let prevXZ = [center[0] + rx, center[1], center[2]];
                for (let i = 1; i <= segments; i++) {
                    const theta = (i * 2 * Math.PI) / segments;
                    const currXZ = [center[0] + rx * Math.cos(theta), center[1], center[2] + rz * Math.sin(theta)];
                    const eRes = testWireframeEdge(prevXZ, currXZ, mvp, mouseX, mouseY, width, height, eye);
                    if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
                    prevXZ = currXZ;
                }

                // YZ Ring
                let prevYZ = [center[0], center[1] + ry, center[2]];
                for (let i = 1; i <= segments; i++) {
                    const theta = (i * 2 * Math.PI) / segments;
                    const currYZ = [center[0], center[1] + ry * Math.cos(theta), center[2] + rz * Math.sin(theta)];
                    const eRes = testWireframeEdge(prevYZ, currYZ, mvp, mouseX, mouseY, width, height, eye);
                    if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
                    prevYZ = currYZ;
                }
            }
        }

        // Domain Box Gridlines
        if (showGrid || showGridBox) {
            const x0 = -0.5 * sX, x1 = 0.5 * sX;
            const y0 = -0.5 * sY, y1 = 0.5 * sY;
            const z0 = -0.5 * sZ, z1 = 0.5 * sZ;

            const corners = [
                [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
            ];
            const edges = [
                [0,1], [1,2], [2,3], [3,0],
                [4,5], [5,6], [6,7], [7,4],
                [0,4], [1,5], [2,6], [3,7]
            ];
            for (const [eA, eB] of edges) {
                const eRes = testWireframeEdge(corners[eA], corners[eB], mvp, mouseX, mouseY, width, height, eye);
                if (eRes && eRes.camDist < minEdgeCamDist) { minEdgeCamDist = eRes.camDist; bestHit = eRes.hitPoint; }
            }
        }
    }

    // --- PHASE 3: UPDATE ROTATION CENTER IF HIT FOUND ---
    if (bestHit) {
        targetX = bestHit[0];
        targetY = bestHit[1];
        targetZ = bestHit[2];

        const u = [
            Math.cos(pitch) * Math.sin(yaw),
            Math.cos(pitch) * Math.cos(yaw),
            Math.sin(pitch)
        ];

        const dxVal = cameraEyeX - targetX;
        const dyVal = cameraEyeY - targetY;
        const dzVal = cameraEyeZ - targetZ;

        const projDist = dxVal * u[0] + dyVal * u[1] + dzVal * u[2];
        distance = Math.max(0.0001, projDist);

        updateMatrices(width, height);
        render();
    }
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
    }
}

function render() {
    if (is2DFallback) {
        render2D();
        return;
    }

    if (isWebGPU && gpuDevice && gpuContext) {
        // Build uniforms data float buffer (72 floats / 288 bytes)
        const uniformData = new Float32Array(72);
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

        const defaultStlRange = quantityRanges[stlQuantity] || DEFAULT_QUANTITY_RANGES[stlQuantity] || [0.0, 1.0];
        let finalStlMin = defaultStlRange[0];
        let finalStlMax = defaultStlRange[1];
        if (autoScale && isFinite(stlVolMin) && isFinite(stlVolMax) && stlVolMax > stlVolMin) {
            finalStlMin = stlVolMin;
            finalStlMax = stlVolMax;
        }

        uniformData[60] = stlShowResults ? 1.0 : 0.0;
        uniformData[61] = getColormapIndex(stlColormap);
        uniformData[62] = dx || 0.01;
        uniformData[63] = finalStlMin;
        const sizeX = getDimX();
        const sizeY = getDimY();
        const sizeZ = getDimZ();
        uniformData[64] = xmin;
        uniformData[65] = ymin;
        uniformData[66] = zmin;
        uniformData[67] = finalStlMax;
        uniformData[68] = sizeX;
        uniformData[69] = sizeY;
        uniformData[70] = sizeZ;
        uniformData[71] = 0.0;
        
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
                    { binding: 1, resource: Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView },
                    { binding: 2, resource: gpuSampler! },
                    { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                ]
            });

            passEncoder.setPipeline(gpuLinePipeline);
            passEncoder.setBindGroup(0, bboxBindGroup);
            passEncoder.setVertexBuffer(0, gpuBBoxBuffer);
            passEncoder.draw(24, 1, 0, 0);
            
            if (gpuAMRTilesBuffer && amrTilesCount > 0) {
                passEncoder.setVertexBuffer(0, gpuAMRTilesBuffer);
                passEncoder.draw(amrTilesCount, 1, 0, 0);
            }
            if (gpuSliceGridlinesBuffer && sliceGridlinesCount > 0) {
                passEncoder.setVertexBuffer(0, gpuSliceGridlinesBuffer);
                passEncoder.draw(sliceGridlinesCount, 1, 0, 0);
            }
        }

        // Draw Axes Indicator (disabled to draw tick labels on bounding box instead)
        /*
        if (gpuAxesBuffer && gpuPipeline && gpuAxesUniformBuffers.length === 3) {
            passEncoder.setPipeline(gpuPipeline);
            const sizeX = getDimX();
            const sizeY = getDimY();
            const sizeZ = getDimZ();
            const maxSize = Math.max(sizeX, sizeY, sizeZ);
            const sX = sizeX / maxSize;
            const sY = sizeY / maxSize;
            const sZ = sizeZ / maxSize;
            const axesModelMatrix = new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                -sX/2, -sY/2, -sZ/2, 1
            ]);

            for (let a = 0; a < 3; a++) {
                const axesData = new Float32Array(uniformData);
                axesData.set(axesModelMatrix, 32);
                axesData[53] = 2.0 + a; // isWireframe = 2.0, 3.0, 4.0 as float
                gpuDevice.queue.writeBuffer(gpuAxesUniformBuffers[a], 0, axesData.buffer);

                const axesBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuAxesUniformBuffers[a] } },
                        { binding: 1, resource: Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setBindGroup(0, axesBindGroup);
                passEncoder.setVertexBuffer(0, gpuAxesBuffer);
                passEncoder.draw(180, 1, a * 180, 0);
            }
        }
        */

        // Draw STL Geometry
        if (showSTL && gpuSTLBuffer && transformedSTLVertices && gpuSTLUniformSolid && gpuSTLUniformWireframe) {
            const count = transformedSTLVertices.length / 7;
            const dummyTexView = Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView;

            const sizeX = getDimX();
            const sizeY = getDimY();
            const sizeZ = getDimZ();
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

            const defaultStlRange = quantityRanges[stlQuantity] || DEFAULT_QUANTITY_RANGES[stlQuantity] || [101325.0, 1013250.0];
            let finalStlMin = defaultStlRange[0];
            let finalStlMax = defaultStlRange[1];
            if (stlAutoScale) {
                if (isFinite(stlVolMin) && isFinite(stlVolMax) && stlVolMax > stlVolMin) {
                    finalStlMin = stlVolMin;
                    finalStlMax = stlVolMax;
                }
            } else {
                finalStlMin = stlMinVal !== undefined ? stlMinVal : defaultStlRange[0];
                finalStlMax = stlMaxVal !== undefined ? stlMaxVal : defaultStlRange[1];
            }

            if (stlSolids && gpuPipeline) {
                const uSolid = new Float32Array(uniformData);
                uSolid.set(stlFinalModel, 32);
                uSolid[48] = stlOpacity;
                uSolid[53] = stlWireframe ? 7.0 : 5.0; // 7.0 for Solid + Wireframe, 5.0 for Solid only
                uSolid[60] = stlShowResults ? 1.0 : 0.0;
                uSolid[61] = getColormapIndex(stlColormap);
                uSolid[62] = dx || 0.01;
                uSolid[63] = finalStlMin;
                uSolid[64] = finalStlMax;
                uSolid[65] = stlLogScale ? 1.0 : 0.0;
                uSolid[68] = xmin; uSolid[69] = ymin; uSolid[70] = zmin;
                uSolid[72] = sizeX; uSolid[73] = sizeY; uSolid[74] = sizeZ;
                gpuDevice.queue.writeBuffer(gpuSTLUniformSolid, 0, uSolid.buffer);

                const stlSampler = (stlSamplingMode === 'linear') ? (gpuSamplerLinear || gpuSampler) : (gpuSamplerNearest || gpuSampler);

                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformSolid } },
                        { binding: 1, resource: dummyTexView },
                        { binding: 2, resource: stlSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuPipeline);
                passEncoder.setBindGroup(0, solidBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.draw(count);
            } else if (stlWireframe && gpuPipeline) {
                const uWire = new Float32Array(uniformData);
                uWire.set(stlFinalModel, 32);
                uWire[48] = 0.0;
                uWire[53] = 6.0; // 6.0 for Wireframe only
                uWire[60] = stlShowResults ? 1.0 : 0.0;
                uWire[61] = getColormapIndex(stlColormap);
                uWire[62] = dx || 0.01;
                uWire[63] = finalStlMin;
                uWire[64] = finalStlMax;
                uWire[65] = stlLogScale ? 1.0 : 0.0;
                uWire[68] = xmin; uWire[69] = ymin; uWire[70] = zmin;
                uWire[72] = sizeX; uWire[73] = sizeY; uWire[74] = sizeZ;
                gpuDevice.queue.writeBuffer(gpuSTLUniformWireframe, 0, uWire.buffer);

                const wireBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuSTLUniformWireframe } },
                        { binding: 1, resource: dummyTexView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuPipeline);
                passEncoder.setBindGroup(0, wireBindGroup);
                passEncoder.setVertexBuffer(0, gpuSTLBuffer);
                passEncoder.draw(count);
            }
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
                    { binding: 1, resource: Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView },
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
        if (showObstacles && gpuObstaclesVertexBuffer && obstacleTriIndexCount > 0 && gpuPipeline) {
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
            const sx = 1.0 / sizeX;
            const sy = 1.0 / sizeY;
            const sz = 1.0 / sizeZ;
            const tx = -xmin * sx - 0.5;
            const ty = -ymin * sy - 0.5;
            const tz = -zmin * sz - 0.5;

            const obsModel = new Float32Array([
                sx, 0, 0, 0,
                0, sy, 0, 0,
                0, 0, sz, 0,
                tx, ty, tz, 1
            ]);
            const obsFinalModel = multiplyMatrices(modelMatrix, obsModel);

            let obsMin = obstaclesMinVal;
            let obsMax = obstaclesMaxVal;
            if (obstaclesAutoScale !== false) {
                obsMin = Infinity;
                obsMax = -Infinity;
                if (latestObstaclesData && latestObstaclesData.length > 0) {
                    for (let i = 0; i < latestObstaclesData.length; i++) {
                        const v = latestObstaclesData[i];
                        if (v < obsMin) obsMin = v;
                        if (v > obsMax) obsMax = v;
                    }
                }
                const defaultObsRange = quantityRanges[obstaclesQuantity] || DEFAULT_QUANTITY_RANGES[obstaclesQuantity] || [0.0, 1.0];
                if (!isFinite(obsMin) || !isFinite(obsMax) || obsMax <= obsMin) {
                    obsMin = defaultObsRange[0];
                    obsMax = defaultObsRange[1];
                }
            }

            // Write solid uniforms
            const uSolid = new Float32Array(uniformData);
            uSolid.set(obsFinalModel, 32);
            uSolid[48] = obstaclesOpacity;
            uSolid[49] = getColormapIndex(obstaclesColormap);
            uSolid[50] = obsMin;
            uSolid[51] = obsMax;
            uSolid[52] = obstaclesLogScale ? 1.0 : 0.0;
            uSolid[53] = obstaclesLighting ? 9.0 : 11.0;
            gpuDevice.queue.writeBuffer(gpuUniformBufferObstaclesSolid, 0, uSolid.buffer);

            // Write wireframe uniforms
            const uWire = new Float32Array(uniformData);
            uWire.set(obsFinalModel, 32);
            uWire[48] = 1.0;
            uWire[53] = 10.0;
            gpuDevice.queue.writeBuffer(gpuUniformBufferObstaclesWire, 0, uWire.buffer);

            const dummyTexView = Object.values(activeSlicesWebGPU)[0]?.gpuTextureView || gpuDummyTextureView;

            // Draw Solid Pass
            if (obstaclesOpacity > 0.0 && gpuObstaclesTriIndexBuffer) {
                const solidBindGroup = gpuDevice.createBindGroup({
                    layout: bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: gpuUniformBufferObstaclesSolid } },
                        { binding: 1, resource: dummyTexView },
                        { binding: 2, resource: gpuSampler! },
                        { binding: 3, resource: gpuVolume3DTextureView || gpuDummy3DTextureView }
                    ]
                });

                passEncoder.setPipeline(gpuPipeline);
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
                        { binding: 1, resource: dummyTexView },
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

        // 2. Draw Slices
        const slicesArray = Object.values(activeSlicesWebGPU).filter(s => {
            const cfg = getSliceConfig(s.index);
            return !cfg || cfg.enabled !== false;
        });
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

        passEncoder.end();
        gpuDevice.queue.submit([commandEncoder.finish()]);
        sendFrameMatrixMessage();
        return;
    }

    // WebGL fallback rendering
    if (!gl || !program) return;
    gl.clearColor(0.02, 0.02, 0.02, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(program);
    const uTexLoc = gl.getUniformLocation(program, "uTexture");
    if (uTexLoc !== null) gl.uniform1i(uTexLoc, 0);

    const uVolTexLoc = gl.getUniformLocation(program, "uVolumeTexture3D");
    if (uVolTexLoc !== null) gl.uniform1i(uVolTexLoc, 1);

    if (gl.TEXTURE_3D) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, glVolume3DTexture || getDummy3DTextureGL());
        gl.activeTexture(gl.TEXTURE0);
    }

    const identityMat = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const uStlMatInitLoc = gl.getUniformLocation(program, "uStlMatrix");
    if (uStlMatInitLoc !== null) gl.uniformMatrix4fv(uStlMatInitLoc, false, identityMat);

    const uProj = gl.getUniformLocation(program, "uProjection");
    const uView = gl.getUniformLocation(program, "uView");
    const uModel = gl.getUniformLocation(program, "uModel");
    const uAlpha = gl.getUniformLocation(program, "uAlpha");
    const uColormap = gl.getUniformLocation(program, "uColormap");
    const uMin = gl.getUniformLocation(program, "uMin");
    const uMax = gl.getUniformLocation(program, "uMax");
    const uUseLog = gl.getUniformLocation(program, "uUseLogScale");
    const uIsAMRLoc = gl.getUniformLocation(program, "uIsAMR");
    const uIsWF = gl.getUniformLocation(program, "uIsWireframe");

    gl.uniformMatrix4fv(uProj, false, projectionMatrix);
    gl.uniform1i(uColormap, colormap);
    gl.uniform1f(uMin, minY);
    gl.uniform1f(uMax, maxY);
    gl.uniform1i(uUseLog, useLogScale ? 1 : 0);
    if (uIsAMRLoc !== null) gl.uniform1i(uIsAMRLoc, meshType === 'amr' ? 1 : 0);
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

    if (amrTilesBuffer && amrTilesCount > 0) {
        gl.uniform1i(uIsWF, 10);
        gl.bindBuffer(gl.ARRAY_BUFFER, amrTilesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
        gl.drawArrays(gl.LINES, 0, amrTilesCount);
    }

    // Draw Axes Indicator (disabled to draw tick labels on bounding box instead)
    /*
    if (axesBuffer) {
        const sizeX = getDimX();
        const sizeY = getDimY();
        const sizeZ = getDimZ();
        const maxSize = Math.max(sizeX, sizeY, sizeZ);
        const sX = sizeX / maxSize;
        const sY = sizeY / maxSize;
        const sZ = sizeZ / maxSize;
        const axesModelMatrix = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            -sX/2, -sY/2, -sZ/2, 1
        ]);
        gl.uniformMatrix4fv(uModel, false, axesModelMatrix);

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
        gl.uniformMatrix4fv(uModel, false, modelMatrix);
    }
    */

    // Draw STL Geometry fallback in WebGL
    if (showSTL && stlBuffer && transformedSTLVertices) {
        const count = transformedSTLVertices.length / 7;

        const sizeX = getDimX();
        const sizeY = getDimY();
        const sizeZ = getDimZ();
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

        const uStlMatLoc = gl.getUniformLocation(program, "uStlMatrix");
        if (uStlMatLoc !== null) gl.uniformMatrix4fv(uStlMatLoc, false, stlModel);

        gl.bindBuffer(gl.ARRAY_BUFFER, stlBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);
        if (glVolume3DTexture && gl.TEXTURE_3D) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, glVolume3DTexture);
            const filter = (stlSamplingMode === 'linear') ? gl.LINEAR : gl.NEAREST;
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
            
            const uVolumeTexLoc = gl.getUniformLocation(program, "uVolumeTexture3D");
            if (uVolumeTexLoc !== null) gl.uniform1i(uVolumeTexLoc, 1);
        }
        
        const uStlShowResLoc = gl.getUniformLocation(program, "uStlShowResults");
        if (uStlShowResLoc !== null) gl.uniform1i(uStlShowResLoc, stlShowResults ? 1 : 0);
        
        const uStlCmapLoc = gl.getUniformLocation(program, "uStlColormap");
        if (uStlCmapLoc !== null) gl.uniform1i(uStlCmapLoc, getColormapIndex(stlColormap));
        
        const uDomainMinLoc = gl.getUniformLocation(program, "uDomainMin");
        if (uDomainMinLoc !== null) gl.uniform3f(uDomainMinLoc, xmin, ymin, zmin);
        
        const uDomainExtentLoc = gl.getUniformLocation(program, "uDomainExtent");
        if (uDomainExtentLoc !== null) gl.uniform3f(uDomainExtentLoc, sizeX, sizeY, sizeZ);
        
        const uDxLoc = gl.getUniformLocation(program, "uDx");
        if (uDxLoc !== null) gl.uniform1f(uDxLoc, dx || 0.01);

        const defaultStlRange = quantityRanges[stlQuantity] || DEFAULT_QUANTITY_RANGES[stlQuantity] || [101325.0, 1013250.0];
        let finalStlMin = defaultStlRange[0];
        let finalStlMax = defaultStlRange[1];
        if (stlAutoScale) {
            if (isFinite(stlVolMin) && isFinite(stlVolMax) && stlVolMax > stlVolMin) {
                finalStlMin = stlVolMin;
                finalStlMax = stlVolMax;
            }
        } else {
            finalStlMin = stlMinVal !== undefined ? stlMinVal : defaultStlRange[0];
            finalStlMax = stlMaxVal !== undefined ? stlMaxVal : defaultStlRange[1];
        }

        const uStlMinLoc = gl.getUniformLocation(program, "uStlMin");
        if (uStlMinLoc !== null) gl.uniform1f(uStlMinLoc, finalStlMin);

        const uStlMaxLoc = gl.getUniformLocation(program, "uStlMax");
        if (uStlMaxLoc !== null) gl.uniform1f(uStlMaxLoc, finalStlMax);

        const uStlLogLoc = gl.getUniformLocation(program, "uStlLogScale");
        if (uStlLogLoc !== null) gl.uniform1i(uStlLogLoc, stlLogScale ? 1 : 0);

        if (stlSolids) {
            gl.uniform1i(uIsWF, stlWireframe ? 7 : 5); // 7 = Solid + Wireframe, 5 = Solid only
            gl.uniform1f(uAlpha, stlOpacity);
            gl.drawArrays(gl.TRIANGLES, 0, count);
        } else if (stlWireframe) {
            gl.uniform1i(uIsWF, 6); // 6 = Wireframe only
            gl.uniform1f(uAlpha, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, count);
        }

        // Restore base model matrix for slices
        gl.uniformMatrix4fv(uModel, false, modelMatrix);
    }

    // Draw Gauges in WebGL fallback
    if (showGauges && gaugesBuffer && gaugesCount > 0) {
        gl.uniform1i(uIsWF, 8); // uIsWireframe = 8 (Gauges color & solid mode)
        gl.uniform1f(uAlpha, 1.0);
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
        const sx = 1.0 / sizeX;
        const sy = 1.0 / sizeY;
        const sz = 1.0 / sizeZ;
        const tx = -xmin * sx - 0.5;
        const ty = -ymin * sy - 0.5;
        const tz = -zmin * sz - 0.5;

        const obsModel = new Float32Array([
            sx, 0, 0, 0,
            0, sy, 0, 0,
            0, 0, sz, 0,
            tx, ty, tz, 1
        ]);
        const obsFinalModel = multiplyMatrices(modelMatrix, obsModel);
        gl.uniformMatrix4fv(uModel, false, obsFinalModel);

        gl.bindBuffer(gl.ARRAY_BUFFER, obstacleBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 20);
        gl.enableVertexAttribArray(2);

        let obsMin = obstaclesMinVal;
        let obsMax = obstaclesMaxVal;
        if (obstaclesAutoScale !== false) {
            obsMin = Infinity;
            obsMax = -Infinity;
            if (latestObstaclesData && latestObstaclesData.length > 0) {
                for (let i = 0; i < latestObstaclesData.length; i++) {
                    const v = latestObstaclesData[i];
                    if (v < obsMin) obsMin = v;
                    if (v > obsMax) obsMax = v;
                }
            }
            const defaultObsRange = quantityRanges[obstaclesQuantity] || DEFAULT_QUANTITY_RANGES[obstaclesQuantity] || [0.0, 1.0];
            if (!isFinite(obsMin) || !isFinite(obsMax) || obsMax <= obsMin) {
                obsMin = defaultObsRange[0];
                obsMax = defaultObsRange[1];
            }
        }

        // Solid pass
        if (obstaclesOpacity > 0.0) {
            gl.uniform1i(uIsWF, obstaclesLighting ? 9 : 11);
            gl.uniform1f(uAlpha, obstaclesOpacity);
            const uColormapLoc = gl.getUniformLocation(program, "uColormap");
            const uMinLoc = gl.getUniformLocation(program, "uMin");
            const uMaxLoc = gl.getUniformLocation(program, "uMax");
            const uLogLoc = gl.getUniformLocation(program, "uUseLogScale");
            if (uColormapLoc) gl.uniform1i(uColormapLoc, getColormapIndex(obstaclesColormap));
            if (uMinLoc) gl.uniform1f(uMinLoc, obsMin);
            if (uMaxLoc) gl.uniform1f(uMaxLoc, obsMax);
            if (uLogLoc) gl.uniform1i(uLogLoc, obstaclesLogScale ? 1.0 : 0.0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleTriIndexBuffer);
            gl.drawElements(gl.TRIANGLES, obstacleTriIndexCount, gl.UNSIGNED_INT, 0);
        }

        // Gridlines pass
        if (obstaclesGridlines) {
            gl.uniform1i(uIsWF, 10);
            gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obstacleWireIndexBuffer);
            gl.drawElements(gl.LINES, obstacleWireIndexCount, gl.UNSIGNED_INT, 0);
        }

        // Restore base model matrix
        gl.uniformMatrix4fv(uModel, false, modelMatrix);
    }

    gl.uniform1i(uIsWF, 0);
    const uShowEdges = gl.getUniformLocation(program, "uShowCellEdges");
    if (uShowEdges !== null) {
        gl.uniform1i(uShowEdges, (meshType === 'amr') ? 0 : (shouldShowCellEdges() ? 1 : 0));
    }
    const uInterp = gl.getUniformLocation(program, "uInterpolate");
    if (uInterp !== null) {
        gl.uniform1i(uInterp, interpolate ? 1 : 0);
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

    const slicesArrayWebGL = Object.values(activeSlicesWebGL).filter(s => {
        const cfg = getSliceConfig(s.index);
        return !cfg || cfg.enabled !== false;
    });

    if (slicesArrayWebGL.length > 0) {
        const opaqueSlices = slicesArrayWebGL.filter(s => {
            const props = getSliceProperties(s);
            return props.opacity >= 0.999;
        });
        const transparentSlices = slicesArrayWebGL.filter(s => {
            const props = getSliceProperties(s);
            return props.opacity < 0.999;
        });

        const uAxisLoc = gl!.getUniformLocation(program, "uAxis");
        const uIsSubmeshLoc = gl!.getUniformLocation(program, "uIsSubmesh");
        const uNumMasksLoc = gl!.getUniformLocation(program, "uNumSubmeshMasks");
        const uMasksLoc = gl!.getUniformLocation(program, "uSubmeshMasks");

        // Pass 1: Opaque Slices (depth write enabled)
        opaqueSlices.forEach(slice => {
            const props = getSliceProperties(slice);

            gl!.uniform1i(uIsWF, 0);
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

            gl!.uniform1f(uMin, props.minY ?? minY);
            gl!.uniform1f(uMax, props.maxY ?? maxY);
            gl!.uniform1i(uColormap, getColormapIndex(props.colormap));
            gl!.uniform1i(uUseLog, props.useLogScale ? 1 : 0);
            if (uInterp !== null) {
                gl!.uniform1i(uInterp, props.interpolate ? 1 : 0);
            }
            gl!.uniform1f(uAlpha, 1.0);

            // Set submesh mask uniforms
            if (uAxisLoc !== null) gl!.uniform1i(uAxisLoc, slice.axis);
            if (uIsSubmeshLoc !== null) gl!.uniform1i(uIsSubmeshLoc, slice.is_submesh ? 1 : 0);
            const { masks, numMasks } = getSubmeshMasks(slice);
            if (uNumMasksLoc !== null) gl!.uniform1i(uNumMasksLoc, numMasks);
            if (uMasksLoc !== null && numMasks > 0) {
                gl!.uniform4fv(uMasksLoc, new Float32Array(masks));
            }

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
                const props = getSliceProperties(slice);

                gl!.uniform1i(uIsWF, 0);
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

                gl!.uniform1f(uMin, props.minY ?? minY);
                gl!.uniform1f(uMax, props.maxY ?? maxY);
                gl!.uniform1i(uColormap, getColormapIndex(props.colormap));
                gl!.uniform1i(uUseLog, props.useLogScale ? 1 : 0);
                if (uInterp !== null) {
                    gl!.uniform1i(uInterp, props.interpolate ? 1 : 0);
                }
                gl!.uniform1f(uAlpha, props.opacity);

                // Set submesh mask uniforms
                if (uAxisLoc !== null) gl!.uniform1i(uAxisLoc, slice.axis);
                if (uIsSubmeshLoc !== null) gl!.uniform1i(uIsSubmeshLoc, slice.is_submesh ? 1 : 0);
                const { masks, numMasks } = getSubmeshMasks(slice);
                if (uNumMasksLoc !== null) gl!.uniform1i(uNumMasksLoc, numMasks);
                if (uMasksLoc !== null && numMasks > 0) {
                    gl!.uniform4fv(uMasksLoc, new Float32Array(masks));
                }

                gl!.drawArrays(gl!.TRIANGLES, 0, 6);
            });

            gl.depthMask(true);
        }

        if (sliceGridlinesBuffer && sliceGridlinesCount > 0) {
            gl.depthMask(false);
            gl.uniform1i(uIsWF, 10);
            gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, sliceGridlinesBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.drawArrays(gl.LINES, 0, sliceGridlinesCount);
            gl.depthMask(true);
        }
    }

    // Draw 3D MPM Particles Point Cloud
    if (showMPMParticles && mpmParticlesBuffer && mpmParticlesCount > 0) {
        gl.uniform1i(uIsWF, 14);
        gl.uniform1f(uAlpha, 1.0);
        const uParticleSizeLoc = gl.getUniformLocation(program, "uParticleSize");
        if (uParticleSizeLoc !== null) gl.uniform1f(uParticleSizeLoc, mpmParticleSize || 4.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, mpmParticlesBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);  // position (x, y, z)
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12); // texCoord = (r, g)
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 20); // sliceSize = (b, 0)
        gl.enableVertexAttribArray(2);
        gl.drawArrays(gl.POINTS, 0, mpmParticlesCount);
    }

    // Draw Charge Geometry
    if (showCharge) {
        if (chargeSolid && chargeBuffer && chargeCount > 0) {
            gl.uniform1i(uIsWF, 13);
            gl.uniform1f(uAlpha, chargeOpacity);
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
            gl.uniform1i(uIsWF, 13);
            gl.uniform1f(uAlpha, 1.0);
            gl.bindBuffer(gl.ARRAY_BUFFER, chargeWireBuffer);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(0);
            gl.disableVertexAttribArray(1);
            gl.disableVertexAttribArray(2);
            gl.drawArrays(gl.LINES, 0, chargeWireCount);
        }
    }
    sendFrameMatrixMessage();
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
            updateMatrices(finalW, finalH);
            render();
        } else if (type === "setSTLGeometry") {
            rawSTLVertices = data.vertices;
            rawSTLSubtractiveFlags = data.subtractive_flags;
            updateSTLGeometry();
            render();
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
            render();
        } else if (type === "resize") {
            const w = data.width > 0 ? data.width : 300;
            const h = data.height > 0 ? data.height : 150;
            lastRequestedWidth = w;
            lastRequestedHeight = h;
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
                distance = Math.max(0.0001, distance + data.dy * 0.01 * distance * 0.1);
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
        } else if (type === "setRotationCenterFromClick") {
            const w = canvasWidth();
            const h = canvasHeight();
            handleSetRotationCenterFromClick(data.mouseX, data.mouseY, w, h);
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
            if (data.xmin !== undefined) xmin = data.xmin;
            if (data.xmax !== undefined) xmax = data.xmax;
            if (data.ymin !== undefined) ymin = data.ymin;
            if (data.ymax !== undefined) ymax = data.ymax;
            if (data.zmin !== undefined) zmin = data.zmin;
            if (data.zmax !== undefined) zmax = data.zmax;
            if (data.dx !== undefined) dx = data.dx;
            if (data.dy !== undefined) dy = data.dy;
            if (data.dz !== undefined) dz = data.dz;
            if (data.nx !== undefined) nx = data.nx;
            if (data.ny !== undefined) ny = data.ny;
            if (data.nz !== undefined) nz = data.nz;
            if (data.usePerspective !== undefined) usePerspective = data.usePerspective;
            if (data.fov !== undefined) fov = data.fov;
            if (data.lightingEnabled !== undefined) lightingEnabled = data.lightingEnabled;
            if (data.aoEnabled !== undefined) aoEnabled = data.aoEnabled;
            if (data.specularIntensity !== undefined) specularIntensity = data.specularIntensity;
            if (data.ambientLevel !== undefined) ambientLevel = data.ambientLevel;
            if (data.quantityColormaps !== undefined) {
                quantityColormaps = { ...quantityColormaps, ...data.quantityColormaps };
                if (cachedSlices.length > 0) {
                    cachedSlices.forEach((sliceObj, i) => {
                        const config = getSliceConfig(i);
                        const qty = config?.quantities?.[0] || 'pressure';
                        sliceObj.colormap = quantityColormaps[qty] || config?.colormap || 'plasma';
                    });
                }
            }
            if (data.quantityRanges !== undefined) {
                quantityRanges = { ...quantityRanges, ...data.quantityRanges };
            }
            if (data.sliceOpacities !== undefined) sliceOpacities = data.sliceOpacities;

            if (data.showObstacles !== undefined) showObstacles = data.showObstacles;
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
            }

            if (data.showMPMParticles !== undefined) showMPMParticles = data.showMPMParticles;
            if (data.mpmParticleSize !== undefined) mpmParticleSize = data.mpmParticleSize;
            if (data.mpmParticleQuantity !== undefined) {
                mpmParticleQuantity = data.mpmParticleQuantity;
                updateMPMParticlesGeometry();
            }
            if (data.mpmParticleColormap !== undefined) {
                mpmParticleColormap = data.mpmParticleColormap;
                updateMPMParticlesGeometry();
            }
            if (data.mpmParticleAutoScale !== undefined) mpmParticleAutoScale = data.mpmParticleAutoScale;
            if (data.mpmParticleMinVal !== undefined) mpmParticleMinVal = data.mpmParticleMinVal;
            if (data.mpmParticleMaxVal !== undefined) mpmParticleMaxVal = data.mpmParticleMaxVal;

            if (data.xmin !== undefined || data.xmax !== undefined || data.ymin !== undefined || data.ymax !== undefined || data.zmin !== undefined || data.zmax !== undefined || data.dx !== undefined || data.nx !== undefined || data.ny !== undefined || data.nz !== undefined) {
                gaugesChanged = true;
                updateMatrices(canvasWidth(), canvasHeight());
                updateSTLGeometry();
                updateChargeGeometry();
            }
            if (gaugesChanged) {
                updateGaugesGeometry();
            }
            if (data.slices !== undefined) {
                slicesConfig = data.slices;
                
                // Ensure cachedSlices length matches slicesConfig length if we have at least one valid slice
                if (cachedSlices.length > 0) {
                    const parentSlices = cachedSlices.filter(s => !s.is_submesh);
                    const submeshSlices = cachedSlices.filter(s => s.is_submesh);

                    while (parentSlices.length < slicesConfig.length) {
                        const i = parentSlices.length;
                        const config = slicesConfig[i];
                        const refSlice = parentSlices[0] || submeshSlices[0];
                        const w = refSlice ? refSlice.w : 64;
                        const h = refSlice ? refSlice.h : 64;
                        const dummyData = new Float32Array(w * h);
                        if (refSlice && refSlice.data.length > 0) {
                            dummyData.fill(refSlice.data[0]);
                        }
                        parentSlices.push({
                            axis: config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2,
                            offset: config.offset,
                            w,
                            h,
                            xmin: xmin,
                            xmax: xmin + getDimX(),
                            ymin: ymin,
                            ymax: ymin + getDimY(),
                            zmin: zmin,
                            zmax: zmin + getDimZ(),
                            level: 0,
                            is_submesh: false,
                            data: dummyData,
                            minY: config.min_val ?? 101325.0,
                            maxY: config.max_val ?? 1013250.0,
                            colormap: config.colormap || 'plasma',
                            useLogScale: config.log_scale === true,
                            interpolate: config.interpolate !== false
                        });
                    }

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
                
                // Now, update cachedSlices configurations in-place
                cachedSlices.forEach((sliceObj, i) => {
                    const config = getSliceConfig(i);
                    if (!config) return;
                    const targetAxis = config.axis === 'xy' ? 0 : config.axis === 'xz' ? 1 : 2;
                    if (targetAxis === sliceObj.axis) {
                        sliceObj.offset = config.offset;
                    }
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
            if (data.stlWireframe !== undefined) stlWireframe = data.stlWireframe;
            if (data.stlSolids !== undefined) stlSolids = data.stlSolids;
            if (data.stlOpacity !== undefined) stlOpacity = data.stlOpacity;
            if (data.stlColormap !== undefined) stlColormap = data.stlColormap;
            if (data.stlShowResults !== undefined) stlShowResults = data.stlShowResults;
            if (data.stlQuantity !== undefined) stlQuantity = data.stlQuantity;
            if (data.stlSamplingMode !== undefined) stlSamplingMode = data.stlSamplingMode;
            if (data.stlAutoScale !== undefined) stlAutoScale = data.stlAutoScale;
            if (data.stlLogScale !== undefined) stlLogScale = data.stlLogScale;
            if (data.stlMinVal !== undefined) stlMinVal = data.stlMinVal;
            if (data.stlMaxVal !== undefined) stlMaxVal = data.stlMaxVal;

            // Recalculate range immediately using cached frame data
            if (cachedSlices.length > 0) {
                const sliceRanges: { min: number, max: number }[] = [];
                for (let i = 0; i < cachedSlices.length; i++) {
                    const slice = cachedSlices[i];
                    const config = getSliceConfig(i);
                    const qty = config.quantities?.[0] || 'pressure';
                    const sliceAutoScale = config.auto_scale !== false;

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

                    const logVal = config.log_scale === true || (config.log_scale !== false && sliceMax > 0 && sliceMin > 0 && (sliceMax / sliceMin > 50.0));
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
                render();
            }
        }
    } catch (err: any) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
