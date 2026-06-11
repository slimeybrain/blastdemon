import { StateManager } from './state-manager.js';

export class ResourceManager {
    public container: HTMLElement;
    private stateManager: StateManager;
    private panelId: string;

    constructor(container: HTMLElement, stateManager: StateManager, panelId: string) {
        if (!container) {
            throw new Error("[RESOURCE MANAGER] Initialization failed: Target container is undefined.");
        }

        this.stateManager = stateManager;
        this.panelId = panelId;

        // Now safely perform your DOM appending
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
    <div class="resource-panel-inner" style="padding: 12px; display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; box-sizing: border-box; height: 100%; overflow-y: auto;">
        <div class="metric-row" style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: bold; color: #94a3b8;">
                <span>GPU UTILIZATION</span>
                <span id="${this.panelId}-gpu-txt">0%</span>
            </div>
            <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden;">
                <div id="${this.panelId}-gpu-bar" style="width: 0%; height: 100%; background: #3b82f6; transition: width 0.1s ease;"></div>
            </div>
        </div>
        <div class="metric-row" style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: bold; color: #94a3b8;">
                <span>VRAM ALLOCATION</span>
                <span id="${this.panelId}-vram-txt">0%</span>
            </div>
            <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden;">
                <div id="${this.panelId}-vram-bar" style="width: 0%; height: 100%; background: #10b981; transition: width 0.1s ease;"></div>
            </div>
        </div>
        <div class="metric-row" style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: bold; color: #94a3b8;">
                <span>CORE TEMPERATURE</span>
                <span id="${this.panelId}-temp-txt">0°C</span>
            </div>
            <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden;">
                <div id="${this.panelId}-temp-bar" style="width: 0%; height: 100%; background: #ef4444; transition: width 0.1s ease;"></div>
            </div>
        </div>
    </div>
  `;
    }

    public updateMetrics(data: { gpu_util: number, vram_util: number, gpu_temp: number }) {
        const gpuBar = this.container.querySelector<HTMLElement>(`#${this.panelId}-gpu-bar`);
        const gpuTxt = this.container.querySelector<HTMLElement>(`#${this.panelId}-gpu-txt`);
        const vramBar = this.container.querySelector<HTMLElement>(`#${this.panelId}-vram-bar`);
        const vramTxt = this.container.querySelector<HTMLElement>(`#${this.panelId}-vram-txt`);
        const tempBar = this.container.querySelector<HTMLElement>(`#${this.panelId}-temp-bar`);
        const tempTxt = this.container.querySelector<HTMLElement>(`#${this.panelId}-temp-txt`);

        if (gpuBar && gpuTxt) {
            gpuBar.style.width = `${Math.min(100, Math.max(0, data.gpu_util))}%`;
            gpuTxt.innerText = `${Math.round(data.gpu_util)}%`;
        }
        if (vramBar && vramTxt) {
            vramBar.style.width = `${Math.min(100, Math.max(0, data.vram_util))}%`;
            vramTxt.innerText = `${Math.round(data.vram_util)}%`;
        }
        if (tempBar && tempTxt) {
            // Map assuming standard 100°C visual maximum threshold
            tempBar.style.width = `${Math.min(100, Math.max(0, data.gpu_temp))}%`;
            tempTxt.innerText = `${Math.round(data.gpu_temp)}°C`;
        }
    }

}
