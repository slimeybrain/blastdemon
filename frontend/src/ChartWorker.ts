// ChartWorker.ts
export {};
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// Logical (CSS-pixel) drawing dimensions
let width = 0;
let height = 0;
// Physical pixel ratio
let dpr = 1;

// Plotting mode: 'spatial' = 1D Radial Profile f(r), 'gauges' = Virtual Gauge Time-History f(t)
let chartMode: 'spatial' | 'gauges' = 'spatial';

let rawData: Float32Array | null = null;
let chartColor = '#00f0ff';
let displayMin = 0;
let displayMax = 1;
let range = 1;
let autoScale = true;
let useLogScale = false;
let showAxes = true;
let showGrid = true;
let showCharge = true;
let showDetonator = true;
let showGauges = true;
let showPeaks = true;
let showCanvasLegend = true;
let theme: 'dark' | 'slate' | 'light' = 'slate';
let clearBgRgb: [number, number, number] | null = null;
let renderQueued = false;

// Multi-channel telemetry:
// Spatial mode: 0=p, 1=rho, 2=u, 3=e_int, 4=all_species, 5=alpha1, 6=alpha2, 7=air, 8=overpressure
// Gauges mode:  0=p, 1=rho, 2=vel, 3=e_int, 4=alpha1, 5=alpha2, 6=air, 7=overpressure, 8=impulse
let selectedChannel = 0;
let selectedProbe = -1; // -1 = all probes, >= 0 = single probe index
let hiddenProbes = new Set<number>();
let hoveredProbe = -1;

// Last received raw multi-channel buffer so we can re-slice when channel changes
let lastBuffer: ArrayBuffer | null = null;

// Virtual gauge time-history storage: values[probeIdx][channelIdx][timeStepIdx]
let gaugeTimes: number[] = [];
let gaugeValues: number[][][] = [];

// X-axis configuration
let xAxisMode = 'radius';
let domainRadius = 1.0;
let chargeRadius = 0.0;
let remapRadius = 0.0;
let detonatorR: number | null = null;
let gauges: Array<{ id?: string; name?: string; r?: number; z?: number; x?: number; y?: number }> = [];

// Simulation metadata for HUD
let simStep = 0;
let simTime = 0;
let simDt = 0;

// Independent 2D X & Y Zoom/Pan State
let isZoomedX = false;
let zoomMinX = 0;
let zoomMaxX = 1.0;

let isZoomedY = false;
let zoomMinY = 0;
let zoomMaxY = 1.0;

let interactionMode: 'pan' | 'boxZoom' = 'pan';

// Drag & Box-Zoom & Hover tracking state
let isDragging = false;
let dragAction: 'pan' | 'boxZoom' | 'panX' | 'panY' = 'pan';
let dragStartX = 0;
let dragStartY = 0;
let dragCurrX = 0;
let dragCurrY = 0;
let dragStartMinX = 0;
let dragStartMaxX = 1.0;
let dragStartMinY = 0;
let dragStartMaxY = 1.0;
let hoverCanvasX: number | null = null;
let hoverCanvasY: number | null = null;

// Throttled probe stats telemetry back to main thread for interactive HTML Probe Card
let lastStatsPostMs = 0;
let pendingStatsTimer: any = null;

export const PROBE_PALETTE = [
    '#00f0ff', // Cyan
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#f43f5e', // Rose
    '#a855f7', // Purple
    '#3b82f6', // Blue
    '#ec4899', // Pink
    '#84cc16', // Lime
    '#14b8a6', // Teal
    '#f97316'  // Orange
];

const SPATIAL_CHANNELS: Record<number, { name: string; unit: string; color: string }> = {
    0: { name: 'Pressure P', unit: 'Pa', color: '#00f0ff' },
    1: { name: 'Density ρ', unit: 'kg/m³', color: '#38bdf8' },
    2: { name: 'Radial Velocity u_r', unit: 'm/s', color: '#10b981' },
    3: { name: 'Internal Energy e', unit: 'J/kg', color: '#f59e0b' },
    4: { name: 'Species Fractions (α₁, α₂, Air)', unit: '-', color: '#f43f5e' },
    5: { name: 'Reacted Products α₁', unit: '-', color: '#f43f5e' },
    6: { name: 'Unreacted Explosive α₂', unit: '-', color: '#f59e0b' },
    7: { name: 'Ambient Air Fraction', unit: '-', color: '#38bdf8' },
    8: { name: 'Overpressure ΔP', unit: 'Pa', color: '#a855f7' }
};

const GAUGE_CHANNELS: Record<number, { name: string; unit: string }> = {
    0: { name: 'Absolute Pressure P(t)', unit: 'Pa' },
    1: { name: 'Density ρ(t)', unit: 'kg/m³' },
    2: { name: 'Flow Velocity |u|(t)', unit: 'm/s' },
    3: { name: 'Internal Energy e(t)', unit: 'J/kg' },
    4: { name: 'Reacted Products α₁(t)', unit: '-' },
    5: { name: 'Unreacted Solid α₂(t)', unit: '-' },
    6: { name: 'Ambient Air α_air(t)', unit: '-' },
    7: { name: 'Overpressure ΔP(t)', unit: 'Pa' },
    8: { name: 'Specific Impulse I(t)', unit: 'Pa·s' }
};

function getPlotRect(): { plotLeft: number; plotTop: number; plotWidth: number; plotHeight: number } {
    if (!showAxes) {
        return {
            plotLeft: 8,
            plotTop: 8,
            plotWidth: Math.max(40, width - 16),
            plotHeight: Math.max(40, height - 16)
        };
    }
    const compactH = height < 250;
    const compactW = width < 420;
    const plotLeft = compactW ? 60 : 72;
    const plotRight = 14;
    const plotTop = compactH ? 16 : 20;
    const plotBottom = compactH ? 24 : 28;
    return {
        plotLeft,
        plotTop,
        plotWidth: Math.max(40, width - plotLeft - plotRight),
        plotHeight: Math.max(40, height - plotTop - plotBottom)
    };
}

function drawYAxisTitle(plotTop: number, plotHeight: number, title: string): void {
    if (!ctx || !showAxes || width < 300 || !title) return;
    ctx.save();
    ctx.translate(12, plotTop + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = theme === 'light' ? '#475569' : '#94a3b8';
    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 0, 0);
    ctx.restore();
}

function getDefaultXBounds(): { defaultMinX: number; defaultMaxX: number } {
    if (chartMode === 'gauges') {
        if (gaugeTimes.length === 0) {
            return { defaultMinX: 0, defaultMaxX: 1e-3 };
        }
        const firstT = Number(gaugeTimes[0] ?? 0);
        if (gaugeTimes.length === 1) {
            const span = Math.abs(firstT) > 1e-9 ? Math.abs(firstT) * 0.5 : 1e-3;
            return { defaultMinX: Math.max(0, firstT - span * 0.2), defaultMaxX: firstT + span };
        }
        const lastT = Number(gaugeTimes[gaugeTimes.length - 1] ?? (firstT + 1e-3));
        const safeMax = lastT > firstT ? lastT : (firstT + 1e-6);
        return { defaultMinX: firstT, defaultMaxX: safeMax };
    }
    const maxXVal = (rawData && rawData.length > 0) ? Math.max(1, rawData.length - 1) : 100;
    return {
        defaultMinX: 0,
        defaultMaxX: xAxisMode === 'radius' ? Math.max(1e-6, domainRadius) : maxXVal
    };
}

function getActiveBounds(): { activeMinX: number; activeMaxX: number; activeMinY: number; activeMaxY: number } {
    const { defaultMinX, defaultMaxX } = getDefaultXBounds();
    let activeMinX = isZoomedX ? zoomMinX : defaultMinX;
    let activeMaxX = isZoomedX ? zoomMaxX : defaultMaxX;
    if (activeMaxX <= activeMinX) activeMaxX = activeMinX + 1e-9;

    let activeMinY = isZoomedY ? zoomMinY : displayMin;
    let activeMaxY = isZoomedY ? zoomMaxY : displayMax;
    if (activeMaxY <= activeMinY) activeMaxY = activeMinY + 1e-9;

    return { activeMinX, activeMaxX, activeMinY, activeMaxY };
}

function isProbeVisible(probeIdx: number): boolean {
    if (selectedProbe >= 0 && probeIdx !== selectedProbe) return false;
    if (hiddenProbes.has(probeIdx)) return false;
    return true;
}

function lowerBoundTime(targetT: number): number {
    let lo = 0;
    let hi = gaugeTimes.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (Number(gaugeTimes[mid]) < targetT) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    const raf = (self as any).requestAnimationFrame;
    if (typeof raf === 'function') {
        raf(() => {
            renderQueued = false;
            render();
        });
    } else {
        setTimeout(() => {
            renderQueued = false;
            render();
        }, 0);
    }
}

