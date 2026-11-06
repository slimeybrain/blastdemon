/**
 * BlastDaemon PlaybackRingBuffer
 * High-performance client-side in-memory telemetry frame cache enabling 60 FPS
 * non-blocking scrubbing, reverse playback, and time transport synchronization.
 */

export interface BufferedFrame {
    index: number;
    step: number;
    time: number;
    modelId?: string;
    buffer: ArrayBuffer;
    sliceBuffer?: ArrayBuffer;
    mpmBuffer?: ArrayBuffer;
    phaseParticlesBuffer?: ArrayBuffer;
    femBuffer?: ArrayBuffer;
    metrics?: {
        dt?: number;
        maxPressure?: number;
        maxVelocity?: number;
        maxTemperature?: number;
        totalEnergy?: number;
        particlesCount?: number;
        elementsCount?: number;
        [key: string]: any;
    };
    timestamp: number;
    byteSize: number;
}

export class PlaybackRingBuffer {
    private frames: BufferedFrame[] = [];
    private maxFrames: number;
    private maxMemoryBytes: number;
    private currentMemoryBytes: number = 0;
    private listeners: ((frame: BufferedFrame, count: number) => void)[] = [];
    private lastRecordedTimestamp: number = 0;
    private lastRecordedFrame: BufferedFrame | null = null;

    /**
     * @param maxFrames Maximum number of frames to store in the ring buffer (default: 1000)
     * @param maxMemoryMB Maximum memory limit in Megabytes before evicting earliest frames (default: 512 MB)
     */
    constructor(maxFrames: number = 1, maxMemoryMB: number = 0) {
        this.maxFrames = Math.max(1, maxFrames);
        this.maxMemoryBytes = Math.max(0, maxMemoryMB * 1024 * 1024);
    }

