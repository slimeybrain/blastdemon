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
    constructor(maxFrames: number = 1000, maxMemoryMB: number = 512) {
        this.maxFrames = Math.max(10, maxFrames);
        this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    }

    /**
     * Store a binary telemetry frame in the ring buffer.
     * Automatically clones the ArrayBuffer to decouple it from network/worker transfers.
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
        const isFEM = magic === 0x46454d33; // 'FEM3'
        const isSlice = magic === 0x43494c53; // 'SLIC'

        // Check if this payload should merge into the existing lastRecordedFrame
        // (i.e. arriving within the same simulation tick / frame batch for the same model)
        const sameModel = !meta.modelId || !this.lastRecordedFrame?.modelId || this.lastRecordedFrame.modelId === meta.modelId;
        const sameStep = meta.step !== undefined && this.lastRecordedFrame && this.lastRecordedFrame.step === meta.step;
        const withinBatch = timeSinceLast < 60;

        if (this.lastRecordedFrame && this.frames.length > 0 && sameModel && (sameStep || withinBatch)) {
            let updated = false;
            if (isMPM) {
                const cloned = rawBuffer.slice(0);
                const prevSize = this.lastRecordedFrame.mpmBuffer ? this.lastRecordedFrame.mpmBuffer.byteLength : 0;
                this.lastRecordedFrame.mpmBuffer = cloned;
                if (!this.lastRecordedFrame.buffer || this.lastRecordedFrame.buffer.byteLength === 0) {
                    this.lastRecordedFrame.buffer = cloned;
                }
                const diff = cloned.byteLength - prevSize;
                this.lastRecordedFrame.byteSize += diff;
                this.currentMemoryBytes += diff;
                updated = true;
            } else if (isFEM) {
                const cloned = rawBuffer.slice(0);
                const prevSize = this.lastRecordedFrame.femBuffer ? this.lastRecordedFrame.femBuffer.byteLength : 0;
                this.lastRecordedFrame.femBuffer = cloned;
                if (!this.lastRecordedFrame.buffer || this.lastRecordedFrame.buffer.byteLength === 0) {
                    this.lastRecordedFrame.buffer = cloned;
                }
                const diff = cloned.byteLength - prevSize;
                this.lastRecordedFrame.byteSize += diff;
                this.currentMemoryBytes += diff;
                updated = true;
            } else if (isSlice) {
                const cloned = rawBuffer.slice(0);
                const prevSize = this.lastRecordedFrame.sliceBuffer ? this.lastRecordedFrame.sliceBuffer.byteLength : 0;
                this.lastRecordedFrame.sliceBuffer = cloned;
                this.lastRecordedFrame.buffer = cloned;
                const diff = cloned.byteLength - prevSize;
                this.lastRecordedFrame.byteSize += diff;
                this.currentMemoryBytes += diff;
                updated = true;
            }

            if (updated) {
                if (meta.step !== undefined) this.lastRecordedFrame.step = meta.step;
                if (meta.time !== undefined) this.lastRecordedFrame.time = meta.time;
                if (meta.metrics) this.lastRecordedFrame.metrics = { ...this.lastRecordedFrame.metrics, ...meta.metrics };
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

        // At high streaming frequencies for identical single-modality streams, avoid cloning buffers faster than 30 FPS (~33ms)
        if (!isStepZero && timeSinceLast < 32 && this.lastRecordedFrame && this.frames.length > 0 && sameModel && !isMPM && !isFEM) {
            if (meta.step !== undefined) this.lastRecordedFrame.step = meta.step;
            if (meta.time !== undefined) this.lastRecordedFrame.time = meta.time;
            if (meta.metrics) this.lastRecordedFrame.metrics = { ...this.lastRecordedFrame.metrics, ...meta.metrics };
            return this.lastRecordedFrame;
        }

        this.lastRecordedTimestamp = now;

        // Clone buffer to retain independent memory
        const clonedBuffer = rawBuffer.slice(0);
        const byteSize = clonedBuffer.byteLength;

        // Auto-extract step/time from binary header if not provided in meta
        let step = meta.step ?? 0;
        let time = meta.time ?? 0;

        if (meta.step === undefined || meta.time === undefined) {
            const parsed = this.parseBinaryHeader(clonedBuffer);
            if (parsed) {
                if (meta.step === undefined) step = parsed.step;
                if (meta.time === undefined) time = parsed.time;
            }
        }

        const frameIndex = this.frames.length > 0 ? this.frames[this.frames.length - 1].index + 1 : 0;

        const frame: BufferedFrame = {
            index: frameIndex,
            step,
            time,
            modelId: meta.modelId,
            buffer: clonedBuffer,
            sliceBuffer: isSlice ? clonedBuffer : undefined,
            mpmBuffer: isMPM ? clonedBuffer : undefined,
            femBuffer: isFEM ? clonedBuffer : undefined,
            metrics: meta.metrics || {},
            timestamp: now,
            byteSize
        };

        // Enforce capacity and memory bounds
        while (
            this.frames.length >= this.maxFrames ||
            (this.frames.length > 1 && this.currentMemoryBytes + byteSize > this.maxMemoryBytes)
        ) {
            const evicted = this.frames.shift();
            if (evicted) {
                this.currentMemoryBytes -= evicted.byteSize;
            }
        }

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
                return { step: 0, time: Number.isFinite(time) ? time : 0 };
            } else if (magic === 0x4d504d33) { // 'MPM3' (3D MPM Particles)
                const time = dataView.getFloat32(4, true);
                return { step: 0, time: Number.isFinite(time) ? time : 0 };
            } else if (magic === 0x46454d33) { // 'FEM3' (3D FEM Mesh)
                const time = dataView.getFloat32(4, true);
                return { step: 0, time: Number.isFinite(time) ? time : 0 };
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
        if (this.frames.length === 0) return null;
        if (!modelId) return this.frames[this.frames.length - 1];
        for (let i = this.frames.length - 1; i >= 0; i--) {
            if (this.frames[i].modelId === modelId) {
                return this.frames[i];
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
        this.maxFrames = Math.max(10, max);
        while (this.frames.length > this.maxFrames) {
            const evicted = this.frames.shift();
            if (evicted) this.currentMemoryBytes -= evicted.byteSize;
        }
    }

    /**
     * Clear all frames and reset memory tracking.
     */
    public clear(): void {
        this.frames = [];
        this.currentMemoryBytes = 0;
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
        const pct = (this.currentMemoryBytes / this.maxMemoryBytes) * 100.0;
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
