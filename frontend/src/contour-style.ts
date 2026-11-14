// contour-style.ts
// Single Source of Truth (SSOT) for per-quantity contour styling, colormap evaluation,
// discrete band quantization, auto-range sample validation, and GPU shader colormap generation.

export type ColormapId =
    | 'rainbow'
    | 'turbo'
    | 'plasma'
    | 'viridis'
    | 'inferno'
    | 'magma'
    | 'jet'
    | 'coolwarm'
    | 'cividis'
    | 'grayscale'
    | 'materials';

export interface QuantityContourStyle {
    colormap: ColormapId;
    autoScale: boolean;
    logScale: boolean;
    minVal: number;
    maxVal: number;
    contourLevels: number;    // 0 = continuous gradient, >= 2 = discrete contour bands
    smoothContours: boolean;  // true when continuous, false when discrete bands are active
    interpolate: boolean;     // true = Smooth / Linear / Nodal, false = Cell / Nearest / Facet
    showColorbar: boolean;    // Whether the unified colour bar for this quantity is visible
}

export const COLORMAP_OPTIONS: ReadonlyArray<{ id: ColormapId; label: string; shaderIndex: number }> = [
    { id: 'rainbow',   label: 'Rainbow',           shaderIndex: 2 },
    { id: 'turbo',     label: 'Turbo',             shaderIndex: 7 },
    { id: 'plasma',    label: 'Plasma',            shaderIndex: 0 },
    { id: 'viridis',   label: 'Viridis',           shaderIndex: 1 },
    { id: 'inferno',   label: 'Inferno',           shaderIndex: 8 },
    { id: 'magma',     label: 'Magma',             shaderIndex: 9 },
    { id: 'jet',       label: 'Jet',               shaderIndex: 10 },
    { id: 'coolwarm',  label: 'Cool-Warm',         shaderIndex: 3 },
    { id: 'cividis',   label: 'Cividis',           shaderIndex: 4 },
    { id: 'grayscale', label: 'Grayscale',         shaderIndex: 5 },
    { id: 'materials', label: 'Materials / Phase', shaderIndex: 6 }
];

export const CONTOUR_BAND_PRESETS: ReadonlyArray<number> = [5, 8, 10, 12, 16, 20, 24];

export function normalizeColormapId(name?: string | null): ColormapId {
    if (!name) return 'rainbow';
    const s = String(name).trim().toLowerCase();
    switch (s) {
        case 'plasma': return 'plasma';
        case 'viridis': return 'viridis';
        case 'rainbow': return 'rainbow';
        case 'coolwarm':
        case 'cool-warm': return 'coolwarm';
        case 'cividis': return 'cividis';
        case 'grayscale':
        case 'greyscale': return 'grayscale';
        case 'materials':
        case 'material':
        case 'phase': return 'materials';
        case 'turbo': return 'turbo';
        case 'inferno': return 'inferno';
        case 'magma': return 'magma';
        case 'jet': return 'jet';
        default: return 'rainbow';
    }
}

export function getColormapIndex(name?: string | null): number {
    const id = normalizeColormapId(name);
    switch (id) {
        case 'plasma': return 0;
        case 'viridis': return 1;
        case 'rainbow': return 2;
        case 'coolwarm': return 3;
        case 'cividis': return 4;
        case 'grayscale': return 5;
        case 'materials': return 6;
        case 'turbo': return 7;
        case 'inferno': return 8;
        case 'magma': return 9;
        case 'jet': return 10;
        default: return 2;
    }
}

export function getColormapLabel(name?: string | null): string {
    const id = normalizeColormapId(name);
    const found = COLORMAP_OPTIONS.find(o => o.id === id);
    return found ? found.label : 'Rainbow';
}

export function canonicalizeQuantity(q: string | undefined | null): string {
    if (!q) return 'pressure';
    const s = String(q).trim().toLowerCase();
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
    if (s === 'velocity' || s === 'speed' || s === 'vel') return 'velocity';
    if (s === 'materials' || s === 'material' || s === 'phase') return 'materials';
    if (s === 'momentorforce' || s === 'moment_or_force' || s === 'axial_force' || s === 'beam_force') return 'momentOrForce';
    if (s === 'pressure' || s === 'density' || s === 'energy' || s === 'solid' || s === 'amr_level') return s;
    return s;
}

export const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    speed: [0.0, 1000.0],
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
    materials: [0.0, 5.0],
    overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0],
    peak_overpressure: [0.0, 101325.0 * 99.0],
    peak_impulse: [0.0, 10000.0],
    vonMises: [0.0, 500000000.0],
    von_mises: [0.0, 500000000.0],
    plasticStrain: [0.0, 1.0],
    plastic_strain: [0.0, 1.0],
    damage: [0.0, 1.0],
    has_failed: [0.0, 1.0],
    cluster_id: [0.0, 50.0],
    object_id: [0.0, 10.0],
    temperature: [300.0, 3000.0],
    displacement: [0.0, 0.1],
    momentOrForce: [0.0, 1000.0]
};

/**
 * Returns true for strictly positive physical thermodynamic quantities where `val <= 0`
 * represents masked solid obstacle interior cells or uninitialized padding in fluid grids.
 */
export function isStrictlyPositiveThermodynamicQuantity(qty: string): boolean {
    const cQty = canonicalizeQuantity(qty);
    return cQty === 'pressure' || cQty === 'density' || cQty === 'temperature' || cQty === 'energy';
}

/**
 * Validates whether a scalar sample should participate in shared Auto [min, max] calculation.
 * Rejects NaN / Infinity and excludes <= 0 placeholder values inside voxelized solid obstacles
 * for strictly positive thermodynamic state quantities (e.g. 0 Pa inside solid blocks).
 */