    /**
     * Store a binary telemetry frame in the ring buffer.
     * When history caching is disabled (maxFrames <= 1 or maxMemoryBytes === 0), avoids cloning
     * ArrayBuffers and retains only a single transient frame reference.
     */
    public addFrame(
        rawBuffer: ArrayBuffer,
        meta: { step?: number; time?: number; modelId?: string; metrics?: any } = {}
    ): BufferedFrame {
        const now = performance.now();
        const isStepZero = meta.step === 0;
        const timeSinceLast = now - this.lastRecordedTimestamp;
        const magic = rawBuffer.byteLength >= 4 ? new DataView(rawBuffer).getUint32(0, true) : 0;
        const isMPM = magic === 0x4d504d33; // 'MPM3'
        const isPhase = magic === 0x50545033; // 'PTP3'
        const isFEM = magic === 0x46454d33; // 'FEM3'
        const isSlice = magic === 0x43494c53; // 'SLIC'
        const isHistoryEnabled = this.maxFrames > 1 && this.maxMemoryBytes > 0;

        // Check if this payload should merge into the existing lastRecordedFrame
        // (i.e. arriving within the same simulation tick / frame batch for the same model)
        const sameModel = meta.modelId ? (this.lastRecordedFrame?.modelId === meta.modelId) : (!this.lastRecordedFrame?.modelId);
        const sameStep = meta.step !== undefined && this.lastRecordedFrame && this.lastRecordedFrame.step === meta.step;
        const withinBatch = timeSinceLast < 60;

        if (this.lastRecordedFrame && this.frames.length > 0 && sameModel && (sameStep || withinBatch || !isHistoryEnabled)) {
            let updated = false;
            let diff = 0;
            if (isMPM) {
                const prevSize = this.lastRecordedFrame.mpmBuffer ? this.lastRecordedFrame.mpmBuffer.byteLength : 0;
                diff = rawBuffer.byteLength - prevSize;
                while (diff > 0 && this.frames.length > 1 && this.currentMemoryBytes + diff > this.maxMemoryBytes) {
                    const evicted = this.frames.shift();
                    if (evicted) this.currentMemoryBytes -= evicted.byteSize;
                }
                const stored = isHistoryEnabled ? rawBuffer.slice(0) : rawBuffer;
                this.lastRecordedFrame.mpmBuffer = stored;
                this.lastRecordedFrame.buffer = stored;
                if (!isHistoryEnabled) {
                    this.lastRecordedFrame.sliceBuffer = undefined;
                    this.lastRecordedFrame.phaseParticlesBuffer = undefined;
                    this.lastRecordedFrame.femBuffer = undefined;
                }
                this.lastRecordedFrame.byteSize = Math.max(0, this.lastRecordedFrame.byteSize + diff);
                this.currentMemoryBytes = isHistoryEnabled ? Math.max(0, this.currentMemoryBytes + diff) : 0;
                updated = true;
            } else if (isPhase) {
                const prevSize = this.lastRecordedFrame.phaseParticlesBuffer ? this.lastRecordedFrame.phaseParticlesBuffer.byteLength : 0;
                diff = rawBuffer.byteLength - prevSize;
                while (diff > 0 && this.frames.length > 1 && this.currentMemoryBytes + diff > this.maxMemoryBytes) {
                    const evicted = this.frames.shift();
                    if (evicted) this.currentMemoryBytes -= evicted.byteSize;
                }
                const stored = isHistoryEnabled ? rawBuffer.slice(0) : rawBuffer;
                this.lastRecordedFrame.phaseParticlesBuffer = stored;
                this.lastRecordedFrame.buffer = stored;
                if (!isHistoryEnabled) {
                    this.lastRecordedFrame.sliceBuffer = undefined;
                    this.lastRecordedFrame.mpmBuffer = undefined;
                    this.lastRecordedFrame.femBuffer = undefined;
                }
                this.lastRecordedFrame.byteSize = Math.max(0, this.lastRecordedFrame.byteSize + diff);
                this.currentMemoryBytes = isHistoryEnabled ? Math.max(0, this.currentMemoryBytes + diff) : 0;
                updated = true;
            } else if (isFEM) {
                const prevSize = this.lastRecordedFrame.femBuffer ? this.lastRecordedFrame.femBuffer.byteLength : 0;
                diff = rawBuffer.byteLength - prevSize;
                while (diff > 0 && this.frames.length > 1 && this.currentMemoryBytes + diff > this.maxMemoryBytes) {
                    const evicted = this.frames.shift();
                    if (evicted) this.currentMemoryBytes -= evicted.byteSize;
                }
                const stored = isHistoryEnabled ? rawBuffer.slice(0) : rawBuffer;
                this.lastRecordedFrame.femBuffer = stored;
                this.lastRecordedFrame.buffer = stored;
                if (!isHistoryEnabled) {
                    this.lastRecordedFrame.sliceBuffer = undefined;
                    this.lastRecordedFrame.mpmBuffer = undefined;
                    this.lastRecordedFrame.phaseParticlesBuffer = undefined;
                }
                this.lastRecordedFrame.byteSize = Math.max(0, this.lastRecordedFrame.byteSize + diff);
                this.currentMemoryBytes = isHistoryEnabled ? Math.max(0, this.currentMemoryBytes + diff) : 0;
                updated = true;
            } else if (isSlice) {
                const prevSize = this.lastRecordedFrame.sliceBuffer ? this.lastRecordedFrame.sliceBuffer.byteLength : 0;
                diff = rawBuffer.byteLength - prevSize;
                while (diff > 0 && this.frames.length > 1 && this.currentMemoryBytes + diff > this.maxMemoryBytes) {
                    const evicted = this.frames.shift();
                    if (evicted) this.currentMemoryBytes -= evicted.byteSize;
                }
                const stored = isHistoryEnabled ? rawBuffer.slice(0) : rawBuffer;
                this.lastRecordedFrame.sliceBuffer = stored;
                this.lastRecordedFrame.buffer = stored;
                if (!isHistoryEnabled) {
                    this.lastRecordedFrame.mpmBuffer = undefined;
                    this.lastRecordedFrame.phaseParticlesBuffer = undefined;
                    this.lastRecordedFrame.femBuffer = undefined;
                }
                this.lastRecordedFrame.byteSize = Math.max(0, this.lastRecordedFrame.byteSize + diff);
                this.currentMemoryBytes = isHistoryEnabled ? Math.max(0, this.currentMemoryBytes + diff) : 0;
                updated = true;
            } else if (!isHistoryEnabled) {
                this.lastRecordedFrame.buffer = rawBuffer;
                this.lastRecordedFrame.sliceBuffer = undefined;
                this.lastRecordedFrame.mpmBuffer = undefined;
                this.lastRecordedFrame.phaseParticlesBuffer = undefined;
                this.lastRecordedFrame.femBuffer = undefined;
                this.lastRecordedFrame.byteSize = rawBuffer.byteLength;
                this.currentMemoryBytes = 0;
                updated = true;
            }

            if (updated) {
                this.lastRecordedTimestamp = now;
                if (meta.step !== undefined && (meta.step > 0 || !this.lastRecordedFrame.step)) {
                    this.lastRecordedFrame.step = meta.step;
                }
                if (meta.time !== undefined && (meta.time > 0 || !this.lastRecordedFrame.time)) {
                    this.lastRecordedFrame.time = meta.time;
                }
                if (meta.metrics) {
                    const dt = (meta.metrics.dt !== undefined && meta.metrics.dt > 0) ? meta.metrics.dt : this.lastRecordedFrame.metrics?.dt;
                    this.lastRecordedFrame.metrics = { ...this.lastRecordedFrame.metrics, ...meta.metrics, ...(dt !== undefined ? { dt } : {}) };
                }
                // Notify listeners of updated multi-modal frame contents
                for (const cb of this.listeners) {
                    try {
                        cb(this.lastRecordedFrame, this.frames.length);
                    } catch (err) {
                        console.error("[PlaybackRingBuffer] Listener error:", err);
                    }
                }
                return this.lastRecordedFrame;
            }
        }

        this.lastRecordedTimestamp = now;

        const rawByteSize = rawBuffer.byteLength;
        // Pre-evict old frames before allocating clone to respect memory bounds and protect JS heap
        while (
            this.frames.length >= this.maxFrames ||
            (this.frames.length > 0 && (!isHistoryEnabled || (this.frames.length > 1 && this.currentMemoryBytes + rawByteSize > this.maxMemoryBytes)))
        ) {
            const evicted = this.frames.shift();
            if (evicted) {
                this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - evicted.byteSize);
            }
        }