function applyTransform(): void {
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function formatSciNumber(v: number): string {
    if (!isFinite(v)) return '0';
    if (v === 0) return '0';
    const absV = Math.abs(v);
    if (absV >= 1e5 || absV < 1e-2) {
        return v.toExponential(2);
    }
    if (absV >= 100) return v.toFixed(1);
    if (absV >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

function formatTimeUnit(tSec: number, maxTSec: number): string {
    if (!isFinite(tSec)) return '0 s';
    const refT = Math.max(Math.abs(maxTSec), Math.abs(tSec));
    if (refT > 0 && refT < 1e-3) {
        return `${(tSec * 1e6).toFixed(1)} µs`;
    }
    if (refT > 0 && refT < 1.0) {
        return `${(tSec * 1e3).toFixed(3)} ms`;
    }
    return `${tSec.toFixed(4)} s`;
}

/**
 * Parse a multi-channel binary frame and extract the selected channel.
 * Frame format: [uint32 n_cells][uint32 n_channels][float32 × n_cells × n_channels]
 */
function extractChannel(buffer: ArrayBuffer, channel: number): Float32Array {
    const MIN_HEADER = 8;
    if (buffer.byteLength < MIN_HEADER) {
        return new Float32Array(buffer);
    }

    const headerView = new DataView(buffer);
    const n_cells    = headerView.getUint32(0, true);
    const n_channels = headerView.getUint32(4, true);

    const expectedPayload = n_cells * n_channels * 4;
    const expectedTotal   = MIN_HEADER + expectedPayload;

    if (n_channels === 0 || n_cells === 0 || buffer.byteLength < expectedTotal) {
        return new Float32Array(buffer);
    }

    // Channel 8 in spatial mode = Overpressure ΔP = P - 101325
    if (channel === 8) {
        const pArr = new Float32Array(buffer, MIN_HEADER, n_cells);
        const dpArr = new Float32Array(n_cells);
        for (let i = 0; i < n_cells; i++) {
            dpArr[i] = pArr[i] - 101325.0;
        }
        return dpArr;
    }

    // Map spatial channels 5->4 (alpha1), 6->5 (alpha2), 7->6 (air)
    let rawCh = channel;
    if (channel === 5) rawCh = 4;
    else if (channel === 6) rawCh = 5;
    else if (channel === 7) rawCh = 6;

    const clampedChannel = Math.max(0, Math.min(rawCh, n_channels - 1));
    const byteOffset = MIN_HEADER + clampedChannel * n_cells * 4;
    return new Float32Array(buffer, byteOffset, n_cells);
}

/**
 * Extract or compute a gauge probe series for the given probe index and channel.
 */
function getGaugeSeries(probeIdx: number, chIdx: number): number[] {
    const probeChannels = gaugeValues[probeIdx];
    if (!probeChannels || !Array.isArray(probeChannels)) return [];

    // Direct channel if populated
    const direct = probeChannels[chIdx];
    if (Array.isArray(direct) && direct.length > 0) {
        return direct;
    }

    const pSeries = probeChannels[0];
    if (!Array.isArray(pSeries) || pSeries.length === 0) return [];

    // Channel 7: Overpressure ΔP = P - 101325
    if (chIdx === 7) {
        const out = new Array(pSeries.length);
        for (let i = 0; i < pSeries.length; i++) {
            out[i] = Number(pSeries[i] ?? 101325) - 101325.0;
        }
        return out;
    }

    // Channel 8: Specific Impulse I(t) = ∫ (P(t) - 101325) dt via trapezoidal rule
    if (chIdx === 8) {
        const out = new Array(pSeries.length);
        let imp = 0;
        out[0] = 0;
        for (let i = 1; i < pSeries.length; i++) {
            const t0 = Number(gaugeTimes[i - 1] ?? (i - 1));
            const t1 = Number(gaugeTimes[i] ?? i);
            const dt = Math.max(0, t1 - t0);
            const dp0 = Number(pSeries[i - 1] ?? 101325) - 101325.0;
            const dp1 = Number(pSeries[i] ?? 101325) - 101325.0;
            imp += 0.5 * (dp0 + dp1) * dt;
            out[i] = imp;
        }
        return out;
    }

    // Channel 6: Air fraction = 1 - alpha1 - alpha2
    if (chIdx === 6) {
        const a1 = probeChannels[4] || [];
        const a2 = probeChannels[5] || [];
        const len = Math.max(a1.length, a2.length);
        const out = new Array(len);
        for (let i = 0; i < len; i++) {
            out[i] = Math.max(0, Math.min(1, 1.0 - Number(a1[i] ?? 0) - Number(a2[i] ?? 0)));
        }
        return out;
    }

    return [];
}

function updateAutoScale(): void {
    if (!autoScale) {
        range = displayMax - displayMin || 1;
        return;
    }

    const { defaultMinX, defaultMaxX } = getDefaultXBounds();
    const winMinX = isZoomedX ? zoomMinX : defaultMinX;
    const winMaxX = isZoomedX ? zoomMaxX : defaultMaxX;

    if (chartMode === 'spatial') {
        if (selectedChannel === 4) {
            displayMin = -0.04;
            displayMax = 1.06;
            range = displayMax - displayMin;
            self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax, isZoomedX, isZoomedY });
            return;
        }

        if (!rawData || rawData.length === 0) {
            if (selectedChannel >= 5 && selectedChannel <= 7) {
                displayMin = -0.04;
                displayMax = 1.06;
            } else if (selectedChannel === 0) {
                displayMin = 0.0;
                displayMax = 120000.0;
            } else if (selectedChannel === 8) {
                displayMin = -5000.0;
                displayMax = 50000.0;
            } else if (selectedChannel === 1) {
                displayMin = 0.0;
                displayMax = 2.0;
            } else if (selectedChannel === 2) {
                displayMin = -10.0;
                displayMax = 100.0;
            } else if (selectedChannel === 3) {
                displayMin = 0.0;
                displayMax = 500000.0;
            } else {
                displayMin = 0.0;
                displayMax = 1.0;
            }
            range = displayMax - displayMin || 1;
            self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax, isZoomedX, isZoomedY });
            return;
        }

        let minY_raw = Infinity;
        let maxY_raw = -Infinity;
        let posMin = Infinity;
        let hasValidData = false;

        const numPoints = rawData.length;
        const dxPerIndex = xAxisMode === 'radius' ? (domainRadius / (numPoints || 1)) : 1;
        const iStart = isZoomedX ? Math.max(0, Math.floor(winMinX / dxPerIndex) - 1) : 0;
        const iEnd = isZoomedX ? Math.min(numPoints - 1, Math.ceil(winMaxX / dxPerIndex) + 1) : (numPoints - 1);

        for (let i = iStart; i <= iEnd; i++) {
            const val = rawData[i];
            if (isFinite(val)) {
                if (val < minY_raw) minY_raw = val;
                if (val > maxY_raw) maxY_raw = val;
                if (val > 0 && val < posMin) posMin = val;
                hasValidData = true;
            }
        }

        if (hasValidData) {
            if (useLogScale && maxY_raw > 0) {
                const floor = maxY_raw * 1e-6;
                displayMin = isFinite(posMin) ? Math.max(floor, posMin * 0.8) : floor;
                displayMax = maxY_raw * 1.18;
            } else {
                const rawRange = maxY_raw - minY_raw === 0 ? Math.max(1e-6, Math.abs(maxY_raw) * 0.1 || 1) : maxY_raw - minY_raw;
                displayMin = minY_raw - (rawRange * 0.08);
                if (minY_raw >= 0 && (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 3)) {
                    displayMin = Math.max(0, displayMin);
                }
                displayMax = maxY_raw + (rawRange * 0.12);
            }
            range = displayMax - displayMin || 1;
            self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax, isZoomedX, isZoomedY });
        }
    } else {
        // Gauges mode auto-scale across visible probes (and visible X window when X-zoomed!)
        let minY_raw = Infinity;
        let maxY_raw = -Infinity;
        let posMin = Infinity;
        let hasValid = false;

        const numProbes = Math.max(gaugeValues.length, gauges.length);
        const iStart = (isZoomedX && gaugeTimes.length > 0) ? Math.max(0, lowerBoundTime(winMinX) - 1) : 0;
        const iEnd = (isZoomedX && gaugeTimes.length > 0) ? Math.min(gaugeTimes.length - 1, lowerBoundTime(winMaxX) + 1) : Infinity;

        for (let p = 0; p < numProbes; p++) {
            if (!isProbeVisible(p)) continue;
            const series = getGaugeSeries(p, selectedChannel);
            const limit = Math.min(series.length - 1, iEnd);
            for (let i = iStart; i <= limit; i++) {
                const v = Number(series[i]);
                if (isFinite(v)) {
                    if (v < minY_raw) minY_raw = v;
                    if (v > maxY_raw) maxY_raw = v;
                    if (v > 0 && v < posMin) posMin = v;
                    hasValid = true;
                }
            }
        }

        if (hasValid) {
            if (useLogScale && maxY_raw > 0) {
                const floor = maxY_raw * 1e-6;
                displayMin = isFinite(posMin) ? Math.max(floor, posMin * 0.8) : floor;
                displayMax = maxY_raw * 1.18;
            } else {
                const span = maxY_raw - minY_raw === 0
                    ? Math.max(1e-4, Math.abs(maxY_raw) * 0.1 || (selectedChannel >= 4 && selectedChannel <= 6 ? 0.2 : 1))
                    : maxY_raw - minY_raw;
                displayMin = minY_raw - span * 0.08;
                if (minY_raw >= 0 && (selectedChannel === 0 || selectedChannel === 1 || selectedChannel === 2 || selectedChannel === 3)) {
                    displayMin = Math.max(0, displayMin);
                }
                displayMax = maxY_raw + span * 0.14;
            }
            range = displayMax - displayMin || 1;
            self.postMessage({ type: 'bounds', minY: displayMin, maxY: displayMax, isZoomedX, isZoomedY });
        } else {
            displayMin = selectedChannel === 0 ? 90000 : (selectedChannel >= 4 && selectedChannel <= 6 ? -0.04 : 0);
            displayMax = selectedChannel === 0 ? 120000 : (selectedChannel >= 4 && selectedChannel <= 6 ? 1.06 : 1);
            range = displayMax - displayMin || 1;
        }
    }
}

function mapYToCanvas(yVal: number, plotTop: number, plotHeight: number, activeMinY: number, activeMaxY: number): number {
    if (useLogScale && activeMaxY > 0) {
        const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
        const logMin = Math.log10(safeMin);
        const logMax = Math.log10(activeMaxY);
        const logV = Math.log10(Math.max(safeMin, yVal));
        const pct = logMax !== logMin ? (logV - logMin) / (logMax - logMin) : 0;
        return plotTop + plotHeight - pct * plotHeight;
    }
    const activeRangeY = activeMaxY - activeMinY || 1;
    return plotTop + plotHeight - ((yVal - activeMinY) / activeRangeY) * plotHeight;
}

function mapCanvasToY(canvasY: number, plotTop: number, plotHeight: number, activeMinY: number, activeMaxY: number): number {
    const pct = Math.max(0, Math.min(1, (plotTop + plotHeight - canvasY) / Math.max(1, plotHeight)));
    if (useLogScale && activeMaxY > 0) {
        const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
        const logMin = Math.log10(safeMin);
        const logMax = Math.log10(activeMaxY);
        return Math.pow(10, logMin + pct * (logMax - logMin));
    }
    return activeMinY + pct * (activeMaxY - activeMinY);
}

function emitProbeStats(payload: any): void {
    const now = performance.now();
    const send = () => {
        pendingStatsTimer = null;
        lastStatsPostMs = performance.now();
        self.postMessage(payload);
    };
    if (now - lastStatsPostMs >= 50) {
        if (pendingStatsTimer) {
            clearTimeout(pendingStatsTimer);
            pendingStatsTimer = null;
        }
        send();
    } else if (!pendingStatsTimer) {
        pendingStatsTimer = setTimeout(send, 55);
    }
}

function drawSpatialCurve(
    data: Float32Array,
    color: string,
    physDrawWidth: number,
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
    activeMinX: number,
    activeMaxX: number,
    activeMinY: number,
    activeMaxY: number,
    fillUnder: boolean = false
): void {
    if (!ctx) return;
    const numPoints = data.length;
    if (numPoints === 0) return;
    const activeRangeX = activeMaxX - activeMinX || 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;

    const dxPerIndex = xAxisMode === 'radius' ? (domainRadius / (numPoints || 1)) : 1;
    const iMin = Math.max(0, Math.floor(activeMinX / dxPerIndex) - 1);
    const iMax = Math.min(numPoints - 1, Math.ceil(activeMaxX / dxPerIndex) + 1);
    const visiblePointsCount = iMax - iMin + 1;

    ctx.beginPath();
    let firstX = plotLeft;
    let lastX = plotLeft;
    let first = true;

    if (visiblePointsCount < plotWidth * 1.5) {
        for (let i = Math.max(0, iMin); i <= iMax; i++) {
            const xVal = xAxisMode === 'radius' ? (i + 0.5) * dxPerIndex : i;
            const yVal = data[i];
            if (!isFinite(yVal)) continue;

            const canvasX = plotLeft + ((xVal - activeMinX) / activeRangeX) * plotWidth;
            const canvasY = mapYToCanvas(yVal, plotTop, plotHeight, activeMinY, activeMaxY);

            if (first) {
                ctx.moveTo(canvasX, canvasY);
                firstX = canvasX;
                first = false;
            } else {
                ctx.lineTo(canvasX, canvasY);
            }
            lastX = canvasX;
        }
    } else {
        for (let px = 0; px < physDrawWidth; px++) {
            const pctL = px / physDrawWidth;
            const pctR = (px + 1) / physDrawWidth;
            const gxL = activeMinX + pctL * activeRangeX;
            const gxR = activeMinX + pctR * activeRangeX;

            const iL = gxL / dxPerIndex;
            const iR = gxR / dxPerIndex;

            let start = Math.floor(Math.min(iL, iR));
            let end = Math.ceil(Math.max(iL, iR));
            start = Math.max(0, Math.min(numPoints - 1, start));
            end = Math.max(0, Math.min(numPoints, end));
            if (start >= end) continue;

            let minY = data[start];
            let maxY = data[start];
            for (let i = start + 1; i < end; i++) {
                const val = data[i];
                if (!isFinite(val)) continue;
                if (val < minY) minY = val;
                if (val > maxY) maxY = val;
            }
            if (!isFinite(minY) || !isFinite(maxY)) continue;

            const yTop    = mapYToCanvas(maxY, plotTop, plotHeight, activeMinY, activeMaxY);
            const yBottom = mapYToCanvas(minY, plotTop, plotHeight, activeMinY, activeMaxY);
            const canvasX = plotLeft + (px / dpr);

            if (first) {
                ctx.moveTo(canvasX, yTop);
                firstX = canvasX;
                first = false;
            } else {
                ctx.lineTo(canvasX, yTop);
            }
            if (Math.abs(yBottom - yTop) > 0.5) {
                ctx.lineTo(canvasX, yBottom);
            }
            lastX = canvasX;
        }
    }
    ctx.stroke();

    if (fillUnder && !first) {
        const grad = ctx.createLinearGradient(0, plotTop, 0, plotTop + plotHeight);
        grad.addColorStop(0, color + '33');
        grad.addColorStop(1, color + '03');
        ctx.lineTo(lastX, plotTop + plotHeight);
        ctx.lineTo(firstX, plotTop + plotHeight);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
    }

    ctx.restore();
}

