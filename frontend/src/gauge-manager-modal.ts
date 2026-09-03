import { Node, Model } from './types.js';
import { StateManager } from './state-manager.js';

export interface GaugeProbe {
    id: string;
    name?: string;
    x?: number;
    y?: number;
    z?: number;
    r?: number;
    plot?: boolean;
    active?: boolean;
    is_3d?: boolean;
    color?: string;
}

export class GaugeManagerModal {
    private overlay: HTMLDivElement | null = null;
    private stateManager: StateManager;
    private vgNode: Node;
    private model: Model;
    private selectedGaugeIdx: number | null = null;
    private checkedIndices: Set<number> = new Set();
    private searchQuery: string = '';
    private is3D: boolean = true;
    private xMin: number = -1.0;
    private xMax: number = 1.0;
    private yMin: number = -1.0;
    private yMax: number = 1.0;
    private zMin: number = -1.0;
    private zMax: number = 1.0;
    private rMin: number = 0.0;
    private rMax: number = 1.0;
    private chargeCenter: { x: number; y: number; z: number } | null = null;
    private chargeMass: number | null = null;

    private tableContainer: HTMLElement | null = null;
    private inspectorPane: HTMLElement | null = null;
    private footerStatusEl: HTMLElement | null = null;
    private onCloseCallback?: () => void;

    constructor(
        stateManager: StateManager,
        vgNode: Node,
        model: Model,
        initialSelectedIdx: number | null = null,
        onClose?: () => void
    ) {
        this.stateManager = stateManager;
        this.vgNode = vgNode;
        this.model = model;
        this.selectedGaugeIdx = initialSelectedIdx;
        this.onCloseCallback = onClose;

        this.detectDomainBounds();
        this.detectChargeLocation();
        this.createDOM();
    }

    private detectDomainBounds(): void {
        this.is3D = this.model.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D');
        const mesh3D = this.model.nodes.find(n => n.type === 'DomainMesh3D');
        if (mesh3D) {
            this.xMin = Number(mesh3D.parameters.xmin ?? -1.0);
            this.xMax = Number(mesh3D.parameters.xmax ?? 1.0);
            this.yMin = Number(mesh3D.parameters.ymin ?? -1.0);
            this.yMax = Number(mesh3D.parameters.ymax ?? 1.0);
            this.zMin = Number(mesh3D.parameters.zmin ?? -1.0);
            this.zMax = Number(mesh3D.parameters.zmax ?? 1.0);
        }
        const mesh2D = this.model.nodes.find(n => n.type === 'DomainMesh2D');
        if (mesh2D) {
            this.rMin = 0.0;
            this.rMax = Number(mesh2D.parameters.rmax ?? mesh2D.parameters.r_max ?? 1.0);
            this.zMin = Number(mesh2D.parameters.zmin ?? mesh2D.parameters.z_min ?? -1.0);
            this.zMax = Number(mesh2D.parameters.zmax ?? 1.0);
        }
    }

