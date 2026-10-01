import { StateManager } from './state-manager.js';

function hexToRgba(hex: string, alpha: number): string {
    if (!hex || !hex.startsWith('#') || hex.length < 7) {
        return `rgba(0, 240, 255, ${alpha})`;
    }
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
        cpu_sys: [] as number[],
        cpu_bd: [] as number[],
        cpu: [] as number[],
        ram_sys: [] as number[],
        ram_bd: [] as number[],
        gpu: [] as number[],
        vram_sys: [] as number[],
        vram_bd: [] as number[],
        temp: [] as number[]
    };
    private historyLimit = 60; // 30 seconds of history at 500ms intervals

    private smoothed = {
        cpu_sys: 0,
        cpu_bd: 0,
        cpu: 0,
        ram_sys_pct: 0,
        ram_bd_pct: 0,
        gpu: 0,
        vram_sys_pct: 0,
        vram_bd_pct: 0,
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
            <div class="resource-header">
                <span class="resource-label" title="Overall CPU usage (Host System & BlastDaemon)">CPU</span>
                <span class="resource-value" id="${this.panelId}-cpu-val" style="color: #38bdf8;">0%</span>
            </div>
            <div class="resource-bar-track">
                <div class="resource-bar-fill" id="${this.panelId}-cpu-fill" style="width: 0%; background: #38bdf8;"></div>
                <div class="resource-bar-fill-inner" id="${this.panelId}-cpu-fill-inner" style="width: 0%; background: #7dd3fc;"></div>
            </div>
            <div class="resource-subtext">
                <span>BD: <strong id="${this.panelId}-cpu-bd-val" style="color: #7dd3fc;">0%</strong></span>
                <span>Sys: <strong id="${this.panelId}-cpu-sys-val" style="color: #38bdf8;">0%</strong></span>
            </div>
            <div class="sparkline-container">
                <canvas class="sparkline-canvas" id="${this.panelId}-cpu-canvas"></canvas>
            </div>
        </div>

        <!-- RAM Card -->
        <div class="resource-card" id="${this.panelId}-card-ram">
            <div class="resource-header">
                <span class="resource-label" title="Host System RAM usage (with BlastDaemon allocated memory)">RAM</span>
                <span class="resource-value" id="${this.panelId}-ram-val" style="color: #10b981;">0%</span>
            </div>
            <div class="resource-bar-track">
                <div class="resource-bar-fill" id="${this.panelId}-ram-fill" style="width: 0%; background: #10b981;"></div>
                <div class="resource-bar-fill-inner" id="${this.panelId}-ram-fill-inner" style="width: 0%; background: #34d399;"></div>
            </div>
            <div class="resource-subtext">
                <span>BD: <strong id="${this.panelId}-ram-bd-val" style="color: #34d399;">0MB</strong></span>
                <span>Sys: <strong id="${this.panelId}-ram-sys-val" style="color: #10b981;">0MB</strong></span>
            </div>
            <div class="sparkline-container">
                <canvas class="sparkline-canvas" id="${this.panelId}-ram-canvas"></canvas>
            </div>
        </div>

        <!-- GPU Card -->
        <div class="resource-card" id="${this.panelId}-card-gpu">
            <div class="resource-header">
                <span class="resource-label" title="GPU compute engine utilization">GPU</span>
                <span class="resource-value" id="${this.panelId}-gpu-val" style="color: #00f0ff;">0%</span>
            </div>
            <div class="resource-bar-track">
                <div class="resource-bar-fill" id="${this.panelId}-gpu-fill" style="width: 0%; background: #00f0ff;"></div>
            </div>
            <div class="resource-subtext">
                <span>Core: <strong id="${this.panelId}-gpu-core-val" style="color: #00f0ff;">0%</strong></span>
                <span>Temp: <strong id="${this.panelId}-gpu-temp-sub-val" style="color: #ef4444;">0°C</strong></span>
            </div>
            <div class="sparkline-container">
                <canvas class="sparkline-canvas" id="${this.panelId}-gpu-canvas"></canvas>
            </div>
        </div>

        <!-- VRAM Card -->
        <div class="resource-card" id="${this.panelId}-card-vram">
            <div class="resource-header">
                <span class="resource-label" title="GPU VRAM allocation (Host System & BlastDaemon)">VRAM</span>
                <span class="resource-value" id="${this.panelId}-vram-val" style="color: #f59e0b;">0%</span>
            </div>
            <div class="resource-bar-track">
                <div class="resource-bar-fill" id="${this.panelId}-vram-fill" style="width: 0%; background: #f59e0b;"></div>
                <div class="resource-bar-fill-inner" id="${this.panelId}-vram-fill-inner" style="width: 0%; background: #fbbf24;"></div>
            </div>
            <div class="resource-subtext">
                <span>BD: <strong id="${this.panelId}-vram-bd-val" style="color: #fbbf24;">0MB</strong></span>
                <span>Sys: <strong id="${this.panelId}-vram-sys-val" style="color: #f59e0b;">0MB</strong></span>
            </div>
            <div class="sparkline-container">
                <canvas class="sparkline-canvas" id="${this.panelId}-vram-canvas"></canvas>
            </div>
        </div>

        <!-- Temp Card -->
        <div class="resource-card" id="${this.panelId}-card-temp">
            <div class="resource-header">
                <span class="resource-label" title="GPU core temperature">TEMP</span>
                <span class="resource-value" id="${this.panelId}-temp-val" style="color: #ef4444;">0°C</span>
            </div>
            <div class="resource-bar-track">
                <div class="resource-bar-fill" id="${this.panelId}-temp-fill" style="width: 0%; background: #ef4444;"></div>
            </div>
            <div class="resource-subtext">
                <span>Status: <strong id="${this.panelId}-temp-status-val" style="color: #10b981;">Nominal</strong></span>
                <span>Target: <strong style="color: #64748b;">&lt; 80°C</strong></span>
            </div>
            <div class="sparkline-container">
                <canvas class="sparkline-canvas" id="${this.panelId}-temp-canvas"></canvas>
            </div>
        </div>
        `;
    }

    public updateMetrics(data: {
        cpu: number;
        cpu_cores?: number;
        cpu_system?: number;
        num_cores?: number;
        ram_alloc: number;
        ram_system?: number;
        ram_total: number;
        gpu_util: number;
        vram_alloc: number;
        vram_blastdaemon?: number;
        vram_total: number;
        gpu_temp: number;
    }) {
        const cpu_bd_pct = data.cpu;
        const cpu_cores = data.cpu_cores !== undefined ? data.cpu_cores : (cpu_bd_pct * (data.num_cores || 1));
        const cpu_sys_pct = data.cpu_system !== undefined && data.cpu_system > 0 ? data.cpu_system : cpu_bd_pct;

        const ram_total_mb = data.ram_total > 0 ? data.ram_total / (1024 * 1024) : 16384;
        const ram_alloc_mb = data.ram_alloc / (1024 * 1024);
        const ram_system_bytes = data.ram_system !== undefined ? data.ram_system : data.ram_alloc;
        const ram_sys_mb = ram_system_bytes / (1024 * 1024);
        
        const ram_sys_pct = data.ram_total > 0 ? (ram_system_bytes / data.ram_total) * 100 : 0;
        const ram_bd_pct = data.ram_total > 0 ? (data.ram_alloc / data.ram_total) * 100 : 0;
        
        const gpu_pct = data.gpu_util;
        const vram_total_mb = data.vram_total > 0 ? data.vram_total / (1024 * 1024) : 0;
        const vram_alloc_mb = data.vram_alloc / (1024 * 1024);
        const vram_bd_bytes = data.vram_blastdaemon !== undefined ? data.vram_blastdaemon : 0;
        const vram_bd_mb = vram_bd_bytes / (1024 * 1024);
        
        const vram_sys_pct = data.vram_total > 0 ? (data.vram_alloc / data.vram_total) * 100 : 0;
        const vram_bd_pct = data.vram_total > 0 ? (vram_bd_bytes / data.vram_total) * 100 : 0;
        const temp_val = data.gpu_temp;

        // Apply EMA smoothing
        this.smoothed.cpu_sys = this.smoothed.cpu_sys * (1 - this.alpha) + cpu_sys_pct * this.alpha;
        this.smoothed.cpu_bd = this.smoothed.cpu_bd * (1 - this.alpha) + cpu_bd_pct * this.alpha;
        this.smoothed.cpu = this.smoothed.cpu_sys;
        this.smoothed.ram_sys_pct = this.smoothed.ram_sys_pct * (1 - this.alpha) + ram_sys_pct * this.alpha;
        this.smoothed.ram_bd_pct = this.smoothed.ram_bd_pct * (1 - this.alpha) + ram_bd_pct * this.alpha;
        this.smoothed.gpu = this.smoothed.gpu * (1 - this.alpha) + gpu_pct * this.alpha;
        this.smoothed.vram_sys_pct = this.smoothed.vram_sys_pct * (1 - this.alpha) + vram_sys_pct * this.alpha;
        this.smoothed.vram_bd_pct = this.smoothed.vram_bd_pct * (1 - this.alpha) + vram_bd_pct * this.alpha;
        this.smoothed.temp = this.smoothed.temp * (1 - this.alpha) + temp_val * this.alpha;

        // Update History buffers
        const updateHistory = (arr: number[], val: number) => {
            arr.push(val);
            if (arr.length > this.historyLimit) arr.shift();
        };
        updateHistory(this.history.cpu_sys, cpu_sys_pct);
        updateHistory(this.history.cpu_bd, cpu_bd_pct);
        updateHistory(this.history.cpu, cpu_sys_pct);
        updateHistory(this.history.ram_sys, ram_sys_pct);
        updateHistory(this.history.ram_bd, ram_bd_pct);
        updateHistory(this.history.gpu, gpu_pct);
        updateHistory(this.history.vram_sys, vram_sys_pct);
        updateHistory(this.history.vram_bd, vram_bd_pct);
        updateHistory(this.history.temp, temp_val);

        // Progress bar width helper
        const setBarWidth = (elementId: string, percentage: number) => {
            const el = this.container.querySelector<HTMLElement>(`#${this.panelId}-${elementId}`);
            if (el) {
                const clamped = Math.min(100, Math.max(0, percentage));
                el.style.width = `${clamped}%`;
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
        setBarWidth('cpu-fill', this.smoothed.cpu_sys);
        setBarWidth('cpu-fill-inner', this.smoothed.cpu_bd);
        setTextValue('cpu-val', `${Math.round(this.smoothed.cpu_sys)}%`);
        const coreStr = (cpu_cores / 100).toFixed(1);
        const bdCpuPctStr = cpu_bd_pct < 1.0 && cpu_bd_pct > 0.05 ? cpu_bd_pct.toFixed(1) : Math.round(cpu_bd_pct);
        setTextValue('cpu-bd-val', `${bdCpuPctStr}% (${coreStr}c)`);
        setTextValue('cpu-sys-val', `${Math.round(this.smoothed.cpu_sys)}%`);
        toggleStress('cpu', this.smoothed.cpu_sys, 85);
        this.drawSparkline('cpu-canvas', this.history.cpu_sys, '#38bdf8', this.history.cpu_bd, '#7dd3fc');

        // Render RAM
        setBarWidth('ram-fill', this.smoothed.ram_sys_pct);
        setBarWidth('ram-fill-inner', this.smoothed.ram_bd_pct);
        const formatRAM = (mb: number) => mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`;
        setTextValue('ram-val', `${Math.round(this.smoothed.ram_sys_pct)}%`);
        const ramBdPctStr = ram_bd_pct < 1.0 && ram_bd_pct > 0.05 ? ram_bd_pct.toFixed(1) : Math.round(ram_bd_pct);
        setTextValue('ram-bd-val', `${formatRAM(ram_alloc_mb)} (${ramBdPctStr}%)`);
        setTextValue('ram-sys-val', `${formatRAM(ram_sys_mb)} (${Math.round(this.smoothed.ram_sys_pct)}%)`);
        toggleStress('ram', this.smoothed.ram_sys_pct, 85);
        this.drawSparkline('ram-canvas', this.history.ram_sys, '#10b981', this.history.ram_bd, '#34d399');

        // Render GPU
        setBarWidth('gpu-fill', this.smoothed.gpu);
        setTextValue('gpu-val', `${Math.round(this.smoothed.gpu)}%`);
        setTextValue('gpu-core-val', `${Math.round(this.smoothed.gpu)}%`);
        setTextValue('gpu-temp-sub-val', `${Math.round(this.smoothed.temp)}°C`);
        toggleStress('gpu', this.smoothed.gpu, 85);
        this.drawSparkline('gpu-canvas', this.history.gpu, '#00f0ff');

        // Render VRAM
        setBarWidth('vram-fill', this.smoothed.vram_sys_pct);
        setBarWidth('vram-fill-inner', this.smoothed.vram_bd_pct);
        const formatVRAM = (mb: number) => vram_total_mb > 0 ? (mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`) : '0MB';
        setTextValue('vram-val', vram_total_mb > 0 ? `${Math.round(this.smoothed.vram_sys_pct)}%` : '0%');
        const vramBdPctStr = vram_bd_pct < 1.0 && vram_bd_pct > 0.05 ? vram_bd_pct.toFixed(1) : Math.round(vram_bd_pct);
        setTextValue('vram-bd-val', vram_total_mb > 0 ? `${formatVRAM(vram_bd_mb)} (${vramBdPctStr}%)` : '0MB (0%)');
        setTextValue('vram-sys-val', vram_total_mb > 0 ? `${formatVRAM(vram_alloc_mb)} (${Math.round(this.smoothed.vram_sys_pct)}%)` : '0MB (0%)');
        toggleStress('vram', this.smoothed.vram_sys_pct, 85);
        this.drawSparkline('vram-canvas', this.history.vram_sys, '#f59e0b', this.history.vram_bd, '#fbbf24');

        // Render Temp
        setBarWidth('temp-fill', Math.min(100, this.smoothed.temp));
        setTextValue('temp-val', `${Math.round(this.smoothed.temp)}°C`);
        const isStressed = this.smoothed.temp >= 80;
        const statusEl = this.container.querySelector<HTMLElement>(`#${this.panelId}-temp-status-val`);
        if (statusEl) {
            statusEl.innerText = isStressed ? 'Throttling' : (this.smoothed.temp >= 70 ? 'Warm' : 'Nominal');
            statusEl.style.color = isStressed ? '#ef4444' : (this.smoothed.temp >= 70 ? '#f59e0b' : '#10b981');
        }
        toggleStress('temp', this.smoothed.temp, 80);
        this.drawSparkline('temp-canvas', this.history.temp, '#ef4444');
    }

    private drawSparkline(canvasId: string, history: number[], color: string, history2?: number[], color2?: string): void {
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

        // 1. Draw gradient area under curve for primary (system)
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

        // 2. Draw primary sparkline path
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

        // 3. Draw secondary sparkline path if provided
        if (history2 && history2.length >= 2 && color2) {
            ctx.beginPath();
            ctx.moveTo(0, height);
            for (let i = 0; i < history2.length; i++) {
                const x = (i / (this.historyLimit - 1)) * width;
                const y = height - (history2[i] / 100) * (height - 4) - 2;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(((history2.length - 1) / (this.historyLimit - 1)) * width, height);
            ctx.closePath();

            const grad2 = ctx.createLinearGradient(0, 0, 0, height);
            grad2.addColorStop(0, hexToRgba(color2, 0.15));
            grad2.addColorStop(1, hexToRgba(color2, 0.0));
            ctx.fillStyle = grad2;
            ctx.fill();

            ctx.beginPath();
            for (let i = 0; i < history2.length; i++) {
                const x = (i / (this.historyLimit - 1)) * width;
                const y = height - (history2[i] / 100) * (height - 4) - 2;
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.strokeStyle = color2;
            ctx.lineWidth = 1.2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();
        }
    }

    public resetMetrics(): void {
        this.smoothed = {
            cpu_sys: 0,
            cpu_bd: 0,
            cpu: 0,
            ram_sys_pct: 0,
            ram_bd_pct: 0,
            gpu: 0,
            vram_sys_pct: 0,
            vram_bd_pct: 0,
            temp: 0
        };
        this.history = {
            cpu_sys: [],
            cpu_bd: [],
            cpu: [],
            ram_sys: [],
            ram_bd: [],
            gpu: [],
            vram_sys: [],
            vram_bd: [],
            temp: []
        };
        this.updateMetrics({
            cpu: 0,
            cpu_cores: 0,
            cpu_system: 0,
            num_cores: 1,
            ram_alloc: 0,
            ram_system: 0,
            ram_total: 0,
            gpu_util: 0,
            vram_alloc: 0,
            vram_blastdaemon: 0,
            vram_total: 0,
            gpu_temp: 0
        });
    }
}