function drawBoxZoomOverlay(plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    if (!ctx || !isDragging || dragAction !== 'boxZoom') return;
    const x0 = Math.max(plotLeft, Math.min(plotLeft + plotWidth, Math.min(dragStartX, dragCurrX)));
    const x1 = Math.max(plotLeft, Math.min(plotLeft + plotWidth, Math.max(dragStartX, dragCurrX)));
    const y0 = Math.max(plotTop, Math.min(plotTop + plotHeight, Math.min(dragStartY, dragCurrY)));
    const y1 = Math.max(plotTop, Math.min(plotTop + plotHeight, Math.max(dragStartY, dragCurrY)));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 2 && bh < 2) return;

    ctx.save();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.92)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(x0, y0, bw, bh);
    ctx.strokeRect(x0, y0, bw, bh);
    ctx.restore();
}

function draw1DSchematicAndOverlays(
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
    activeMinX: number,
    activeMaxX: number,
    hasLiveCurve: boolean
): void {
    if (!ctx || xAxisMode !== 'radius') return;
    const activeRangeX = activeMaxX - activeMinX || 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    // Draw Charge Zone [0, chargeRadius]
    if (showCharge && chargeRadius > 0) {
        const x0 = plotLeft + ((0 - activeMinX) / activeRangeX) * plotWidth;
        const x1 = plotLeft + ((chargeRadius - activeMinX) / activeRangeX) * plotWidth;
        const w = Math.max(2, x1 - x0);
        ctx.fillStyle = hasLiveCurve ? 'rgba(244, 63, 94, 0.08)' : 'rgba(244, 63, 94, 0.22)';
        ctx.fillRect(x0, plotTop, w, plotHeight);
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, plotTop);
        ctx.lineTo(x1, plotTop + plotHeight);
        ctx.stroke();

        if (!hasLiveCurve) {
            ctx.fillStyle = '#fda4af';
            ctx.font = '10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`Charge (R=${chargeRadius.toFixed(3)}m)`, Math.max(plotLeft + 6, x1 + 6), plotTop + 20);
        }
    }

    // Draw Detonator marker
    if (showDetonator && detonatorR !== null && isFinite(detonatorR)) {
        const detX = plotLeft + ((detonatorR - activeMinX) / activeRangeX) * plotWidth;
        const detY = plotTop + plotHeight - 12;
        ctx.beginPath();
        ctx.arc(detX, detY, 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = '#ff3b30';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.fill();
        ctx.stroke();
    }

    // Draw Remap Handoff Radius R_remap (when downstream 2D/3D stage references this 1D model)
    if (showCharge && remapRadius > 0 && remapRadius <= domainRadius) {
        const rx = plotLeft + ((remapRadius - activeMinX) / activeRangeX) * plotWidth;
        if (rx >= plotLeft && rx <= plotLeft + plotWidth) {
            ctx.save();
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = 'rgba(0, 240, 255, 0.82)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(rx, plotTop);
            ctx.lineTo(rx, plotTop + plotHeight);
            ctx.stroke();
            ctx.setLineDash([]);

            const rLabel = `R_remap = ${remapRadius.toFixed(3)} m`;
            ctx.font = "600 9.5px 'JetBrains Mono', monospace";
            const tw = ctx.measureText(rLabel).width;
            const bx = (rx + tw + 18 <= plotLeft + plotWidth) ? (rx + 5) : Math.max(plotLeft + 4, rx - tw - 15);
            const by = plotTop + plotHeight - 24;
            ctx.fillStyle = 'rgba(11, 15, 25, 0.88)';
            ctx.strokeStyle = 'rgba(0, 240, 255, 0.65)';
            ctx.lineWidth = 1;
            drawRoundedBox(bx, by, tw + 10, 17, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#67e8f9';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(rLabel, bx + 5, by + 8.5);
            ctx.restore();
        }
    }

    // Detect and draw live leading shock front R_shock from 1D planar binary buffer
    if (hasLiveCurve && lastBuffer && lastBuffer.byteLength >= 8) {
        const hv = new DataView(lastBuffer);
        const nCells = hv.getUint32(0, true);
        const nCh = hv.getUint32(4, true);
        if (nCells > 2 && nCh >= 3 && lastBuffer.byteLength >= 8 + nCells * 3 * 4) {
            const pArr = new Float32Array(lastBuffer, 8, nCells);
            const uArr = new Float32Array(lastBuffer, 8 + 2 * nCells * 4, nCells);
            const pAmb = isFinite(pArr[nCells - 1]) && pArr[nCells - 1] > 1000 ? pArr[nCells - 1] : 101325.0;
            const pThresh = Math.max(pAmb * 1.05, pAmb + 5000.0);
            let shockIdx = -1;
            for (let i = nCells - 2; i >= 0; i--) {
                if (pArr[i] > pThresh || Math.abs(uArr[i]) > 5.0) {
                    shockIdx = i;
                    break;
                }
            }
            if (shockIdx >= 0) {
                const rShock = (shockIdx + 0.5) * (domainRadius / nCells);
                const sx = plotLeft + ((rShock - activeMinX) / activeRangeX) * plotWidth;
                if (sx >= plotLeft && sx <= plotLeft + plotWidth) {
                    const reachedRemap = remapRadius > 0 && rShock >= remapRadius * 0.995;
                    ctx.save();
                    ctx.setLineDash([2, 3]);
                    ctx.strokeStyle = reachedRemap ? 'rgba(16, 185, 129, 0.72)' : 'rgba(251, 191, 36, 0.72)';
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.moveTo(sx, plotTop);
                    ctx.lineTo(sx, plotTop + plotHeight);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    const sLabel = reachedRemap
                        ? `⚡ R_shock = ${rShock.toFixed(3)} m ✓`
                        : `⚡ R_shock = ${rShock.toFixed(3)} m`;
                    ctx.font = "600 9px 'JetBrains Mono', monospace";
                    const stw = ctx.measureText(sLabel).width;
                    const sbx = (sx + stw + 18 <= plotLeft + plotWidth) ? (sx + 5) : Math.max(plotLeft + 4, sx - stw - 15);
                    const sby = plotTop + 6;
                    ctx.fillStyle = 'rgba(11, 15, 25, 0.86)';
                    ctx.strokeStyle = reachedRemap ? 'rgba(16, 185, 129, 0.6)' : 'rgba(251, 191, 36, 0.6)';
                    ctx.lineWidth = 1;
                    drawRoundedBox(sbx, sby, stw + 10, 16, 4);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = reachedRemap ? '#6ee7b7' : '#fcd34d';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(sLabel, sbx + 5, sby + 8);
                    ctx.restore();
                }
            }
        }
    }

    // Draw Virtual Gauges vertical dashed lines & labels
    if (showGauges && gauges && gauges.length > 0) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.65)';
        ctx.lineWidth = 1;
        ctx.font = '10px monospace';
        ctx.fillStyle = '#6ee7b7';
        ctx.textAlign = 'left';
        for (let i = 0; i < gauges.length; ++i) {
            if (!isProbeVisible(i)) continue;
            const g = gauges[i];
            const gr = Number(g.r ?? g.x ?? 0);
            const gx = plotLeft + ((gr - activeMinX) / activeRangeX) * plotWidth;
            if (gx < plotLeft || gx > plotLeft + plotWidth) continue;
            ctx.beginPath();
            ctx.moveTo(gx, plotTop);
            ctx.lineTo(gx, plotTop + plotHeight);
            ctx.stroke();
            const label = g.name || g.id || `G${i + 1}`;
            ctx.fillText(`${label} (${gr.toFixed(2)}m)`, gx + 4, plotTop + 26 + (i % 5) * 14);
        }
        ctx.restore();
    }

    if (!hasLiveCurve && showCanvasLegend) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`1D Domain Preview (R_max = ${domainRadius.toFixed(2)} m) — Step or Run simulation`, plotLeft + 14, plotTop + plotHeight / 2);
    }

    ctx.restore();
}

function drawSpeciesLegend(plotLeft: number, plotTop: number, plotWidth: number): void {
    if (!ctx) return;
    ctx.save();
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const items = [
        { label: 'Reacted Products α₁ (JWL)', color: '#f43f5e' },
        { label: 'Unreacted Solid α₂ (JWL)', color: '#f59e0b' },
        { label: 'Ambient Air (Ideal Gas)', color: '#38bdf8' }
    ];

    const boxWidth = 195;
    const boxHeight = 64;
    const x = plotLeft + plotWidth - boxWidth - 10;
    const y = plotTop + 8;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ctx.strokeRect(x, y, boxWidth, boxHeight);

    for (let i = 0; i < items.length; i++) {
        const itemY = y + 13 + i * 18;
        ctx.fillStyle = items[i].color;
        ctx.fillRect(x + 10, itemY - 4, 12, 8);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(items[i].label, x + 28, itemY);
    }
    ctx.restore();
}

function drawRoundedBox(x: number, y: number, w: number, h: number, r: number): void {
    if (!ctx) return;
    ctx.beginPath();
    if (typeof (ctx as any).roundRect === 'function') {
        (ctx as any).roundRect(x, y, w, h, r);
    } else {
        ctx.rect(x, y, w, h);
    }
}