        // Only clone buffer if multi-frame history is enabled
        const storedBuffer = isHistoryEnabled ? rawBuffer.slice(0) : rawBuffer;
        const byteSize = isHistoryEnabled ? storedBuffer.byteLength : 0;

        // Auto-extract step/time from binary header if not provided in meta
        let step = meta.step ?? 0;
        let time = meta.time ?? 0;

        if (meta.step === undefined || meta.time === undefined) {
            const parsed = this.parseBinaryHeader(storedBuffer);
            if (parsed) {
                if (meta.step === undefined) step = parsed.step;
                if (meta.time === undefined) time = parsed.time;
            }
        }

        // If step or time was unresolved or 0, preserve previous frame values for the same model if available
        if (step === 0 && this.lastRecordedFrame && this.lastRecordedFrame.step > 0 && sameModel) {
            step = this.lastRecordedFrame.step;
        }
        if (time === 0 && this.lastRecordedFrame && this.lastRecordedFrame.time > 0 && sameModel) {
            time = this.lastRecordedFrame.time;
        }

        const metrics = { ...(this.lastRecordedFrame?.metrics || {}), ...(meta.metrics || {}) };
        if (metrics.dt === undefined || metrics.dt <= 0) {
            const lastDt = this.lastRecordedFrame?.metrics?.dt;
            if (typeof lastDt === 'number' && lastDt > 0 && sameModel) {
                metrics.dt = lastDt;
            }
        }

        const frameIndex = this.frames.length > 0 ? this.frames[this.frames.length - 1].index + 1 : 0;

        const frame: BufferedFrame = {
            index: frameIndex,
            step,
            time,
            modelId: meta.modelId,
            buffer: storedBuffer,
            sliceBuffer: isSlice ? storedBuffer : undefined,
            mpmBuffer: isMPM ? storedBuffer : undefined,
            phaseParticlesBuffer: isPhase ? storedBuffer : undefined,
            femBuffer: isFEM ? storedBuffer : undefined,
            metrics,
            timestamp: now,
            byteSize
        };

        this.frames.push(frame);
        this.currentMemoryBytes += byteSize;
        this.lastRecordedFrame = frame;

        // Notify listeners of new frame arrival
        for (const cb of this.listeners) {
            try {
                cb(frame, this.frames.length);
            } catch (err) {
                console.error("[PlaybackRingBuffer] Listener error:", err);
            }
        }

