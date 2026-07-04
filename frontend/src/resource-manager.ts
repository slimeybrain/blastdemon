import { StateManager } from './state-manager.js';

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class ResourceManager {
    public container: HTMLElement;
    private stateManager: StateManager;
    private panelId: string;

    private history = {
        cpu: [] as number[],
        ram: [] as number[],
        gpu: [] as number[],
        vram: [] as number[],
        temp: [] as number[]
    };
    private historyLimit = 60; // 30 seconds of history at 500ms intervals

    private smoothed = {
        cpu: 0,
        ram_pct: 0,
        gpu: 0,
        vram_pct: 0,
        temp: 0
    };
    private alpha = 0.2; // Exponential moving average smoothing factor

    constructor(container: HTMLElement, stateManager: StateManager, panelId: string) {
        if (!container) {
            throw new Error("[RESOURCE MANAGER] Initialization failed: Target container is undefined.");
        }

        this.stateManager = stateManager;
        this.panelId = panelId;

        this.container = document.createElement('div');
        this.container.className = 'resource-grid';
        container.appendChild(this.container);

        this.initUI();
    }

    public destroy(): void {
        this.container.remove();
    }

    private initUI(): void {
        this.container.innerHTML = `
        <!-- CPU Card -->
        <div class="resource-card" id="${this.panelId}-card-cpu">
            <div class="resource-label">CPU UTILIZATION</div>
            <div class="meter-container">
                <svg class="meter-svg" width="80" height="80" viewBox="0 0 80 80">
                    <circle class="meter-bg" cx="40" cy="40" r="32"></circle>
                    <circle class="meter-fill" id="${this.panelId}-cpu-fill" cx="40" cy="40" r="32" stroke-dasharray="201.06" stroke-dashoffset="201.06" style="stroke: #3b82f6;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-cpu-val">0%</div>
            </div>
            <div class="sparkline-container" style="width: 100%; height: 50px; background: #0b0b0e; margin-top: 10px; border-radius: 3px; overflow: hidden; border: 1px solid #222;">
                <canvas class="sparkline-canvas" id="${this.panelId}-cpu-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
            </div>
        </div>

        <!-- RAM Card -->
        <div class="resource-card" id="${this.panelId}-card-ram">
            <div class="resource-label">RAM ALLOCATION</div>
            <div class="meter-container">
                <svg class="meter-svg" width="80" height="80" viewBox="0 0 80 80">
                    <circle class="meter-bg" cx="40" cy="40" r="32"></circle>
                    <circle class="meter-fill" id="${this.panelId}-ram-fill" cx="40" cy="40" r="32" stroke-dasharray="201.06" stroke-dashoffset="201.06" style="stroke: #10b981;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-ram-val" style="font-size: 10px; font-weight: bold;">0 MB</div>
            </div>
            <div class="sparkline-container" style="width: 100%; height: 50px; background: #0b0b0e; margin-top: 10px; border-radius: 3px; overflow: hidden; border: 1px solid #222;">
                <canvas class="sparkline-canvas" id="${this.panelId}-ram-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
            </div>
        </div>

        <!-- GPU Card -->
        <div class="resource-card" id="${this.panelId}-card-gpu">
            <div class="resource-label">GPU UTILIZATION</div>
            <div class="meter-container">
                <svg class="meter-svg" width="80" height="80" viewBox="0 0 80 80">
                    <circle class="meter-bg" cx="40" cy="40" r="32"></circle>
                    <circle class="meter-fill" id="${this.panelId}-gpu-fill" cx="40" cy="40" r="32" stroke-dasharray="201.06" stroke-dashoffset="201.06" style="stroke: #00f0ff;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-gpu-val">0%</div>
            </div>
            <div class="sparkline-container" style="width: 100%; height: 50px; background: #0b0b0e; margin-top: 10px; border-radius: 3px; overflow: hidden; border: 1px solid #222;">
                <canvas class="sparkline-canvas" id="${this.panelId}-gpu-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
            </div>
        </div>

        <!-- VRAM Card -->
        <div class="resource-card" id="${this.panelId}-card-vram">
            <div class="resource-label">VRAM ALLOCATION</div>
            <div class="meter-container">
                <svg class="meter-svg" width="80" height="80" viewBox="0 0 80 80">
                    <circle class="meter-bg" cx="40" cy="40" r="32"></circle>
                    <circle class="meter-fill" id="${this.panelId}-vram-fill" cx="40" cy="40" r="32" stroke-dasharray="201.06" stroke-dashoffset="201.06" style="stroke: #f59e0b;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-vram-val" style="font-size: 10px; font-weight: bold;">0 MB</div>
            </div>
            <div class="sparkline-container" style="width: 100%; height: 50px; background: #0b0b0e; margin-top: 10px; border-radius: 3px; overflow: hidden; border: 1px solid #222;">
                <canvas class="sparkline-canvas" id="${this.panelId}-vram-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
            </div>
        </div>

        <!-- Temp Card -->
        <div class="resource-card" id="${this.panelId}-card-temp">
            <div class="resource-label">CORE TEMPERATURE</div>
            <div class="meter-container">
                <svg class="meter-svg" width="80" height="80" viewBox="0 0 80 80">
                    <circle class="meter-bg" cx="40" cy="40" r="32"></circle>
                    <circle class="meter-fill" id="${this.panelId}-temp-fill" cx="40" cy="40" r="32" stroke-dasharray="201.06" stroke-dashoffset="201.06" style="stroke: #ef4444;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-temp-val">0°C</div>
            </div>
            <div class="sparkline-container" style="width: 100%; height: 50px; background: #0b0b0e; margin-top: 10px; border-radius: 3px; overflow: hidden; border: 1px solid #222;">
                <canvas class="sparkline-canvas" id="${this.panelId}-temp-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
            </div>
        </div>
        `;
    }

    public updateMetrics(data: {
        cpu: number;
        ram_alloc: number;
        ram_total: number;
        gpu_util: number;
        vram_alloc: number;
        vram_total: number;
        gpu_temp: number;
    }) {
        const cpu_pct = data.cpu;
        const ram_total_mb = data.ram_total > 0 ? data.ram_total / (1024 * 1024) : 16384;
        const ram_alloc_mb = data.ram_alloc / (1024 * 1024);
        const ram_pct = data.ram_total > 0 ? (data.ram_alloc / data.ram_total) * 100 : 0;
        const gpu_pct = data.gpu_util;
        const vram_total_mb = data.vram_total > 0 ? data.vram_total / (1024 * 1024) : 0;
        const vram_alloc_mb = data.vram_alloc / (1024 * 1024);
        const vram_pct = data.vram_total > 0 ? (data.vram_alloc / data.vram_total) * 100 : 0;
        const temp_val = data.gpu_temp;

        // Apply EMA smoothing
        this.smoothed.cpu = this.smoothed.cpu * (1 - this.alpha) + cpu_pct * this.alpha;
        this.smoothed.ram_pct = this.smoothed.ram_pct * (1 - this.alpha) + ram_pct * this.alpha;
        this.smoothed.gpu = this.smoothed.gpu * (1 - this.alpha) + gpu_pct * this.alpha;
        this.smoothed.vram_pct = this.smoothed.vram_pct * (1 - this.alpha) + vram_pct * this.alpha;
        this.smoothed.temp = this.smoothed.temp * (1 - this.alpha) + temp_val * this.alpha;

        // Update History buffers
        const updateHistory = (arr: number[], val: number) => {
            arr.push(val);
            if (arr.length > this.historyLimit) arr.shift();
        };
        updateHistory(this.history.cpu, cpu_pct);
        updateHistory(this.history.ram, ram_pct);
        updateHistory(this.history.gpu, gpu_pct);
        updateHistory(this.history.vram, vram_pct);
        updateHistory(this.history.temp, temp_val);

        // Circular dash offset helper
        const setDashOffset = (elementId: string, percentage: number) => {
            const el = this.container.querySelector<SVGCircleElement>(`#${this.panelId}-${elementId}`);
            if (el) {
                const circumference = 201.06;
                const offset = circumference * (1 - Math.min(100, Math.max(0, percentage)) / 100);
                el.style.strokeDashoffset = `${offset}`;
            }
        };

        // Text value update helper
        const setTextValue = (elementId: string, text: string) => {
            const el = this.container.querySelector<HTMLElement>(`#${this.panelId}-${elementId}`);
            if (el) el.innerText = text;
        };

        // Toggle Stress class
        const toggleStress = (cardId: string, value: number, threshold: number) => {
            const card = this.container.querySelector<HTMLElement>(`#${this.panelId}-card-${cardId}`);
            if (card) {
                if (value >= threshold) {
                    card.classList.add('is-stressed');
                } else {
                    card.classList.remove('is-stressed');
                }
            }
        };

        // Render CPU
        setDashOffset('cpu-fill', this.smoothed.cpu);
        setTextValue('cpu-val', `${Math.round(this.smoothed.cpu)}%`);
        toggleStress('cpu', this.smoothed.cpu, 85);
        this.drawSparkline('cpu-canvas', this.history.cpu, '#3b82f6');

        // Render RAM
        setDashOffset('ram-fill', this.smoothed.ram_pct);
        const formatRAM = (mb: number) => mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`;
        setTextValue('ram-val', formatRAM(ram_alloc_mb));
        toggleStress('ram', this.smoothed.ram_pct, 85);
        this.drawSparkline('ram-canvas', this.history.ram, '#10b981');

        // Render GPU
        setDashOffset('gpu-fill', this.smoothed.gpu);
        setTextValue('gpu-val', `${Math.round(this.smoothed.gpu)}%`);
        toggleStress('gpu', this.smoothed.gpu, 85);
        this.drawSparkline('gpu-canvas', this.history.gpu, '#00f0ff');

        // Render VRAM
        setDashOffset('vram-fill', this.smoothed.vram_pct);
        const formatVRAM = (mb: number) => vram_total_mb > 0 ? (mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`) : '0MB';
        setTextValue('vram-val', formatVRAM(vram_alloc_mb));
        toggleStress('vram', this.smoothed.vram_pct, 85);
        this.drawSparkline('vram-canvas', this.history.vram, '#f59e0b');

        // Render Temp
        setDashOffset('temp-fill', Math.min(100, this.smoothed.temp)); // clamp temp to gauge max
        setTextValue('temp-val', `${Math.round(this.smoothed.temp)}°C`);
        toggleStress('temp', this.smoothed.temp, 80);
        this.drawSparkline('temp-canvas', this.history.temp, '#ef4444');
    }

    private drawSparkline(canvasId: string, history: number[], color: string): void {
        const canvas = this.container.querySelector<HTMLCanvasElement>(`#${this.panelId}-${canvasId}`);
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        if (width === 0 || height === 0) return;

        // Scale by DPR for razor-sharp rendering on High-DPI screens
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, width, height);

        if (history.length < 2) return;

        // 1. Draw gradient area under curve
        ctx.beginPath();
        ctx.moveTo(0, height);
        for (let i = 0; i < history.length; i++) {
            const x = (i / (this.historyLimit - 1)) * width;
            const y = height - (history[i] / 100) * (height - 4) - 2;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(((history.length - 1) / (this.historyLimit - 1)) * width, height);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, hexToRgba(color, 0.22));
        grad.addColorStop(1, hexToRgba(color, 0.0));
        ctx.fillStyle = grad;
        ctx.fill();

        // 2. Draw sparkline path
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
            const x = (i / (this.historyLimit - 1)) * width;
            const y = height - (history[i] / 100) * (height - 4) - 2;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
    }
}