function drawExtremaTriangle(cx: number, cy: number, isPeak: boolean, color: string, emphasized: boolean): void {
    if (!ctx) return;
    const sz = emphasized ? 6.0 : 4.6;
    ctx.save();
    ctx.beginPath();
    if (isPeak) {
        ctx.moveTo(cx, cy - sz - 1);
        ctx.lineTo(cx + sz, cy + sz - 1);
        ctx.lineTo(cx - sz, cy + sz - 1);
    } else {
        ctx.moveTo(cx, cy + sz + 1);
        ctx.lineTo(cx + sz, cy - sz + 1);
        ctx.lineTo(cx - sz, cy - sz + 1);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0b0f19';
    ctx.lineWidth = emphasized ? 1.7 : 1.3;
    ctx.fill();
    ctx.stroke();
    if (emphasized) {
        ctx.beginPath();
        ctx.arc(cx, cy, sz + 3.5, 0, 2 * Math.PI);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.stroke();
    }
    ctx.restore();
}

function renderGaugesMode(
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number
): void {
    if (!ctx) return;

    const numSteps = gaugeTimes.length;
    const numProbes = Math.max(gaugeValues.length, gauges.length);
    const { defaultMinX, defaultMaxX } = getDefaultXBounds();
    const { activeMinX, activeMaxX, activeMinY, activeMaxY } = getActiveBounds();

    if (!isZoomedX) {
        zoomMinX = activeMinX;
        zoomMaxX = activeMaxX;
    }
    if (!isZoomedY) {
        zoomMinY = activeMinY;
        zoomMaxY = activeMaxY;
    }

    const activeRangeX = activeMaxX - activeMinX || 1;
    const activeRangeY = activeMaxY - activeMinY || 1;

    // Draw grid and axes
    if (showAxes) {
        const numTicksY = height < 230 ? 4 : 5;
        const numTicksX = width < 420 ? 4 : 6;

        if (showGrid) {
            ctx.save();
            ctx.strokeStyle = theme === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(148, 163, 184, 0.12)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 1; i < numTicksY; i++) {
                const pct = i / (numTicksY - 1);
                const y = plotTop + plotHeight - pct * plotHeight;
                ctx.moveTo(plotLeft, y);
                ctx.lineTo(plotLeft + plotWidth, y);
            }
            for (let i = 1; i < numTicksX; i++) {
                const pct = i / (numTicksX - 1);
                const x = plotLeft + pct * plotWidth;
                ctx.moveTo(x, plotTop);
                ctx.lineTo(x, plotTop + plotHeight);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Border box
        ctx.strokeStyle = theme === 'light' ? 'rgba(51, 65, 85, 0.45)' : 'rgba(56, 189, 248, 0.38)';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);

        ctx.fillStyle = theme === 'light' ? '#334155' : '#cbd5e1';
        ctx.font = "9.5px 'JetBrains Mono', monospace";

        // Y-axis ticks
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < numTicksY; i++) {
            const pct = i / (numTicksY - 1);
            let val: number;
            if (useLogScale && activeMaxY > 0) {
                const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
                const logMin = Math.log10(safeMin);
                const logMax = Math.log10(activeMaxY);
                val = Math.pow(10, logMin + pct * (logMax - logMin));
            } else {
                val = activeMinY + pct * activeRangeY;
            }
            const y = plotTop + plotHeight - pct * plotHeight;
            ctx.beginPath();
            ctx.moveTo(plotLeft - 4, y);
            ctx.lineTo(plotLeft, y);
            ctx.stroke();
            ctx.fillText(formatSciNumber(val), plotLeft - 6, y);
        }

        // X-axis ticks (Time)
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < numTicksX; i++) {
            const pct = i / (numTicksX - 1);
            const x = plotLeft + pct * plotWidth;
            const tVal = activeMinX + pct * activeRangeX;
            ctx.beginPath();
            ctx.moveTo(x, plotTop + plotHeight);
            ctx.lineTo(x, plotTop + plotHeight + 4);
            ctx.stroke();
            ctx.fillText(formatTimeUnit(tVal, activeMaxX), x, plotTop + plotHeight + 5);
        }
        if (height >= 230) {
            ctx.fillStyle = theme === 'light' ? '#475569' : '#94a3b8';
            ctx.fillText('Time t', plotLeft + plotWidth / 2, plotTop + plotHeight + 16);
        }
        const gMeta = GAUGE_CHANNELS[selectedChannel] || { name: `Channel ${selectedChannel}`, unit: '' };
        const gYTitle = gMeta.unit && gMeta.unit !== '-' ? `${gMeta.name} [${gMeta.unit}]` : gMeta.name;
        drawYAxisTitle(plotTop, plotHeight, gYTitle);
    }

    const firstBracketIdx = numSteps > 0 ? Math.max(0, lowerBoundTime(activeMinX) - 1) : 0;
    const lastBracketIdx = numSteps > 0 ? Math.min(numSteps - 1, lowerBoundTime(activeMaxX) + 1) : 0;

    const probeStatsList: Array<{
        index: number;
        id: string;
        coordDesc: string;
        color: string;
        visible: boolean;
        peakVal: number | null;
        peakT: number | null;
        troughVal: number | null;
        troughT: number | null;
        winPeakVal: number | null;
        winPeakT: number | null;
        winTroughVal: number | null;
        winTroughT: number | null;
        lastVal: number | null;
        hoverVal: number | null;
    }> = [];

    for (let p = 0; p < numProbes; p++) {
        const gMeta = gauges[p];
        const gName = gMeta?.name || gMeta?.id || `G${p + 1}`;
        let coordDesc = '';
        if (gMeta) {
            if (gMeta.x !== undefined && gMeta.y !== undefined && gMeta.z !== undefined && gMeta.r === undefined) {
                coordDesc = `(${Number(gMeta.x).toFixed(2)}, ${Number(gMeta.y).toFixed(2)}, ${Number(gMeta.z).toFixed(2)})`;
            } else if (gMeta.r !== undefined && gMeta.z !== undefined) {
                coordDesc = `(${Number(gMeta.r).toFixed(2)}, ${Number(gMeta.z).toFixed(2)}m)`;
            } else if (gMeta.r !== undefined) {
                coordDesc = `(r=${Number(gMeta.r).toFixed(2)}m)`;
            }
        }
        const series = getGaugeSeries(p, selectedChannel);
        const count = Math.min(numSteps, series.length);
        let peakVal = -Infinity, peakT = 0;
        let troughVal = Infinity, troughT = 0;
        let winPeakVal = -Infinity, winPeakT = 0;
        let winTroughVal = Infinity, winTroughT = 0;

        for (let i = 0; i < count; i++) {
            const v = Number(series[i]);
            if (!isFinite(v)) continue;
            const t = Number(gaugeTimes[i] ?? 0);
            if (v > peakVal) { peakVal = v; peakT = t; }
            if (v < troughVal) { troughVal = v; troughT = t; }
            if (i >= firstBracketIdx && i <= lastBracketIdx) {
                if (v > winPeakVal) { winPeakVal = v; winPeakT = t; }
                if (v < winTroughVal) { winTroughVal = v; winTroughT = t; }
            }
        }
        if (!isFinite(winPeakVal) && isFinite(peakVal)) { winPeakVal = peakVal; winPeakT = peakT; }
        if (!isFinite(winTroughVal) && isFinite(troughVal)) { winTroughVal = troughVal; winTroughT = troughT; }

        const lastVal = count > 0 ? Number(series[count - 1]) : null;
        probeStatsList.push({
            index: p,
            id: gName,
            coordDesc,
            color: PROBE_PALETTE[p % PROBE_PALETTE.length],
            visible: isProbeVisible(p),
            peakVal: isFinite(peakVal) ? peakVal : null,
            peakT: isFinite(peakVal) ? peakT : null,
            troughVal: isFinite(troughVal) ? troughVal : null,
            troughT: isFinite(troughVal) ? troughT : null,
            winPeakVal: isFinite(winPeakVal) ? winPeakVal : null,
            winPeakT: isFinite(winPeakVal) ? winPeakT : null,
            winTroughVal: isFinite(winTroughVal) ? winTroughVal : null,
            winTroughT: isFinite(winTroughVal) ? winTroughT : null,
            lastVal: (lastVal !== null && isFinite(lastVal)) ? lastVal : null,
            hoverVal: null
        });
    }

    if (numSteps === 0 || gaugeValues.length === 0) {
        if (showCanvasLegend) {
            ctx.save();
            ctx.fillStyle = '#94a3b8';
            ctx.font = "11px 'JetBrains Mono', monospace";
            ctx.textAlign = 'center';
            const probeCount = gauges.length;
            const msg = probeCount > 0
                ? `Virtual Gauge Time-History Ready (${probeCount} probe${probeCount === 1 ? '' : 's'} configured) — Initialize, Step or Run simulation`
                : `No Virtual Gauge Probes configured — Add probes via Probes Manager`;
            ctx.fillText(msg, plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
            ctx.restore();
        }
        emitProbeStats({
            type: 'probeStats',
            chartMode,
            channel: selectedChannel,
            numSteps: 0,
            probes: probeStatsList,
            activeMinX,
            activeMaxX,
            activeMinY,
            activeMaxY,
            isZoomedX,
            isZoomedY,
            hoverT: null
        });
        return;
    }

    // Determine hover snap index & closest curve to mouse Y for automatic hover emphasis
    const isMouseInPlot = !isDragging
        && hoverCanvasX !== null && hoverCanvasX >= plotLeft && hoverCanvasX <= plotLeft + plotWidth
        && hoverCanvasY !== null && hoverCanvasY >= plotTop && hoverCanvasY <= plotTop + plotHeight;

    let bestHoverIdx = -1;
    let snapHoverT: number | null = null;
    let autoClosestProbe = -1;

    if (isMouseInPlot && hoverCanvasX !== null && hoverCanvasY !== null && numSteps > 0) {
        const hoverT = activeMinX + ((hoverCanvasX - plotLeft) / plotWidth) * activeRangeX;
        const lb = lowerBoundTime(hoverT);
        bestHoverIdx = Math.min(numSteps - 1, Math.max(0, lb));
        if (lb > 0 && lb < numSteps) {
            const d0 = Math.abs(Number(gaugeTimes[lb - 1]) - hoverT);
            const d1 = Math.abs(Number(gaugeTimes[lb]) - hoverT);
            if (d0 <= d1) bestHoverIdx = lb - 1;
        } else if (lb >= numSteps) {
            bestHoverIdx = numSteps - 1;
        }
        snapHoverT = Number(gaugeTimes[bestHoverIdx] ?? hoverT);

        let bestDy = 42; // snap highlight if within 42px vertically
        for (let p = 0; p < numProbes; p++) {
            if (!isProbeVisible(p)) continue;
            const series = getGaugeSeries(p, selectedChannel);
            if (!series || series.length === 0) continue;
            const v = Number(series[Math.min(bestHoverIdx, series.length - 1)]);
            if (!isFinite(v)) continue;
            const cy = mapYToCanvas(v, plotTop, plotHeight, activeMinY, activeMaxY);
            const dy = Math.abs(cy - hoverCanvasY);
            if (dy < bestDy) {
                bestDy = dy;
                autoClosestProbe = p;
            }
        }
    }

    const effectiveFocusProbe = hoveredProbe >= 0 ? hoveredProbe : autoClosestProbe;

    // Draw probe waveforms clipped inside plot rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    const physDrawWidth = Math.max(40, Math.round(plotWidth * dpr));

    const drawOrder: number[] = [];
    for (let p = 0; p < numProbes; p++) {
        if (!isProbeVisible(p)) continue;
        if (p !== effectiveFocusProbe) drawOrder.push(p);
    }
    if (effectiveFocusProbe >= 0 && effectiveFocusProbe < numProbes && isProbeVisible(effectiveFocusProbe)) {
        drawOrder.push(effectiveFocusProbe);
    }

    for (const p of drawOrder) {
        const series = getGaugeSeries(p, selectedChannel);
        if (!series || series.length === 0) continue;

        const color = PROBE_PALETTE[p % PROBE_PALETTE.length];
        const isHov = effectiveFocusProbe === p;
        const dimOther = hoveredProbe >= 0 && !isHov;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = dimOther ? 0.35 : 1.0;
        ctx.lineWidth = isHov ? 2.8 : (selectedProbe === p ? 2.2 : 1.85);
        if (isHov) {
            ctx.shadowColor = color;
            ctx.shadowBlur = 7;
        }

        const maxIdx = Math.min(lastBracketIdx, series.length - 1);
        const spanCount = maxIdx - firstBracketIdx + 1;

        if (series.length === 1 || numSteps === 1) {
            // Single-sample initial state at t=0: draw dashed reference baseline + clear sample marker!
            const t0 = Number(gaugeTimes[0] ?? 0);
            const v0 = Number(series[0]);
            if (isFinite(v0)) {
                const cx = plotLeft + ((t0 - activeMinX) / activeRangeX) * plotWidth;
                const cy = mapYToCanvas(v0, plotTop, plotHeight, activeMinY, activeMaxY);
                ctx.save();
                ctx.setLineDash([5, 4]);
                ctx.lineWidth = 1.3;
                ctx.globalAlpha = dimOther ? 0.25 : 0.65;
                ctx.beginPath();
                ctx.moveTo(plotLeft, cy);
                ctx.lineTo(plotLeft + plotWidth, cy);
                ctx.stroke();
                ctx.restore();

                ctx.fillStyle = color;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(cx, cy, isHov ? 5.2 : 4.0, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            }
        } else if (spanCount <= physDrawWidth * 2) {
            ctx.beginPath();
            let first = true;
            for (let i = firstBracketIdx; i <= maxIdx; i++) {
                const t = Number(gaugeTimes[i] ?? i);
                const v = Number(series[i]);
                if (!isFinite(v)) continue;
                const cx = plotLeft + ((t - activeMinX) / activeRangeX) * plotWidth;
                const cy = mapYToCanvas(v, plotTop, plotHeight, activeMinY, activeMaxY);
                if (first) {
                    ctx.moveTo(cx, cy);
                    first = false;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();

            if (spanCount <= 45) {
                ctx.fillStyle = color;
                for (let i = firstBracketIdx; i <= maxIdx; i++) {
                    const t = Number(gaugeTimes[i] ?? i);
                    const v = Number(series[i]);
                    if (!isFinite(v)) continue;
                    const cx = plotLeft + ((t - activeMinX) / activeRangeX) * plotWidth;
                    const cy = mapYToCanvas(v, plotTop, plotHeight, activeMinY, activeMaxY);
                    ctx.beginPath();
                    ctx.arc(cx, cy, isHov ? 3.2 : 2.2, 0, 2 * Math.PI);
                    ctx.fill();
                }
            }
        } else {
            ctx.beginPath();
            let first = true;
            let cursor = firstBracketIdx;
            for (let px = 0; px < physDrawWidth; px++) {
                const tL = activeMinX + (px / physDrawWidth) * activeRangeX;
                const tR = activeMinX + ((px + 1) / physDrawWidth) * activeRangeX;
                while (cursor < maxIdx && Number(gaugeTimes[cursor]) < tL) cursor++;
                let end = cursor;
                while (end <= maxIdx && Number(gaugeTimes[end]) <= tR) end++;
                const bStart = Math.max(firstBracketIdx, cursor - 1);
                const bEnd = Math.min(maxIdx, Math.max(bStart, end - 1));
                let minV = Infinity;
                let maxV = -Infinity;
                for (let k = bStart; k <= bEnd; k++) {
                    const v = Number(series[k]);
                    if (!isFinite(v)) continue;
                    if (v < minV) minV = v;
                    if (v > maxV) maxV = v;
                }
                if (!isFinite(minV) || !isFinite(maxV)) continue;
                const cx = plotLeft + (px / dpr);
                const yTop = mapYToCanvas(maxV, plotTop, plotHeight, activeMinY, activeMaxY);
                const yBot = mapYToCanvas(minV, plotTop, plotHeight, activeMinY, activeMaxY);
                if (first) {
                    ctx.moveTo(cx, yTop);
                    first = false;
                } else {
                    ctx.lineTo(cx, yTop);
                }
                if (Math.abs(yBot - yTop) > 0.5) {
                    ctx.lineTo(cx, yBot);
                }
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // Automatic Peak (▲) & Trough (▼) Curve Callouts
    if ((showPeaks || isMouseInPlot) && numSteps >= 2) {
        let calloutLabelsDrawn = 0;
        for (const p of drawOrder) {
            const st = probeStatsList[p];
            if (!st || !st.visible) continue;
            const isEmph = p === effectiveFocusProbe || selectedProbe === p || drawOrder.length === 1;

            if (st.winTroughVal !== null && st.winTroughT !== null) {
                const tx = plotLeft + ((st.winTroughT - activeMinX) / activeRangeX) * plotWidth;
                const ty = mapYToCanvas(st.winTroughVal, plotTop, plotHeight, activeMinY, activeMaxY);
                if (tx >= plotLeft - 4 && tx <= plotLeft + plotWidth + 4) {
                    drawExtremaTriangle(tx, ty, false, st.color, isEmph);
                    if (isEmph && !isMouseInPlot && calloutLabelsDrawn < 4) {
                        const txt = `▼ ${formatSciNumber(st.winTroughVal)}`;
                        ctx.save();
                        ctx.font = "700 8.5px 'JetBrains Mono', monospace";
                        const tw = ctx.measureText(txt).width + 8;
                        const bx = Math.min(plotLeft + plotWidth - tw - 4, Math.max(plotLeft + 4, tx + 7));
                        const by = Math.min(plotTop + plotHeight - 17, ty + 4);
                        ctx.fillStyle = 'rgba(11, 15, 25, 0.88)';
                        ctx.strokeStyle = st.color;
                        ctx.lineWidth = 1;
                        drawRoundedBox(bx, by, tw, 14, 3);
                        ctx.fill();
                        ctx.stroke();
                        ctx.fillStyle = '#e2e8f0';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(txt, bx + 4, by + 7);
                        ctx.restore();
                        calloutLabelsDrawn++;
                    }
                }
            }

            if (st.winPeakVal !== null && st.winPeakT !== null) {
                const px = plotLeft + ((st.winPeakT - activeMinX) / activeRangeX) * plotWidth;
                const py = mapYToCanvas(st.winPeakVal, plotTop, plotHeight, activeMinY, activeMaxY);
                if (px >= plotLeft - 4 && px <= plotLeft + plotWidth + 4) {
                    drawExtremaTriangle(px, py, true, st.color, isEmph);
                    if ((isEmph || drawOrder.length <= 3) && !isMouseInPlot && calloutLabelsDrawn < 5) {
                        const txt = `${st.id} ▲ ${formatSciNumber(st.winPeakVal)}`;
                        ctx.save();
                        ctx.font = "700 8.5px 'JetBrains Mono', monospace";
                        const tw = ctx.measureText(txt).width + 8;
                        const bx = Math.min(plotLeft + plotWidth - tw - 4, Math.max(plotLeft + 4, px + 7));
                        const by = Math.max(plotTop + 3, py - 17);
                        ctx.fillStyle = 'rgba(11, 15, 25, 0.88)';
                        ctx.strokeStyle = st.color;
                        ctx.lineWidth = 1;
                        drawRoundedBox(bx, by, tw, 14, 3);
                        ctx.fill();
                        ctx.stroke();
                        ctx.fillStyle = st.color;
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(txt, bx + 4, by + 7);
                        ctx.restore();
                        calloutLabelsDrawn++;
                    }
                }
            }
        }
    }

    // Hover Crosshair + Curve Snap Dots
    let hoverTimeStr = '';
    let snapXForTooltip = hoverCanvasX ?? plotLeft;
    if (isMouseInPlot && bestHoverIdx >= 0 && snapHoverT !== null) {
        const snapX = plotLeft + ((snapHoverT - activeMinX) / activeRangeX) * plotWidth;
        snapXForTooltip = snapX;

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.68)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(snapX, plotTop);
        ctx.lineTo(snapX, plotTop + plotHeight);
        if (hoverCanvasY !== null) {
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)';
            ctx.moveTo(plotLeft, hoverCanvasY);
            ctx.lineTo(plotLeft + plotWidth, hoverCanvasY);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        for (let p = 0; p < numProbes; p++) {
            if (!isProbeVisible(p)) continue;
            const series = getGaugeSeries(p, selectedChannel);
            if (!series || series.length === 0) continue;
            const v = Number(series[Math.min(bestHoverIdx, series.length - 1)]);
            if (isFinite(v)) {
                const cy = mapYToCanvas(v, plotTop, plotHeight, activeMinY, activeMaxY);
                const isEmph = effectiveFocusProbe === p;
                ctx.fillStyle = PROBE_PALETTE[p % PROBE_PALETTE.length];
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = isEmph ? 2.0 : 1.2;
                ctx.beginPath();
                ctx.arc(snapX, cy, isEmph ? 5.4 : 3.8, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
                if (probeStatsList[p]) probeStatsList[p].hoverVal = v;
            }
        }
        ctx.restore();
        hoverTimeStr = ` • t = ${formatTimeUnit(snapHoverT, activeMaxX)}`;
    }

    drawBoxZoomOverlay(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.restore(); // End plot clip

    // Optional fallback canvas legend when not hovering (only shown when standalone/NodeViewer without floating HTML Probe Card)
    const visibleItems = probeStatsList.filter(item => item.visible);
    if (showCanvasLegend && !isMouseInPlot && visibleItems.length > 0) {
        ctx.save();
        ctx.font = "600 9.5px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const maxVisibleLeg = Math.min(visibleItems.length, 8);
        const boxW = Math.min(285, Math.max(175, plotWidth * 0.42));
        const boxH = 12 + maxVisibleLeg * 16;
        const bx = plotLeft + plotWidth - boxW - 8;
        const by = plotTop + 8;

        ctx.fillStyle = 'rgba(14, 15, 19, 0.88)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.lineWidth = 1;
        drawRoundedBox(bx, by, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();

        for (let i = 0; i < maxVisibleLeg; i++) {
            const item = visibleItems[i];
            const iy = by + 12 + i * 16;
            ctx.fillStyle = item.color;
            ctx.fillRect(bx + 8, iy - 4, 9, 8);
            ctx.fillStyle = '#e2e8f0';
            const rightText = item.peakVal !== null
                ? `▲${formatSciNumber(item.peakVal)} ▼${formatSciNumber(item.troughVal ?? 0)}`
                : '—';
            const fullText = `${item.id}: ${rightText}`;
            ctx.fillText(fullText.length > 38 ? fullText.slice(0, 38) : fullText, bx + 21, iy);
        }
        ctx.restore();
    }

    // Rich Floating Glassmorphic Hover Card (Instantaneous Value + Automatic ▲ Peak & ▼ Trough!)
    const chMeta = GAUGE_CHANNELS[selectedChannel] || { name: `Channel ${selectedChannel}`, unit: '' };
    const unitSuffix = chMeta.unit && chMeta.unit !== '-' ? ` ${chMeta.unit}` : '';
    if (isMouseInPlot && snapHoverT !== null && visibleItems.length > 0 && hoverCanvasY !== null) {
        // Prioritize hovered/closest curve first, then remaining visible curves (up to 6)
        const orderedHoverItems = [...visibleItems].sort((a, b) => {
            if (a.index === effectiveFocusProbe) return -1;
            if (b.index === effectiveFocusProbe) return 1;
            return a.index - b.index;
        }).slice(0, 6);

        ctx.save();
        ctx.font = "600 9.5px 'JetBrains Mono', monospace";
        const headerStr = `⏱ t = ${formatTimeUnit(snapHoverT, activeMaxX)}  •  ${chMeta.name}`;
        let maxW = ctx.measureText(headerStr).width + 8;

        const formattedBlocks = orderedHoverItems.map(item => {
            const instStr = item.hoverVal !== null ? `${formatSciNumber(item.hoverVal)}${unitSuffix}` : '—';
            const topRow = `${item.id} ${item.coordDesc}:  ${instStr}`;
            const pkPart = item.peakVal !== null && item.peakT !== null
                ? `▲ Peak ${formatSciNumber(item.peakVal)} @ ${formatTimeUnit(item.peakT, defaultMaxX)}`
                : '▲ —';
            const trPart = item.troughVal !== null && item.troughT !== null
                ? `▼ Min ${formatSciNumber(item.troughVal)} @ ${formatTimeUnit(item.troughT, defaultMaxX)}`
                : '▼ —';
            const subRow = `  ${pkPart}  •  ${trPart}`;
            maxW = Math.max(maxW, ctx!.measureText(topRow).width + 18, ctx!.measureText(subRow).width + 18);
            return { item, topRow, subRow, isFocus: item.index === effectiveFocusProbe };
        });

        const cardW = Math.min(width - 16, maxW + 18);
        const blockH = 29;
        const cardH = 26 + formattedBlocks.length * blockH + (visibleItems.length > 6 ? 14 : 4);
        let cardX = snapXForTooltip + 14;
        let cardY = hoverCanvasY - Math.round(cardH * 0.45);
        if (cardX + cardW > width - 8) cardX = Math.max(8, snapXForTooltip - cardW - 14);
        if (cardY + cardH > height - 8) cardY = height - cardH - 8;
        if (cardY < 8) cardY = 8;

        ctx.fillStyle = 'rgba(11, 15, 25, 0.94)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.lineWidth = 1.1;
        drawRoundedBox(cardX, cardY, cardW, cardH, 7);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#38bdf8';
        ctx.font = "700 9.5px 'JetBrains Mono', monospace";
        ctx.fillText(headerStr, cardX + 10, cardY + 13);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        ctx.beginPath();
        ctx.moveTo(cardX + 8, cardY + 22);
        ctx.lineTo(cardX + cardW - 8, cardY + 22);
        ctx.stroke();

        for (let i = 0; i < formattedBlocks.length; i++) {
            const b = formattedBlocks[i];
            const by = cardY + 31 + i * blockH;
            if (b.isFocus) {
                ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
                drawRoundedBox(cardX + 5, by - 7, cardW - 10, blockH - 2, 4);
                ctx.fill();
            }
            ctx.fillStyle = b.item.color;
            ctx.beginPath();
            ctx.arc(cardX + 13, by, 4, 0, 2 * Math.PI);
            ctx.fill();

            ctx.font = b.isFocus ? "700 9.5px 'JetBrains Mono', monospace" : "600 9.5px 'JetBrains Mono', monospace";
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(b.topRow, cardX + 22, by);

            ctx.font = "500 8.5px 'JetBrains Mono', monospace";
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(b.subRow, cardX + 16, by + 13);
        }
        if (visibleItems.length > 6) {
            ctx.font = "500 8.5px 'JetBrains Mono', monospace";
            ctx.fillStyle = '#64748b';
            ctx.fillText(`+ ${visibleItems.length - 6} more probes visible`, cardX + 12, cardY + cardH - 9);
        }
        ctx.restore();
    }

    // Subtle top-left status line above plot box
    const zoomTag = (isZoomedX || isZoomedY) ? ' • [ZOOMED]' : '';
    ctx.save();
    ctx.font = "600 9.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = theme === 'light' ? '#334155' : '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
        `${chMeta.name} [${chMeta.unit}] • ${numSteps} pts (${formatTimeUnit(defaultMaxX, defaultMaxX)})${zoomTag}${hoverTimeStr}`,
        plotLeft,
        Math.max(9, plotTop - 9)
    );
    ctx.restore();

    emitProbeStats({
        type: 'probeStats',
        chartMode,
        channel: selectedChannel,
        numSteps,
        probes: probeStatsList,
        activeMinX,
        activeMaxX,
        activeMinY,
        activeMaxY,
        isZoomedX,
        isZoomedY,
        hoverT: snapHoverT
    });
}

function render(): void {
    try {
        if (!ctx || !canvas || width <= 0 || height <= 0) {
            return;
        }

        const { plotLeft, plotTop, plotWidth, plotHeight } = getPlotRect();

        // Clear and fill 3D-consistent studio background
        ctx.clearRect(0, 0, width, height);
        if (clearBgRgb) {
            ctx.fillStyle = `rgb(${clearBgRgb[0]}, ${clearBgRgb[1]}, ${clearBgRgb[2]})`;
            ctx.fillRect(0, 0, width, height);
        } else {
            const bgGrad = ctx.createRadialGradient(
                width * 0.5, height * 0.45, Math.min(width, height) * 0.08,
                width * 0.5, height * 0.5, Math.max(width, height) * 0.78
            );
            if (theme === 'light') {
                bgGrad.addColorStop(0, '#f8fafc');
                bgGrad.addColorStop(1, '#e2e8f0');
            } else if (theme === 'slate') {
                bgGrad.addColorStop(0, '#1e293b');
                bgGrad.addColorStop(1, '#0f172a');
            } else {
                bgGrad.addColorStop(0, '#131926');
                bgGrad.addColorStop(1, '#090d16');
            }
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, width, height);
        }

        // Plot interior card depth matching 3D stage
        ctx.save();
        ctx.fillStyle = theme === 'light' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(11, 17, 32, 0.76)';
        ctx.fillRect(plotLeft, plotTop, plotWidth, plotHeight);
        ctx.restore();

        if (chartMode === 'gauges') {
            renderGaugesMode(plotLeft, plotTop, plotWidth, plotHeight);
            return;
        }

        const { activeMinX, activeMaxX, activeMinY, activeMaxY } = getActiveBounds();
        if (!isZoomedX) {
            zoomMinX = activeMinX;
            zoomMaxX = activeMaxX;
        }
        if (!isZoomedY) {
            zoomMinY = activeMinY;
            zoomMaxY = activeMaxY;
        }

        const activeRangeX = activeMaxX - activeMinX || 1;
        const activeRangeY = activeMaxY - activeMinY || 1;

        if (showAxes) {
            const numTicksY = height < 230 ? 4 : 5;
            const numTicksX = width < 420 ? 4 : 6;

            if (showGrid) {
                ctx.save();
                ctx.strokeStyle = theme === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(148, 163, 184, 0.12)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = 1; i < numTicksY; i++) {
                    const pct = i / (numTicksY - 1);
                    const y = plotTop + plotHeight - pct * plotHeight;
                    ctx.moveTo(plotLeft, y);
                    ctx.lineTo(plotLeft + plotWidth, y);
                }
                for (let i = 1; i < numTicksX; i++) {
                    const pct = i / (numTicksX - 1);
                    const x = plotLeft + pct * plotWidth;
                    ctx.moveTo(x, plotTop);
                    ctx.lineTo(x, plotTop + plotHeight);
                }
                ctx.stroke();
                ctx.restore();
            }

            ctx.strokeStyle = theme === 'light' ? 'rgba(51, 65, 85, 0.45)' : 'rgba(56, 189, 248, 0.38)';
            ctx.lineWidth = 1.1;
            ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);

            ctx.fillStyle = theme === 'light' ? '#334155' : '#cbd5e1';
            ctx.font = "9.5px 'JetBrains Mono', monospace";

            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (let i = 0; i < numTicksY; i++) {
                const pct = i / (numTicksY - 1);
                let val: number;
                if (useLogScale && activeMaxY > 0) {
                    const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
                    const logMin = Math.log10(safeMin);
                    const logMax = Math.log10(activeMaxY);
                    val = Math.pow(10, logMin + pct * (logMax - logMin));
                } else {
                    val = activeMinY + pct * activeRangeY;
                }
                const y = plotTop + plotHeight - pct * plotHeight;

                ctx.strokeStyle = '#475569';
                ctx.beginPath();
                ctx.moveTo(plotLeft - 4, y);
                ctx.lineTo(plotLeft, y);
                ctx.stroke();

                const labelText = (selectedChannel >= 4 && selectedChannel <= 7) ? val.toFixed(2) : formatSciNumber(val);
                ctx.fillText(labelText, plotLeft - 6, y);
            }

            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (let i = 0; i < numTicksX; i++) {
                const pct = i / (numTicksX - 1);
                const x = plotLeft + pct * plotWidth;

                ctx.strokeStyle = '#475569';
                ctx.beginPath();
                ctx.moveTo(x, plotTop + plotHeight);
                ctx.lineTo(x, plotTop + plotHeight + 4);
                ctx.stroke();

                const val = activeMinX + pct * activeRangeX;
                const labelText = xAxisMode === 'radius' ? `${val.toFixed(2)} m` : String(Math.round(val));
                ctx.fillText(labelText, x, plotTop + plotHeight + 5);
            }
            if (height >= 230) {
                ctx.fillStyle = theme === 'light' ? '#475569' : '#94a3b8';
                ctx.fillText(xAxisMode === 'radius' ? 'Radial Coordinate r [m]' : 'Cell Index', plotLeft + plotWidth / 2, plotTop + plotHeight + 16);
            }
            const sMeta = SPATIAL_CHANNELS[selectedChannel] || { name: `Channel ${selectedChannel}`, unit: '', color: chartColor };
            const sYTitle = sMeta.unit && sMeta.unit !== '-' ? `${sMeta.name} [${sMeta.unit}]` : sMeta.name;
            drawYAxisTitle(plotTop, plotHeight, sYTitle);
        }

        const physDrawWidth = Math.round(plotWidth * dpr);
        const hasLiveCurve = Boolean(rawData && rawData.length > 0);
        draw1DSchematicAndOverlays(plotLeft, plotTop, plotWidth, plotHeight, activeMinX, activeMaxX, hasLiveCurve);

        const chMeta = SPATIAL_CHANNELS[selectedChannel] || { name: `Channel ${selectedChannel}`, unit: '', color: chartColor };
        const unitSuffix = chMeta.unit && chMeta.unit !== '-' ? ` ${chMeta.unit}` : '';

        if (selectedChannel === 4 && lastBuffer) {
            const dataBurned = extractChannel(lastBuffer, 5);
            const dataUnburnt = extractChannel(lastBuffer, 6);
            const dataAir = extractChannel(lastBuffer, 7);

            drawSpatialCurve(dataAir, '#38bdf8', physDrawWidth, plotLeft, plotTop, plotWidth, plotHeight, activeMinX, activeMaxX, activeMinY, activeMaxY, false);
            drawSpatialCurve(dataUnburnt, '#f59e0b', physDrawWidth, plotLeft, plotTop, plotWidth, plotHeight, activeMinX, activeMaxX, activeMinY, activeMaxY, false);
            drawSpatialCurve(dataBurned, '#f43f5e', physDrawWidth, plotLeft, plotTop, plotWidth, plotHeight, activeMinX, activeMaxX, activeMinY, activeMaxY, false);

            drawSpeciesLegend(plotLeft, plotTop, plotWidth);
        } else if (rawData && rawData.length > 0) {
            const curveCol = chMeta.color || chartColor;
            drawSpatialCurve(rawData, curveCol, physDrawWidth, plotLeft, plotTop, plotWidth, plotHeight, activeMinX, activeMaxX, activeMinY, activeMaxY, true);
        }

        // Compute spatial Peak & Trough across visible window
        let spPeakVal = -Infinity, spPeakX = 0;
        let spTroughVal = Infinity, spTroughX = 0;
        if (rawData && rawData.length > 0 && selectedChannel !== 4) {
            const numPoints = rawData.length;
            const dxPerIndex = xAxisMode === 'radius' ? (domainRadius / (numPoints || 1)) : 1;
            const iMin = Math.max(0, Math.floor(activeMinX / dxPerIndex) - 1);
            const iMax = Math.min(numPoints - 1, Math.ceil(activeMaxX / dxPerIndex) + 1);
            for (let i = iMin; i <= iMax; i++) {
                const v = rawData[i];
                if (!isFinite(v)) continue;
                const xCoord = xAxisMode === 'radius' ? (i + 0.5) * dxPerIndex : i;
                if (v > spPeakVal) { spPeakVal = v; spPeakX = xCoord; }
                if (v < spTroughVal) { spTroughVal = v; spTroughX = xCoord; }
            }
        }

        const isMouseInPlot = !isDragging
            && hoverCanvasX !== null && hoverCanvasX >= plotLeft && hoverCanvasX <= plotLeft + plotWidth
            && hoverCanvasY !== null && hoverCanvasY >= plotTop && hoverCanvasY <= plotTop + plotHeight;

        // Draw spatial Peak (▲) & Trough (▼) callouts inside plot clip
        if ((showPeaks || isMouseInPlot) && isFinite(spPeakVal) && isFinite(spTroughVal)) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
            ctx.clip();

            const tx = plotLeft + ((spTroughX - activeMinX) / activeRangeX) * plotWidth;
            const ty = mapYToCanvas(spTroughVal, plotTop, plotHeight, activeMinY, activeMaxY);
            drawExtremaTriangle(tx, ty, false, '#38bdf8', isMouseInPlot);

            const px = plotLeft + ((spPeakX - activeMinX) / activeRangeX) * plotWidth;
            const py = mapYToCanvas(spPeakVal, plotTop, plotHeight, activeMinY, activeMaxY);
            drawExtremaTriangle(px, py, true, '#fbbf24', true);

            if (!isMouseInPlot) {
                const pkTxt = `▲ ${formatSciNumber(spPeakVal)}${unitSuffix}`;
                ctx.font = "700 8.5px 'JetBrains Mono', monospace";
                const tw = ctx.measureText(pkTxt).width + 8;
                const bx = Math.min(plotLeft + plotWidth - tw - 4, Math.max(plotLeft + 4, px + 7));
                const by = Math.max(plotTop + 3, py - 17);
                ctx.fillStyle = 'rgba(11, 15, 25, 0.88)';
                ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
                ctx.lineWidth = 1;
                drawRoundedBox(bx, by, tw, 14, 3);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#fbbf24';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(pkTxt, bx + 4, by + 7);
            }
            ctx.restore();
        }

        let hoverReadout = '';
        let bufCells = 0;
        let bufCh = 0;
        if (lastBuffer && lastBuffer.byteLength >= 8) {
            const hv = new DataView(lastBuffer);
            bufCells = hv.getUint32(0, true);
            bufCh = hv.getUint32(4, true);
            if (lastBuffer.byteLength < 8 + bufCells * bufCh * 4) {
                bufCells = 0;
            }
        }
        const numSpatialPts = (rawData && rawData.length > 0) ? rawData.length : bufCells;

        if (isMouseInPlot && hoverCanvasX !== null && hoverCanvasY !== null && numSpatialPts > 0) {
            const hoverXVal = activeMinX + ((hoverCanvasX - plotLeft) / plotWidth) * activeRangeX;
            const dxPerIndex = xAxisMode === 'radius' ? (domainRadius / (numSpatialPts || 1)) : 1;
            const cellIdx = Math.max(0, Math.min(numSpatialPts - 1, Math.floor(hoverXVal / dxPerIndex)));
            const cellVal = (rawData && cellIdx < rawData.length)
                ? rawData[cellIdx]
                : (bufCells > 0 && bufCh >= 5 ? new Float32Array(lastBuffer!, 8 + 4 * bufCells * 4, bufCells)[cellIdx] : NaN);

            if (isFinite(cellVal)) {
                const rCoord = xAxisMode === 'radius' ? (cellIdx + 0.5) * dxPerIndex : cellIdx;
                const snapX = plotLeft + ((rCoord - activeMinX) / activeRangeX) * plotWidth;
                const snapY = mapYToCanvas(cellVal, plotTop, plotHeight, activeMinY, activeMaxY);

                ctx.save();
                ctx.beginPath();
                ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
                ctx.clip();

                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = 'rgba(226, 232, 240, 0.65)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(snapX, plotTop);
                ctx.lineTo(snapX, plotTop + plotHeight);
                if (selectedChannel !== 4) {
                    ctx.moveTo(plotLeft, snapY);
                    ctx.lineTo(plotLeft + plotWidth, snapY);
                }
                ctx.stroke();
                ctx.setLineDash([]);

                if (selectedChannel === 4 && bufCells > 0 && bufCh >= 7 && cellIdx < bufCells) {
                    const a1 = new Float32Array(lastBuffer!, 8 + 4 * bufCells * 4, bufCells)[cellIdx];
                    const a2 = new Float32Array(lastBuffer!, 8 + 5 * bufCells * 4, bufCells)[cellIdx];
                    const aAir = new Float32Array(lastBuffer!, 8 + 6 * bufCells * 4, bufCells)[cellIdx];
                    const dots: Array<{ v: number; c: string }> = [
                        { v: a1, c: '#f43f5e' },
                        { v: a2, c: '#f59e0b' },
                        { v: aAir, c: '#38bdf8' }
                    ];
                    for (const d of dots) {
                        const dyDot = mapYToCanvas(d.v, plotTop, plotHeight, activeMinY, activeMaxY);
                        ctx.fillStyle = d.c;
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 1.4;
                        ctx.beginPath();
                        ctx.arc(snapX, dyDot, 4.2, 0, 2 * Math.PI);
                        ctx.fill();
                        ctx.stroke();
                    }
                } else {
                    ctx.fillStyle = chMeta.color || chartColor;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.6;
                    ctx.beginPath();
                    ctx.arc(snapX, snapY, 4.8, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.restore();

                const xUnit = xAxisMode === 'radius' ? 'm' : '';
                hoverReadout = selectedChannel === 4
                    ? ` • r = ${rCoord.toFixed(3)} ${xUnit}`
                    : ` • r = ${rCoord.toFixed(3)} ${xUnit} → ${formatSciNumber(cellVal)}${unitSuffix}`;

                // Rich glassmorphic hover tooltip card in Spatial Mode
                const lines: Array<{ text: string; color: string }> = [
                    { text: `📍 ${xAxisMode === 'radius' ? `r = ${rCoord.toFixed(4)} m (Cell #${cellIdx})` : `Cell #${cellIdx}`}  •  ${chMeta.name}`, color: '#38bdf8' }
                ];
                if (selectedChannel !== 4) {
                    lines.push({ text: `Cursor:   ${formatSciNumber(cellVal)}${unitSuffix}`, color: '#f8fafc' });
                }
                if (bufCells > 0 && bufCh >= 7 && cellIdx < bufCells) {
                    const pV = new Float32Array(lastBuffer!, 8, bufCells)[cellIdx];
                    const rhoV = new Float32Array(lastBuffer!, 8 + bufCells * 4, bufCells)[cellIdx];
                    const uV = new Float32Array(lastBuffer!, 8 + 2 * bufCells * 4, bufCells)[cellIdx];
                    const eV = new Float32Array(lastBuffer!, 8 + 3 * bufCells * 4, bufCells)[cellIdx];
                    const a1V = new Float32Array(lastBuffer!, 8 + 4 * bufCells * 4, bufCells)[cellIdx];
                    const a2V = new Float32Array(lastBuffer!, 8 + 5 * bufCells * 4, bufCells)[cellIdx];
                    const airV = new Float32Array(lastBuffer!, 8 + 6 * bufCells * 4, bufCells)[cellIdx];
                    lines.push({
                        text: `P = ${formatSciNumber(pV)} Pa  (ΔP = ${formatSciNumber(pV - 101325.0)} Pa)`,
                        color: '#cbd5e1'
                    });
                    lines.push({
                        text: `ρ = ${formatSciNumber(rhoV)} kg/m³  •  u_r = ${formatSciNumber(uV)} m/s  •  e = ${formatSciNumber(eV)} J/kg`,
                        color: '#94a3b8'
                    });
                    lines.push({
                        text: `α₁ = ${a1V.toFixed(3)}  •  α₂ = ${a2V.toFixed(3)}  •  Air = ${airV.toFixed(3)}`,
                        color: '#fda4af'
                    });
                }
                if (selectedChannel !== 4 && isFinite(spPeakVal) && isFinite(spTroughVal)) {
                    lines.push({
                        text: `▲ Peak:   ${formatSciNumber(spPeakVal)}${unitSuffix} @ ${xAxisMode === 'radius' ? spPeakX.toFixed(3) + ' m' : '#' + spPeakX}`,
                        color: '#fbbf24'
                    });
                    lines.push({
                        text: `▼ Trough: ${formatSciNumber(spTroughVal)}${unitSuffix} @ ${xAxisMode === 'radius' ? spTroughX.toFixed(3) + ' m' : '#' + spTroughX}`,
                        color: '#38bdf8'
                    });
                }

                ctx.save();
                ctx.font = "600 9.5px 'JetBrains Mono', monospace";
                let maxW = 0;
                for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l.text).width);
                const cardW = maxW + 18;
                const cardH = 10 + lines.length * 15;
                let cxCard = snapX + 14;
                let cyCard = hoverCanvasY - cardH - 10;
                if (cxCard + cardW > width - 8) cxCard = Math.max(8, snapX - cardW - 14);
                if (cyCard < 8) cyCard = Math.min(height - cardH - 8, hoverCanvasY + 14);

                ctx.fillStyle = 'rgba(11, 15, 25, 0.94)';
                ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
                ctx.lineWidth = 1;
                drawRoundedBox(cxCard, cyCard, cardW, cardH, 6);
                ctx.fill();
                ctx.stroke();

                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                for (let i = 0; i < lines.length; i++) {
                    ctx.fillStyle = lines[i].color;
                    ctx.fillText(lines[i].text, cxCard + 9, cyCard + 12 + i * 15);
                }
                ctx.restore();
            }
        }

        drawBoxZoomOverlay(plotLeft, plotTop, plotWidth, plotHeight);

        const zoomTag = (isZoomedX || isZoomedY) ? ' • [ZOOMED]' : '';
        ctx.save();
        ctx.font = "600 9.5px 'JetBrains Mono', monospace";
        ctx.fillStyle = theme === 'light' ? '#334155' : '#cbd5e1';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const cellsDesc = rawData && rawData.length > 0 ? ` • ${rawData.length} cells` : '';
        ctx.fillText(
            `${chMeta.name} [${chMeta.unit}]${cellsDesc} • [${formatSciNumber(activeMinY)}, ${formatSciNumber(activeMaxY)}]${zoomTag}${hoverReadout}`,
            plotLeft,
            Math.max(9, plotTop - 9)
        );
        ctx.restore();
    } catch (err) {
        console.error('ChartWorker rendering error:', err);
    }
}

self.onmessage = (event) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
        if (data.byteLength >= 4) {
            const magic = new DataView(data).getUint32(0, true);
            if (magic === 0x46454d33 || magic === 0x4d504d33 || magic === 0x43494c53 || magic === 0x4253544c || magic === 0x424f4253) {
                return;
            }
        }
        lastBuffer = data;
        rawData = extractChannel(data, selectedChannel);
        if (chartMode === 'spatial') {
            updateAutoScale();
            requestRender();
        }
        return;
    }

    if (data.type === 'setGaugeData') {
        if (Array.isArray(data.times)) gaugeTimes = data.times;
        if (Array.isArray(data.gauges) && data.gauges.length > 0) gauges = data.gauges;
        if (Array.isArray(data.values)) {
            gaugeValues = data.values;
            if ((!gauges || gauges.length === 0) && gaugeValues.length > 0) {
                gauges = gaugeValues.map((_: any, idx: number) => ({ id: `G${idx + 1}`, name: `G${idx + 1}` }));
            }
        } else if (Array.isArray(data.gauges_history) && data.gauges_history.length > 0) {
            if (!gauges || gauges.length === 0) {
                gauges = data.gauges_history.map((h: any, idx: number) => ({ id: h.id || `G${idx + 1}`, name: h.id || `G${idx + 1}` }));
            }
            gaugeValues = gauges.map((g, idx) => {
                const gid = String(g.id || g.name || `G${idx + 1}`);
                const gidLo = gid.toLowerCase();
                const match = data.gauges_history.find((h: any) => String(h.id || '').toLowerCase() === gidLo) || data.gauges_history[idx];
                return Array.isArray(match?.channel_values) ? match.channel_values : [];
            });
        } else if (data.values && typeof data.values === 'object') {
            const valMap = data.values as Record<string, number[][]>;
            const keys = Object.keys(valMap).filter(k => isNaN(Number(k)));
            if ((!gauges || gauges.length === 0) && keys.length > 0) {
                gauges = keys.map(k => ({ id: k, name: k }));
            }
            gaugeValues = gauges.map((g, idx) => {
                const gid = String(g.id || g.name || `G${idx + 1}`);
                const gidLo = gid.toLowerCase();
                if (valMap[gid]) return valMap[gid];
                const ciKey = keys.find(k => k.toLowerCase() === gidLo);
                if (ciKey && valMap[ciKey]) return valMap[ciKey];
                return valMap[String(idx)] || (keys[idx] ? valMap[keys[idx]] : []);
            });
        }
        if (typeof data.step === 'number') simStep = data.step;
        if (typeof data.time === 'number') simTime = data.time;
        if (typeof data.dt === 'number') simDt = data.dt;
        if (chartMode === 'gauges') {
            updateAutoScale();
            requestRender();
        }
        return;
    }

    if (data.type === 'clearData') {
        lastBuffer = null;
        rawData = null;
        gaugeTimes = [];
        gaugeValues = [];
        simStep = 0;
        simTime = 0;
        isZoomedX = false;
        isZoomedY = false;
        requestRender();
        return;
    }

    if (data.type === 'resetView') {
        isZoomedX = false;
        isZoomedY = false;
        updateAutoScale();
        requestRender();
        return;
    }

    if (data.type === 'zoom') {
        const factor = Number(data.factor) > 0 ? (1.0 / Number(data.factor)) : 0.85;
        const axis = data.axis || 'xy';
        const { activeMinX, activeMaxX, activeMinY, activeMaxY } = getActiveBounds();
        if (axis === 'x' || axis === 'xy') {
            const midX = 0.5 * (activeMinX + activeMaxX);
            const halfX = Math.max(1e-12, 0.5 * (activeMaxX - activeMinX) * factor);
            zoomMinX = midX - halfX;
            zoomMaxX = midX + halfX;
            isZoomedX = true;
        }
        if (axis === 'y' || axis === 'xy') {
            if (useLogScale && activeMaxY > 0) {
                const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
                const lMin = Math.log10(safeMin);
                const lMax = Math.log10(activeMaxY);
                const lMid = 0.5 * (lMin + lMax);
                const lHalf = Math.max(1e-6, 0.5 * (lMax - lMin) * factor);
                zoomMinY = Math.pow(10, lMid - lHalf);
                zoomMaxY = Math.pow(10, lMid + lHalf);
            } else {
                const midY = 0.5 * (activeMinY + activeMaxY);
                const halfY = Math.max(1e-12, 0.5 * (activeMaxY - activeMinY) * factor);
                zoomMinY = midY - halfY;
                zoomMaxY = midY + halfY;
            }
            isZoomedY = true;
            self.postMessage({ type: 'bounds', minY: zoomMinY, maxY: zoomMaxY, isZoomedX, isZoomedY });
        }
        requestRender();
        return;
    }

    if (data.type === 'mouseEvent') {
        const { event: mouseEvt, offsetX, offsetY, deltaY, shiftKey, altKey, button } = data;
        const { plotLeft, plotTop, plotWidth, plotHeight } = getPlotRect();

        if (plotWidth > 0 && plotHeight > 0) {
            const { activeMinX, activeMaxX, activeMinY, activeMaxY } = getActiveBounds();

            if (mouseEvt === 'mousedown') {
                isDragging = true;
                dragStartX = offsetX;
                dragStartY = offsetY;
                dragCurrX = offsetX;
                dragCurrY = offsetY;
                dragStartMinX = activeMinX;
                dragStartMaxX = activeMaxX;
                dragStartMinY = activeMinY;
                dragStartMaxY = activeMaxY;

                const onLeftGutter = offsetX < plotLeft;
                const onBottomGutter = offsetY > plotTop + plotHeight;
                if (shiftKey || button === 1 || button === 2 || interactionMode === 'boxZoom') {
                    dragAction = 'boxZoom';
                } else if (onLeftGutter) {
                    dragAction = 'panY';
                } else if (onBottomGutter) {
                    dragAction = 'panX';
                } else {
                    dragAction = 'pan';
                }
            } else if (mouseEvt === 'mousemove') {
                hoverCanvasX = offsetX;
                hoverCanvasY = offsetY;
                if (isDragging) {
                    dragCurrX = offsetX;
                    dragCurrY = offsetY;
                    const dxScreen = offsetX - dragStartX;
                    const dyScreen = offsetY - dragStartY;

                    if (dragAction === 'pan' || dragAction === 'panX') {
                        if (Math.abs(dxScreen) > 0.5 || isZoomedX) {
                            const rangeX = dragStartMaxX - dragStartMinX;
                            const dx = (dxScreen / plotWidth) * rangeX;
                            zoomMinX = dragStartMinX - dx;
                            zoomMaxX = dragStartMaxX - dx;
                            isZoomedX = true;
                        }
                    }
                    if (dragAction === 'panY' || (dragAction === 'pan' && (!autoScale || altKey))) {
                        if (Math.abs(dyScreen) > 0.5 || isZoomedY) {
                            if (useLogScale && dragStartMaxY > 0) {
                                const safeMin = Math.max(dragStartMaxY * 1e-6, dragStartMinY > 0 ? dragStartMinY : dragStartMaxY * 1e-6);
                                const lMin = Math.log10(safeMin);
                                const lMax = Math.log10(dragStartMaxY);
                                const dLog = (dyScreen / plotHeight) * (lMax - lMin);
                                zoomMinY = Math.pow(10, lMin + dLog);
                                zoomMaxY = Math.pow(10, lMax + dLog);
                            } else {
                                const rangeY = dragStartMaxY - dragStartMinY;
                                const dy = (dyScreen / plotHeight) * rangeY;
                                zoomMinY = dragStartMinY + dy;
                                zoomMaxY = dragStartMaxY + dy;
                            }
                            isZoomedY = true;
                            self.postMessage({ type: 'bounds', minY: zoomMinY, maxY: zoomMaxY, isZoomedX, isZoomedY });
                        }
                    } else if (autoScale) {
                        isZoomedY = false;
                        updateAutoScale();
                    }
                }
                requestRender();
            } else if (mouseEvt === 'mouseup') {
                if (isDragging && dragAction === 'boxZoom') {
                    const x0 = Math.max(plotLeft, Math.min(plotLeft + plotWidth, Math.min(dragStartX, dragCurrX)));
                    const x1 = Math.max(plotLeft, Math.min(plotLeft + plotWidth, Math.max(dragStartX, dragCurrX)));
                    const y0 = Math.max(plotTop, Math.min(plotTop + plotHeight, Math.min(dragStartY, dragCurrY)));
                    const y1 = Math.max(plotTop, Math.min(plotTop + plotHeight, Math.max(dragStartY, dragCurrY)));
                    if (x1 - x0 >= 6 && y1 - y0 >= 6) {
                        const newMinX = activeMinX + ((x0 - plotLeft) / plotWidth) * (activeMaxX - activeMinX);
                        const newMaxX = activeMinX + ((x1 - plotLeft) / plotWidth) * (activeMaxX - activeMinX);
                        const newMaxY = mapCanvasToY(y0, plotTop, plotHeight, activeMinY, activeMaxY);
                        const newMinY = mapCanvasToY(y1, plotTop, plotHeight, activeMinY, activeMaxY);
                        if (newMaxX > newMinX && (autoScale && !altKey ? true : newMaxY > newMinY)) {
                            zoomMinX = newMinX;
                            zoomMaxX = newMaxX;
                            isZoomedX = true;
                            if (autoScale && !altKey) {
                                isZoomedY = false;
                                updateAutoScale();
                            } else {
                                zoomMinY = newMinY;
                                zoomMaxY = newMaxY;
                                isZoomedY = true;
                                self.postMessage({ type: 'bounds', minY: zoomMinY, maxY: zoomMaxY, isZoomedX, isZoomedY });
                            }
                        }
                    }
                }
                isDragging = false;
                requestRender();
            } else if (mouseEvt === 'mouseleave') {
                if (!isDragging) {
                    hoverCanvasX = null;
                    hoverCanvasY = null;
                    requestRender();
                }
            } else if (mouseEvt === 'dblclick') {
                isZoomedX = false;
                isZoomedY = false;
                updateAutoScale();
                requestRender();
            } else if (mouseEvt === 'wheel') {
                const zoomFactor = deltaY > 0 ? 1.14 : 0.875;
                const onLeftGutter = offsetX < plotLeft;
                const onBottomGutter = offsetY > plotTop + plotHeight;

                // When autoScale is active, normal wheel inside plot zooms X and auto-fits Y to the visible X window.
                // Left Y-gutter wheel or Alt+Wheel manually zooms Y; if autoScale is off, wheel zooms both X and Y.
                const doZoomX = !onLeftGutter && !altKey;
                const doZoomY = onLeftGutter || altKey || (!autoScale && !onBottomGutter && !shiftKey);

                if (doZoomX) {
                    const pctX = Math.max(0, Math.min(1, (offsetX - plotLeft) / plotWidth));
                    const targetX = activeMinX + pctX * (activeMaxX - activeMinX);
                    const newRangeX = Math.max(1e-12, (activeMaxX - activeMinX) * zoomFactor);
                    zoomMinX = targetX - pctX * newRangeX;
                    zoomMaxX = zoomMinX + newRangeX;
                    isZoomedX = true;
                }

                if (doZoomY) {
                    const pctY = Math.max(0, Math.min(1, (plotTop + plotHeight - offsetY) / plotHeight));
                    if (useLogScale && activeMaxY > 0) {
                        const safeMin = Math.max(activeMaxY * 1e-6, activeMinY > 0 ? activeMinY : activeMaxY * 1e-6);
                        const lMin = Math.log10(safeMin);
                        const lMax = Math.log10(activeMaxY);
                        const targetL = lMin + pctY * (lMax - lMin);
                        const newSpanL = Math.max(1e-6, (lMax - lMin) * zoomFactor);
                        zoomMinY = Math.pow(10, targetL - pctY * newSpanL);
                        zoomMaxY = Math.pow(10, targetL + (1 - pctY) * newSpanL);
                    } else {
                        const targetY = activeMinY + pctY * (activeMaxY - activeMinY);
                        const newRangeY = Math.max(1e-12, (activeMaxY - activeMinY) * zoomFactor);
                        zoomMinY = targetY - pctY * newRangeY;
                        zoomMaxY = zoomMinY + newRangeY;
                    }
                    isZoomedY = true;
                    self.postMessage({ type: 'bounds', minY: zoomMinY, maxY: zoomMaxY, isZoomedX, isZoomedY });
                } else if (autoScale) {
                    isZoomedY = false;
                    updateAutoScale();
                }

                requestRender();
            }
        }
        return;
    }

    if (data.type === 'init') {
        canvas = data.canvas as OffscreenCanvas;
        dpr = Number(data.dpr) || (typeof self !== 'undefined' && (self as any).devicePixelRatio) || 1;
        width  = Number(data.width) || canvas.width || 400;
        height = Number(data.height) || canvas.height || 300;
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        applyTransform();
        requestRender();
        return;
    }

    if (data.type === 'resize' && canvas && ctx) {
        const nextW = Number(data.width);
        const nextH = Number(data.height);
        if (isFinite(nextW) && nextW > 0 && isFinite(nextH) && nextH > 0) {
            width  = nextW;
            height = nextH;
            canvas.width  = Math.round(width  * dpr);
            canvas.height = Math.round(height * dpr);
            applyTransform();
            requestRender();
        }
        return;
    }

    if (data.type === 'setConfig') {
        if (data.chartMode === 'spatial' || data.chartMode === 'gauges') {
            if (data.chartMode !== chartMode) {
                chartMode = data.chartMode;
                isZoomedX = false;
                isZoomedY = false;
            }
        }
        if (data.interactionMode === 'pan' || data.interactionMode === 'boxZoom') {
            interactionMode = data.interactionMode;
        }
        if (data.color)                              chartColor = data.color;
        if (typeof data.autoScale === 'boolean') {
            autoScale = data.autoScale;
            if (autoScale && data.resetZoomY !== false) {
                isZoomedY = false;
            }
        }
        if (typeof data.logScale === 'boolean')      useLogScale = data.logScale;
        if (typeof data.showAxes === 'boolean')      showAxes = data.showAxes;
        if (typeof data.showGrid === 'boolean')      showGrid = data.showGrid;
        if (typeof data.showCharge === 'boolean')    showCharge = data.showCharge;
        if (typeof data.showDetonator === 'boolean') showDetonator = data.showDetonator;
        if (typeof data.showGauges === 'boolean')    showGauges = data.showGauges;
        if (typeof data.showPeaks === 'boolean')     showPeaks = data.showPeaks;
        if (typeof data.showCanvasLegend === 'boolean') showCanvasLegend = data.showCanvasLegend;
        if (data.theme === 'dark' || data.theme === 'slate' || data.theme === 'light') theme = data.theme;
        if (Array.isArray(data.clearColor) && data.clearColor.length === 3) {
            clearBgRgb = [
                Math.round(Number(data.clearColor[0]) * 255),
                Math.round(Number(data.clearColor[1]) * 255),
                Math.round(Number(data.clearColor[2]) * 255)
            ];
        } else if (data.clearColor === null) {
            clearBgRgb = null;
        }
        if (data.xAxisMode)                          xAxisMode = data.xAxisMode;
        if (typeof data.domainRadius === 'number' && data.domainRadius > 0) domainRadius = data.domainRadius;
        if (typeof data.chargeRadius === 'number')   chargeRadius = data.chargeRadius;
        if (typeof data.remapRadius === 'number')    remapRadius = data.remapRadius;
        if (data.detonatorR !== undefined)           detonatorR = data.detonatorR;
        if (Array.isArray(data.gauges))              gauges = data.gauges;
        if (typeof data.selectedProbe === 'number')  selectedProbe = data.selectedProbe;
        if (Array.isArray(data.hiddenProbes))        hiddenProbes = new Set(data.hiddenProbes.map((n: any) => Number(n)));
        if (typeof data.hoveredProbe === 'number')   hoveredProbe = data.hoveredProbe;
        if (typeof data.step === 'number')           simStep = data.step;
        if (typeof data.time === 'number')           simTime = data.time;
        if (typeof data.dt === 'number')             simDt = data.dt;

        const minCand = typeof data.min === 'number' ? data.min : (typeof data.minVal === 'number' ? data.minVal : undefined);
        const maxCand = typeof data.max === 'number' ? data.max : (typeof data.maxVal === 'number' ? data.maxVal : undefined);
        if (!autoScale) {
            if (minCand !== undefined && isFinite(minCand)) {
                displayMin = minCand;
                isZoomedY = false;
            }
            if (maxCand !== undefined && isFinite(maxCand)) {
                displayMax = maxCand;
                isZoomedY = false;
            }
        }
        range = displayMax - displayMin || 1;

        if (typeof data.channel === 'number' && data.channel !== selectedChannel) {
            selectedChannel = data.channel;
            isZoomedY = false;
            if (lastBuffer) {
                rawData = extractChannel(lastBuffer, selectedChannel);
            }
        }
        updateAutoScale();
        requestRender();
        return;
    }

    const isTelemetryEvent =
        data.type === 'telemetry' || data.type === 'TELEMETRY' ||
        data.type === 'frame'    || data.type === 'data';
    if (isTelemetryEvent) {
        const pressureData = data.data || data.telemetry;
        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
            rawData = new Float32Array(pressureData);
            updateAutoScale();
            requestRender();
        }
    }
};
