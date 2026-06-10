import { StateManager } from './state-manager.js';

export class ResourceManager {
    private container: HTMLElement;
    private stateManager: StateManager;
    private telemetryListener: (nodeId: string, data: any) => void;

    private cpuHistory: number[] = [];
    private ramHistory: number[] = [];
    private historyLimit = 100;

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.className = 'resource-manager-grid';
        parent.appendChild(this.container);

        this.stateManager = stateManager;
        this.telemetryListener = (_nodeId, data) => {
            if (data && data.type === 'resource_pulse') {
                this.update(data);
            }
        };

        this.stateManager.onTelemetryUpdate(this.telemetryListener);
        this.initUI();
    }

    public destroy(): void {
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.container.remove();
    }

    private initUI(): void {
        this.container.innerHTML = `
            <div class="resource-card" id="res-gpu">
                <div class="resource-label">GPU LOAD</div>
                <div class="meter-container">
                    <svg class="meter-svg" width="80" height="80">
                        <circle class="meter-bg" cx="40" cy="40" r="35"></circle>
                        <circle class="meter-fill" cx="40" cy="40" r="35" stroke-dasharray="219.9" stroke-dashoffset="219.9"></circle>
                    </svg>
                    <div class="meter-value">0%</div>
                </div>
            </div>
            <div class="resource-card" id="res-vram">
                <div class="resource-label">VRAM LOAD</div>
                <div class="meter-container">
                    <svg class="meter-svg" width="80" height="80">
                        <circle class="meter-bg" cx="40" cy="40" r="35"></circle>
                        <circle class="meter-fill" cx="40" cy="40" r="35" stroke-dasharray="219.9" stroke-dashoffset="219.9"></circle>
                    </svg>
                    <div class="meter-value">0%</div>
                </div>
            </div>
            <div class="resource-card" id="res-temp">
                <div class="resource-label">CORE TEMP</div>
                <div class="meter-container">
                    <svg class="meter-svg" width="80" height="80">
                        <circle class="meter-bg" cx="40" cy="40" r="35"></circle>
                        <circle class="meter-fill" cx="40" cy="40" r="35" stroke-dasharray="219.9" stroke-dashoffset="219.9" style="stroke: #ef4444"></circle>
                    </svg>
                    <div class="meter-value">0°C</div>
                </div>
            </div>
            <div class="resource-card">
                <div class="resource-label">CPU & RAM HISTORY</div>
                <div class="sparkline-container">
                    <canvas id="resource-sparkline" class="sparkline-canvas"></canvas>
                </div>
            </div>
        `;
    }

    private update(data: any): void {
        this.updateMeter('res-gpu', data.gpu_util, '%');
        this.updateMeter('res-vram', data.vram_util, '%');
        this.updateMeter('res-temp', data.gpu_temp, '°C', 90);

        this.cpuHistory.push(data.cpu);
        this.ramHistory.push(data.ram / (1024 * 1024 * 1024)); // GB

        if (this.cpuHistory.length > this.historyLimit) this.cpuHistory.shift();
        if (this.ramHistory.length > this.historyLimit) this.ramHistory.shift();

        this.drawSparkline();
    }

    private updateMeter(id: string, value: number, unit: string, stressThreshold: number = 90): void {
        const card = document.getElementById(id);
        if (!card) return;

        const fill = card.querySelector('.meter-fill') as SVGCircleElement;
        const text = card.querySelector('.meter-value') as HTMLElement;

        if (fill) {
            const circumference = 2 * Math.PI * 35;
            const offset = circumference - (value / 100) * circumference;
            fill.style.strokeDashoffset = offset.toString();
        }

        if (text) {
            text.textContent = `${Math.round(value)}${unit}`;
        }

        card.classList.toggle('is-stressed', value >= stressThreshold);
    }

    private drawSparkline(): void {
        const canvas = document.getElementById('resource-sparkline') as HTMLCanvasElement;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Auto-resize
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw CPU (Cyan)
        this.drawPath(ctx, this.cpuHistory, 100, '#00f0ff');
        // Draw RAM (Green) - Normalized to 16GB for mock visualization
        this.drawPath(ctx, this.ramHistory, 16, '#16a34a');
    }

    private drawPath(ctx: CanvasRenderingContext2D, data: number[], max: number, color: string): void {
        if (data.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;

        const step = ctx.canvas.width / (this.historyLimit - 1);
        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const y = ctx.canvas.height - (data[i] / max) * ctx.canvas.height;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
}