    private detectChargeLocation(): void {
        const chargeNode = this.model.nodes.find(n => n.type === 'Charge3D' || n.type === 'Charge2D' || n.type === 'Charge1D');
        const detNode = this.model.nodes.find(n => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation');

        if (chargeNode) {
            const p = chargeNode.parameters;
            const cx = Number(p.center_x ?? p.x ?? 0.0);
            const cy = Number(p.center_y ?? p.y ?? 0.0);
            const cz = Number(p.center_z ?? p.z ?? p.center_r ?? 0.0);
            this.chargeCenter = { x: cx, y: cy, z: cz };
            if (p.charge_mass !== undefined) {
                this.chargeMass = Number(p.charge_mass);
            }
        } else if (detNode) {
            const p = detNode.parameters;
            const cx = Number(p.det_x ?? p.x ?? 0.0);
            const cy = Number(p.det_y ?? p.y ?? 0.0);
            const cz = Number(p.det_z ?? p.z ?? 0.0);
            this.chargeCenter = { x: cx, y: cy, z: cz };
        }
    }

    private getGauges(): GaugeProbe[] {
        return [...(this.vgNode.parameters.gauges || [])];
    }

    private setGauges(gauges: GaugeProbe[], invalidate: boolean = true): void {
        this.vgNode.parameters.gauges = gauges;
        if (invalidate) {
            this.stateManager.updateNodeParameters(this.vgNode.id, { gauges });
            this.stateManager.setModelStatus(this.model.id, 'UNINITIALIZED');
        } else {
            this.stateManager.updateNodeParametersInPlace(this.vgNode.id, { gauges });
        }
        const vpNode = this.model.nodes.find(n => n.type === 'Telemetry3DViewport');
        if (vpNode) {
            this.stateManager.updateNodeParametersInPlace(vpNode.id, { _gauge_ts: Date.now() });
        }
    }

    private calculateStandoff(gauge: GaugeProbe): { r: number | null; zScaled: number | null } {
        if (!this.chargeCenter) return { r: null, zScaled: null };
        const gx = gauge.x !== undefined ? Number(gauge.x) : (gauge.r !== undefined ? Number(gauge.r) : 0.0);
        const gy = gauge.y !== undefined ? Number(gauge.y) : 0.0;
        const gz = gauge.z !== undefined ? Number(gauge.z) : 0.0;

        let dist: number;
        if (this.is3D) {
            dist = Math.sqrt(
                Math.pow(gx - this.chargeCenter.x, 2) +
                Math.pow(gy - this.chargeCenter.y, 2) +
                Math.pow(gz - this.chargeCenter.z, 2)
            );
        } else {
            dist = Math.sqrt(
                Math.pow(gx - this.chargeCenter.x, 2) +
                Math.pow(gz - this.chargeCenter.z, 2)
            );
        }

        let zScaled: number | null = null;
        if (this.chargeMass && this.chargeMass > 0) {
            zScaled = dist / Math.cbrt(this.chargeMass);
        }
        return { r: dist, zScaled };
    }

    private getTelemetryMetrics(gauge: GaugeProbe, gaugeIdx: number): { pMax: number; impulse: number; times: number[]; pressures: number[] } {
        let times: number[] = [];
        let pressures: number[] = [];
        let impulses: number[] = [];
        let pMax = 0.0;
        let impMax = 0.0;

        const tData = this.stateManager.telemetryStore.get(this.vgNode.id);
        if (tData && tData.gauges_history) {
            const gId = gauge.id || gauge.name || `G${gaugeIdx + 1}`;
            const gh = tData.gauges_history.find((h: any) => h.id === gId || h.id === String(gaugeIdx));
            if (gh && gh.channel_values) {
                pressures = gh.channel_values[0] || [];
                impulses = gh.channel_values[8] || [];
                times = tData.gauge_times || [];
                for (const p of pressures) {
                    if (p > pMax) pMax = p;
                }
                for (const imp of impulses) {
                    if (imp > impMax) impMax = imp;
                }
            }
        }
        return { pMax, impulse: impMax, times, pressures };
    }

    private createDOM(): void {
        const existing = document.querySelector('.gmm-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'gmm-overlay';
        this.overlay = overlay;

        // Escape key listener
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.close();
            }
        };
        window.addEventListener('keydown', keyHandler);
        overlay.dataset.keyHandler = 'true';

        // Backdrop click to close if clicking outside modal box
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this.close();
            }
        });

        const box = document.createElement('div');
        box.className = 'gmm-box';
        overlay.appendChild(box);

        // 1. Header
        const header = document.createElement('div');
        header.className = 'gmm-header';

        const titleBox = document.createElement('div');
        titleBox.className = 'gmm-title-box';
        const titleIcon = document.createElement('span');
        titleIcon.className = 'gmm-title-icon';
        titleIcon.textContent = '⏱️';
        const titleText = document.createElement('div');
        titleText.className = 'gmm-title-text';
        titleText.innerHTML = `<strong>Virtual Gauge Manager & Data Grid</strong> <span class="gmm-model-tag">${this.model.name} · ${this.vgNode.parameters.name || this.vgNode.id}</span>`;
        titleBox.appendChild(titleIcon);
        titleBox.appendChild(titleText);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gmm-close-btn';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Close Window (Esc)';
        closeBtn.onclick = () => this.close();

        header.appendChild(titleBox);
        header.appendChild(closeBtn);
        box.appendChild(header);

        // 2. Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'gmm-toolbar';

        // Search Input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'gmm-search-input';
        searchInput.placeholder = '🔍 Search by ID, name, or coordinates...';
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', () => {
            this.searchQuery = searchInput.value.toLowerCase().trim();
            this.renderTable();
        });
        toolbar.appendChild(searchInput);

        // Action Buttons
        const btnGroup = document.createElement('div');
        btnGroup.className = 'gmm-btn-group';

        const addBtn = document.createElement('button');
        addBtn.className = 'gmm-action-btn primary';
        addBtn.innerHTML = '<span>➕</span> <span>Add Probe</span>';
        addBtn.title = 'Add a new virtual gauge probe at domain center';
        addBtn.onclick = () => this.addSingleProbe();
        btnGroup.appendChild(addBtn);

        const rakeBtn = document.createElement('button');
        rakeBtn.className = 'gmm-action-btn';
        rakeBtn.innerHTML = '<span>📐</span> <span>Linear Rake...</span>';
        rakeBtn.title = 'Generate an array of probes distributed evenly along a line';
        rakeBtn.onclick = () => this.openRakeGeneratorDialog();
        btnGroup.appendChild(rakeBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'gmm-action-btn';
        importBtn.innerHTML = '<span>📥</span> <span>Import CSV</span>';
        importBtn.title = 'Import probe coordinates from a CSV file';
        importBtn.onclick = () => this.triggerCsvImport();
        btnGroup.appendChild(importBtn);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'gmm-action-btn';
        exportBtn.innerHTML = '<span>📤</span> <span>Export CSV</span>';
        exportBtn.title = 'Export all probe definitions to CSV';
        exportBtn.onclick = () => this.exportAllCsv();
        btnGroup.appendChild(exportBtn);

        const toggleAllBtn = document.createElement('button');
        toggleAllBtn.className = 'gmm-action-btn';
        toggleAllBtn.innerHTML = '<span>👁</span> <span>Toggle Plot</span>';
        toggleAllBtn.title = 'Toggle plotting on/off for all probes';
        toggleAllBtn.onclick = () => this.toggleAllPlotting();
        btnGroup.appendChild(toggleAllBtn);

        const delSelectedBtn = document.createElement('button');
        delSelectedBtn.className = 'gmm-action-btn danger';
        delSelectedBtn.innerHTML = '<span>🗑</span> <span>Delete Selected</span>';
        delSelectedBtn.title = 'Delete all checked probes in table';
        delSelectedBtn.onclick = () => this.deleteCheckedProbes();
        btnGroup.appendChild(delSelectedBtn);

        toolbar.appendChild(btnGroup);
        box.appendChild(toolbar);

        // 3. Body Split (Data Grid Table on Left, Inspector on Right)
        const bodySplit = document.createElement('div');
        bodySplit.className = 'gmm-body-split';

        const tableContainer = document.createElement('div');
        tableContainer.className = 'gmm-table-container';
        this.tableContainer = tableContainer;
        bodySplit.appendChild(tableContainer);

        const inspectorPane = document.createElement('div');
        inspectorPane.className = 'gmm-inspector-pane';
        this.inspectorPane = inspectorPane;
        bodySplit.appendChild(inspectorPane);

        box.appendChild(bodySplit);

        // 4. Footer Status Bar
        const footer = document.createElement('div');
        footer.className = 'gmm-footer';

        const statusEl = document.createElement('div');
        statusEl.className = 'gmm-footer-status';
        this.footerStatusEl = statusEl;
        footer.appendChild(statusEl);

        const footerCloseBtn = document.createElement('button');
        footerCloseBtn.className = 'gmm-footer-close-btn';
        footerCloseBtn.textContent = 'Done';
        footerCloseBtn.onclick = () => this.close();
        footer.appendChild(footerCloseBtn);

        box.appendChild(footer);

        document.body.appendChild(overlay);

        // Initial Renders
        this.renderTable();
        this.renderInspector();
    }

    public render(): void {
        this.renderTable();
        this.renderInspector();
    }

    private renderTable(): void {
        if (!this.tableContainer) return;
        this.tableContainer.innerHTML = '';

        const gauges = this.getGauges();
        const totalCount = gauges.length;

        // Filter gauges based on search query
        const indexedGauges = gauges.map((g, idx) => ({ gauge: g, idx }));
        const filtered = indexedGauges.filter(({ gauge, idx }) => {
            if (!this.searchQuery) return true;
            const idStr = (gauge.id || '').toLowerCase();
            const nameStr = (gauge.name || '').toLowerCase();
            const numStr = `#${idx + 1}`;
            const coordsStr = `${gauge.x ?? ''} ${gauge.y ?? ''} ${gauge.z ?? ''} ${gauge.r ?? ''}`;
            return idStr.includes(this.searchQuery) ||
                   nameStr.includes(this.searchQuery) ||
                   numStr.includes(this.searchQuery) ||
                   coordsStr.includes(this.searchQuery);
        });

        // Update Footer Status
        const activePlotCount = gauges.filter(g => g.plot !== false).length;
        if (this.footerStatusEl) {
            this.footerStatusEl.innerHTML = `
                <span>Total Probes: <strong>${totalCount}</strong></span>
                <span class="gmm-sep">·</span>
                <span>Active for Plotting: <strong style="color: #38bdf8;">${activePlotCount}</strong></span>
                <span class="gmm-sep">·</span>
                <span>Checked: <strong>${this.checkedIndices.size}</strong></span>
                <span class="gmm-sep">·</span>
                <span>Storage: <strong>${this.vgNode.parameters.storage_backend || 'HDF5 Stream'}</strong></span>
            `;
        }

        if (totalCount === 0) {
            const emptyNotice = document.createElement('div');
            emptyNotice.className = 'gmm-empty-state';
            emptyNotice.innerHTML = `
                <div class="gmm-empty-icon">⏱️</div>
                <div class="gmm-empty-title">No Virtual Gauges Defined</div>
                <div class="gmm-empty-desc">Add individual sensor probes or generate an automated linear rake along a blast propagation path.</div>
                <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <button class="gmm-action-btn primary" id="gmm-empty-add-btn">➕ Add First Probe</button>
                    <button class="gmm-action-btn" id="gmm-empty-rake-btn">📐 Generate Rake</button>
                </div>
            `;
            this.tableContainer.appendChild(emptyNotice);
            emptyNotice.querySelector('#gmm-empty-add-btn')?.addEventListener('click', () => this.addSingleProbe());
            emptyNotice.querySelector('#gmm-empty-rake-btn')?.addEventListener('click', () => this.openRakeGeneratorDialog());
            return;
        }

        const table = document.createElement('table');
        table.className = 'gmm-data-table';

        // Sticky Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        // Checkbox Master
        const thCheck = document.createElement('th');
        thCheck.style.width = '32px';
        const masterCheck = document.createElement('input');
        masterCheck.type = 'checkbox';
        masterCheck.title = 'Select / Deselect all';
        masterCheck.checked = filtered.length > 0 && filtered.every(({ idx }) => this.checkedIndices.has(idx));
        masterCheck.onchange = () => {
            if (masterCheck.checked) {
                filtered.forEach(({ idx }) => this.checkedIndices.add(idx));
            } else {
                filtered.forEach(({ idx }) => this.checkedIndices.delete(idx));
            }
            this.renderTable();
        };
        thCheck.appendChild(masterCheck);
        headerRow.appendChild(thCheck);

        // Columns
        const thPlot = document.createElement('th');
        thPlot.style.width = '36px';
        thPlot.textContent = 'Plot';
        thPlot.title = 'Toggle plotting visibility in charts and telemetry';
        headerRow.appendChild(thPlot);

        const thIdx = document.createElement('th');
        thIdx.style.width = '44px';
        thIdx.textContent = '#';
        headerRow.appendChild(thIdx);

        const thId = document.createElement('th');
        thId.style.width = '80px';
        thId.textContent = 'ID';
        headerRow.appendChild(thId);

        const thName = document.createElement('th');
        thName.style.width = '120px';
        thName.textContent = 'Name';
        headerRow.appendChild(thName);

        if (this.is3D) {
            const thX = document.createElement('th');
            thX.textContent = 'X [m]';
            headerRow.appendChild(thX);

            const thY = document.createElement('th');
            thY.textContent = 'Y [m]';
            headerRow.appendChild(thY);

            const thZ = document.createElement('th');
            thZ.textContent = 'Z [m]';
            headerRow.appendChild(thZ);
        } else {
            const thR = document.createElement('th');
            thR.textContent = 'R [m]';
            headerRow.appendChild(thR);

            const thZ = document.createElement('th');
            thZ.textContent = 'Z [m]';
            headerRow.appendChild(thZ);
        }

        const thStandoff = document.createElement('th');
        thStandoff.style.width = '90px';
        thStandoff.textContent = 'Standoff R';
        thStandoff.title = 'Distance from detonator / charge center [m]';
        headerRow.appendChild(thStandoff);

        const thPmax = document.createElement('th');
        thPmax.style.width = '85px';
        thPmax.textContent = 'P_max';
        thPmax.title = 'Peak recorded overpressure [kPa]';
        headerRow.appendChild(thPmax);

        const thActions = document.createElement('th');
        thActions.style.width = '64px';
        thActions.style.textAlign = 'right';
        thActions.textContent = 'Actions';
        headerRow.appendChild(thActions);

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body Rows
        const tbody = document.createElement('tbody');

        filtered.forEach(({ gauge, idx }) => {
            const tr = document.createElement('tr');
            tr.className = `gmm-data-row ${this.selectedGaugeIdx === idx ? 'selected' : ''}`;

            // Checkbox Cell
            const tdCheck = document.createElement('td');
            const rowCheck = document.createElement('input');
            rowCheck.type = 'checkbox';
            rowCheck.checked = this.checkedIndices.has(idx);
            rowCheck.onchange = (e) => {
                e.stopPropagation();
                if (rowCheck.checked) this.checkedIndices.add(idx);
                else this.checkedIndices.delete(idx);
                this.renderTable();
            };
            tdCheck.appendChild(rowCheck);
            tr.appendChild(tdCheck);

            // Plot Toggle (Eye Icon)
            const tdPlot = document.createElement('td');
            const isPlotted = gauge.plot !== false && gauge.active !== false;
            const eyeBtn = document.createElement('button');
            eyeBtn.className = `gmm-eye-btn ${isPlotted ? 'active' : 'inactive'}`;
            eyeBtn.innerHTML = isPlotted ? '👁' : '🚫';
            eyeBtn.title = isPlotted ? 'Plotting Enabled — Click to disable' : 'Plotting Disabled — Click to enable';
            eyeBtn.onclick = (e) => {
                e.stopPropagation();
                gauge.plot = !isPlotted;
                const current = this.getGauges();
                current[idx] = { ...gauge, plot: !isPlotted };
                this.setGauges(current, false);
                this.renderTable();
                if (this.selectedGaugeIdx === idx) this.renderInspector();
            };
            tdPlot.appendChild(eyeBtn);
            tr.appendChild(tdPlot);

            // Index
            const tdIdx = document.createElement('td');
            tdIdx.className = 'gmm-cell-mono';
            tdIdx.textContent = `#${idx + 1}`;
            tr.appendChild(tdIdx);

            // ID (In-place editable on double click)
            const tdId = document.createElement('td');
            tdId.className = 'gmm-cell-editable';
            tdId.textContent = gauge.id || `G${idx + 1}`;
            tdId.title = 'Double-click to rename ID';
            tdId.ondblclick = (e) => {
                e.stopPropagation();
                this.makeCellEditable(tdId, gauge.id || `G${idx + 1}`, (newVal) => {
                    const current = this.getGauges();
                    current[idx] = { ...gauge, id: newVal };
                    this.setGauges(current, false);
                    this.renderTable();
                    if (this.selectedGaugeIdx === idx) this.renderInspector();
                });
            };
            tr.appendChild(tdId);

            // Name
            const tdName = document.createElement('td');
            tdName.className = 'gmm-cell-editable';
            tdName.textContent = gauge.name || gauge.id || `Gauge ${idx + 1}`;
            tdName.title = 'Double-click to edit name';
            tdName.ondblclick = (e) => {
                e.stopPropagation();
                this.makeCellEditable(tdName, gauge.name || gauge.id || `Gauge ${idx + 1}`, (newVal) => {
                    const current = this.getGauges();
                    current[idx] = { ...gauge, name: newVal };
                    this.setGauges(current, false);
                    this.renderTable();
                    if (this.selectedGaugeIdx === idx) this.renderInspector();
                });
            };
            tr.appendChild(tdName);

            // Spatial Coordinates
            if (this.is3D) {
                const tdX = document.createElement('td');
                tdX.className = 'gmm-cell-mono gmm-cell-editable';
                const curX = gauge.x !== undefined ? Number(gauge.x) : 0.0;
                tdX.textContent = curX.toFixed(4);
                tdX.ondblclick = (e) => {
                    e.stopPropagation();
                    this.makeCellEditable(tdX, String(curX), (newVal) => {
                        const val = parseFloat(newVal);
                        if (!isNaN(val)) {
                            const current = this.getGauges();
                            current[idx] = { ...gauge, x: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdX);

                const tdY = document.createElement('td');
                tdY.className = 'gmm-cell-mono gmm-cell-editable';
                const curY = gauge.y !== undefined ? Number(gauge.y) : 0.0;
                tdY.textContent = curY.toFixed(4);
                tdY.ondblclick = (e) => {
                    e.stopPropagation();
                    this.makeCellEditable(tdY, String(curY), (newVal) => {
                        const val = parseFloat(newVal);
                        if (!isNaN(val)) {
                            const current = this.getGauges();
                            current[idx] = { ...gauge, y: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdY);

                const tdZ = document.createElement('td');
                tdZ.className = 'gmm-cell-mono gmm-cell-editable';
                const curZ = gauge.z !== undefined ? Number(gauge.z) : 0.0;
                tdZ.textContent = curZ.toFixed(4);
                tdZ.ondblclick = (e) => {
                    e.stopPropagation();
                    this.makeCellEditable(tdZ, String(curZ), (newVal) => {
                        const val = parseFloat(newVal);
                        if (!isNaN(val)) {
                            const current = this.getGauges();
                            current[idx] = { ...gauge, z: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdZ);
            } else {
                const tdR = document.createElement('td');
                tdR.className = 'gmm-cell-mono gmm-cell-editable';
                const curR = gauge.r !== undefined ? Number(gauge.r) : (gauge.x !== undefined ? Number(gauge.x) : 0.0);
                tdR.textContent = curR.toFixed(4);
                tdR.ondblclick = (e) => {
                    e.stopPropagation();
                    this.makeCellEditable(tdR, String(curR), (newVal) => {
                        const val = parseFloat(newVal);
                        if (!isNaN(val)) {
                            const current = this.getGauges();
                            current[idx] = { ...gauge, r: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdR);

                const tdZ = document.createElement('td');
                tdZ.className = 'gmm-cell-mono gmm-cell-editable';
                const curZ = gauge.z !== undefined ? Number(gauge.z) : 0.0;
                tdZ.textContent = curZ.toFixed(4);
                tdZ.ondblclick = (e) => {
                    e.stopPropagation();
                    this.makeCellEditable(tdZ, String(curZ), (newVal) => {
                        const val = parseFloat(newVal);
                        if (!isNaN(val)) {
                            const current = this.getGauges();
                            current[idx] = { ...gauge, z: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdZ);
            }

            // Standoff R
            const standoff = this.calculateStandoff(gauge);
            const tdStandoff = document.createElement('td');
            tdStandoff.className = 'gmm-cell-mono';
            tdStandoff.style.color = '#94a3b8';
            tdStandoff.textContent = standoff.r !== null ? `${standoff.r.toFixed(3)} m` : '—';
            if (standoff.zScaled !== null) {
                tdStandoff.title = `Scaled distance Z = ${standoff.zScaled.toFixed(3)} m/kg^(1/3)`;
            }
            tr.appendChild(tdStandoff);

            // P_max
            const telemetry = this.getTelemetryMetrics(gauge, idx);
            const tdPmax = document.createElement('td');
            tdPmax.className = 'gmm-cell-mono';
            if (telemetry.pMax > 0) {
                tdPmax.textContent = `${(telemetry.pMax / 1e3).toFixed(1)} kPa`;
                tdPmax.style.color = '#f87171';
                tdPmax.style.fontWeight = 'bold';
            } else {
                tdPmax.textContent = '—';
                tdPmax.style.color = '#64748b';
            }
            tr.appendChild(tdPmax);

            // Actions
            const tdActions = document.createElement('td');
            tdActions.style.textAlign = 'right';

            const dupBtn = document.createElement('button');
            dupBtn.className = 'gmm-row-icon-btn';
            dupBtn.innerHTML = '📑';
            dupBtn.title = 'Duplicate probe';
            dupBtn.onclick = (e) => {
                e.stopPropagation();
                this.duplicateProbe(idx);
            };
            tdActions.appendChild(dupBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'gmm-row-icon-btn danger';
            delBtn.innerHTML = '✖';
            delBtn.title = 'Delete probe';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                this.deleteSingleProbe(idx);
            };
            tdActions.appendChild(delBtn);

            tr.appendChild(tdActions);

            // Click Row to Select
            tr.onclick = () => {
                this.selectedGaugeIdx = idx;
                this.stateManager.setSelectedGaugeIndex(idx);
                this.renderTable();
                this.renderInspector();
            };

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        this.tableContainer.appendChild(table);
    }

    private makeCellEditable(cell: HTMLElement, initialValue: string, onCommit: (val: string) => void): void {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gmm-inline-input';
        input.value = initialValue;

        const finish = (commit: boolean) => {
            if (commit) onCommit(input.value);
            else cell.textContent = initialValue;
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        };
        input.onblur = () => finish(true);

        cell.innerHTML = '';
        cell.appendChild(input);
        input.focus();
        input.select();
    }

    private renderInspector(): void {
        if (!this.inspectorPane) return;
        this.inspectorPane.innerHTML = '';

        const gauges = this.getGauges();
        if (this.selectedGaugeIdx === null || !gauges[this.selectedGaugeIdx]) {
            const placeholder = document.createElement('div');
            placeholder.className = 'gmm-inspector-placeholder';
            placeholder.innerHTML = `
                <div class="gmm-inspector-placeholder-icon">🎯</div>
                <div class="gmm-inspector-placeholder-title">No Probe Selected</div>
                <div class="gmm-inspector-placeholder-desc">Click any row in the spreadsheet to inspect and tune its spatial coordinates, standoff distance, and real-time waveform.</div>
            `;
            this.inspectorPane.appendChild(placeholder);
            return;
        }

        const gaugeIdx = this.selectedGaugeIdx;
        const gauge = gauges[gaugeIdx];
        const standoff = this.calculateStandoff(gauge);
        const telemetry = this.getTelemetryMetrics(gauge, gaugeIdx);

        // Header Card
        const cardHeader = document.createElement('div');
        cardHeader.className = 'gmm-inspector-card-header';

        const titleDiv = document.createElement('div');
        titleDiv.innerHTML = `<span style="font-size: 14px; font-weight: bold; color: #38bdf8;">#${gaugeIdx + 1} ${gauge.name || gauge.id}</span>`;
        cardHeader.appendChild(titleDiv);

        const deselectBtn = document.createElement('button');
        deselectBtn.className = 'gmm-inspector-close-btn';
        deselectBtn.innerHTML = '✕';
        deselectBtn.title = 'Unfocus probe';
        deselectBtn.onclick = () => {
            this.selectedGaugeIdx = null;
            this.stateManager.setSelectedGaugeIndex(null);
            this.renderTable();
            this.renderInspector();
        };
        cardHeader.appendChild(deselectBtn);
        this.inspectorPane.appendChild(cardHeader);

        // Accordion 1: Coordinates
        const coordSec = document.createElement('div');
        coordSec.className = 'gmm-inspector-section';
        const coordHdr = document.createElement('div');
        coordHdr.className = 'gmm-inspector-sec-title';
        coordHdr.textContent = 'Spatial Coordinates';
        coordSec.appendChild(coordHdr);

        const coordTable = document.createElement('table');
        coordTable.className = 'gmm-inspector-table';

        const updateCoord = (key: 'x' | 'y' | 'z' | 'r', val: number) => {
            const current = this.getGauges();
            current[gaugeIdx] = { ...gauge, [key]: val };
            this.setGauges(current, true);
            this.renderTable();
            this.renderInspector();
        };

        if (this.is3D) {
            coordTable.appendChild(this.createCoordRow('X-Coordinate [m]', gauge.x ?? 0.0, this.xMin, this.xMax, (v) => updateCoord('x', v)));
            coordTable.appendChild(this.createCoordRow('Y-Coordinate [m]', gauge.y ?? 0.0, this.yMin, this.yMax, (v) => updateCoord('y', v)));
            coordTable.appendChild(this.createCoordRow('Z-Coordinate [m]', gauge.z ?? 0.0, this.zMin, this.zMax, (v) => updateCoord('z', v)));
        } else {
            coordTable.appendChild(this.createCoordRow('R-Coordinate [m]', gauge.r ?? (gauge.x ?? 0.0), this.rMin, this.rMax, (v) => updateCoord('r', v)));
            coordTable.appendChild(this.createCoordRow('Z-Coordinate [m]', gauge.z ?? 0.0, this.zMin, this.zMax, (v) => updateCoord('z', v)));
        }
        coordSec.appendChild(coordTable);
        this.inspectorPane.appendChild(coordSec);

        // Accordion 2: Blast Standoff Metrics
        if (standoff.r !== null) {
            const standoffSec = document.createElement('div');
            standoffSec.className = 'gmm-inspector-section';
            const standoffHdr = document.createElement('div');
            standoffHdr.className = 'gmm-inspector-sec-title';
            standoffHdr.textContent = 'Blast Standoff Physics';
            standoffSec.appendChild(standoffHdr);

            const grid = document.createElement('div');
            grid.className = 'gmm-metrics-grid';

            const rCard = document.createElement('div');
            rCard.className = 'gmm-metric-card';
            rCard.innerHTML = `<span class="gmm-metric-lbl">Standoff Distance (R)</span><span class="gmm-metric-val">${standoff.r.toFixed(3)} m</span>`;
            grid.appendChild(rCard);

            if (standoff.zScaled !== null) {
                const zCard = document.createElement('div');
                zCard.className = 'gmm-metric-card';
                zCard.innerHTML = `<span class="gmm-metric-lbl">Scaled Standoff (Z)</span><span class="gmm-metric-val">${standoff.zScaled.toFixed(3)} m/kg^(1/3)</span>`;
                grid.appendChild(zCard);
            }
            standoffSec.appendChild(grid);
            this.inspectorPane.appendChild(standoffSec);
        }

        // Accordion 3: Live Waveform Interrogation
        const waveSec = document.createElement('div');
        waveSec.className = 'gmm-inspector-section';
        const waveHdr = document.createElement('div');
        waveHdr.className = 'gmm-inspector-sec-title';
        waveHdr.textContent = 'Live Telemetry & Waveform';
        waveSec.appendChild(waveHdr);

        const metricsRow = document.createElement('div');
        metricsRow.style.display = 'flex';
        metricsRow.style.gap = '8px';
        metricsRow.style.marginBottom = '8px';

        const pBadge = document.createElement('div');
        pBadge.className = 'gmm-telemetry-badge red';
        pBadge.innerHTML = `P_max: <strong>${(telemetry.pMax / 1e3).toFixed(1)} kPa</strong>`;
        metricsRow.appendChild(pBadge);

        const impBadge = document.createElement('div');
        impBadge.className = 'gmm-telemetry-badge blue';
        impBadge.innerHTML = `Impulse: <strong>${telemetry.impulse.toFixed(1)} Pa·s</strong>`;
        metricsRow.appendChild(impBadge);
        waveSec.appendChild(metricsRow);

        // Sparkline Canvas
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'gmm-sparkline-box';
        const canvas = document.createElement('canvas');
        canvasContainer.appendChild(canvas);
        waveSec.appendChild(canvasContainer);

        requestAnimationFrame(() => {
            const rect = canvasContainer.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.max(10, Math.floor(rect.width * dpr));
            canvas.height = Math.max(10, Math.floor(rect.height * dpr));
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.scale(dpr, dpr);

            const w = rect.width;
            const h = rect.height;
            ctx.clearRect(0, 0, w, h);

            if (telemetry.pressures.length < 2) {
                ctx.fillStyle = '#64748b';
                ctx.font = '11px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Awaiting Simulation Telemetry...', w / 2, h / 2);
                return;
            }

            const minP = Math.min(...telemetry.pressures);
            const maxP = Math.max(...telemetry.pressures);
            const range = (maxP - minP) || 1.0;

            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < telemetry.pressures.length; ++i) {
                const cx = (i / (telemetry.pressures.length - 1)) * (w - 10) + 5;
                const cy = h - 5 - ((telemetry.pressures[i] - minP) / range) * (h - 10);
                if (i === 0) ctx.moveTo(cx, cy);
                else ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        });

        this.inspectorPane.appendChild(waveSec);

        // Inspector Action Buttons
        const actSec = document.createElement('div');
        actSec.className = 'gmm-inspector-actions';

        const pinnedIds: string[] = this.vgNode.parameters.pinned_probe_ids || [];
        const isPinned = pinnedIds.includes(gauge.id || '') || pinnedIds.includes(String(gaugeIdx));

        const pinBtn = document.createElement('button');
        pinBtn.className = `gmm-action-btn ${isPinned ? 'warning' : ''}`;
        pinBtn.innerHTML = isPinned ? '<span>📌</span> <span>Pinned to Watch</span>' : '<span>📌</span> <span>Pin to Watch</span>';
        pinBtn.onclick = () => {
            const gId = gauge.id || String(gaugeIdx);
            let nextPinned = [...pinnedIds];
            if (isPinned) nextPinned = nextPinned.filter(id => id !== gId && id !== String(gaugeIdx));
            else nextPinned.push(gId);
            this.stateManager.updateNodeParametersInPlace(this.vgNode.id, { pinned_probe_ids: nextPinned });
            this.renderInspector();
        };
        actSec.appendChild(pinBtn);

        const csvBtn = document.createElement('button');
        csvBtn.className = 'gmm-action-btn';
        csvBtn.innerHTML = '<span>💾</span> <span>Export CSV</span>';
        csvBtn.onclick = () => {
            let csv = 'time_s,pressure_Pa,impulse_Pas\n';
            for (let i = 0; i < telemetry.times.length; ++i) {
                csv += `${telemetry.times[i]},${telemetry.pressures[i] ?? 0.0},${telemetry.times[i] ?? 0.0}\n`;
            }
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `probe_${gauge.id || gaugeIdx + 1}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        };
        actSec.appendChild(csvBtn);

        const dupBtn = document.createElement('button');
        dupBtn.className = 'gmm-action-btn';
        dupBtn.innerHTML = '<span>📑</span> <span>Duplicate</span>';
        dupBtn.onclick = () => this.duplicateProbe(gaugeIdx);
        actSec.appendChild(dupBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'gmm-action-btn danger';
        delBtn.innerHTML = '<span>🗑</span> <span>Delete</span>';
        delBtn.onclick = () => this.deleteSingleProbe(gaugeIdx);
        actSec.appendChild(delBtn);

        this.inspectorPane.appendChild(actSec);
    }

    private createCoordRow(label: string, curVal: number, minVal: number, maxVal: number, onChange: (val: number) => void): HTMLElement {
        const tr = document.createElement('tr');
        tr.className = 'gmm-inspector-row';

        const tdLbl = document.createElement('td');
        tdLbl.className = 'gmm-inspector-lbl';
        tdLbl.textContent = label;
        tr.appendChild(tdLbl);

        const tdVal = document.createElement('td');
        tdVal.className = 'gmm-inspector-val';

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.step = 'any';
        numInput.className = 'gmm-coord-input';
        numInput.value = String(curVal);

        const commit = () => {
            const v = parseFloat(numInput.value);
            if (!isNaN(v)) {
                onChange(v);
            }
        };

        numInput.onchange = commit;
        numInput.onblur = commit;
        numInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                numInput.blur();
            }
        });

        tdVal.appendChild(numInput);
        tr.appendChild(tdVal);

        return tr;
    }

    private addSingleProbe(): void {
        const current = this.getGauges();
        const nextIdx = current.length + 1;
        const newProbe: GaugeProbe = this.is3D ? {
            id: `G${nextIdx}`,
            name: `Gauge ${nextIdx}`,
            x: (this.xMin + this.xMax) / 2.0,
            y: (this.yMin + this.yMax) / 2.0,
            z: (this.zMin + this.zMax) / 2.0,
            plot: true,
            active: true
        } : {
            id: `G${nextIdx}`,
            name: `Gauge ${nextIdx}`,
            r: this.rMax / 2.0,
            z: (this.zMin + this.zMax) / 2.0,
            plot: true,
            active: true
        };

        const updated = [...current, newProbe];
        this.setGauges(updated, true);
        this.selectedGaugeIdx = updated.length - 1;
        this.stateManager.setSelectedGaugeIndex(this.selectedGaugeIdx);
        this.renderTable();
        this.renderInspector();
    }

    private duplicateProbe(idx: number): void {
        const current = this.getGauges();
        if (idx < 0 || idx >= current.length) return;
        const source = current[idx];
        const nextIdx = current.length + 1;
        const dup: GaugeProbe = {
            ...source,
            id: `G${nextIdx}`,
            name: `${source.name || source.id} (Copy)`,
            x: source.x !== undefined ? source.x + 0.05 : undefined,
            y: source.y !== undefined ? source.y + 0.05 : undefined,
            z: source.z !== undefined ? source.z + 0.05 : undefined,
            r: source.r !== undefined ? source.r + 0.05 : undefined
        };
        const updated = [...current, dup];
        this.setGauges(updated, true);
        this.selectedGaugeIdx = updated.length - 1;
        this.stateManager.setSelectedGaugeIndex(this.selectedGaugeIdx);
        this.renderTable();
        this.renderInspector();
    }

    private deleteSingleProbe(idx: number): void {
        const current = this.getGauges();
        if (idx < 0 || idx >= current.length) return;
        const updated = current.filter((_, i) => i !== idx);
        this.checkedIndices.delete(idx);
        this.setGauges(updated, true);
        if (this.selectedGaugeIdx === idx) {
            this.selectedGaugeIdx = updated.length > 0 ? Math.min(idx, updated.length - 1) : null;
            this.stateManager.setSelectedGaugeIndex(this.selectedGaugeIdx);
        } else if (this.selectedGaugeIdx !== null && this.selectedGaugeIdx > idx) {
            this.selectedGaugeIdx--;
            this.stateManager.setSelectedGaugeIndex(this.selectedGaugeIdx);
        }
        this.renderTable();
        this.renderInspector();
    }

    private deleteCheckedProbes(): void {
        if (this.checkedIndices.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${this.checkedIndices.size} selected virtual gauge probe(s)?`)) return;

        const current = this.getGauges();
        const updated = current.filter((_, idx) => !this.checkedIndices.has(idx));
        this.checkedIndices.clear();
        this.selectedGaugeIdx = null;
        this.stateManager.setSelectedGaugeIndex(null);
        this.setGauges(updated, true);
        this.renderTable();
        this.renderInspector();
    }

    private toggleAllPlotting(): void {
        const current = this.getGauges();
        if (current.length === 0) return;
        const anyDisabled = current.some(g => g.plot === false);
        const targetState = anyDisabled; // if any disabled, turn all on, otherwise turn all off
        const updated = current.map(g => ({ ...g, plot: targetState }));
        this.setGauges(updated, false);
        this.renderTable();
        this.renderInspector();
    }

    private openRakeGeneratorDialog(): void {
        const modal = document.createElement('div');
        modal.className = 'gmm-rake-modal-overlay';

        const box = document.createElement('div');
        box.className = 'gmm-rake-dialog';
        box.innerHTML = `
            <div class="gmm-rake-title">📐 Linear Probe Rake / Array Generator</div>
            <div class="gmm-rake-desc">Automatically generates and spaces probes along a line from Point A to Point B. Ideal for standoff blast interrogation.</div>
            <div class="gmm-rake-form">
                <div class="gmm-rake-row">
                    <label>Start Point A [m]:</label>
                    <div style="display: flex; gap: 4px;">
                        <input type="number" id="rake-ax" step="0.01" value="${this.chargeCenter?.x ?? 0.0}" placeholder="X" />
                        ${this.is3D ? `<input type="number" id="rake-ay" step="0.01" value="${this.chargeCenter?.y ?? 0.0}" placeholder="Y" />` : ''}
                        <input type="number" id="rake-az" step="0.01" value="${this.chargeCenter?.z ?? 0.0}" placeholder="Z" />
                    </div>
                </div>
                <div class="gmm-rake-row">
                    <label>End Point B [m]:</label>
                    <div style="display: flex; gap: 4px;">
                        <input type="number" id="rake-bx" step="0.01" value="${this.xMax}" placeholder="X" />
                        ${this.is3D ? `<input type="number" id="rake-by" step="0.01" value="0.0" placeholder="Y" />` : ''}
                        <input type="number" id="rake-bz" step="0.01" value="0.0" placeholder="Z" />
                    </div>
                </div>
                <div class="gmm-rake-row">
                    <label>Probe Count (N):</label>
                    <input type="number" id="rake-n" min="2" max="500" value="8" style="width: 80px;" />
                </div>
                <div class="gmm-rake-row">
                    <label>ID Prefix:</label>
                    <input type="text" id="rake-prefix" value="Rake_" style="width: 120px;" />
                </div>
            </div>
            <div class="gmm-rake-actions">
                <button class="gmm-action-btn" id="rake-cancel-btn">Cancel</button>
                <button class="gmm-action-btn primary" id="rake-generate-btn">Generate Rake</button>
            </div>
        `;
        modal.appendChild(box);
        document.body.appendChild(modal);

        const closeRake = () => modal.remove();
        box.querySelector('#rake-cancel-btn')?.addEventListener('click', closeRake);
        box.querySelector('#rake-generate-btn')?.addEventListener('click', () => {
            const ax = parseFloat((box.querySelector('#rake-ax') as HTMLInputElement).value) || 0;
            const ay = this.is3D ? (parseFloat((box.querySelector('#rake-ay') as HTMLInputElement).value) || 0) : 0;
            const az = parseFloat((box.querySelector('#rake-az') as HTMLInputElement).value) || 0;

            const bx = parseFloat((box.querySelector('#rake-bx') as HTMLInputElement).value) || 0;
            const by = this.is3D ? (parseFloat((box.querySelector('#rake-by') as HTMLInputElement).value) || 0) : 0;
            const bz = parseFloat((box.querySelector('#rake-bz') as HTMLInputElement).value) || 0;

            const n = Math.max(2, parseInt((box.querySelector('#rake-n') as HTMLInputElement).value, 10) || 8);
            const prefix = (box.querySelector('#rake-prefix') as HTMLInputElement).value || 'Rake_';

            const newProbes: GaugeProbe[] = [];
            for (let i = 0; i < n; ++i) {
                const t = i / (n - 1);
                const x = ax + t * (bx - ax);
                const y = ay + t * (by - ay);
                const z = az + t * (bz - az);

                newProbes.push(this.is3D ? {
                    id: `${prefix}${i + 1}`,
                    name: `${prefix}${i + 1} (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,
                    x, y, z,
                    plot: true,
                    active: true
                } : {
                    id: `${prefix}${i + 1}`,
                    name: `${prefix}${i + 1} (R:${x.toFixed(2)}, Z:${z.toFixed(2)})`,
                    r: x, z,
                    plot: true,
                    active: true
                });
            }

            const current = this.getGauges();
            const updated = [...current, ...newProbes];
            this.setGauges(updated, true);
            closeRake();
            this.renderTable();
            this.renderInspector();
        });
    }

    private triggerCsvImport(): void {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.csv,.txt';
        fileInput.onchange = () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target?.result as string;
                if (!text) return;
                this.parseAndAppendCsv(text);
            };
            reader.readAsText(file);
        };
        fileInput.click();
    }

    private parseAndAppendCsv(csvText: string): void {
        const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return;

        const imported: GaugeProbe[] = [];
        const startIdx = this.getGauges().length;

        for (let i = 0; i < lines.length; ++i) {
            const line = lines[i];
            // Skip header if non-numeric
            if (i === 0 && (line.toLowerCase().includes('x') || line.toLowerCase().includes('id'))) continue;

            const parts = line.split(/[,\t\s]+/).map(p => p.trim());
            if (parts.length >= 3) {
                // Check if first token is ID
                let gId = `G${startIdx + imported.length + 1}`;
                let x = 0, y = 0, z = 0;
                if (isNaN(parseFloat(parts[0]))) {
                    gId = parts[0];
                    x = parseFloat(parts[1]) || 0;
                    y = parseFloat(parts[2]) || 0;
                    z = parts[3] ? (parseFloat(parts[3]) || 0) : 0;
                } else {
                    x = parseFloat(parts[0]) || 0;
                    y = parseFloat(parts[1]) || 0;
                    z = parts[2] ? (parseFloat(parts[2]) || 0) : 0;
                }

                imported.push(this.is3D ? {
                    id: gId,
                    name: `Imported ${gId}`,
                    x, y, z,
                    plot: true,
                    active: true
                } : {
                    id: gId,
                    name: `Imported ${gId}`,
                    r: x, z: y,
                    plot: true,
                    active: true
                });
            }
        }

        if (imported.length > 0) {
            const current = this.getGauges();
            const updated = [...current, ...imported];
            this.setGauges(updated, true);
            this.renderTable();
            this.renderInspector();
        }
    }

    private exportAllCsv(): void {
        const gauges = this.getGauges();
        let csv = this.is3D ? 'id,name,x,y,z,plot,standoff_r_m\n' : 'id,name,r,z,plot,standoff_r_m\n';

        gauges.forEach((g) => {
            const standoff = this.calculateStandoff(g);
            const rStr = standoff.r !== null ? standoff.r.toFixed(4) : '';
            if (this.is3D) {
                csv += `"${g.id || ''}","${g.name || ''}",${g.x ?? 0.0},${g.y ?? 0.0},${g.z ?? 0.0},${g.plot !== false},${rStr}\n`;
            } else {
                csv += `"${g.id || ''}","${g.name || ''}",${g.r ?? (g.x ?? 0.0)},${g.z ?? 0.0},${g.plot !== false},${rStr}\n`;
            }
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.vgNode.parameters.name || 'virtual_gauges'}_probes.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    public close(): void {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        if (this.onCloseCallback) {
            this.onCloseCallback();
        }
    }
}
