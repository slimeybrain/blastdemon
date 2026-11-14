import { Node, Model, isDomainMesh3DNode, isDomainMesh2DNode } from './types.js';
import { StateManager, resolveResourcePath } from './state-manager.js';
import { HostFileBrowserModal, readHostFile, writeHostFile, showRecentFoldersQuickMenu, recordRecentFolder } from './host-file-browser.js';
import { CustomDialog } from './custom-dialog.js';

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
    private is1D: boolean = false;
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
    private waveformChannel: 'P' | 'dP' | 'I' | 'rho' | 'vel' | 'e' | 'a1' | 'a2' | 'air' = 'P';
    private waveView: { xMin: number; xMax: number; yMin: number; yMax: number; gaugeKey: string } | null = null;
    private activeWaveformRedraw: (() => void) | null = null;
    private telemetryListener: (nodeId: string, data: any) => void;
    private liveTelRafId: number | null = null;

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

        this.telemetryListener = (nodeId: string) => {
            if (nodeId !== this.vgNode.id && nodeId !== `${this.model.id}-gauges`) return;
            if (this.liveTelRafId !== null) return;
            this.liveTelRafId = requestAnimationFrame(() => {
                this.liveTelRafId = null;
                if (!this.overlay) return;
                const activeEl = document.activeElement;
                const editingTable = this.tableContainer && activeEl && this.tableContainer.contains(activeEl);
                if (!editingTable) {
                    this.renderTable();
                }
                if (this.activeWaveformRedraw) {
                    this.activeWaveformRedraw();
                }
            });
        };

        this.detectDomainBounds();
        this.detectChargeLocation();
        this.createDOM();
        this.stateManager.onTelemetryUpdate(this.telemetryListener);
    }

    private detectDomainBounds(): void {
        this.is3D = this.model.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D');
        const has2D = !this.is3D && this.model.nodes.some(n => isDomainMesh2DNode(n.type) || n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');
        this.is1D = !this.is3D && !has2D;

        const mesh3D = this.model.nodes.find(n => isDomainMesh3DNode(n.type));
        if (mesh3D) {
            this.xMin = Number(mesh3D.parameters.xmin ?? -1.0);
            this.xMax = Number(mesh3D.parameters.xmax ?? 1.0);
            this.yMin = Number(mesh3D.parameters.ymin ?? -1.0);
            this.yMax = Number(mesh3D.parameters.ymax ?? 1.0);
            this.zMin = Number(mesh3D.parameters.zmin ?? -1.0);
            this.zMax = Number(mesh3D.parameters.zmax ?? 1.0);
        }
        const mesh2D = this.model.nodes.find(n => isDomainMesh2DNode(n.type));
        if (mesh2D) {
            this.rMin = Number(mesh2D.parameters.min_r ?? 0.0);
            this.rMax = Number(mesh2D.parameters.max_r ?? mesh2D.parameters.rmax ?? mesh2D.parameters.r_max ?? 1.0);
            this.zMin = Number(mesh2D.parameters.min_z ?? mesh2D.parameters.zmin ?? mesh2D.parameters.z_min ?? 0.0);
            this.zMax = Number(mesh2D.parameters.max_z ?? mesh2D.parameters.zmax ?? 1.0);
            this.xMin = this.rMin;
            this.xMax = this.rMax;
        }
        const mesh1D = this.model.nodes.find(n => n.type === 'DomainMesh');
        if (mesh1D && this.is1D) {
            this.rMin = 0.0;
            this.rMax = Number(mesh1D.parameters.domain_radius ?? 1.0);
            this.zMin = 0.0;
            this.zMax = 0.0;
            this.xMin = 0.0;
            this.xMax = this.rMax;
        }
    }

    private detectChargeLocation(): void {
        const chargeNode = this.model.nodes.find(n => n.type === 'Charge3D' || n.type === 'Charge2D' || n.type === 'Charge1D');
        const remapNode = this.model.nodes.find(n =>
            n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode' || n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode'
        );
        const detNode = this.model.nodes.find(n => n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation' || n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation');

        if (chargeNode) {
            const p = chargeNode.parameters || {};
            const cx = Number(p.charge_x ?? p.charge_r ?? p.center_x ?? p.x ?? p.center_r ?? 0.0);
            const cy = Number(p.charge_y ?? p.center_y ?? p.y ?? 0.0);
            const cz = Number(p.charge_z ?? p.center_z ?? p.z ?? 0.0);
            this.chargeCenter = { x: cx, y: cy, z: cz };
            if (p.charge_mass !== undefined) {
                this.chargeMass = Number(p.charge_mass);
            }
        } else if (remapNode) {
            const rp = remapNode.parameters || {};
            const allModels = this.stateManager.getAppState().models || {};
            const srcId = String(rp.source_model_id || '');
            let srcModel = srcId && srcId !== this.model.id ? allModels[srcId] : undefined;
            if (!srcModel) {
                const ws = this.stateManager.getActiveWorkspace();
                const pipeConn = (ws?.connections || []).find(c => c.toNode === this.model.id && c.fromNode !== this.model.id);
                if (pipeConn) srcModel = allModels[pipeConn.fromNode];
            }

            if (remapNode.type === 'Remap1DTo3DNode' || remapNode.type === 'Remap3DTo3DNode') {
                this.chargeCenter = {
                    x: Number(rp.explosive_x ?? 0.5),
                    y: Number(rp.explosive_y ?? 0.5),
                    z: Number(rp.explosive_z ?? 0.5)
                };
            } else if (remapNode.type === 'Remap2DTo3DNode') {
                // For 2D -> 3D, axial burst height can come from upstream 2D Charge2D or 2D Remap1DTo2DNode
                const srcCharge2D = srcModel?.nodes.find(n => n.type === 'Charge2D');
                const srcRemap2D = srcModel?.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode');
                const inheritedZ = srcCharge2D?.parameters?.charge_z ?? srcRemap2D?.parameters?.explosive_z ?? 0.0;
                this.chargeCenter = {
                    x: Number(rp.explosive_x ?? 0.5),
                    y: Number(rp.explosive_y ?? 0.5),
                    z: Number(rp.explosive_z !== undefined && Number(rp.explosive_z) !== 0 ? rp.explosive_z : inheritedZ)
                };
            } else {
                // RemapNode / Remap1DTo2DNode (2D Axisymmetric)
                this.chargeCenter = {
                    x: Number(rp.explosive_r ?? 0.0),
                    y: 0.0,
                    z: Number(rp.explosive_z ?? 0.5)
                };
            }

            // Walk upstream (up to 2 hops for 1D -> 2D -> 3D) to resolve charge_mass
            let curSrc = srcModel;
            for (let hop = 0; hop < 2 && curSrc; hop++) {
                const upCharge = curSrc.nodes.find(n => n.type === 'Charge1D' || n.type === 'Charge2D' || n.type === 'Charge3D');
                if (upCharge?.parameters?.charge_mass !== undefined) {
                    this.chargeMass = Number(upCharge.parameters.charge_mass);
                    break;
                }
                const upRemap = curSrc.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode');
                const nextId = String(upRemap?.parameters?.source_model_id || '');
                curSrc = (nextId && nextId !== curSrc.id) ? allModels[nextId] : undefined;
            }
        } else if (detNode) {
            const p = detNode.parameters || {};
            const cx = Number(p.trigger_x ?? p.detonator_x ?? p.det_x ?? p.x ?? p.trigger_r ?? p.detonator_r ?? 0.0);
            const cy = Number(p.trigger_y ?? p.detonator_y ?? p.det_y ?? p.y ?? 0.0);
            const cz = Number(p.trigger_z ?? p.detonator_z ?? p.det_z ?? p.z ?? 0.0);
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
        const vpNode = this.model.nodes.find(n => n.type === 'Telemetry3DViewport' || n.type === 'TelemetryContour' || n.type === 'TelemetryGraph');
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
        } else if (this.is1D) {
            dist = Math.abs(gx - this.chargeCenter.x);
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

    private getTelemetryMetrics(gauge: GaugeProbe, gaugeIdx: number): { pMax: number; impulse: number; times: number[]; pressures: number[]; impulses: number[]; channels: Record<number, number[]> } {
        let times: number[] = [];
        let pressures: number[] = [];
        let impulses: number[] = [];
        const channels: Record<number, number[]> = {};
        let pMax = 0.0;
        let impMax = 0.0;

        let rawTel = this.stateManager.getTelemetry(this.vgNode.id) || this.stateManager.getTelemetry(this.model.id + '-gauges');
        if (rawTel && (rawTel.gauges_history || Array.isArray(rawTel)) && (!rawTel.times || !rawTel.values)) {
            rawTel = this.stateManager.normalizeGaugesTelemetry(rawTel);
        }
        if (rawTel && rawTel.times && rawTel.values) {
            times = rawTel.times;
            const values = rawTel.values;
            const gId = gauge.id || gauge.name || `G${gaugeIdx + 1}`;
            const gData = values[gId] || values[gauge.name || ''] || values[gId.toUpperCase()] || values[gId.toLowerCase()] || values[gaugeIdx] || values[String(gaugeIdx)] || values['G' + (gaugeIdx + 1)] || values['g' + (gaugeIdx + 1)];
            if (gData) {
                for (let ch = 0; ch <= 8; ch++) {
                    if (Array.isArray(gData[ch])) {
                        channels[ch] = gData[ch];
                    }
                }
                pressures = channels[0] || [];
                const rawImp = channels[8];
                if (rawImp && rawImp.length > 0 && rawImp.some((v: number) => Math.abs(v) > 0)) {
                    impulses = rawImp;
                } else if (pressures.length > 0 && times.length > 0) {
                    const nPts = Math.min(pressures.length, times.length);
                    impulses = new Array(nPts);
                    let acc = 0.0;
                    impulses[0] = 0.0;
                    for (let i = 1; i < nPts; ++i) {
                        const dt = Math.max(0, times[i] - times[i - 1]);
                        const dp0 = pressures[i - 1] - 101325.0;
                        const dp1 = pressures[i] - 101325.0;
                        acc += 0.5 * (dp0 + dp1) * dt;
                        impulses[i] = acc;
                    }
                }
                channels[8] = impulses;
                if ((!channels[7] || channels[7].length === 0) && pressures.length > 0) {
                    channels[7] = pressures.map((p: number) => p - 101325.0);
                }
                for (const p of pressures) {
                    const overP = Math.max(0, p - 101325.0);
                    if (overP > pMax) pMax = overP;
                }
                for (const imp of impulses) {
                    if (imp > impMax) impMax = imp;
                }
            }
        }
        return { pMax, impulse: impMax, times, pressures, impulses, channels };
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

        const plotWaveBtn = document.createElement('button');
        plotWaveBtn.className = 'gmm-action-btn';
        plotWaveBtn.innerHTML = '<span>📈</span> <span>Plot Waveforms</span>';
        plotWaveBtn.title = 'Open Virtual Gauge Time-History Waveforms in Workspace Viewport';
        plotWaveBtn.onclick = () => {
            window.dispatchEvent(new CustomEvent('blastdemon-open-gauge-waveforms', { detail: { modelId: this.model.id } }));
        };
        btnGroup.appendChild(plotWaveBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'gmm-action-btn';
        importBtn.innerHTML = '<span>📥</span> <span>Import CSV...</span>';
        importBtn.title = 'Import probe coordinates from host CSV file (Shift+Click for local browser file upload)';
        importBtn.onclick = (e) => {
            if (e.shiftKey) {
                this.triggerLocalCsvImport();
            } else {
                this.triggerCsvImport();
            }
        };
        btnGroup.appendChild(importBtn);

        const recentCsvBtn = document.createElement('button');
        recentCsvBtn.className = 'gmm-action-btn';
        recentCsvBtn.innerHTML = '<span>🕒</span>';
        recentCsvBtn.title = 'Import probe CSV from a Recent Folder';
        recentCsvBtn.style.padding = '5px 8px';
        recentCsvBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showRecentFoldersQuickMenu(
                recentCsvBtn,
                (folderPath) => this.triggerCsvImport(folderPath),
                {
                    title: 'Import CSV from Recent Folder',
                    onBrowseOther: () => this.triggerCsvImport()
                }
            );
        };
        btnGroup.appendChild(recentCsvBtn);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'gmm-action-btn';
        exportBtn.innerHTML = '<span>📤</span> <span>Export CSV...</span>';
        exportBtn.title = 'Save all probe definitions to host CSV file (Shift+Click for local browser download)';
        exportBtn.onclick = (e) => {
            if (e.shiftKey) {
                this.downloadAllCsvLocally();
            } else {
                this.exportAllCsv();
            }
        };
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
        const checkedRowCount = filtered.filter(({ idx }) => this.checkedIndices.has(idx)).length;
        masterCheck.checked = filtered.length > 0 && checkedRowCount === filtered.length;
        masterCheck.indeterminate = checkedRowCount > 0 && checkedRowCount < filtered.length;
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
        thPlot.style.width = '52px';
        thPlot.title = 'Toggle plotting visibility in charts and telemetry';
        const plotHdrWrap = document.createElement('label');
        plotHdrWrap.style.cssText = 'display:inline-flex; align-items:center; gap:4px; cursor:pointer; user-select:none;';
        const plotMasterCheck = document.createElement('input');
        plotMasterCheck.type = 'checkbox';
        const plottedCount = filtered.filter(({ gauge }) => gauge.plot !== false && gauge.active !== false).length;
        plotMasterCheck.checked = filtered.length > 0 && plottedCount === filtered.length;
        plotMasterCheck.indeterminate = plottedCount > 0 && plottedCount < filtered.length;
        plotMasterCheck.onchange = () => {
            const nextPlot = plotMasterCheck.checked;
            const current = this.getGauges();
            filtered.forEach(({ gauge, idx }) => {
                gauge.plot = nextPlot;
                current[idx] = { ...gauge, plot: nextPlot };
            });
            this.setGauges(current, false);
            this.renderTable();
            this.renderInspector();
        };
        plotHdrWrap.appendChild(plotMasterCheck);
        plotHdrWrap.appendChild(document.createTextNode('Plot'));
        thPlot.appendChild(plotHdrWrap);
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
        } else if (this.is1D) {
            const thR = document.createElement('th');
            thR.textContent = 'R [m]';
            headerRow.appendChild(thR);
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
        thPmax.textContent = 'ΔP_max';
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
                            current[idx] = { ...gauge, r: val, x: val };
                            this.setGauges(current, true);
                            this.renderTable();
                            if (this.selectedGaugeIdx === idx) this.renderInspector();
                        }
                    });
                };
                tr.appendChild(tdR);

                if (!this.is1D) {
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
            if (key === 'r') {
                current[gaugeIdx] = { ...gauge, r: val, x: val };
            } else {
                current[gaugeIdx] = { ...gauge, [key]: val };
            }
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
            if (!this.is1D) {
                coordTable.appendChild(this.createCoordRow('Z-Coordinate [m]', gauge.z ?? 0.0, this.zMin, this.zMax, (v) => updateCoord('z', v)));
            }
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
        waveHdr.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px;';
        const waveTitleSpan = document.createElement('span');
        waveTitleSpan.textContent = 'Live Telemetry & Waveform';
        waveHdr.appendChild(waveTitleSpan);

        const waveCtrlGrp = document.createElement('div');
        waveCtrlGrp.style.cssText = 'display:flex; align-items:center; gap:4px;';

        const chSel = document.createElement('select');
        chSel.style.cssText = 'background:#141a29; color:#e2e8f0; border:1px solid rgba(148,163,184,0.3); border-radius:4px; font-size:10px; padding:1px 4px; cursor:pointer;';
        const allWaveOpts: Array<{ v: 'P' | 'dP' | 'I' | 'rho' | 'vel' | 'e' | 'a1' | 'a2' | 'air'; l: string; param: string }> = [
            { v: 'P',   l: 'P(t) [Pa]',      param: 'qty_pressure' },
            { v: 'dP',  l: 'ΔP(t) [Pa]',     param: 'qty_overpressure' },
            { v: 'I',   l: 'I(t) [Pa·s]',    param: 'qty_impulse' },
            { v: 'rho', l: 'ρ(t) [kg/m³]',   param: 'qty_density' },
            { v: 'vel', l: '|u|(t) [m/s]',   param: 'qty_velocity' },
            { v: 'e',   l: 'e(t) [J/kg]',    param: 'qty_energy' },
            { v: 'a1',  l: 'α₁(t) [-]',      param: 'qty_reacted' },
            { v: 'a2',  l: 'α₂(t) [-]',      param: 'qty_unreacted' },
            { v: 'air', l: 'α_air(t) [-]',   param: 'qty_air' }
        ];
        const enabledWaveOpts = allWaveOpts.filter(o => this.vgNode.parameters?.[o.param] !== false);
        const activeWaveOpts = enabledWaveOpts.length > 0 ? enabledWaveOpts : allWaveOpts;
        if (!activeWaveOpts.some(o => o.v === this.waveformChannel)) {
            this.waveformChannel = activeWaveOpts[0].v;
        }
        activeWaveOpts.forEach(optDef => {
            const o = document.createElement('option');
            o.value = optDef.v;
            o.textContent = optDef.l;
            if (this.waveformChannel === optDef.v) o.selected = true;
            chSel.appendChild(o);
        });
        waveCtrlGrp.appendChild(chSel);

        const fitWaveBtn = document.createElement('button');
        fitWaveBtn.textContent = '🏠 Fit';
        fitWaveBtn.title = 'Reset waveform pan & zoom (or double-click chart)';
        fitWaveBtn.style.cssText = 'background:rgba(30,41,59,0.85); color:#cbd5e1; border:1px solid rgba(148,163,184,0.3); border-radius:4px; font-size:9.5px; padding:1px 6px; cursor:pointer;';
        waveCtrlGrp.appendChild(fitWaveBtn);
        waveHdr.appendChild(waveCtrlGrp);
        waveSec.appendChild(waveHdr);

        const metricsRow = document.createElement('div');
        metricsRow.style.display = 'flex';
        metricsRow.style.gap = '8px';
        metricsRow.style.marginBottom = '8px';

        const pBadge = document.createElement('div');
        pBadge.className = 'gmm-telemetry-badge red';
        pBadge.innerHTML = `ΔP_max: <strong>${(telemetry.pMax / 1e3).toFixed(1)} kPa</strong>`;
        metricsRow.appendChild(pBadge);

        const impBadge = document.createElement('div');
        impBadge.className = 'gmm-telemetry-badge blue';
        impBadge.innerHTML = `Impulse: <strong>${telemetry.impulse.toFixed(1)} Pa·s</strong>`;
        metricsRow.appendChild(impBadge);
        waveSec.appendChild(metricsRow);

        // Interactive Calibrated Waveform Canvas
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'gmm-sparkline-box';
        const canvas = document.createElement('canvas');
        canvasContainer.appendChild(canvas);
        waveSec.appendChild(canvasContainer);

        const gaugeKey = `${gauge.id || gaugeIdx}:${this.waveformChannel}`;
        if (this.waveView && this.waveView.gaugeKey !== gaugeKey) {
            this.waveView = null;
        }

        let hoverMouse: { x: number; y: number } | null = null;
        let dragState: { startX: number; startY: number; xMin: number; xMax: number; yMin: number; yMax: number } | null = null;

        const fmtTime = (t: number): string => {
            const at = Math.abs(t);
            if (at === 0) return '0 s';
            if (at < 1e-3) return `${(t * 1e6).toFixed(1)} µs`;
            if (at < 1.0) return `${(t * 1e3).toFixed(2)} ms`;
            return `${t.toFixed(3)} s`;
        };
        const fmtVal = (v: number, mode: typeof this.waveformChannel): string => {
            const av = Math.abs(v);
            if (mode === 'I') {
                if (av >= 1e3) return `${(v / 1e3).toFixed(2)} kPa·s`;
                return `${v.toFixed(2)} Pa·s`;
            }
            if (mode === 'rho') return `${v.toFixed(2)} kg/m³`;
            if (mode === 'vel') return `${v.toFixed(2)} m/s`;
            if (mode === 'e') {
                if (av >= 1e6) return `${(v / 1e6).toFixed(2)} MJ/kg`;
                if (av >= 1e3) return `${(v / 1e3).toFixed(1)} kJ/kg`;
                return `${v.toFixed(1)} J/kg`;
            }
            if (mode === 'a1' || mode === 'a2' || mode === 'air') return v.toFixed(3);
            if (av >= 1e6) return `${(v / 1e6).toFixed(2)} MPa`;
            if (av >= 1e3) return `${(v / 1e3).toFixed(1)} kPa`;
            return `${v.toFixed(1)} Pa`;
        };

        const extractSeries = (liveTel: ReturnType<GaugeManagerModal['getTelemetryMetrics']>, mode: typeof this.waveformChannel): { xs: number[]; ys: number[] } => {
            const chMap: Record<typeof this.waveformChannel, number> = {
                P: 0, rho: 1, vel: 2, e: 3, a1: 4, a2: 5, air: 6, dP: 7, I: 8
            };
            const chIdx = chMap[mode] ?? 0;
            const rawArr = liveTel.channels[chIdx] || (mode === 'dP' ? liveTel.pressures.map(p => p - 101325.0) : (mode === 'I' ? liveTel.impulses : liveTel.pressures));
            const nPts = Math.min(rawArr.length, liveTel.times.length || rawArr.length);
            const xs = new Array<number>(nPts);
            const ys = new Array<number>(nPts);
            for (let i = 0; i < nPts; ++i) {
                xs[i] = liveTel.times[i] ?? i;
                ys[i] = rawArr[i] ?? 0;
            }
            return { xs, ys };
        };

        const computeAutoBounds = (xs: number[], ys: number[]) => {
            if (xs.length === 0 || ys.length === 0) {
                return { xMin: 0, xMax: 1e-3, yMin: 0, yMax: 1 };
            }
            let xMin = xs[0], xMax = xs[xs.length - 1];
            if (!(xMax > xMin)) {
                const padX = Math.max(1e-4, Math.abs(xMin) * 0.1);
                xMin -= padX * 0.2;
                xMax += padX;
            }
            let yMin = Infinity, yMax = -Infinity;
            for (let i = 0; i < ys.length; ++i) {
                if (ys[i] < yMin) yMin = ys[i];
                if (ys[i] > yMax) yMax = ys[i];
            }
            if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1; }
            const spanY = yMax - yMin;
            const padY = spanY > 1e-12 ? spanY * 0.14 : Math.max(1.0, Math.abs(yMax) * 0.05);
            return { xMin, xMax, yMin: yMin - padY, yMax: yMax + padY };
        };

        const drawWaveform = () => {
            if (!canvas.isConnected) return;
            const liveTel = this.getTelemetryMetrics(gauge, gaugeIdx);
            pBadge.innerHTML = `ΔP_max: <strong>${(liveTel.pMax / 1e3).toFixed(1)} kPa</strong>`;
            impBadge.innerHTML = `Impulse: <strong>${liveTel.impulse.toFixed(1)} Pa·s</strong>`;

            const rect = canvasContainer.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return;
            const dpr = window.devicePixelRatio || 1;
            const targetW = Math.max(10, Math.floor(rect.width * dpr));
            const targetH = Math.max(10, Math.floor(rect.height * dpr));
            if (canvas.width !== targetW || canvas.height !== targetH) {
                canvas.width = targetW;
                canvas.height = targetH;
            }
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const w = rect.width;
            const h = rect.height;
            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 0, w, h);

            const { xs, ys } = extractSeries(liveTel, this.waveformChannel);
            const nPts = xs.length;
            if (nPts < 1) {
                ctx.fillStyle = '#64748b';
                ctx.font = '11px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Awaiting Simulation Telemetry...', w / 2, h / 2);
                ctx.restore();
                return;
            }

            const padL = 52, padR = 10, padT = 14, padB = 22;
            const pw = Math.max(20, w - padL - padR);
            const ph = Math.max(20, h - padT - padB);

            const curKey = `${gauge.id || gaugeIdx}:${this.waveformChannel}`;
            const bounds = (this.waveView && this.waveView.gaugeKey === curKey)
                ? this.waveView
                : computeAutoBounds(xs, ys);

            const toSx = (xv: number) => padL + ((xv - bounds.xMin) / Math.max(1e-18, bounds.xMax - bounds.xMin)) * pw;
            const toSy = (yv: number) => padT + ph - ((yv - bounds.yMin) / Math.max(1e-18, bounds.yMax - bounds.yMin)) * ph;

            // Grid & Axis Ticks
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
            ctx.lineWidth = 1;
            ctx.fillStyle = '#94a3b8';
            ctx.font = '9.5px monospace';
            const yTicks = 3;
            for (let j = 0; j <= yTicks; ++j) {
                const frac = j / yTicks;
                const sy = padT + ph - frac * ph;
                const yVal = bounds.yMin + frac * (bounds.yMax - bounds.yMin);
                ctx.beginPath();
                ctx.moveTo(padL, sy);
                ctx.lineTo(padL + pw, sy);
                ctx.stroke();
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(fmtVal(yVal, this.waveformChannel).replace(/\s.*$/, ''), padL - 5, sy);
            }
            const xTicks = 3;
            for (let i = 0; i <= xTicks; ++i) {
                const frac = i / xTicks;
                const sx = padL + frac * pw;
                const xVal = bounds.xMin + frac * (bounds.xMax - bounds.xMin);
                ctx.beginPath();
                ctx.moveTo(sx, padT);
                ctx.lineTo(sx, padT + ph);
                ctx.stroke();
                ctx.textAlign = i === 0 ? 'left' : (i === xTicks ? 'right' : 'center');
                ctx.textBaseline = 'top';
                ctx.fillText(fmtTime(xVal), sx, padT + ph + 4);
            }

            // Plot Border & Clip
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
            ctx.strokeRect(padL, padT, pw, ph);
            ctx.save();
            ctx.beginPath();
            ctx.rect(padL, padT, pw, ph);
            ctx.clip();

            // Find Peak & Trough
            let peakIdx = 0, troughIdx = 0;
            for (let i = 1; i < nPts; ++i) {
                if (ys[i] > ys[peakIdx]) peakIdx = i;
                if (ys[i] < ys[troughIdx]) troughIdx = i;
            }

            const curveColor = gauge.color || '#38bdf8';
            if (nPts === 1) {
                const sy0 = toSy(ys[0]);
                const sx0 = toSx(xs[0]);
                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = curveColor;
                ctx.globalAlpha = 0.65;
                ctx.beginPath();
                ctx.moveTo(padL, sy0);
                ctx.lineTo(padL + pw, sy0);
                ctx.stroke();
                ctx.restore();
                ctx.fillStyle = curveColor;
                ctx.beginPath();
                ctx.arc(sx0, sy0, 4, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.strokeStyle = curveColor;
                ctx.lineWidth = 1.75;
                ctx.beginPath();
                for (let i = 0; i < nPts; ++i) {
                    const cx = toSx(xs[i]);
                    const cy = toSy(ys[i]);
                    if (i === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                }
                ctx.stroke();

                // Peak ▲ & Trough ▼ Markers
                const px = toSx(xs[peakIdx]), py = toSy(ys[peakIdx]);
                ctx.fillStyle = '#fbbf24';
                ctx.beginPath();
                ctx.moveTo(px, py - 6);
                ctx.lineTo(px - 4.5, py + 2);
                ctx.lineTo(px + 4.5, py + 2);
                ctx.closePath();
                ctx.fill();

                if (troughIdx !== peakIdx) {
                    const tx = toSx(xs[troughIdx]), ty = toSy(ys[troughIdx]);
                    ctx.fillStyle = '#38bdf8';
                    ctx.beginPath();
                    ctx.moveTo(tx, ty + 6);
                    ctx.lineTo(tx - 4.5, ty - 2);
                    ctx.lineTo(tx + 4.5, ty - 2);
                    ctx.closePath();
                    ctx.fill();
                }
            }

            // Mouseover Crosshair + Snapped Sample Dot
            let snappedIdx = -1;
            if (hoverMouse && hoverMouse.x >= padL && hoverMouse.x <= padL + pw && hoverMouse.y >= padT && hoverMouse.y <= padT + ph) {
                const targetX = bounds.xMin + ((hoverMouse.x - padL) / pw) * (bounds.xMax - bounds.xMin);
                let bestDist = Infinity;
                for (let i = 0; i < nPts; ++i) {
                    const d = Math.abs(xs[i] - targetX);
                    if (d < bestDist) { bestDist = d; snappedIdx = i; }
                }
                const hx = snappedIdx >= 0 ? toSx(xs[snappedIdx]) : hoverMouse.x;
                const hy = snappedIdx >= 0 ? toSy(ys[snappedIdx]) : hoverMouse.y;

                ctx.save();
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(hx, padT);
                ctx.lineTo(hx, padT + ph);
                ctx.moveTo(padL, hy);
                ctx.lineTo(padL + pw, hy);
                ctx.stroke();
                ctx.restore();

                if (snappedIdx >= 0) {
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = curveColor;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }
            ctx.restore(); // unclip

            // Glassmorphic Hover Card with Instantaneous + ▲Peak + ▼Trough
            if (snappedIdx >= 0 && hoverMouse) {
                const lines = [
                    `t = ${fmtTime(xs[snappedIdx])}  |  ${fmtVal(ys[snappedIdx], this.waveformChannel)}`,
                    `▲ Peak: ${fmtVal(ys[peakIdx], this.waveformChannel)} @ ${fmtTime(xs[peakIdx])}`,
                    `▼ Min : ${fmtVal(ys[troughIdx], this.waveformChannel)} @ ${fmtTime(xs[troughIdx])}`
                ];
                ctx.font = '9.5px monospace';
                let boxW = 0;
                for (const ln of lines) boxW = Math.max(boxW, ctx.measureText(ln).width);
                boxW += 12;
                const boxH = lines.length * 13 + 8;
                let bx = hoverMouse.x + 10;
                if (bx + boxW > w - 4) bx = Math.max(4, hoverMouse.x - boxW - 10);
                let by = Math.max(4, Math.min(h - boxH - 4, hoverMouse.y - boxH - 6));

                ctx.fillStyle = 'rgba(10, 15, 28, 0.92)';
                ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(bx, by, boxW, boxH, 4);
                ctx.fill();
                ctx.stroke();

                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillStyle = '#f8fafc';
                ctx.fillText(lines[0], bx + 6, by + 4);
                ctx.fillStyle = '#fbbf24';
                ctx.fillText(lines[1], bx + 6, by + 17);
                ctx.fillStyle = '#38bdf8';
                ctx.fillText(lines[2], bx + 6, by + 30);
            }

            ctx.restore();
        };

        this.activeWaveformRedraw = drawWaveform;

        chSel.onchange = () => {
            this.waveformChannel = chSel.value as typeof this.waveformChannel;
            this.waveView = null;
            drawWaveform();
        };
        fitWaveBtn.onclick = () => {
            this.waveView = null;
            drawWaveform();
        };

        canvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            const liveTel = this.getTelemetryMetrics(gauge, gaugeIdx);
            const { xs, ys } = extractSeries(liveTel, this.waveformChannel);
            if (xs.length < 1) return;
            const curKey = `${gauge.id || gaugeIdx}:${this.waveformChannel}`;
            const cur = (this.waveView && this.waveView.gaugeKey === curKey) ? this.waveView : computeAutoBounds(xs, ys);
            this.waveView = { ...cur, gaugeKey: curKey };
            dragState = { startX: e.clientX, startY: e.clientY, xMin: cur.xMin, xMax: cur.xMax, yMin: cur.yMin, yMax: cur.yMax };
            canvas.setPointerCapture(e.pointerId);
        });

        canvas.addEventListener('pointermove', (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            hoverMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            if (dragState && this.waveView) {
                const pw = Math.max(20, rect.width - 62);
                const ph = Math.max(20, rect.height - 36);
                const dx = e.clientX - dragState.startX;
                const dy = e.clientY - dragState.startY;
                const spanX = dragState.xMax - dragState.xMin;
                const spanY = dragState.yMax - dragState.yMin;
                this.waveView.xMin = dragState.xMin - (dx / pw) * spanX;
                this.waveView.xMax = dragState.xMax - (dx / pw) * spanX;
                this.waveView.yMin = dragState.yMin + (dy / ph) * spanY;
                this.waveView.yMax = dragState.yMax + (dy / ph) * spanY;
            }
            drawWaveform();
        });

        const endDrag = (e: PointerEvent) => {
            if (dragState) {
                dragState = null;
                try { canvas.releasePointerCapture(e.pointerId); } catch {}
            }
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('pointerleave', () => {
            if (!dragState) {
                hoverMouse = null;
                drawWaveform();
            }
        });

        canvas.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const liveTel = this.getTelemetryMetrics(gauge, gaugeIdx);
            const { xs, ys } = extractSeries(liveTel, this.waveformChannel);
            if (xs.length < 1) return;
            const curKey = `${gauge.id || gaugeIdx}:${this.waveformChannel}`;
            const cur = (this.waveView && this.waveView.gaugeKey === curKey) ? this.waveView : computeAutoBounds(xs, ys);
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const padL = 52, padT = 14, pw = Math.max(20, rect.width - 62), ph = Math.max(20, rect.height - 36);
            const fx = Math.max(0, Math.min(1, (mx - padL) / pw));
            const fy = Math.max(0, Math.min(1, 1.0 - (my - padT) / ph));
            const zoom = e.deltaY > 0 ? 1.15 : (1.0 / 1.15);
            const zoomX = !e.altKey;
            const zoomY = !e.shiftKey;
            const xAnchor = cur.xMin + fx * (cur.xMax - cur.xMin);
            const yAnchor = cur.yMin + fy * (cur.yMax - cur.yMin);
            const newSpanX = (cur.xMax - cur.xMin) * (zoomX ? zoom : 1.0);
            const newSpanY = (cur.yMax - cur.yMin) * (zoomY ? zoom : 1.0);
            this.waveView = {
                gaugeKey: curKey,
                xMin: xAnchor - fx * newSpanX,
                xMax: xAnchor + (1 - fx) * newSpanX,
                yMin: yAnchor - fy * newSpanY,
                yMax: yAnchor + (1 - fy) * newSpanY
            };
            drawWaveform();
        }, { passive: false });

        canvas.addEventListener('dblclick', () => {
            this.waveView = null;
            drawWaveform();
        });

        requestAnimationFrame(drawWaveform);

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
        csvBtn.innerHTML = '<span>💾</span> <span>Export CSV...</span>';
        csvBtn.title = 'Save probe waveform history to host CSV file (Shift+Click for local browser download)';
        csvBtn.onclick = (e) => {
            let csv = 'time_s,pressure_Pa,impulse_Pas\n';
            for (let i = 0; i < telemetry.times.length; ++i) {
                csv += `${telemetry.times[i]},${telemetry.pressures[i] ?? 0.0},${telemetry.impulses[i] ?? 0.0}\n`;
            }
            const defaultFile = `probe_${gauge.id || gaugeIdx + 1}.csv`;
            const net = (window as any).networkManager;
            if (!e.shiftKey && net && net.isConnected()) {
                const rawDir = String(this.vgNode.parameters?.output_dir || '');
                const startDir = rawDir ? resolveResourcePath(rawDir, this.model?.filename) : '';
                const browser = new HostFileBrowserModal(net, {
                    title: 'Export Probe Waveform CSV (Host)',
                    mode: 'save',
                    defaultFilename: defaultFile,
                    filters: [
                        { label: 'CSV Waveform (*.csv)', extensions: ['.csv'] },
                        { label: 'All Files (*.*)', extensions: ['*'] }
                    ],
                    onSelect: async (savePath: string) => {
                        const finalPath = /\.csv$/i.test(savePath) ? savePath : `${savePath}.csv`;
                        try {
                            await writeHostFile(net, finalPath, csv, 'utf8');
                            await CustomDialog.alert(`Saved probe waveform CSV to:\n${finalPath}`, 'Waveform Exported');
                        } catch (err: any) {
                            await CustomDialog.alert(err?.message || `Failed to write "${finalPath}".`, 'Export Error');
                        }
                    }
                });
                browser.open(startDir);
                return;
            }
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultFile;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        const rMid = this.rMax / 2.0;
        const newProbe: GaugeProbe = this.is3D ? {
            id: `G${nextIdx}`,
            name: `Gauge ${nextIdx}`,
            x: (this.xMin + this.xMax) / 2.0,
            y: (this.yMin + this.yMax) / 2.0,
            z: (this.zMin + this.zMax) / 2.0,
            plot: true,
            active: true
        } : this.is1D ? {
            id: `G${nextIdx}`,
            name: `Gauge ${nextIdx}`,
            r: rMid,
            x: rMid,
            z: 0.0,
            plot: true,
            active: true
        } : {
            id: `G${nextIdx}`,
            name: `Gauge ${nextIdx}`,
            r: rMid,
            x: rMid,
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
            z: source.z !== undefined ? (this.is1D ? 0.0 : source.z + 0.05) : undefined,
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

    private async deleteCheckedProbes(): Promise<void> {
        if (this.checkedIndices.size === 0) return;
        const ok = await CustomDialog.confirm(
            `Are you sure you want to delete ${this.checkedIndices.size} selected virtual gauge probe(s)?`,
            'Delete Selected Probes',
            { confirmText: 'Delete', danger: true }
        );
        if (!ok) return;

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

        const endXDefault = this.is3D ? this.xMax : this.rMax;
        const box = document.createElement('div');
        box.className = 'gmm-rake-dialog';
        box.innerHTML = `
            <div class="gmm-rake-title">📐 Linear Probe Rake / Array Generator</div>
            <div class="gmm-rake-desc">Automatically generates and spaces probes along a line from Point A to Point B. Ideal for standoff blast interrogation.</div>
            <div class="gmm-rake-form">
                <div class="gmm-rake-row">
                    <label>Start Point A [m]:</label>
                    <div style="display: flex; gap: 4px;">
                        <input type="number" id="rake-ax" step="0.01" value="${this.chargeCenter?.x ?? 0.0}" placeholder="${this.is3D ? 'X' : 'R'}" />
                        ${this.is3D ? `<input type="number" id="rake-ay" step="0.01" value="${this.chargeCenter?.y ?? 0.0}" placeholder="Y" />` : ''}
                        ${!this.is1D ? `<input type="number" id="rake-az" step="0.01" value="${this.chargeCenter?.z ?? 0.0}" placeholder="Z" />` : ''}
                    </div>
                </div>
                <div class="gmm-rake-row">
                    <label>End Point B [m]:</label>
                    <div style="display: flex; gap: 4px;">
                        <input type="number" id="rake-bx" step="0.01" value="${endXDefault}" placeholder="${this.is3D ? 'X' : 'R'}" />
                        ${this.is3D ? `<input type="number" id="rake-by" step="0.01" value="0.0" placeholder="Y" />` : ''}
                        ${!this.is1D ? `<input type="number" id="rake-bz" step="0.01" value="0.0" placeholder="Z" />` : ''}
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
            const az = !this.is1D ? (parseFloat((box.querySelector('#rake-az') as HTMLInputElement).value) || 0) : 0;

            const bx = parseFloat((box.querySelector('#rake-bx') as HTMLInputElement).value) || 0;
            const by = this.is3D ? (parseFloat((box.querySelector('#rake-by') as HTMLInputElement).value) || 0) : 0;
            const bz = !this.is1D ? (parseFloat((box.querySelector('#rake-bz') as HTMLInputElement).value) || 0) : 0;

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
                } : this.is1D ? {
                    id: `${prefix}${i + 1}`,
                    name: `${prefix}${i + 1} (R:${x.toFixed(2)})`,
                    r: x, x, z: 0.0,
                    plot: true,
                    active: true
                } : {
                    id: `${prefix}${i + 1}`,
                    name: `${prefix}${i + 1} (R:${x.toFixed(2)}, Z:${z.toFixed(2)})`,
                    r: x, x, z,
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

    private parseCsvLine(line: string): string[] {
        if (line.includes(',') || line.includes('"')) {
            const fields: string[] = [];
            let cur = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (inQuotes) {
                    if (ch === '"') {
                        if (i + 1 < line.length && line[i + 1] === '"') {
                            cur += '"';
                            i++;
                        } else {
                            inQuotes = false;
                        }
                    } else {
                        cur += ch;
                    }
                } else {
                    if (ch === '"') {
                        inQuotes = true;
                    } else if (ch === ',') {
                        fields.push(cur.trim());
                        cur = '';
                    } else {
                        cur += ch;
                    }
                }
            }
            fields.push(cur.trim());
            return fields;
        }
        if (line.includes('\t')) {
            return line.split('\t').map(p => p.trim());
        }
        return line.split(/\s+/).map(p => p.trim()).filter(p => p.length > 0);
    }

    private triggerCsvImport(initialFolderOverride?: string): void {
        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            const rawExt = String(this.vgNode.parameters?.external_file_path || this.vgNode.parameters?.output_dir || '');
            const startPath = initialFolderOverride !== undefined
                ? initialFolderOverride
                : (rawExt ? resolveResourcePath(rawExt, this.model?.filename) : '');

            const browser = new HostFileBrowserModal(net, {
                title: 'Import Virtual Gauge Probes CSV (Host)',
                mode: 'open',
                filters: [
                    { label: 'CSV / Sensor Probe Files (*.csv, *.txt, *.dat)', extensions: ['.csv', '.txt', '.dat'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: async (selectedPath: string) => {
                    try {
                        const res = await readHostFile(net, selectedPath);
                        const count = this.parseAndAppendCsv(res.content);
                        if (count === 0) {
                            await CustomDialog.alert(`No valid probe coordinates were found in:\n${selectedPath}`, 'CSV Import');
                        }
                    } catch (err: any) {
                        await CustomDialog.alert(err?.message || `Failed to read "${selectedPath}".`, 'CSV Import Error');
                    }
                }
            });
            browser.open(startPath);
            return;
        }

        this.triggerLocalCsvImport();
    }

    private triggerLocalCsvImport(): void {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.csv,.txt,.dat';
        fileInput.onchange = () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                const text = e.target?.result as string;
                if (!text) return;
                const count = this.parseAndAppendCsv(text);
                if (count === 0) {
                    await CustomDialog.alert(`No valid probe coordinates were found in "${file.name}".`, 'CSV Import');
                }
            };
            reader.readAsText(file);
        };
        fileInput.click();
    }

    private parseAndAppendCsv(csvText: string): number {
        const lines = csvText
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('#'));
        if (lines.length === 0) return 0;

        const isFiniteNumStr = (s: string | undefined): boolean => {
            if (s === undefined || s.trim() === '') return false;
            return Number.isFinite(Number(s));
        };

        const firstRow = this.parseCsvLine(lines[0]);
        const headerTokens = firstRow.map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
        const knownHeaders = new Set(['id', 'probe_id', 'name', 'label', 'x', 'x_m', 'y', 'y_m', 'z', 'z_m', 'r', 'r_m', 'plot', 'active', 'standoff_r_m']);
        const hasHeader = firstRow.every(tok => !isFiniteNumStr(tok)) || headerTokens.some(t => knownHeaders.has(t));

        let colMap: Record<string, number> | null = null;
        let dataStartRow = 0;
        if (hasHeader) {
            colMap = {};
            headerTokens.forEach((tok, idx) => {
                if (!(tok in colMap!)) colMap![tok] = idx;
            });
            dataStartRow = 1;
        }

        const getMapped = (parts: string[], keys: string[]): string | undefined => {
            if (!colMap) return undefined;
            for (const k of keys) {
                const idx = colMap[k];
                if (idx !== undefined && idx < parts.length) return parts[idx];
            }
            return undefined;
        };

        const imported: GaugeProbe[] = [];
        const startIdx = this.getGauges().length;

        for (let i = dataStartRow; i < lines.length; ++i) {
            const parts = this.parseCsvLine(lines[i]);
            if (parts.length === 0) continue;

            const defaultId = `G${startIdx + imported.length + 1}`;
            let gId = defaultId;
            let gName = '';
            let x = 0;
            let y = 0;
            let z = 0;
            let rVal: number | undefined = undefined;
            let plot = true;

            if (colMap) {
                const rawId = getMapped(parts, ['id', 'probe_id']);
                const rawName = getMapped(parts, ['name', 'label']);
                const rawX = getMapped(parts, ['x', 'x_m']);
                const rawY = getMapped(parts, ['y', 'y_m']);
                const rawZ = getMapped(parts, ['z', 'z_m']);
                const rawR = getMapped(parts, ['r', 'r_m']);
                const rawPlot = getMapped(parts, ['plot', 'active']);

                if (rawId) gId = rawId;
                if (rawName) gName = rawName;
                if (rawR !== undefined && isFiniteNumStr(rawR)) rVal = Number(rawR);
                if (rawX !== undefined && isFiniteNumStr(rawX)) x = Number(rawX);
                else if (rVal !== undefined) x = rVal;
                if (rawY !== undefined && isFiniteNumStr(rawY)) y = Number(rawY);
                if (rawZ !== undefined && isFiniteNumStr(rawZ)) z = Number(rawZ);
                if (rawPlot !== undefined && rawPlot !== '') {
                    const lp = rawPlot.toLowerCase();
                    plot = lp !== 'false' && lp !== '0' && lp !== 'no';
                }
            } else {
                // Headerless row detection:
                // Case A: "id", "name", x, y, z, [plot]
                if (parts.length >= 3 && !isFiniteNumStr(parts[0]) && !isFiniteNumStr(parts[1]) && isFiniteNumStr(parts[2])) {
                    gId = parts[0] || defaultId;
                    gName = parts[1] || '';
                    x = Number(parts[2]) || 0;
                    y = isFiniteNumStr(parts[3]) ? Number(parts[3]) : 0;
                    z = isFiniteNumStr(parts[4]) ? Number(parts[4]) : 0;
                    if (parts[5] !== undefined) {
                        const lp = parts[5].toLowerCase();
                        if (lp === 'false' || lp === '0') plot = false;
                    }
                } else if (!isFiniteNumStr(parts[0])) {
                    // Case B: "id", x, [y], [z]
                    if (parts.length < 2 || !isFiniteNumStr(parts[1])) continue;
                    gId = parts[0] || defaultId;
                    x = Number(parts[1]) || 0;
                    y = isFiniteNumStr(parts[2]) ? Number(parts[2]) : 0;
                    z = isFiniteNumStr(parts[3]) ? Number(parts[3]) : 0;
                } else {
                    // Case C: x, [y], [z]
                    x = Number(parts[0]) || 0;
                    y = isFiniteNumStr(parts[1]) ? Number(parts[1]) : 0;
                    z = isFiniteNumStr(parts[2]) ? Number(parts[2]) : 0;
                }
            }

            const finalName = gName || `Imported ${gId}`;
            if (this.is3D) {
                imported.push({
                    id: gId,
                    name: finalName,
                    x,
                    y,
                    z,
                    plot,
                    active: plot
                });
            } else if (this.is1D) {
                const rCoord = rVal ?? x;
                imported.push({
                    id: gId,
                    name: finalName,
                    r: rCoord,
                    x: rCoord,
                    z: 0.0,
                    plot,
                    active: plot
                });
            } else {
                const rCoord = rVal ?? x;
                const zCoord = colMap ? z : y;
                imported.push({
                    id: gId,
                    name: finalName,
                    r: rCoord,
                    x: rCoord,
                    z: zCoord,
                    plot,
                    active: plot
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
        return imported.length;
    }

    private buildAllProbesCsvString(): string {
        const csvQuote = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        const gauges = this.getGauges();
        let csv = this.is3D ? 'id,name,x,y,z,plot,standoff_r_m\n' : (this.is1D ? 'id,name,r,plot,standoff_r_m\n' : 'id,name,r,z,plot,standoff_r_m\n');

        gauges.forEach((g) => {
            const standoff = this.calculateStandoff(g);
            const rStr = standoff.r !== null ? standoff.r.toFixed(4) : '';
            if (this.is3D) {
                csv += `${csvQuote(g.id || '')},${csvQuote(g.name || '')},${g.x ?? 0.0},${g.y ?? 0.0},${g.z ?? 0.0},${g.plot !== false},${rStr}\n`;
            } else if (this.is1D) {
                csv += `${csvQuote(g.id || '')},${csvQuote(g.name || '')},${g.r ?? (g.x ?? 0.0)},${g.plot !== false},${rStr}\n`;
            } else {
                csv += `${csvQuote(g.id || '')},${csvQuote(g.name || '')},${g.r ?? (g.x ?? 0.0)},${g.z ?? 0.0},${g.plot !== false},${rStr}\n`;
            }
        });
        return csv;
    }

    private exportAllCsv(): void {
        const csv = this.buildAllProbesCsvString();
        const defaultName = `${this.vgNode.parameters.name || 'virtual_gauges'}_probes.csv`;
        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            const rawDir = String(this.vgNode.parameters?.output_dir || '');
            const startDir = rawDir ? resolveResourcePath(rawDir, this.model?.filename) : '';
            const browser = new HostFileBrowserModal(net, {
                title: 'Export Virtual Gauge Probes CSV (Host)',
                mode: 'save',
                defaultFilename: defaultName,
                filters: [
                    { label: 'CSV Probe Definitions (*.csv)', extensions: ['.csv'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ],
                onSelect: async (savePath: string) => {
                    const finalPath = /\.csv$/i.test(savePath) ? savePath : `${savePath}.csv`;
                    try {
                        await writeHostFile(net, finalPath, csv, 'utf8');
                        await CustomDialog.alert(`Saved ${this.getGauges().length} probe definitions to:\n${finalPath}`, 'Probes Exported');
                    } catch (err: any) {
                        await CustomDialog.alert(err?.message || `Failed to write "${finalPath}".`, 'Export Error');
                    }
                }
            });
            browser.open(startDir);
            return;
        }

        this.downloadAllCsvLocally();
    }

    private downloadAllCsvLocally(): void {
        const csv = this.buildAllProbesCsvString();
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.vgNode.parameters.name || 'virtual_gauges'}_probes.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    public close(): void {
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        if (this.liveTelRafId !== null) {
            cancelAnimationFrame(this.liveTelRafId);
            this.liveTelRafId = null;
        }
        this.activeWaveformRedraw = null;
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        if (this.onCloseCallback) {
            this.onCloseCallback();
        }
    }
}