        return frame;
    }

    /**
     * Inspect binary buffer header to parse step and physical time.
     * BlastDaemon standard binary frame format starts with magic/header integers and doubles.
     */
    private parseBinaryHeader(buffer: ArrayBuffer): { step: number; time: number } | null {
        if (buffer.byteLength < 8) return null;
        try {
            const dataView = new DataView(buffer);
            const magic = dataView.getUint32(0, true);
            if (magic === 0x424C5354) { // 'BLST'
                const step = dataView.getUint32(4, true);
                const time = dataView.getFloat64(8, true);
                return { step, time };
            } else if (magic === 0x43494c53) { // 'SLIC' (3D Slices)
                const time = dataView.getFloat32(4, true);
                const step = (this.lastRecordedFrame && this.lastRecordedFrame.step > 0) ? this.lastRecordedFrame.step : 0;
                return { step, time: Number.isFinite(time) ? time : 0 };
            } else if (magic === 0x4d504d33) { // 'MPM3' (3D MPM Particles)
                const time = dataView.getFloat32(4, true);
                const step = (this.lastRecordedFrame && this.lastRecordedFrame.step > 0) ? this.lastRecordedFrame.step : 0;
                return { step, time: Number.isFinite(time) ? time : 0 };
            } else if (magic === 0x50545033) { // 'PTP3' (Phase Tracking Particles)
                const time = dataView.getFloat32(4, true);
                const step = (this.lastRecordedFrame && this.lastRecordedFrame.step > 0) ? this.lastRecordedFrame.step : 0;
                return { step, time: Number.isFinite(time) ? time : 0 };
            } else if (magic === 0x46454d33) { // 'FEM3' (3D FEM Mesh)
                const time = dataView.getFloat32(4, true);
                const step = (this.lastRecordedFrame && this.lastRecordedFrame.step > 0) ? this.lastRecordedFrame.step : 0;
                return { step, time: Number.isFinite(time) ? time : 0 };
            } else {
                // Fallback: heuristic header parsing
                const step = dataView.getUint32(0, true);
                const time = dataView.getFloat32(4, true);
                if (Number.isFinite(time) && time >= 0 && time < 1e6 && step < 1e7) {
                    return { step, time };
                }
            }
        } catch {
            // Ignore parse failures
        }
        return null;
    }

    /**
     * Get frame by internal ring buffer index (0 to count-1).
     */
    public getFrame(index: number): BufferedFrame | null {
        if (index < 0 || index >= this.frames.length) return null;
        return this.frames[index];
    }

    /**
     * Get the latest recorded frame.
     */
    public getLatestFrame(): BufferedFrame | null {
        if (this.frames.length === 0) return null;
        return this.frames[this.frames.length - 1];
    }

    /**
     * Get the earliest recorded frame in the buffer.
     */
    public getEarliestFrame(): BufferedFrame | null {
        if (this.frames.length === 0) return null;
        return this.frames[0];
    }

    /**
     * Binary search to find the closest frame matching or preceding a given solver step.
     */
    public getFrameByStep(targetStep: number): BufferedFrame | null {
        if (this.frames.length === 0) return null;
        if (targetStep <= this.frames[0].step) return this.frames[0];
        if (targetStep >= this.frames[this.frames.length - 1].step) return this.frames[this.frames.length - 1];

        let low = 0;
        let high = this.frames.length - 1;
        let bestIdx = 0;

        while (low <= high) {
            const mid = (low + high) >> 1;
            const s = this.frames[mid].step;
            if (s === targetStep) return this.frames[mid];
            if (s < targetStep) {
                bestIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return this.frames[bestIdx];
    }

    /**
     * Binary search to find the closest frame matching or preceding a physical simulation time `t`.
     */
    public getFrameByTime(targetTime: number): BufferedFrame | null {
        if (this.frames.length === 0) return null;
        if (targetTime <= this.frames[0].time) return this.frames[0];
        if (targetTime >= this.frames[this.frames.length - 1].time) return this.frames[this.frames.length - 1];

        let low = 0;
        let high = this.frames.length - 1;
        let bestIdx = 0;

        while (low <= high) {
            const mid = (low + high) >> 1;
            const t = this.frames[mid].time;
            if (Math.abs(t - targetTime) < 1e-12) return this.frames[mid];
            if (t < targetTime) {
                bestIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return this.frames[bestIdx];
    }

    /**
     * Get the latest recorded frame for a specific model (or globally if modelId is unspecified).
     */
    public getLatestFrameForModel(modelId?: string | null): BufferedFrame | null {
        if (this.frames.length === 0 || !modelId) return null;
        for (let i = this.frames.length - 1; i >= 0; i--) {
            if (this.frames[i].modelId === modelId) {
                return this.frames[i];
            }
        }
        return null;
    }

    /**
     * Get the latest recorded FEM3 binary mesh buffer for a model (or across any model).
     */
    public getLatestFEMBuffer(modelId?: string | null): ArrayBuffer | null {
        if (this.frames.length === 0) return null;
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const f = this.frames[i];
            if ((!modelId || f.modelId === modelId) && f.femBuffer && f.femBuffer.byteLength >= 24) {
                return f.femBuffer;
            }
        }
        // Fallback: check all frames if modelId was specified but had no FEM frame specifically tagged
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const buf = this.frames[i]?.femBuffer;
            if (buf && buf.byteLength >= 24) {
                return buf;
            }
        }
        return null;
    }

    /**
     * Get total number of stored frames in the buffer.
     */
    public getFrameCount(): number {
        return this.frames.length;
    }

    /**
     * Get current maximum capacity.
     */
    public getMaxFrames(): number {
        return this.maxFrames;
    }

    /**
     * Update capacity.
     */
    public setMaxFrames(max: number): void {
        this.maxFrames = Math.max(1, max);
        while (this.frames.length > this.maxFrames) {
            const evicted = this.frames.shift();
            if (evicted) this.currentMemoryBytes = Math.max(0, this.currentMemoryBytes - evicted.byteSize);
        }
    }

    /**
     * Clear frames and reset memory tracking (either globally or for a specific model).
     */
    public clear(modelId?: string): void {
        if (!modelId) {
            this.frames = [];
            this.currentMemoryBytes = 0;
            this.lastRecordedFrame = null;
            this.lastRecordedTimestamp = 0;
        } else {
            this.frames = this.frames.filter(f => f.modelId !== modelId);
            this.currentMemoryBytes = this.frames.reduce((sum, f) => sum + f.byteSize, 0);
            if (this.lastRecordedFrame && this.lastRecordedFrame.modelId === modelId) {
                this.lastRecordedFrame = this.frames.length > 0 ? this.frames[this.frames.length - 1] : null;
            }
        }
    }

    /**
     * Get physical time and step bounds across the entire recorded history.
     */
    public getTimeRange(): { minTime: number; maxTime: number; minStep: number; maxStep: number } {
        if (this.frames.length === 0) {
            return { minTime: 0, maxTime: 0, minStep: 0, maxStep: 0 };
        }
        return {
            minTime: this.frames[0].time,
            maxTime: this.frames[this.frames.length - 1].time,
            minStep: this.frames[0].step,
            maxStep: this.frames[this.frames.length - 1].step
        };
    }

    /**
     * Get current memory footprint in bytes and megabytes.
     */
    public getMemoryUsage(): { bytes: number; megabytes: number; percentLimit: number } {
        const mb = this.currentMemoryBytes / (1024 * 1024);
        const pct = this.maxMemoryBytes > 0 ? (this.currentMemoryBytes / this.maxMemoryBytes) * 100.0 : 0.0;
        return {
            bytes: this.currentMemoryBytes,
            megabytes: Math.round(mb * 100) / 100,
            percentLimit: Math.min(100.0, Math.round(pct * 10) / 10)
        };
    }

    /**
     * Register a callback fired whenever a new frame is appended.
     */
    public onFrameAdded(callback: (frame: BufferedFrame, count: number) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    }

    /**
     * Export lightweight metadata index JSON.
     */
    public exportSummaryJSON(): string {
        const summary = {
            frameCount: this.frames.length,
            timeRange: this.getTimeRange(),
            memoryMB: this.getMemoryUsage().megabytes,
            steps: this.frames.map(f => ({ step: f.step, time: f.time, bytes: f.byteSize }))
        };
        return JSON.stringify(summary, null, 2);
    }
}