export function isValidQuantitySample(qty: string, val: number): boolean {
    if (!Number.isFinite(val)) return false;
    if (isStrictlyPositiveThermodynamicQuantity(qty) && val <= 0.0) return false;
    return true;
}

export function getDefaultQuantityStyle(qty: string): QuantityContourStyle {
    const cQty = canonicalizeQuantity(qty);
    const defRange = DEFAULT_QUANTITY_RANGES[cQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
    const isDiscreteField = cQty === 'solid' || cQty === 'materials' || cQty === 'cluster_id' || cQty === 'object_id' || cQty === 'has_failed';
    return {
        colormap: cQty === 'materials' ? 'materials' : 'rainbow',
        autoScale: true,
        logScale: false,
        minVal: defRange[0],
        maxVal: defRange[1],
        contourLevels: 0,
        smoothContours: true,
        interpolate: !isDiscreteField,
        showColorbar: true
    };
}

/**
 * Resolves the single authoritative QuantityContourStyle for `qty` from a viewport node's
 * parameters, transparently migrating any legacy per-layer or partial map fields.
 */
export function getQuantityStyle(params: Record<string, any> | undefined | null, qty: string): QuantityContourStyle {
    const cQty = canonicalizeQuantity(qty);
    const def = getDefaultQuantityStyle(cQty);
    if (!params) return def;

    const storedMap = params.quantity_styles || params.quantityStyles;
    const stored: Partial<QuantityContourStyle> | undefined =
        storedMap?.[cQty] || storedMap?.[qty];

    const qCmaps = params.quantity_colormaps || params.quantityColormaps || {};
    const qRanges = params.quantity_ranges || params.quantityRanges || {};
    const qAutos = params.quantity_auto_scales || params.quantityAutoScales || {};
    const qLogs = params.quantity_log_scales || params.quantityLogScales || {};
    const qVis = params.colorbar_quantities_visible || {};

    // Legacy fallback discovery across slices / FEM / MPM / STL / Obstacles when migrating older projects
    let legacyLevels: number | undefined;
    let legacySmooth: boolean | undefined;
    let legacyInterp: boolean | undefined;
    let legacyCmap: string | undefined;
    let legacyAuto: boolean | undefined;
    let legacyLog: boolean | undefined;
    let legacyRange: [number, number] | undefined;

    if (Array.isArray(params.slices)) {
        const matchingSlice = params.slices.find((s: any) => canonicalizeQuantity(s?.quantities?.[0] || 'pressure') === cQty);
        if (matchingSlice) {
            if (matchingSlice.contour_levels !== undefined) legacyLevels = Number(matchingSlice.contour_levels);
            if (matchingSlice.smooth_contours !== undefined) legacySmooth = Boolean(matchingSlice.smooth_contours);
            if (matchingSlice.interpolate !== undefined) legacyInterp = Boolean(matchingSlice.interpolate);
            if (matchingSlice.colormap) legacyCmap = matchingSlice.colormap;
            if (matchingSlice.auto_scale !== undefined) legacyAuto = Boolean(matchingSlice.auto_scale);
            if (matchingSlice.log_scale !== undefined) legacyLog = Boolean(matchingSlice.log_scale);
            if (matchingSlice.min_val !== undefined && matchingSlice.max_val !== undefined) {
                legacyRange = [Number(matchingSlice.min_val), Number(matchingSlice.max_val)];
            }
        }
    }
    if (legacyLevels === undefined && params.sliceContourLevels !== undefined && (cQty === 'pressure' || cQty === 'density' || cQty === 'velocity' || cQty === 'energy' || cQty === 'peak_overpressure' || cQty === 'peak_impulse')) {
        legacyLevels = Number(params.sliceContourLevels);
        legacySmooth = params.sliceSmoothContours !== undefined ? Boolean(params.sliceSmoothContours) : (legacyLevels <= 1);
    }
    if (legacyLevels === undefined && canonicalizeQuantity(params.femQuantity || 'vonMises') === cQty && params.femContourLevels !== undefined) {
        legacyLevels = Number(params.femContourLevels);
        legacySmooth = params.femSmoothContours !== undefined ? Boolean(params.femSmoothContours) : (legacyLevels <= 1);
        if (legacyInterp === undefined && params.femInterpolate !== undefined) legacyInterp = Boolean(params.femInterpolate);
    }
    if (legacyLevels === undefined && canonicalizeQuantity(params.mpmParticleQuantity || 'vonMises') === cQty && params.mpmContourLevels !== undefined) {
        legacyLevels = Number(params.mpmContourLevels);
        legacySmooth = params.mpmSmoothContours !== undefined ? Boolean(params.mpmSmoothContours) : (legacyLevels <= 1);
    }
    if (legacyLevels === undefined && canonicalizeQuantity(params.stl_quantity || 'pressure') === cQty && params.stl_contour_levels !== undefined) {
        legacyLevels = Number(params.stl_contour_levels);
        legacySmooth = params.stl_smooth_contours !== undefined ? Boolean(params.stl_smooth_contours) : (legacyLevels <= 1);
        if (legacyInterp === undefined && params.stl_sampling_mode !== undefined) legacyInterp = params.stl_sampling_mode !== 'nearest';
    }

    const resolvedRange =
        (stored?.minVal !== undefined && stored?.maxVal !== undefined && Number.isFinite(stored.minVal) && Number.isFinite(stored.maxVal))
            ? [Number(stored.minVal), Number(stored.maxVal)]
            : (qRanges[cQty] || qRanges[qty] || legacyRange || [def.minVal, def.maxVal]);

    let contourLevels = stored?.contourLevels !== undefined
        ? Math.max(0, Math.round(Number(stored.contourLevels)))
        : (legacyLevels !== undefined ? Math.max(0, Math.round(legacyLevels)) : def.contourLevels);

    let smoothContours = stored?.smoothContours !== undefined
        ? Boolean(stored.smoothContours)
        : (legacySmooth !== undefined ? legacySmooth : (contourLevels <= 1));

    if (contourLevels <= 1) {
        contourLevels = 0;
        smoothContours = true;
    } else if (smoothContours) {
        contourLevels = 0;
    }

    const colormap = normalizeColormapId(
        stored?.colormap ?? qCmaps[cQty] ?? qCmaps[qty] ?? legacyCmap ?? def.colormap
    );
    const autoScale = stored?.autoScale !== undefined
        ? Boolean(stored.autoScale)
        : (qAutos[cQty] !== undefined ? Boolean(qAutos[cQty]) : (qAutos[qty] !== undefined ? Boolean(qAutos[qty]) : (legacyAuto ?? def.autoScale)));
    const logScale = stored?.logScale !== undefined
        ? Boolean(stored.logScale)
        : (qLogs[cQty] !== undefined ? Boolean(qLogs[cQty]) : (qLogs[qty] !== undefined ? Boolean(qLogs[qty]) : (legacyLog ?? def.logScale)));
    const interpolate = stored?.interpolate !== undefined
        ? Boolean(stored.interpolate)
        : (legacyInterp !== undefined ? legacyInterp : (params.interpolate !== undefined && cQty !== 'solid' && cQty !== 'materials' ? Boolean(params.interpolate) : def.interpolate));
    const showColorbar = stored?.showColorbar !== undefined
        ? Boolean(stored.showColorbar)
        : (qVis[cQty] !== undefined ? Boolean(qVis[cQty]) : (qVis[qty] !== undefined ? Boolean(qVis[qty]) : def.showColorbar));

    return {
        colormap,
        autoScale,
        logScale,
        minVal: Number.isFinite(Number(resolvedRange[0])) ? Number(resolvedRange[0]) : def.minVal,
        maxVal: Number.isFinite(Number(resolvedRange[1])) ? Number(resolvedRange[1]) : def.maxVal,
        contourLevels,
        smoothContours,
        interpolate,
        showColorbar
    };
}

const KNOWN_CANONICAL_QUANTITIES: ReadonlyArray<string> = [
    'pressure',
    'density',
    'velocity',
    'energy',
    'species1',
    'species2',
    'species3',
    'solid',
    'materials',
    'peak_overpressure',
    'peak_impulse',
    'vonMises',
    'plastic_strain',
    'damage',
    'has_failed',
    'cluster_id',
    'object_id',
    'temperature',
    'displacement',
    'momentOrForce'
];

/**
 * Builds a complete canonical map of QuantityContourStyle entries for worker synchronization.
 */
export function buildAllQuantityStylesMap(params: Record<string, any> | undefined | null): Record<string, QuantityContourStyle> {
    const out: Record<string, QuantityContourStyle> = {};
    const keys = new Set<string>(KNOWN_CANONICAL_QUANTITIES);
    if (params) {
        const sources = [
            params.quantity_styles,
            params.quantityStyles,
            params.quantity_colormaps,
            params.quantity_ranges,
            params.quantity_auto_scales,
            params.quantity_log_scales
        ];
        for (const src of sources) {
            if (src && typeof src === 'object') {
                for (const k of Object.keys(src)) keys.add(canonicalizeQuantity(k));
            }
        }
        if (Array.isArray(params.slices)) {
            for (const s of params.slices) {
                if (s?.quantities?.[0]) keys.add(canonicalizeQuantity(s.quantities[0]));
            }
        }
        if (params.stl_quantity) keys.add(canonicalizeQuantity(params.stl_quantity));
        if (params.obstacles_quantity) keys.add(canonicalizeQuantity(params.obstacles_quantity));
        if (params.mpmParticleQuantity) keys.add(canonicalizeQuantity(params.mpmParticleQuantity));
        if (params.femQuantity) keys.add(canonicalizeQuantity(params.femQuantity));
        if (params.beamQuantity) keys.add(canonicalizeQuantity(params.beamQuantity));
    }
    for (const k of keys) {
        out[k] = getQuantityStyle(params, k);
    }
    return out;
}

/**
 * Applies a partial QuantityContourStyle update to `params` and returns a clean `updates`
 * dictionary that updates `quantity_styles[cQty]` while keeping legacy parameter mirrors
 * (`quantity_colormaps`, `quantity_ranges`, `quantity_auto_scales`, `quantity_log_scales`,
 * `colorbar_quantities_visible`, and matching object mirrors) 100% synchronized.
 */
export function applyQuantityStyleUpdate(
    params: Record<string, any>,
    qty: string,
    patch: Partial<QuantityContourStyle>
): { canonicalQty: string; nextStyle: QuantityContourStyle; updates: Record<string, any> } {
    const cQty = canonicalizeQuantity(qty);
    const prev = getQuantityStyle(params, cQty);

    let contourLevels = patch.contourLevels !== undefined ? Math.max(0, Math.round(Number(patch.contourLevels))) : prev.contourLevels;
    let smoothContours = patch.smoothContours !== undefined ? Boolean(patch.smoothContours) : prev.smoothContours;

    if (patch.contourLevels !== undefined && patch.smoothContours === undefined) {
        smoothContours = contourLevels <= 1;
    } else if (patch.smoothContours !== undefined && patch.contourLevels === undefined) {
        if (smoothContours) {
            contourLevels = 0;
        } else if (contourLevels <= 1) {
            contourLevels = 10;
        }
    }
    if (contourLevels <= 1) {
        contourLevels = 0;
        smoothContours = true;
    } else if (smoothContours) {
        contourLevels = 0;
    }

    const nextStyle: QuantityContourStyle = {
        colormap: patch.colormap !== undefined ? normalizeColormapId(patch.colormap) : prev.colormap,
        autoScale: patch.autoScale !== undefined ? Boolean(patch.autoScale) : prev.autoScale,
        logScale: patch.logScale !== undefined ? Boolean(patch.logScale) : prev.logScale,
        minVal: patch.minVal !== undefined && Number.isFinite(Number(patch.minVal)) ? Number(patch.minVal) : prev.minVal,
        maxVal: patch.maxVal !== undefined && Number.isFinite(Number(patch.maxVal)) ? Number(patch.maxVal) : prev.maxVal,
        contourLevels,
        smoothContours,
        interpolate: patch.interpolate !== undefined ? Boolean(patch.interpolate) : prev.interpolate,
        showColorbar: patch.showColorbar !== undefined ? Boolean(patch.showColorbar) : prev.showColorbar
    };

    const qStyles = { ...(params.quantity_styles || {}) };
    qStyles[cQty] = nextStyle;

    const qCmaps = { ...(params.quantity_colormaps || {}) };
    qCmaps[cQty] = nextStyle.colormap;

    const qRanges = { ...(params.quantity_ranges || {}) };
    qRanges[cQty] = [nextStyle.minVal, nextStyle.maxVal];

    const qAutos = { ...(params.quantity_auto_scales || {}) };
    qAutos[cQty] = nextStyle.autoScale;

    const qLogs = { ...(params.quantity_log_scales || {}) };
    qLogs[cQty] = nextStyle.logScale;

    const qVis = { ...(params.colorbar_quantities_visible || {}) };
    qVis[cQty] = nextStyle.showColorbar;

    // Keep common alias keys mirrored for backward compatibility
    const aliases: string[] = [];
    if (qty && qty !== cQty) aliases.push(qty);
    if (cQty === 'velocity') aliases.push('speed');
    if (cQty === 'peak_overpressure') aliases.push('overpressure');
    if (cQty === 'peak_impulse') aliases.push('impulse');
    if (cQty === 'plastic_strain') aliases.push('plasticStrain');
    if (cQty === 'vonMises') aliases.push('von_mises');
    for (const a of aliases) {
        qCmaps[a] = nextStyle.colormap;
        qRanges[a] = [nextStyle.minVal, nextStyle.maxVal];
        qAutos[a] = nextStyle.autoScale;
        qLogs[a] = nextStyle.logScale;
        qVis[a] = nextStyle.showColorbar;
    }

    const updates: Record<string, any> = {
        quantity_styles: qStyles,
        quantity_colormaps: qCmaps,
        quantity_ranges: qRanges,
        quantity_auto_scales: qAutos,
        quantity_log_scales: qLogs,
        colorbar_quantities_visible: qVis,
        lock_quantity_ranges: true
    };

    // Keep legacy slice / object fields synchronized so older serialization paths never diverge
    if (Array.isArray(params.slices)) {
        updates.slices = params.slices.map((s: any) => {
            if (canonicalizeQuantity(s?.quantities?.[0] || 'pressure') !== cQty) return s;
            return {
                ...s,
                colormap: nextStyle.colormap,
                auto_scale: nextStyle.autoScale,
                log_scale: nextStyle.logScale,
                min_val: nextStyle.minVal,
                max_val: nextStyle.maxVal,
                contour_levels: nextStyle.contourLevels,
                smooth_contours: nextStyle.smoothContours,
                interpolate: nextStyle.interpolate,
                show_colorbar: nextStyle.showColorbar
            };
        });
    }

    if (canonicalizeQuantity(params.stl_quantity || 'pressure') === cQty) {
        updates.stl_colormap = nextStyle.colormap;
        updates.stl_auto_scale = nextStyle.autoScale;
        updates.stl_log_scale = nextStyle.logScale;
        updates.stl_min_val = nextStyle.minVal;
        updates.stl_max_val = nextStyle.maxVal;
        updates.stl_contour_levels = nextStyle.contourLevels;
        updates.stl_smooth_contours = nextStyle.smoothContours;
        updates.stl_sampling_mode = nextStyle.interpolate ? 'linear' : 'nearest';
        updates.stl_show_colorbar = nextStyle.showColorbar;
    }

    if (canonicalizeQuantity(params.obstacles_quantity || 'pressure') === cQty) {
        updates.obstacles_colormap = nextStyle.colormap;
        updates.obstacles_auto_scale = nextStyle.autoScale;
        updates.obstacles_log_scale = nextStyle.logScale;
        updates.obstacles_min_val = nextStyle.minVal;
        updates.obstacles_max_val = nextStyle.maxVal;
        updates.obstacles_contour_levels = nextStyle.contourLevels;
        updates.obstacles_smooth_contours = nextStyle.smoothContours;
        updates.obstacles_interpolate = nextStyle.interpolate;
        updates.obstacles_show_colorbar = nextStyle.showColorbar;
    }

    if (canonicalizeQuantity(params.mpmParticleQuantity || 'vonMises') === cQty) {
        updates.mpmParticleColormap = nextStyle.colormap;
        updates.mpmParticleAutoScale = nextStyle.autoScale;
        updates.mpmParticleLogScale = nextStyle.logScale;
        updates.mpmParticleMinVal = nextStyle.minVal;
        updates.mpmParticleMaxVal = nextStyle.maxVal;
        updates.mpmContourLevels = nextStyle.contourLevels;
        updates.mpmSmoothContours = nextStyle.smoothContours;
        updates.mpmParticleShowColorbar = nextStyle.showColorbar;
    }

    if (canonicalizeQuantity(params.femQuantity || 'vonMises') === cQty) {
        updates.femColormap = nextStyle.colormap;
        updates.femAutoScale = nextStyle.autoScale;
        updates.femLogScale = nextStyle.logScale;
        updates.femMinVal = nextStyle.minVal;
        updates.femMaxVal = nextStyle.maxVal;
        updates.femContourLevels = nextStyle.contourLevels;
        updates.femSmoothContours = nextStyle.smoothContours;
        updates.femInterpolate = nextStyle.interpolate;
        updates.femShowColorbar = nextStyle.showColorbar;
    }

    if (canonicalizeQuantity(params.beamQuantity || 'plasticStrain') === cQty) {
        updates.beamColormap = nextStyle.colormap;
        updates.beamAutoScale = nextStyle.autoScale;
        updates.beamLogScale = nextStyle.logScale;
        updates.beamMinVal = nextStyle.minVal;
        updates.beamMaxVal = nextStyle.maxVal;
        updates.beamContourLevels = nextStyle.contourLevels;
        updates.beamSmoothContours = nextStyle.smoothContours;
        updates.beamShowColorbar = nextStyle.showColorbar;
    }

    return { canonicalQty: cQty, nextStyle, updates };
}

export function formatQuantityStyleSummary(style: QuantityContourStyle): string {
    const cmapLabel = getColormapLabel(style.colormap);
    const scalePart = `${style.autoScale ? 'Auto' : 'Manual'}${style.logScale ? ' (Log)' : ''}`;
    const bandPart = (!style.smoothContours && style.contourLevels >= 2) ? `${style.contourLevels} Bands` : 'Continuous';
    const interpPart = style.interpolate ? 'Smooth' : 'Cell';
    return `${cmapLabel} · ${scalePart} · ${bandPart} · ${interpPart}`;
}

// ============================================================================
// Unified 9-Stop Piecewise-Linear Colormap Tables (Shared by CSS, CPU & GPU)
// ============================================================================

type RGBTuple = readonly [number, number, number];
type Stops9 = readonly [RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple];

const CONTINUOUS_COLORMAP_STOPS: Record<Exclude<ColormapId, 'materials'>, Stops9> = {
    rainbow: [
        [0.0000, 0.0000, 1.0000], // 0.000 Blue
        [0.0000, 0.5000, 1.0000], // 0.125 Azure
        [0.0000, 1.0000, 1.0000], // 0.250 Cyan
        [0.0000, 1.0000, 0.5000], // 0.375 Spring
        [0.0000, 1.0000, 0.0000], // 0.500 Green
        [0.5000, 1.0000, 0.0000], // 0.625 Chartreuse
        [1.0000, 1.0000, 0.0000], // 0.750 Yellow
        [1.0000, 0.5000, 0.0000], // 0.875 Orange
        [1.0000, 0.0000, 0.0000]  // 1.000 Red
    ],
    jet: [
        [0.0000, 0.0000, 0.5000], // 0.000 Dark Navy
        [0.0000, 0.0000, 1.0000], // 0.125 Blue
        [0.0000, 0.5000, 1.0000], // 0.250 Sky Blue
        [0.0000, 1.0000, 1.0000], // 0.375 Cyan
        [0.5000, 1.0000, 0.5000], // 0.500 Mint Green
        [1.0000, 1.0000, 0.0000], // 0.625 Yellow
        [1.0000, 0.5000, 0.0000], // 0.750 Orange
        [1.0000, 0.0000, 0.0000], // 0.875 Red
        [0.5000, 0.0000, 0.0000]  // 1.000 Dark Crimson
    ],
    turbo: [
        [0.1899, 0.0718, 0.2322],
        [0.2745, 0.3843, 0.8431],
        [0.1961, 0.6980, 0.9608],
        [0.1020, 0.9137, 0.6902],
        [0.4863, 0.9922, 0.3490],
        [0.8392, 0.9137, 0.2078],
        [0.9882, 0.6745, 0.2039],
        [0.9020, 0.2941, 0.0471],
        [0.4784, 0.0157, 0.0118]
    ],
    plasma: [
        [0.0510, 0.0314, 0.5294],
        [0.2941, 0.0118, 0.6314],
        [0.4941, 0.0118, 0.6588],
        [0.6667, 0.1373, 0.5843],
        [0.7961, 0.2784, 0.4745],
        [0.9020, 0.4235, 0.3608],
        [0.9725, 0.5843, 0.2510],
        [0.9922, 0.7686, 0.1529],
        [0.9412, 0.9765, 0.1294]
    ],
    viridis: [
        [0.2667, 0.0039, 0.3294],
        [0.2824, 0.1569, 0.4706],
        [0.2431, 0.2902, 0.5373],
        [0.1922, 0.4078, 0.5569],
        [0.1294, 0.5686, 0.5490],
        [0.2078, 0.7176, 0.4745],
        [0.4275, 0.8078, 0.3451],
        [0.7098, 0.8706, 0.1686],
        [0.9922, 0.9059, 0.1451]
    ],
    inferno: [
        [0.0015, 0.0005, 0.0139],
        [0.1412, 0.0471, 0.3098],
        [0.3412, 0.0627, 0.4314],
        [0.5451, 0.1373, 0.4118],
        [0.7373, 0.2157, 0.3294],
        [0.8902, 0.3490, 0.2000],
        [0.9765, 0.5569, 0.0353],
        [0.9765, 0.7961, 0.2078],
        [0.9882, 1.0000, 0.6431]
    ],
    magma: [
        [0.0015, 0.0005, 0.0139],
        [0.1294, 0.0667, 0.3059],
        [0.3176, 0.0706, 0.4863],
        [0.5255, 0.1529, 0.5059],
        [0.7176, 0.2157, 0.4745],
        [0.8863, 0.3059, 0.4039],
        [0.9843, 0.5333, 0.3804],
        [0.9961, 0.7686, 0.5294],
        [0.9882, 0.9922, 0.7490]
    ],
    coolwarm: [
        [0.2314, 0.2980, 0.7529],
        [0.3843, 0.5098, 0.9176],
        [0.5529, 0.6902, 0.9961],
        [0.7216, 0.8157, 0.9765],
        [0.8667, 0.8667, 0.8667],
        [0.9608, 0.7686, 0.6784],
        [0.9569, 0.6039, 0.4824],
        [0.8667, 0.3725, 0.2941],
        [0.7059, 0.0157, 0.1490]
    ],
    cividis: [
        [0.0000, 0.1255, 0.3176],
        [0.0980, 0.2196, 0.4353],
        [0.2235, 0.3216, 0.4627],
        [0.3451, 0.4157, 0.4706],
        [0.4863, 0.4824, 0.4706],
        [0.6235, 0.5882, 0.4627],
        [0.7686, 0.7020, 0.4235],
        [0.9098, 0.8196, 0.3490],
        [0.9922, 0.9176, 0.2706]
    ],
    grayscale: [
        [0.0000, 0.0000, 0.0000],
        [0.1250, 0.1250, 0.1250],
        [0.2500, 0.2500, 0.2500],
        [0.3750, 0.3750, 0.3750],
        [0.5000, 0.5000, 0.5000],
        [0.6250, 0.6250, 0.6250],
        [0.7500, 0.7500, 0.7500],
        [0.8750, 0.8750, 0.8750],
        [1.0000, 1.0000, 1.0000]
    ]
};

const MATERIALS_STOPS: readonly [RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple, RGBTuple] = [
    [0.5300, 0.8100, 0.9800], // 0: Air (Sky Blue)
    [0.0500, 0.4500, 0.8500], // 1: Water (Ocean Blue)
    [0.8500, 0.5800, 0.2500], // 2: Soil (Sand Amber)
    [1.0000, 0.5000, 0.0000], // 3: HE Solid (Warning Orange)
    [0.9500, 0.1500, 0.1500], // 4: Detonation Products (Crimson Fire)
    [0.5800, 0.2000, 0.9200]  // 5: FEM Solid / Obstacle (Purple)
];

export function normalizeScalarToT(val: number, minVal: number, maxVal: number, logScale: boolean): number {
    if (!Number.isFinite(val)) return 0.0;
    const denom = maxVal - minVal;
    if (!(denom > 1e-20)) return 0.0;
    if (logScale) {
        const eps = 1e-20;
        const logMin = Math.log(Math.max(minVal, eps));
        const logMax = Math.log(Math.max(maxVal, eps));
        const logDenom = logMax - logMin;
        if (!(logDenom > 1e-12)) return 0.0;
        const logVal = Math.log(Math.max(val, eps));
        const t = (logVal - logMin) / logDenom;
        return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
    }
    const t = (val - minVal) / denom;
    return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
}

export function quantizeContourT(t: number, contourLevels: number, smoothContours: boolean): number {
    const clamped = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
    if (smoothContours || !(contourLevels >= 2)) return clamped;
    const n = Math.floor(contourLevels);
    const band = Math.min(n - 1, Math.floor(clamped * n));
    return (band + 0.5) / n;
}

export function evaluateColormapRGB(t: number, cmapName?: string | null): [number, number, number] {
    const clamped = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
    const id = normalizeColormapId(cmapName);
    if (id === 'materials') {
        const matIdx = Math.max(0, Math.min(5, Math.floor(clamped * 5.0 + 0.5)));
        const c = MATERIALS_STOPS[matIdx];
        return [c[0], c[1], c[2]];
    }
    const stops = CONTINUOUS_COLORMAP_STOPS[id];
    const scaled = clamped * 8.0;
    const idx = Math.min(7, Math.max(0, Math.floor(scaled)));
    const frac = scaled - idx;
    const c0 = stops[idx];
    const c1 = stops[idx + 1];
    return [
        c0[0] + (c1[0] - c0[0]) * frac,
        c0[1] + (c1[1] - c0[1]) * frac,
        c0[2] + (c1[2] - c0[2]) * frac
    ];
}

export function sampleQuantityColorRGB(
    val: number,
    style: QuantityContourStyle,
    effectiveMin?: number,
    effectiveMax?: number
): [number, number, number] {
    const minV = effectiveMin !== undefined ? effectiveMin : style.minVal;
    const maxV = effectiveMax !== undefined ? effectiveMax : style.maxVal;
    const t = normalizeScalarToT(val, minV, maxV, style.logScale);
    const tq = quantizeContourT(t, style.contourLevels, style.smoothContours);
    return evaluateColormapRGB(tq, style.colormap);
}

export function buildColormapLUT(
    cmapName: string | undefined | null,
    contourLevels: number = 0,
    smoothContours: boolean = true,
    lutSize: number = 1024
): Float32Array {
    const lut = new Float32Array(lutSize * 3);
    const denom = Math.max(1, lutSize - 1);
    for (let i = 0; i < lutSize; i++) {
        const t = i / denom;
        const tq = quantizeContourT(t, contourLevels, smoothContours);
        const [r, g, b] = evaluateColormapRGB(tq, cmapName);
        lut[i * 3] = r;
        lut[i * 3 + 1] = g;
        lut[i * 3 + 2] = b;
    }
    return lut;
}

export function buildColormapRGBA32LUT(
    cmapName: string | undefined | null,
    contourLevels: number = 0,
    smoothContours: boolean = true,
    lutSize: number = 1024
): Uint32Array {
    const lut = new Uint32Array(lutSize);
    const denom = Math.max(1, lutSize - 1);
    for (let i = 0; i < lutSize; i++) {
        const t = i / denom;
        const tq = quantizeContourT(t, contourLevels, smoothContours);
        const [r, g, b] = evaluateColormapRGB(tq, cmapName);
        const ri = Math.max(0, Math.min(255, Math.round(r * 255)));
        const gi = Math.max(0, Math.min(255, Math.round(g * 255)));
        const bi = Math.max(0, Math.min(255, Math.round(b * 255)));
        lut[i] = (255 << 24) | (bi << 16) | (gi << 8) | ri;
    }
    return lut;
}

function rgbFloatToCss(c: readonly [number, number, number]): string {
    return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

export function buildColormapCSSGradient(
    cmapName: string | undefined | null,
    direction: 'to top' | 'to right' = 'to top',
    contourLevels: number = 0,
    smoothContours: boolean = true
): string {
    const id = normalizeColormapId(cmapName);
    if (id === 'materials') {
        const stops: string[] = [];
        for (let i = 0; i < 6; i++) {
            const col = rgbFloatToCss(MATERIALS_STOPS[i]);
            const p0 = ((i / 6) * 100).toFixed(2);
            const p1 = (((i + 1) / 6) * 100).toFixed(2);
            stops.push(`${col} ${p0}%`, `${col} ${p1}%`);
        }
        return `linear-gradient(${direction}, ${stops.join(', ')})`;
    }

    const effectiveBands = (!smoothContours && contourLevels >= 2) ? Math.floor(contourLevels) : 0;
    if (effectiveBands >= 2) {
        const stops: string[] = [];
        for (let i = 0; i < effectiveBands; i++) {
            const normVal = (i + 0.5) / effectiveBands;
            const col = rgbFloatToCss(evaluateColormapRGB(normVal, id));
            const p0 = ((i / effectiveBands) * 100).toFixed(2);
            const p1 = (((i + 1) / effectiveBands) * 100).toFixed(2);
            stops.push(`${col} ${p0}%`, `${col} ${p1}%`);
        }
        return `linear-gradient(${direction}, ${stops.join(', ')})`;
    }

    const stops = CONTINUOUS_COLORMAP_STOPS[id];
    const cssStops = stops.map((c, idx) => `${rgbFloatToCss(c)} ${(idx * 12.5).toFixed(1)}%`);
    return `linear-gradient(${direction}, ${cssStops.join(', ')})`;
}

// ============================================================================
// Auto-Generated Bit-Identical GLSL & WGSL Colormap + Quantization Shaders
// ============================================================================

function fmtFloat(n: number): string {
    const s = n.toFixed(4);
    return s.includes('.') ? s : `${s}.0`;
}

function buildGLSLColormapFunction(name: string, stops: Stops9): string {
    const v = (c: RGBTuple) => `vec3(${fmtFloat(c[0])}, ${fmtFloat(c[1])}, ${fmtFloat(c[2])})`;
    return `vec3 colormap_${name}(float t) {
    float s = clamp(t, 0.0, 1.0) * 8.0;
    if (s < 4.0) {
        if (s < 2.0) {
            if (s < 1.0) return mix(${v(stops[0])}, ${v(stops[1])}, s);
            return mix(${v(stops[1])}, ${v(stops[2])}, s - 1.0);
        } else {
            if (s < 3.0) return mix(${v(stops[2])}, ${v(stops[3])}, s - 2.0);
            return mix(${v(stops[3])}, ${v(stops[4])}, s - 3.0);
        }
    } else {
        if (s < 6.0) {
            if (s < 5.0) return mix(${v(stops[4])}, ${v(stops[5])}, s - 4.0);
            return mix(${v(stops[5])}, ${v(stops[6])}, s - 5.0);
        } else {
            if (s < 7.0) return mix(${v(stops[6])}, ${v(stops[7])}, s - 6.0);
            return mix(${v(stops[7])}, ${v(stops[8])}, min(1.0, s - 7.0));
        }
    }
}`;
}

function buildWGSLColormapFunction(name: string, stops: Stops9): string {
    const v = (c: RGBTuple) => `vec3<f32>(${fmtFloat(c[0])}, ${fmtFloat(c[1])}, ${fmtFloat(c[2])})`;
    return `fn colormap_${name}(t: f32) -> vec3<f32> {
    let s = clamp(t, 0.0, 1.0) * 8.0;
    if (s < 4.0) {
        if (s < 2.0) {
            if (s < 1.0) { return mix(${v(stops[0])}, ${v(stops[1])}, s); }
            return mix(${v(stops[1])}, ${v(stops[2])}, s - 1.0);
        } else {
            if (s < 3.0) { return mix(${v(stops[2])}, ${v(stops[3])}, s - 2.0); }
            return mix(${v(stops[3])}, ${v(stops[4])}, s - 3.0);
        }
    } else {
        if (s < 6.0) {
            if (s < 5.0) { return mix(${v(stops[4])}, ${v(stops[5])}, s - 4.0); }
            return mix(${v(stops[5])}, ${v(stops[6])}, s - 5.0);
        } else {
            if (s < 7.0) { return mix(${v(stops[6])}, ${v(stops[7])}, s - 6.0); }
            return mix(${v(stops[7])}, ${v(stops[8])}, min(1.0, s - 7.0));
        }
    }
}`;
}

export const GLSL_COLORMAP_FUNCTIONS: string = [
    ...(Object.keys(CONTINUOUS_COLORMAP_STOPS) as Array<Exclude<ColormapId, 'materials'>>).map(
        k => buildGLSLColormapFunction(k, CONTINUOUS_COLORMAP_STOPS[k])
    ),
    `vec3 colormap_materials(float t) {
    float id = floor(clamp(t, 0.0, 1.0) * 5.0 + 0.5);
    if (id < 0.5) return vec3(0.5300, 0.8100, 0.9800);
    if (id < 1.5) return vec3(0.0500, 0.4500, 0.8500);
    if (id < 2.5) return vec3(0.8500, 0.5800, 0.2500);
    if (id < 3.5) return vec3(1.0000, 0.5000, 0.0000);
    if (id < 4.5) return vec3(0.9500, 0.1500, 0.1500);
    return vec3(0.5800, 0.2000, 0.9200);
}`,
    `vec3 getColormapColor(float t, int cmap) {
    if (cmap == 0) return colormap_plasma(t);
    if (cmap == 1) return colormap_viridis(t);
    if (cmap == 2) return colormap_rainbow(t);
    if (cmap == 3) return colormap_coolwarm(t);
    if (cmap == 4) return colormap_cividis(t);
    if (cmap == 5) return colormap_grayscale(t);
    if (cmap == 6) return colormap_materials(t);
    if (cmap == 7) return colormap_turbo(t);
    if (cmap == 8) return colormap_inferno(t);
    if (cmap == 9) return colormap_magma(t);
    if (cmap == 10) return colormap_jet(t);
    return colormap_rainbow(t);
}`,
    `float getT(float raw, float minVal, float maxVal, bool useLogScale) {
    float denom = maxVal - minVal;
    if (denom <= 1e-20) return 0.0;
    if (useLogScale) {
        float eps = 1e-20;
        float logMin = log(max(minVal, eps));
        float logMax = log(max(maxVal, eps));
        float logDenom = logMax - logMin;
        if (logDenom <= 1e-12) return 0.0;
        float logVal = log(max(raw, eps));
        return clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    }
    return clamp((raw - minVal) / denom, 0.0, 1.0);
}`,
    `float quantizeContourT(float t, float levels) {
    float c = clamp(t, 0.0, 1.0);
    if (levels >= 2.0) {
        float n = floor(levels);
        float band = min(n - 1.0, floor(c * n));
        return (band + 0.5) / n;
    }
    return c;
}`
].join('\n\n');

export const WGSL_COLORMAP_FUNCTIONS: string = [
    ...(Object.keys(CONTINUOUS_COLORMAP_STOPS) as Array<Exclude<ColormapId, 'materials'>>).map(
        k => buildWGSLColormapFunction(k, CONTINUOUS_COLORMAP_STOPS[k])
    ),
    `fn colormap_materials(t: f32) -> vec3<f32> {
    let id = floor(clamp(t, 0.0, 1.0) * 5.0 + 0.5);
    if (id < 0.5) { return vec3<f32>(0.5300, 0.8100, 0.9800); }
    if (id < 1.5) { return vec3<f32>(0.0500, 0.4500, 0.8500); }
    if (id < 2.5) { return vec3<f32>(0.8500, 0.5800, 0.2500); }
    if (id < 3.5) { return vec3<f32>(1.0000, 0.5000, 0.0000); }
    if (id < 4.5) { return vec3<f32>(0.9500, 0.1500, 0.1500); }
    return vec3<f32>(0.5800, 0.2000, 0.9200);
}`,
    `fn getColormapColor(t: f32, cmap: f32) -> vec3<f32> {
    let c = i32(cmap + 0.5);
    if (c == 0) { return colormap_plasma(t); }
    if (c == 1) { return colormap_viridis(t); }
    if (c == 2) { return colormap_rainbow(t); }
    if (c == 3) { return colormap_coolwarm(t); }
    if (c == 4) { return colormap_cividis(t); }
    if (c == 5) { return colormap_grayscale(t); }
    if (c == 6) { return colormap_materials(t); }
    if (c == 7) { return colormap_turbo(t); }
    if (c == 8) { return colormap_inferno(t); }
    if (c == 9) { return colormap_magma(t); }
    if (c == 10) { return colormap_jet(t); }
    return colormap_rainbow(t);
}`,
    `fn getT(raw: f32, minVal: f32, maxVal: f32, useLogScale: f32) -> f32 {
    let denom = maxVal - minVal;
    if (denom <= 1e-20) { return 0.0; }
    if (useLogScale > 0.5) {
        let eps: f32 = 1e-20;
        let logMin = log(max(minVal, eps));
        let logMax = log(max(maxVal, eps));
        let logDenom = logMax - logMin;
        if (logDenom <= 1e-12) { return 0.0; }
        let logVal = log(max(raw, eps));
        return clamp((logVal - logMin) / logDenom, 0.0, 1.0);
    }
    return clamp((raw - minVal) / denom, 0.0, 1.0);
}`,
    `fn quantizeContourT(t: f32, levels: f32) -> f32 {
    let c = clamp(t, 0.0, 1.0);
    if (levels >= 2.0) {
        let n = floor(levels);
        let band = min(n - 1.0, floor(c * n));
        return (band + 0.5) / n;
    }
    return c;
}`
].join('\n\n');
