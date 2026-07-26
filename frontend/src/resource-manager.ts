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

function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class ResourceManager {
    public container: HTMLElement;
    private stateManager: StateManager;
    private panelId: string;

    private history = {
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
        cpu: 0,
        ram_sys_pct: 0,
        ram_bd_pct: 0,
        gpu: 0,
        vram_sys_pct: 0,
        vram_bd_pct: 0,
        temp: 0
    };
    private alpha = 0.2; // Exponential moving average smoothing factor

    private telemetryListener: (nodeId: string, data: any) => void;
    private modelStatusListener: (modelId: string, status: any) => void;
    private stateListener: () => void;

    private speedTrackers: Map<string, {
        lastSimTime: number;
        lastWallclock: number;
        lastRealTime: number;
        smoothedSpeed: number;
    }> = new Map();

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

        this.telemetryListener = (nodeId: string, data: any) => this.onTelemetryReceived(nodeId, data);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);

        this.modelStatusListener = () => this.renderModelSpeedEntries();
        this.stateManager.onModelStatusChange(this.modelStatusListener);

        this.stateListener = () => this.renderModelSpeedEntries();
        this.stateManager.onStateChange(this.stateListener);

        this.renderModelSpeedEntries();
    }

    public destroy(): void {
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.stateManager.offModelStatusChange(this.modelStatusListener);
        this.stateManager.offStateChange(this.stateListener);
        this.container.remove();
    }

    private initUI(): void {
        this.container.innerHTML = `
        <!-- Simulation Speed Card (One Entry per Model, All on Single Card) -->
        <div class="resource-card speed-card" id="${this.panelId}-card-speed" style="grid-column: 1 / -1; align-items: stretch; width: 100%; box-sizing: border-box; padding: 8px 10px;">
            <div class="resource-label" style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-bottom: 1px solid #2a2a2a; padding-bottom: 4px; margin-bottom: 6px; font-size: 11px;">
                <span style="display: flex; align-items: center; gap: 5px; color: #00f0ff;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                    SIMULATION SPEED (CELLS/S)
                </span>
                <span id="${this.panelId}-speed-total" style="font-family: var(--font-mono); color: #00f0ff; font-weight: bold; font-size: 11px;">0 cells/s</span>
            </div>
            <div class="speed-models-list" id="${this.panelId}-speed-models-list" style="width: 100%; display: flex; flex-direction: column; gap: 3px;">
                <!-- Model speed entries rendered dynamically -->
            </div>
        </div>

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
                    <circle cx="40" cy="40" r="24" style="fill: none; stroke: #222; stroke-width: 5;"></circle>
                    <circle class="meter-fill-inner" id="${this.panelId}-ram-fill-inner" cx="40" cy="40" r="24" stroke-dasharray="150.8" stroke-dashoffset="150.8" style="fill: none; stroke: #34d399; stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.3s;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-ram-val">0%</div>
            </div>
            <div class="meter-details" style="font-size: 11px; margin-top: 8px; width: 100%; display: flex; flex-direction: column; gap: 3px; font-family: var(--font-mono); color: #ccc;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="color: #888;">BlastDaemon:</span>
                    <span id="${this.panelId}-ram-bd-val" style="color: #34d399; font-weight: bold;">0MB</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #2a2a2a; padding-top: 2px;">
                    <span style="color: #888;">System Total:</span>
                    <span id="${this.panelId}-ram-sys-val" style="color: #10b981; font-weight: bold;">0MB</span>
                </div>
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
                    <circle cx="40" cy="40" r="24" style="fill: none; stroke: #222; stroke-width: 5;"></circle>
                    <circle class="meter-fill-inner" id="${this.panelId}-vram-fill-inner" cx="40" cy="40" r="24" stroke-dasharray="150.8" stroke-dashoffset="150.8" style="fill: none; stroke: #fbbf24; stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.3s;"></circle>
                </svg>
                <div class="meter-value" id="${this.panelId}-vram-val">0%</div>
            </div>
            <div class="meter-details" style="font-size: 11px; margin-top: 8px; width: 100%; display: flex; flex-direction: column; gap: 3px; font-family: var(--font-mono); color: #ccc;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="color: #888;">BlastDaemon:</span>
                    <span id="${this.panelId}-vram-bd-val" style="color: #fbbf24; font-weight: bold;">0MB</span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #2a2a2a; padding-top: 2px;">
                    <span style="color: #888;">System Total:</span>
                    <span id="${this.panelId}-vram-sys-val" style="color: #f59e0b; font-weight: bold;">0MB</span>
                </div>
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

    private calculateModelCellStats(model: any): { totalCells: number; effectiveCellUpdatesPerStep: number; label: string } {
        if (!model || !model.nodes) return { totalCells: 0, effectiveCellUpdatesPerStep: 0, label: '0 cells' };

        const solver3D = model.nodes.find((n: any) => n.type === 'CFDSolver3D');
        if (solver3D) {
            const mesh = model.nodes.find((n: any) => n.type === 'DomainMesh3D');
            const dx = Number(mesh?.parameters?.cell_size ?? solver3D.parameters?.cell_size ?? 0.01);
            const xmin = Number(mesh?.parameters?.xmin ?? 0.0);
            const xmax = Number(mesh?.parameters?.xmax ?? 1.0);
            const ymin = Number(mesh?.parameters?.ymin ?? 0.0);
            const ymax = Number(mesh?.parameters?.ymax ?? 1.0);
            const zmin = Number(mesh?.parameters?.zmin ?? 0.0);
            const zmax = Number(mesh?.parameters?.zmax ?? 1.0);
            const nx = Math.max(1, Math.round((xmax - xmin) / dx));
            const ny = Math.max(1, Math.round((ymax - ymin) / dx));
            const nz = Math.max(1, Math.round((zmax - zmin) / dx));
            const rootCells = nx * ny * nz;
            let total = rootCells;
            let effectiveCellUpdatesPerStep = rootCells;

            const refMeshes = model.nodes.filter((n: any) => n.type === 'RefinementMesh3D');
            let subgridCells = 0;
            for (const refNode of refMeshes) {
                const sx = Number(refNode?.parameters?.submesh_size_x ?? 0.5);
                const sy = Number(refNode?.parameters?.submesh_size_y ?? 0.5);
                const sz = Number(refNode?.parameters?.submesh_size_z ?? 0.5);
                const lvl = Number(refNode?.parameters?.refinement_level ?? 1);
                const refinedDx = dx / Math.pow(2, lvl);
                const snx = Math.max(1, Math.round(sx / refinedDx));
                const sny = Math.max(1, Math.round(sy / refinedDx));
                const snz = Math.max(1, Math.round(sz / refinedDx));
                const cellCount = snx * sny * snz;
                subgridCells += cellCount;

                // Subcycling factor: each subgrid level takes 2^lvl sub-steps per parent step
                const subcyclingFactor = Math.pow(2, lvl);
                effectiveCellUpdatesPerStep += cellCount * subcyclingFactor;
            }
            total += subgridCells;
            const formatted = total >= 1e6 ? `${(total / 1e6).toFixed(2)}M` : (total >= 1e3 ? `${(total / 1e3).toFixed(1)}k` : `${total}`);
            const label = refMeshes.length > 0
                ? `3D ${nx}×${ny}×${nz} + ${refMeshes.length} Subgrid${refMeshes.length > 1 ? 's' : ''} (${formatted} cells)`
                : `3D ${nx}×${ny}×${nz} (${formatted} cells)`;
            return { totalCells: total, effectiveCellUpdatesPerStep, label };
        }

        const solver2D = model.nodes.find((n: any) => n.type === 'CFDSolver2D' || n.type === 'FSICoupler2D' || n.type === 'MPMDomain2D');
        if (solver2D) {
            const mesh = model.nodes.find((n: any) => n.type === 'DomainMesh2D' || n.type === 'MPMDomain2D');
            const dx = Number(mesh?.parameters?.cell_size ?? 0.01);
            const mr = Number(mesh?.parameters?.max_r ?? 1.0);
            const mz = Number(mesh?.parameters?.max_z ?? 1.0);
            const nr = Math.max(1, Math.round(mr / dx));
            const nz = Math.max(1, Math.round(mz / dx));
            const total = nr * nz;
            const formatted = total >= 1e6 ? `${(total / 1e6).toFixed(2)}M` : (total >= 1e3 ? `${(total / 1e3).toFixed(1)}k` : `${total}`);
            return { totalCells: total, effectiveCellUpdatesPerStep: total, label: `2D ${nr}×${nz} (${formatted} cells)` };
        }

        const solver1D = model.nodes.find((n: any) => n.type === 'CFDSolver');
        if (solver1D) {
            const mesh = model.nodes.find((n: any) => n.type === 'DomainMesh');
            let n_cells = Number(mesh?.parameters?.n_cells ?? mesh?.parameters?.num_cells ?? solver1D.parameters?.n_cells);
            if (isNaN(n_cells) || n_cells <= 0) {
                const radius = Number(mesh?.parameters?.domain_radius ?? 1.0);
                const dx = Number(mesh?.parameters?.cell_size ?? 0.001);
                n_cells = Math.max(1, Math.round(radius / dx));
            }
            return { totalCells: n_cells, effectiveCellUpdatesPerStep: n_cells, label: `1D (${n_cells} cells)` };
        }

        return { totalCells: 0, effectiveCellUpdatesPerStep: 0, label: 'No Solver' };
    }

    private onTelemetryReceived(nodeId: string, data: any): void {
        if (!data || data instanceof ArrayBuffer) return;

        const models = this.stateManager.getWorkspaceModels();
        let model = models.find(m => m.nodes.some(n => n.id === nodeId));
        if (!model && data.modelId) {
            model = models.find(m => m.id === data.modelId);
        }
        if (!model && models.length === 1) {
            model = models[0];
        }
        if (!model) return;

        const modelId = model.id;
        const status = this.stateManager.getModelStatus(modelId);
        if (status !== 'RUNNING') {
            const tracker = this.speedTrackers.get(modelId);
            if (tracker) tracker.smoothedSpeed = 0;
            this.renderModelSpeedEntries();
            return;
        }

        const now = performance.now();
        const stats = this.calculateModelCellStats(model);
        const cellUpdatesPerStep = stats.effectiveCellUpdatesPerStep;
        if (cellUpdatesPerStep <= 0) return;

        const simTime = typeof data.time === 'number' ? data.time : (typeof data.sim_time === 'number' ? data.sim_time : 0);
        const wallclock = typeof data.wallclock === 'number' ? data.wallclock : 0;
        const dt = typeof data.dt === 'number' && data.dt > 0 ? data.dt : 0;

        let tracker = this.speedTrackers.get(modelId);
        if (!tracker) {
            tracker = {
                lastSimTime: simTime,
                lastWallclock: wallclock,
                lastRealTime: now,
                smoothedSpeed: 0
            };
            this.speedTrackers.set(modelId, tracker);
            return;
        }

        const deltaRealSec = (now - tracker.lastRealTime) / 1000;
        const deltaSimSec = simTime - tracker.lastSimTime;
        const deltaWallSec = wallclock - tracker.lastWallclock;

        if (deltaRealSec >= 0.02) {
            let instSpeed = 0;
            if (deltaSimSec > 0) {
                let parentSteps = 1;
                if (dt > 0) {
                    parentSteps = Math.max(1, deltaSimSec / dt);
                }
                const totalCellUpdates = parentSteps * cellUpdatesPerStep;
                if (deltaWallSec > 0.0001) {
                    instSpeed = totalCellUpdates / deltaWallSec;
                } else {
                    instSpeed = totalCellUpdates / deltaRealSec;
                }
            }

            tracker.smoothedSpeed = tracker.smoothedSpeed * 0.75 + instSpeed * 0.25;
            tracker.lastSimTime = simTime;
            tracker.lastWallclock = wallclock;
            tracker.lastRealTime = now;

            this.renderModelSpeedEntries();
        }
    }

    private formatCellsPerSec(cps: number): string {
        if (isNaN(cps) || cps <= 0) return "0 cells/s";
        if (cps < 1000) return `${Math.round(cps)} cells/s`;
        if (cps < 1e6) return `${(cps / 1e3).toFixed(1)} kcells/s`;
        if (cps < 1e9) return `${(cps / 1e6).toFixed(2)} Mcells/s`;
        return `${(cps / 1e9).toFixed(2)} Gcells/s`;
    }

    private renderModelSpeedEntries(): void {
        const listContainer = this.container.querySelector<HTMLElement>(`#${this.panelId}-speed-models-list`);
        const totalEl = this.container.querySelector<HTMLElement>(`#${this.panelId}-speed-total`);
        if (!listContainer) return;

        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) {
            listContainer.innerHTML = `<div style="font-size: 11px; color: #666; font-style: italic; padding: 6px 0; text-align: center;">No models in workspace</div>`;
            if (totalEl) totalEl.innerText = "0 cells/s";
            return;
        }

        let totalSpeed = 0;
        let html = '';

        for (const m of models) {
            const colors = this.stateManager.getModelColors(m.id);
            const status = this.stateManager.getModelStatus(m.id);
            const stats = this.calculateModelCellStats(m);
            const tracker = this.speedTrackers.get(m.id);

            const isRunning = status === 'RUNNING';
            const speed = isRunning && tracker ? tracker.smoothedSpeed : 0;
            totalSpeed += speed;

            let statusColor = '#6b7280';
            let statusIcon = '○';
            if (status === 'RUNNING') {
                statusColor = '#10b981';
                statusIcon = '▶';
            } else if (status === 'PAUSED') {
                statusColor = '#f59e0b';
                statusIcon = '❚❚';
            } else if (status === 'INITIALIZED') {
                statusColor = '#3b82f6';
                statusIcon = '●';
            } else if (status === 'TERMINATED') {
                statusColor = '#ef4444';
                statusIcon = '■';
            }

            const formattedSpeed = this.formatCellsPerSec(speed);
            const maxExpectedSpeed = 5e7;
            const barPct = speed > 0 ? Math.min(100, Math.max(5, (speed / maxExpectedSpeed) * 100)) : 0;

            html += `
            <div class="speed-model-item" style="background: #141418; border: 1px solid #23232c; border-radius: 3px; padding: 4px 7px; display: flex; flex-direction: column; gap: 2px; position: relative;">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 6px; min-width: 0;">
                    <div style="display: flex; align-items: center; gap: 5px; font-weight: 600; font-size: 11px; color: #eee; min-width: 0; flex: 1;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${colors.base}; display: inline-block; flex-shrink: 0; box-shadow: 0 0 4px ${hexToRgba(colors.base, 0.6)};"></span>
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1;" title="${escapeHtml(m.name || m.id)}">${escapeHtml(m.name || m.id)}</span>
                        <span style="font-size: 8.5px; padding: 0px 4px; border-radius: 2px; background: ${hexToRgba(statusColor, 0.15)}; color: ${statusColor}; border: 1px solid ${hexToRgba(statusColor, 0.35)}; font-family: var(--font-mono); font-weight: 700; white-space: nowrap; flex-shrink: 0; line-height: 13px;">
                            ${statusIcon} ${status}
                        </span>
                    </div>
                    <div style="font-family: var(--font-mono); font-weight: 700; font-size: 11px; color: ${speed > 0 ? '#00f0ff' : '#777'}; white-space: nowrap; flex-shrink: 0;">
                        ${formattedSpeed}
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; color: #888; font-family: var(--font-mono); width: 100%; gap: 6px; min-width: 0;">
                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1;" title="${stats.label}">${stats.label}</span>
                    <span style="color: #666; flex-shrink: 0; white-space: nowrap;">${speed > 0 ? `${Math.round(speed / Math.max(1, stats.effectiveCellUpdatesPerStep))} steps/s` : (status === 'RUNNING' ? 'Calculating...' : 'Idle')}</span>
                </div>
                <div style="width: 100%; height: 2px; background: #0a0a0d; border-radius: 1px; overflow: hidden; margin-top: 1px;">
                    <div style="height: 100%; width: ${barPct}%; background: ${speed > 0 ? colors.base : '#222'}; transition: width 0.3s ease;"></div>
                </div>
            </div>
            `;
        }

        listContainer.innerHTML = html;
        if (totalEl) {
            totalEl.innerText = this.formatCellsPerSec(totalSpeed);
        }
    }

    public updateMetrics(data: {
        cpu: number;
        ram_alloc: number;
        ram_system?: number;
        ram_total: number;
        gpu_util: number;
        vram_alloc: number;
        vram_blastdaemon?: number;
        vram_total: number;
        gpu_temp: number;
    }) {
        const cpu_pct = data.cpu;
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
        this.smoothed.cpu = this.smoothed.cpu * (1 - this.alpha) + cpu_pct * this.alpha;
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
        updateHistory(this.history.cpu, cpu_pct);
        updateHistory(this.history.ram_sys, ram_sys_pct);
        updateHistory(this.history.ram_bd, ram_bd_pct);
        updateHistory(this.history.gpu, gpu_pct);
        updateHistory(this.history.vram_sys, vram_sys_pct);
        updateHistory(this.history.vram_bd, vram_bd_pct);
        updateHistory(this.history.temp, temp_val);

        // Circular dash offset helper
        const setDashOffset = (elementId: string, percentage: number, circumference = 201.06) => {
            const el = this.container.querySelector<SVGCircleElement>(`#${this.panelId}-${elementId}`);
            if (el) {
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
        setDashOffset('ram-fill', this.smoothed.ram_sys_pct);
        setDashOffset('ram-fill-inner', this.smoothed.ram_bd_pct, 150.8);
        const formatRAM = (mb: number) => mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`;
        setTextValue('ram-val', `${Math.round(this.smoothed.ram_sys_pct)}%`);
        setTextValue('ram-bd-val', formatRAM(ram_alloc_mb));
        setTextValue('ram-sys-val', formatRAM(ram_sys_mb));
        toggleStress('ram', this.smoothed.ram_sys_pct, 85);
        this.drawSparkline('ram-canvas', this.history.ram_sys, '#10b981', this.history.ram_bd, '#34d399');

        // Render GPU
        setDashOffset('gpu-fill', this.smoothed.gpu);
        setTextValue('gpu-val', `${Math.round(this.smoothed.gpu)}%`);
        toggleStress('gpu', this.smoothed.gpu, 85);
        this.drawSparkline('gpu-canvas', this.history.gpu, '#00f0ff');

        // Render VRAM
        setDashOffset('vram-fill', this.smoothed.vram_sys_pct);
        setDashOffset('vram-fill-inner', this.smoothed.vram_bd_pct, 150.8);
        const formatVRAM = (mb: number) => vram_total_mb > 0 ? (mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`) : '0MB';
        setTextValue('vram-val', vram_total_mb > 0 ? `${Math.round(this.smoothed.vram_sys_pct)}%` : '0%');
        setTextValue('vram-bd-val', vram_total_mb > 0 ? formatVRAM(vram_bd_mb) : '0MB');
        setTextValue('vram-sys-val', vram_total_mb > 0 ? formatVRAM(vram_alloc_mb) : '0MB');
        toggleStress('vram', this.smoothed.vram_sys_pct, 85);
        this.drawSparkline('vram-canvas', this.history.vram_sys, '#f59e0b', this.history.vram_bd, '#fbbf24');

        // Render Temp
        setDashOffset('temp-fill', Math.min(100, this.smoothed.temp)); // clamp temp to gauge max
        setTextValue('temp-val', `${Math.round(this.smoothed.temp)}°C`);
        toggleStress('temp', this.smoothed.temp, 80);
        this.drawSparkline('temp-canvas', this.history.temp, '#ef4444');

        // Refresh speed card
        this.renderModelSpeedEntries();
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
        this.speedTrackers.clear();
        this.updateMetrics({
            cpu: 0,
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
