import { StateManager } from './state-manager.js';
import { Node } from './types.js';
import { validateSimulationState } from './validation.js';
import { HostFileBrowserModal } from './host-file-browser.js';

export class PropertyEditor {
    public container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private listener: ((state: any) => void) | null = null;
    private activeTabIdx: number = 0;

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.id = 'property-editor-container';
        this.container.className = 'panel-content scrollable';
        parent.appendChild(this.container);

        this.stateManager = stateManager;
        this.listener = () => this.render();
        this.stateManager.onStateChange(this.listener);
        this.render();
    }

    public destroy(): void {
        if (this.listener) {
            this.stateManager.offStateChange(this.listener);
        }
        this.container.remove();
    }

    public setSelectedNode(nodeId: string | null): void {
        if (this.currentNodeId === nodeId) return;
        this.currentNodeId = nodeId;
        this.activeTabIdx = 0;
        this.render(true);
    }

    private render(forceFull: boolean = false): void {
        if (!this.currentNodeId) {
            this.container.innerHTML = '<div style="padding: 20px; color: #666;">No node selected</div>';
            return;
        }

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);

        if (!node) {
            this.container.innerHTML = '<div style="padding: 20px; color: #f44336;">Node not found</div>';
            return;
        }

        if (!forceFull && this.container.querySelector('form')) {
            for (const [key, value] of Object.entries(node.parameters)) {
                const input = this.container.querySelector(`[data-key="${key}"]`) as HTMLInputElement | HTMLSelectElement;
                if (input && document.activeElement !== input) {
                    input.value = value.toString();
                }
            }

            const gridInfo = this.container.querySelector('#grid-info-display') as HTMLDivElement;
            if (gridInfo) {
                const cellSize = Number(node.parameters['cell_size'] ?? 0.001);
                if (node.type === 'DomainMesh') {
                    const radius = Number(node.parameters['domain_radius'] ?? 1.0);
                    const n_cells = Math.round(radius / cellSize);
                    gridInfo.textContent = `Calculated Grid: ${n_cells} cells (Total: ${n_cells.toLocaleString()})`;
                } else if (node.type === 'DomainMesh2D') {
                    const max_r = Number(node.parameters['max_r'] ?? 1.0);
                    const max_z = Number(node.parameters['max_z'] ?? 1.0);
                    const nr = Math.round(max_r / cellSize);
                    const nz = Math.round(max_z / cellSize);
                    gridInfo.textContent = `Calculated Grid: ${nr} x ${nz} cells (Total: ${(nr * nz).toLocaleString()})`;
                }
            }

            return;
        }

        this.container.innerHTML = '';

        const editorHeader = document.createElement('div');
        editorHeader.style.padding = '10px';
        editorHeader.style.borderBottom = '1px solid #333';
        editorHeader.style.fontWeight = 'bold';
        editorHeader.innerHTML = `${node.type} (${node.id})`;
        this.container.appendChild(editorHeader);

        const descBlock = document.createElement('div');
        descBlock.style.padding = '8px 10px';
        descBlock.style.fontSize = 'var(--font-sm)';
        descBlock.style.color = '#aaa';
        descBlock.style.background = '#252526';
        descBlock.style.borderBottom = '1px solid #333';
        
        let descText = this.getNodeDescription(node.type);
        if (node.type === 'Material') {
            const matType = node.parameters['material_type'] || 'Air';
            if (matType === 'JWL Charge') {
                const comp = node.parameters['composition'] || 'TNT';
                const EXPLOSIVE_REFS: Record<string, string> = {
                    'Aluminized ANFO': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                    'Ammonal': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                    'ANFO': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                    'Baratol': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                    'C-4': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Composition A-3': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Composition B': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Composition C-3': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Cyclotol': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Heavy ANFO': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                    'HMX': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'LX-04': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'LX-07': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'LX-10': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'LX-14': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'LX-17': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Mining Emulsion': 'Castedo et al., Int. Journal of Rock Mechanics & Mining Sciences (2018)',
                    'Octol': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                    'PBX 9404': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'PBX 9501': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'PBX 9502': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'PE-10': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                    'PE-12': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                    'PE-4': 'Dobratz & Crawford, LLNL Explosives Handbook (1985) / PE-4 Cylinder Test Fit',
                    'PE-8': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                    'Pentolite': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                    'PETN': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'RDX': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'TATB': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Tetryl': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'TNT': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                    'Water Gel': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                    'Custom': 'N/A'
                };
                const ref = EXPLOSIVE_REFS[comp] || 'N/A';
                descText += ` | Composition: ${comp} (Reference: ${ref})`;
            }
        }
        descBlock.textContent = descText;
        this.container.appendChild(descBlock);

        // Validation warnings banner
        const warnings: string[] = [];
        if (state) {
            const valResults = validateSimulationState(state);
            warnings.push(...valResults.globalWarnings);
        }

        if (warnings.length > 0) {
            const warnBox = document.createElement('div');
            warnBox.className = 'validation-warning-box';
            warnBox.style.background = '#dc262622';
            warnBox.style.border = '1px solid #dc2626';
            warnBox.style.borderRadius = '4px';
            warnBox.style.margin = '10px';
            warnBox.style.padding = '10px';
            warnBox.style.color = '#ef4444';
            warnBox.style.fontSize = 'var(--font-sm)';
            warnBox.style.fontWeight = 'bold';
            
            warnings.forEach(w => {
                const p = document.createElement('div');
                p.style.marginBottom = '4px';
                p.innerHTML = `⚠️ ${w}`;
                warnBox.appendChild(p);
            });
            this.container.appendChild(warnBox);
        }

        // Parameters Section
        if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D' || node.type === 'VTKOutput' || node.type === 'Telemetry3DViewport') {
            this.renderTabbedProperties(node);
            return;
        }
 
        const form = document.createElement('form');
        form.style.padding = '10px';
        form.onsubmit = (e) => e.preventDefault();

        const paramKeys = Object.keys(node.parameters);
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D') {
            paramKeys.sort((a, b) => {
                if (a === 'cell_size') return -1;
                if (b === 'cell_size') return 1;
                return 0;
            });
            
            const cellSize = Number(node.parameters['cell_size'] ?? 0.001);
            const info = document.createElement('div');
            info.id = 'grid-info-display';
            info.style.fontSize = 'var(--font-sm)';
            info.style.color = '#569cd6';
            info.style.marginBottom = '10px';
            if (node.type === 'DomainMesh') {
                const radius = Number(node.parameters['domain_radius'] ?? 1.0);
                const n_cells = Math.round(radius / cellSize);
                info.textContent = `Calculated Grid: ${n_cells} cells (Total: ${n_cells.toLocaleString()})`;
            } else {
                const max_r = Number(node.parameters['max_r'] ?? 1.0);
                const max_z = Number(node.parameters['max_z'] ?? 1.0);
                const nr = Math.round(max_r / cellSize);
                const nz = Math.round(max_z / cellSize);
                info.textContent = `Calculated Grid: ${nr} x ${nz} cells (Total: ${(nr * nz).toLocaleString()})`;
            }
            form.appendChild(info);
        }

        let addedQtyHeader = false;
        for (const key of paramKeys) {
            const value = node.parameters[key];
            if (key === 'nr' || key === 'nz' || key === 'n_cells') continue;

            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'Material') {
                const matType = node.parameters['material_type'] || 'Air';
                const airKeys = ['gamma', 'atm_pressure', 'atm_temperature'];
                const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                const customKeys = ['det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                const igKeys = ['ideal_gamma', 'ideal_rho_0', 'ideal_e_0'];

                if (matType === 'Air' && (jwlKeys.includes(key) || igKeys.includes(key))) continue;
                if (matType === 'JWL Charge') {
                    if (airKeys.includes(key) || igKeys.includes(key)) continue;
                }
                if (matType === 'Ideal Gas Charge') {
                    const igKeys = ['composition', 'ideal_rho_0', 'ideal_e_0'];
                    if (!igKeys.includes(key)) continue;
                }
            }
            if (node.type === 'Charge2D') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (key === 'charge_height' && shape !== 'Cylinder') continue;
            }
            // DetonatorLocation and DetonatorLocation3D are separate nodes now, showing correct properties

            if (key.startsWith('qty_') && !addedQtyHeader) {
                addedQtyHeader = true;
                const sectionHeader = document.createElement('div');
                sectionHeader.style.fontWeight = 'bold';
                sectionHeader.style.fontSize = 'var(--font-sm)';
                sectionHeader.style.color = '#569cd6';
                sectionHeader.style.marginTop = '15px';
                sectionHeader.style.marginBottom = '6px';
                sectionHeader.style.borderTop = '1px solid #333';
                sectionHeader.style.paddingTop = '10px';
                sectionHeader.textContent = 'OUTPUT QUANTITIES';
                form.appendChild(sectionHeader);
            }

            const row = document.createElement('div');
            row.style.marginBottom = '10px';

            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';
            label.style.marginBottom = '4px';
            
            let labelText = key.replace(/_/g, ' ').toUpperCase();
            if (key === 'qty_reacted') labelText = 'Reacted Explosive (Alpha1)';
            else if (key === 'qty_unreacted') labelText = 'Unreacted Explosive (Alpha2)';
            label.textContent = labelText;
            row.appendChild(label);

            const input = this.createInputElement(node, key, value);
            input.dataset.key = key;
            row.appendChild(input);
            form.appendChild(row);
        }
        this.container.appendChild(form);

        // I/O Connections Sector (Phase 16.0 Requirement 6)
        const ioSection = document.createElement('div');
        ioSection.style.padding = '10px';
        ioSection.style.borderTop = '1px solid #333';
        ioSection.style.marginTop = '10px';

        const ioTitle = document.createElement('div');
        ioTitle.style.fontSize = 'var(--font-sm)';
        ioTitle.style.color = '#888';
        ioTitle.style.marginBottom = '8px';
        ioTitle.style.fontWeight = 'bold';
        ioTitle.textContent = 'I/O CONNECTIONS';
        ioSection.appendChild(ioTitle);

        const list = document.createElement('div');
        list.style.fontSize = 'var(--font-xs)';
        list.style.color = '#ccc';

        // Inputs
        const inputs = state!.connections.filter(c => c.toNode === node.id);
        if (inputs.length > 0) {
            const inputTitle = document.createElement('div');
            inputTitle.style.color = '#569cd6';
            inputTitle.style.marginTop = '4px';
            inputTitle.textContent = 'Inputs:';
            list.appendChild(inputTitle);
            inputs.forEach(c => {
                const item = document.createElement('div');
                item.style.paddingLeft = '8px';
                item.textContent = `← [${c.fromNode}] : ${c.toPort}`;
                list.appendChild(item);
            });
        }

        // Outputs
        const outputs = state!.connections.filter(c => c.fromNode === node.id);
        if (outputs.length > 0) {
            const outputTitle = document.createElement('div');
            outputTitle.style.color = '#4ec9b0';
            outputTitle.style.marginTop = '8px';
            outputTitle.textContent = 'Outputs:';
            list.appendChild(outputTitle);
            outputs.forEach(c => {
                const item = document.createElement('div');
                item.style.paddingLeft = '8px';
                item.textContent = `→ ${c.fromPort} : [${c.toNode}]`;
                list.appendChild(item);
            });
        }

        if (inputs.length === 0 && outputs.length === 0) {
            const empty = document.createElement('div');
            empty.style.fontStyle = 'italic';
            empty.style.opacity = '0.5';
            empty.textContent = 'No active connections.';
            list.appendChild(empty);
        }

        ioSection.appendChild(list);
        this.container.appendChild(ioSection);
    }

    private renderTabbedProperties(node: Node): void {
        const form = document.createElement('form');
        form.style.padding = '10px';
        form.onsubmit = (e) => e.preventDefault();

        const tabs = node.type === 'Telemetry3DViewport' ? ['VIEWPORT', 'SLICES', 'EXPORTS', 'QUANTITIES'] : ['FORMATS', 'CONFIG', 'QUANTITIES'];
        const activeTabIdx = this.activeTabIdx;

        // Create Tab Bar
        const tabBar = document.createElement('div');
        tabBar.style.display = 'flex';
        tabBar.style.borderBottom = '1px solid #333';
        tabBar.style.marginBottom = '12px';
        tabBar.style.gap = '4px';

        const panels: HTMLDivElement[] = [];

        tabs.forEach((tabName, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = tabName;
            btn.style.padding = '6px 12px';
            btn.style.fontSize = '10px';
            btn.style.fontWeight = 'bold';
            btn.style.background = idx === activeTabIdx ? '#569cd6' : '#2d2d2d';
            btn.style.color = idx === activeTabIdx ? '#fff' : '#888';
            btn.style.border = 'none';
            btn.style.borderRadius = '3px 3px 0 0';
            btn.style.cursor = 'pointer';
            btn.style.flex = '1';
            btn.style.textAlign = 'center';
            btn.onclick = () => {
                this.activeTabIdx = idx;
                tabBar.querySelectorAll('button').forEach((b, bIdx) => {
                    b.style.background = bIdx === idx ? '#569cd6' : '#2d2d2d';
                    b.style.color = bIdx === idx ? '#fff' : '#888';
                });
                panels.forEach((p, pIdx) => {
                    p.style.display = pIdx === idx ? 'block' : 'none';
                });
            };
            tabBar.appendChild(btn);
        });
        form.appendChild(tabBar);

        // Create Tab Panels
        tabs.forEach((_, idx) => {
            const panel = document.createElement('div');
            panel.style.display = idx === activeTabIdx ? 'block' : 'none';
            panels.push(panel);
            form.appendChild(panel);
        });

        const createCheckboxField = (key: string, value: boolean, labelText: string) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.marginBottom = '8px';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = value;
            cb.style.cursor = 'pointer';
            cb.style.width = 'auto';
            cb.onchange = () => {
                this.updateParameter(key, cb.checked);
            };

            const span = document.createElement('span');
            span.style.fontSize = 'var(--font-sm)';
            span.style.color = '#ccc';
            span.style.cursor = 'pointer';
            span.textContent = labelText;
            span.onclick = () => {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            };

            row.appendChild(cb);
            row.appendChild(span);
            return row;
        };

        const addRowToPanel = (key: string, labelText: string, inputEl: HTMLElement, panelIdx: number) => {
            const row = document.createElement('div');
            row.style.marginBottom = '10px';

            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';
            label.style.marginBottom = '4px';
            label.textContent = labelText;
            row.appendChild(label);

            inputEl.dataset.key = key;

            if (key === 'output_dir' || key === 'vtk_dir') {
                const wrapper = document.createElement('div');
                wrapper.style.display = 'flex';
                wrapper.style.gap = '8px';
                wrapper.style.alignItems = 'center';
                
                inputEl.style.flex = '1';
                wrapper.appendChild(inputEl);
                
                const browseBtn = document.createElement('button');
                browseBtn.type = 'button';
                browseBtn.textContent = 'Browse';
                browseBtn.style.padding = '4px 8px';
                browseBtn.style.background = '#333';
                browseBtn.style.color = '#fff';
                browseBtn.style.border = '1px solid #555';
                browseBtn.style.cursor = 'pointer';
                browseBtn.onclick = () => {
                    const startPath = node.parameters[key] || '';
                    const browser = new HostFileBrowserModal((window as any).networkManager, 'save', 'select_dir', (path) => {
                        const lastSlash = path.lastIndexOf('/');
                        const dir = lastSlash !== -1 ? path.substring(0, lastSlash) : path;
                        this.updateParameter(key, dir);
                    });
                    browser.open(startPath);
                };
                wrapper.appendChild(browseBtn);
                row.appendChild(wrapper);

                const activeWs = this.stateManager.getActiveWorkspace();
                const model = this.stateManager.getAllModels().find(m => m.id === activeWs.activeModelId);
                if (model && model.filename) {
                    const lastSlash = model.filename.lastIndexOf('/');
                    const projDir = lastSlash !== -1 ? model.filename.substring(0, lastSlash) : '.';
                    const projInfo = document.createElement('div');
                    projInfo.style.fontSize = 'var(--font-xs)';
                    projInfo.style.color = '#569cd6';
                    projInfo.style.marginTop = '4px';
                    projInfo.textContent = `Project Folder: ${projDir}`;
                    row.appendChild(projInfo);
                }
            } else {
                row.appendChild(inputEl);
            }
            
            panels[panelIdx].appendChild(row);
        };

        if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D') {
            // FORMATS Tab: checkboxes
            const formatsGrid = document.createElement('div');
            formatsGrid.style.display = 'grid';
            formatsGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
            formatsGrid.style.gap = '8px';
            formatsGrid.style.marginBottom = '10px';

            formatsGrid.appendChild(createCheckboxField('export_ascii', !!node.parameters['export_ascii'], 'ASCII'));
            formatsGrid.appendChild(createCheckboxField('export_binary', !!node.parameters['export_binary'], 'Binary'));
            formatsGrid.appendChild(createCheckboxField('export_hdf5', !!node.parameters['export_hdf5'], 'HDF5'));
            panels[0].appendChild(formatsGrid);

            // FILES/CONFIG Tab: text/number/dropdown
            const delimEl = this.createInputElement(node, 'ascii_delimiter', node.parameters['ascii_delimiter'] ?? 'Comma');
            addRowToPanel('ascii_delimiter', 'ASCII DELIMITER', delimEl, 1);

            const precEl = this.createInputElement(node, 'ascii_precision', node.parameters['ascii_precision'] ?? 6);
            addRowToPanel('ascii_precision', 'ASCII PRECISION', precEl, 1);

            const fileEl = this.createInputElement(node, 'custom_filename', node.parameters['custom_filename'] ?? 'gauges');
            addRowToPanel('custom_filename', 'CUSTOM FILENAME', fileEl, 1);

            const dirEl = this.createInputElement(node, 'output_dir', node.parameters['output_dir'] ?? '');
            addRowToPanel('output_dir', 'OUTPUT DIR', dirEl, 1);

            panels[1].appendChild(createCheckboxField('include_header', !!node.parameters['include_header'], 'Include Header'));

        } else if (node.type === 'VTKOutput') {
            // FORMATS/TRIGGERS Tab
            const formatEl = this.createInputElement(node, 'vtk_format', node.parameters['vtk_format'] ?? 'Binary');
            addRowToPanel('vtk_format', 'VTK FORMAT', formatEl, 0);

            const stepEl = this.createInputElement(node, 'step_interval', node.parameters['step_interval'] ?? 10);
            addRowToPanel('step_interval', 'STEP INTERVAL', stepEl, 0);

            const timeEl = this.createInputElement(node, 'time_interval', node.parameters['time_interval'] ?? 0.0);
            addRowToPanel('time_interval', 'TIME INTERVAL', timeEl, 0);

            const triggersGrid = document.createElement('div');
            triggersGrid.style.display = 'grid';
            triggersGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            triggersGrid.style.gap = '8px';
            triggersGrid.style.marginTop = '8px';

            triggersGrid.appendChild(createCheckboxField('export_slices', !!node.parameters['export_slices'], 'Export Slices'));
            triggersGrid.appendChild(createCheckboxField('export_volumes', !!node.parameters['export_volumes'], 'Export Volumes'));
            panels[0].appendChild(triggersGrid);

            // FILES/CONFIG Tab
            const fileEl = this.createInputElement(node, 'custom_filename', node.parameters['custom_filename'] ?? 'vtk_output');
            addRowToPanel('custom_filename', 'CUSTOM FILENAME', fileEl, 1);

            const dirEl = this.createInputElement(node, 'vtk_dir', node.parameters['vtk_dir'] ?? '');
            addRowToPanel('vtk_dir', 'VTK DIR', dirEl, 1);
        } else if (node.type === 'Telemetry3DViewport') {
            // VIEWPORT Tab
            const cmapEl = this.createInputElement(node, 'colormap', node.parameters['colormap'] ?? 'plasma');
            addRowToPanel('colormap', 'COLORMAP', cmapEl, 0);

            const rateEl = this.createInputElement(node, 'refresh_rate', node.parameters['refresh_rate'] ?? 0.033);
            addRowToPanel('refresh_rate', 'REFRESH RATE (SECONDS)', rateEl, 0);

            const minEl = this.createInputElement(node, 'min_val', node.parameters['min_val'] ?? 101325.0);
            addRowToPanel('min_val', 'MIN VALUE', minEl, 0);

            const maxEl = this.createInputElement(node, 'max_val', node.parameters['max_val'] ?? 101325.0 * 100.0);
            addRowToPanel('max_val', 'MAX VALUE', maxEl, 0);

            const cbGrid = document.createElement('div');
            cbGrid.style.display = 'grid';
            cbGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            cbGrid.style.gap = '8px';
            cbGrid.style.marginTop = '8px';
            cbGrid.appendChild(createCheckboxField('log_scale', !!node.parameters['log_scale'], 'Log Scale'));
            cbGrid.appendChild(createCheckboxField('auto_scale', !!node.parameters['auto_scale'], 'Auto Scale'));
            cbGrid.appendChild(createCheckboxField('show_grid', !!node.parameters['show_grid'], 'Show Grid'));
            cbGrid.appendChild(createCheckboxField('interpolate', !!node.parameters['interpolate'], 'Interpolate'));
            panels[0].appendChild(cbGrid);

            // SLICES Tab
            this.renderTelemetry3DViewportSlices(node, panels[1]);

            // EXPORTS Tab
            const formatEl = this.createInputElement(node, 'vtk_format', node.parameters['vtk_format'] ?? 'Binary');
            addRowToPanel('vtk_format', 'VTK FORMAT', formatEl, 2);

            const stepEl = this.createInputElement(node, 'step_interval', node.parameters['step_interval'] ?? 10);
            addRowToPanel('step_interval', 'STEP INTERVAL', stepEl, 2);

            const timeEl = this.createInputElement(node, 'time_interval', node.parameters['time_interval'] ?? 0.0);
            addRowToPanel('time_interval', 'TIME INTERVAL', timeEl, 2);

            const fileEl = this.createInputElement(node, 'custom_filename', node.parameters['custom_filename'] ?? 'vtk_output');
            addRowToPanel('custom_filename', 'CUSTOM FILENAME', fileEl, 2);

            const dirEl = this.createInputElement(node, 'vtk_dir', node.parameters['vtk_dir'] ?? '');
            addRowToPanel('vtk_dir', 'VTK DIR', dirEl, 2);

            const exportGrid = document.createElement('div');
            exportGrid.style.display = 'grid';
            exportGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            exportGrid.style.gap = '8px';
            exportGrid.style.marginTop = '8px';
            exportGrid.appendChild(createCheckboxField('export_slices', !!node.parameters['export_slices'], 'Export Slices'));
            exportGrid.appendChild(createCheckboxField('export_volumes', !!node.parameters['export_volumes'], 'Export Volumes'));
            panels[2].appendChild(exportGrid);

            // QUANTITIES Tab
            const qtyGrid = document.createElement('div');
            qtyGrid.style.display = 'grid';
            qtyGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            qtyGrid.style.gap = '8px';

            qtyGrid.appendChild(createCheckboxField('qty_pressure', !!node.parameters['qty_pressure'], 'Pressure'));
            qtyGrid.appendChild(createCheckboxField('qty_density', !!node.parameters['qty_density'], 'Density'));
            qtyGrid.appendChild(createCheckboxField('qty_velocity', !!node.parameters['qty_velocity'], 'Velocity'));
            qtyGrid.appendChild(createCheckboxField('qty_energy', !!node.parameters['qty_energy'], 'Internal Energy'));
            qtyGrid.appendChild(createCheckboxField('qty_reacted', !!node.parameters['qty_reacted'], 'Reacted (Alpha1)'));
            qtyGrid.appendChild(createCheckboxField('qty_unreacted', !!node.parameters['qty_unreacted'], 'Unreacted (Alpha2)'));
            qtyGrid.appendChild(createCheckboxField('qty_air', !!node.parameters['qty_air'], 'Air'));
            panels[3].appendChild(qtyGrid);
        }

        if (node.type !== 'Telemetry3DViewport') {
            // QUANTITIES Tab: multi-column checkboxes
            const qtyGrid = document.createElement('div');
            qtyGrid.style.display = 'grid';
            qtyGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            qtyGrid.style.gap = '8px';

            qtyGrid.appendChild(createCheckboxField('qty_pressure', !!node.parameters['qty_pressure'], 'Pressure'));
            qtyGrid.appendChild(createCheckboxField('qty_density', !!node.parameters['qty_density'], 'Density'));
            qtyGrid.appendChild(createCheckboxField('qty_velocity', !!node.parameters['qty_velocity'], 'Velocity'));
            qtyGrid.appendChild(createCheckboxField('qty_energy', !!node.parameters['qty_energy'], 'Internal Energy'));
            qtyGrid.appendChild(createCheckboxField('qty_reacted', !!node.parameters['qty_reacted'], 'Reacted (Alpha1)'));
            qtyGrid.appendChild(createCheckboxField('qty_unreacted', !!node.parameters['qty_unreacted'], 'Unreacted (Alpha2)'));
            qtyGrid.appendChild(createCheckboxField('qty_air', !!node.parameters['qty_air'], 'Air'));

            panels[2].appendChild(qtyGrid);
        }

        this.container.appendChild(form);

        // Connections section
        const ioSection = document.createElement('div');
        ioSection.style.padding = '10px';
        ioSection.style.borderTop = '1px solid #333';
        ioSection.style.marginTop = '10px';

        const ioHeader = document.createElement('div');
        ioHeader.style.fontWeight = 'bold';
        ioHeader.style.fontSize = 'var(--font-sm)';
        ioHeader.style.color = '#569cd6';
        ioHeader.style.marginBottom = '8px';
        ioHeader.textContent = 'I/O CONNECTIONS';
        ioSection.appendChild(ioHeader);

        const state = this.stateManager.getCurrentState();
        const incoming = state ? state.connections.filter(c => c.toNode === node.id) : [];
        const outgoing = state ? state.connections.filter(c => c.fromNode === node.id) : [];

        if (incoming.length === 0 && outgoing.length === 0) {
            const noConn = document.createElement('div');
            noConn.style.fontSize = 'var(--font-sm)';
            noConn.style.color = '#666';
            noConn.style.fontStyle = 'italic';
            noConn.textContent = 'No connections active';
            ioSection.appendChild(noConn);
        } else {
            incoming.forEach(c => {
                const connDiv = document.createElement('div');
                connDiv.style.fontSize = 'var(--font-sm)';
                connDiv.style.color = '#ccc';
                connDiv.style.marginBottom = '4px';
                connDiv.textContent = `📥 ${c.fromPort} ← [${c.fromNode}]`;
                ioSection.appendChild(connDiv);
            });
            outgoing.forEach(c => {
                const connDiv = document.createElement('div');
                connDiv.style.fontSize = 'var(--font-sm)';
                connDiv.style.color = '#ccc';
                connDiv.style.marginBottom = '4px';
                connDiv.textContent = `📤 ${c.fromPort} → [${c.toNode}] (${c.toPort})`;
                ioSection.appendChild(connDiv);
            });
        }
        this.container.appendChild(ioSection);
    }

    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        if (typeof value === 'boolean') {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = value;
            checkbox.style.width = 'auto';
            checkbox.style.margin = '4px 0';
            checkbox.addEventListener('change', () => {
                this.updateParameter(key, checkbox.checked);
            });
            return checkbox;
        }

        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'output_interval',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
            'ascii_precision', 'step_interval', 'time_interval',
            // 2D CFD keys
            'nr', 'nz', 'max_r', 'max_z', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r',
            'charge_r', 'charge_z', 'charge_radius', 'charge_height',
            'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
            'ideal_gamma', 'ideal_rho_0', 'ideal_e_0'
        ];

        const dropdowns: Record<string, string[]> = {
            'dimension': ['1D', '2D', '3D'],
            'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'left_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'right_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_x_min': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_x_max': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_y_min': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_y_max': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_r_min': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_r_max': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_z_min': ['Reflecting', 'Transmitting', 'Terminate'],
            'bc_z_max': ['Reflecting', 'Transmitting', 'Terminate'],
            'coordinate_system': ['Axisymmetric', 'Cartesian'],
            'device': ['cpu', 'cuda'],
            'precision': ['double', 'single'],
            'trigger_type': ['end', 'time', 'step'],
            'composition': ['Aluminized ANFO', 'Ammonal', 'ANFO', 'Baratol', 'C-4', 'Composition A-3', 'Composition B', 'Composition C-3', 'Cyclotol', 'Heavy ANFO', 'HMX', 'LX-04', 'LX-07', 'LX-10', 'LX-14', 'LX-17', 'Mining Emulsion', 'Octol', 'PBX 9404', 'PBX 9501', 'PBX 9502', 'PE-10', 'PE-12', 'PE-4', 'PE-8', 'Pentolite', 'PETN', 'RDX', 'TATB', 'Tetryl', 'TNT', 'Water Gel', 'Custom'],
            'init_mode': ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3'],
            'output_mode': ['By Step', 'By Time'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': ['Sphere', 'Cylinder'],
            'material_type': ['Air', 'JWL Charge', 'Ideal Gas Charge'],
            'colormap': ['plasma', 'viridis', 'rainbow', 'coolwarm', 'cividis', 'grayscale'],
            'refresh_rate': ['0.0', '0.016', '0.033', '0.05', '0.1', '0.2', '0.5', '1.0'],
            'ascii_delimiter': ['Comma', 'Tab', 'Space'],
            'vtk_format': ['ASCII', 'Binary', 'Compressed Binary']
        };

        if (dropdowns[key]) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';

            dropdowns[key].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.text = opt;
                if (opt === value.toString()) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                let val: any = select.value;
                if (numericKeys.includes(key)) val = Number(val);
                this.updateParameter(key, val);
            });
            return select;
        }

        const input = document.createElement('input');
        const isNumeric = numericKeys.includes(key) || typeof value === 'number';
        input.type = isNumeric ? 'number' : 'text';
        if (input.type === 'number') input.step = 'any';
        input.value = value;
        input.style.width = '100%';
        input.style.background = '#252526';
        input.style.color = '#ccc';
        input.style.border = '1px solid #444';
        input.style.padding = '4px';

        input.addEventListener('input', () => {
            let newVal: any = input.value;
            if (input.type === 'number') {
                newVal = Number(input.value);
            }
            this.updateParameter(key, newVal);
        });

        return input;
    }

    private renderTelemetry3DViewportSlices(node: Node, container: HTMLElement): void {
        const slices = node.parameters.slices || [];
        
        const sectionTitle = document.createElement('div');
        sectionTitle.style.fontWeight = 'bold';
        sectionTitle.style.fontSize = 'var(--font-sm)';
        sectionTitle.style.color = '#888';
        sectionTitle.style.marginTop = '15px';
        sectionTitle.style.marginBottom = '6px';
        sectionTitle.textContent = 'ACTIVE CROSS-SECTION SLICES';
        container.appendChild(sectionTitle);

        const listContainer = document.createElement('div');
        listContainer.style.display = 'flex';
        listContainer.style.flexDirection = 'column';
        listContainer.style.gap = '8px';
        container.appendChild(listContainer);

        slices.forEach((slice: any, idx: number) => {
            const row = document.createElement('div');
            row.style.background = '#1e1e1e';
            row.style.border = '1px solid #333';
            row.style.borderRadius = '4px';
            row.style.padding = '8px';
            row.style.display = 'flex';
            row.style.flexDirection = 'column';
            row.style.gap = '4px';

            // Header of the slice row (Slice # and Delete button)
            const rowHeader = document.createElement('div');
            rowHeader.style.display = 'flex';
            rowHeader.style.justifyContent = 'space-between';
            rowHeader.style.alignItems = 'center';

            const title = document.createElement('span');
            title.style.fontSize = 'var(--font-xs)';
            title.style.fontWeight = 'bold';
            title.style.color = '#569cd6';
            title.textContent = `Slice #${idx + 1}`;
            rowHeader.appendChild(title);

            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete';
            delBtn.style.fontSize = '10px';
            delBtn.style.padding = '2px 6px';
            delBtn.style.background = '#dc2626';
            delBtn.style.color = '#fff';
            delBtn.style.border = 'none';
            delBtn.style.borderRadius = '3px';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = (e) => {
                e.preventDefault();
                const updated = slices.filter((_: any, i: number) => i !== idx);
                this.updateParameter('slices', updated);
            };
            rowHeader.appendChild(delBtn);
            row.appendChild(rowHeader);

            // Inputs: Axis and Offset
            const inputsRow = document.createElement('div');
            inputsRow.style.display = 'flex';
            inputsRow.style.gap = '8px';

            // Axis select
            const axisDiv = document.createElement('div');
            axisDiv.style.flex = '1';
            const axisLabel = document.createElement('label');
            axisLabel.style.fontSize = '10px';
            axisLabel.style.color = '#888';
            axisLabel.textContent = 'AXIS';
            axisDiv.appendChild(axisLabel);

            const axisSelect = document.createElement('select');
            axisSelect.style.width = '100%';
            axisSelect.style.background = '#252526';
            axisSelect.style.color = '#ccc';
            axisSelect.style.border = '1px solid #444';
            axisSelect.style.fontSize = 'var(--font-xs)';
            axisSelect.style.padding = '2px';
            
            ['xy', 'xz', 'yz'].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.text = opt.toUpperCase();
                if (opt === slice.axis) option.selected = true;
                axisSelect.appendChild(option);
            });
            axisSelect.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, axis: axisSelect.value };
                this.updateParameter('slices', updated);
            };
            axisDiv.appendChild(axisSelect);
            inputsRow.appendChild(axisDiv);

            // Offset input
            const offsetDiv = document.createElement('div');
            offsetDiv.style.flex = '1';
            const offsetLabel = document.createElement('label');
            offsetLabel.style.fontSize = '10px';
            offsetLabel.style.color = '#888';
            offsetLabel.textContent = 'OFFSET';
            offsetDiv.appendChild(offsetLabel);

            const offsetInput = document.createElement('input');
            offsetInput.type = 'number';
            offsetInput.step = 'any';
            offsetInput.value = slice.offset;
            offsetInput.style.width = '100%';
            offsetInput.style.background = '#252526';
            offsetInput.style.color = '#ccc';
            offsetInput.style.border = '1px solid #444';
            offsetInput.style.fontSize = 'var(--font-xs)';
            offsetInput.style.padding = '2px';
            offsetInput.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, offset: Number(offsetInput.value) };
                this.updateParameter('slices', updated);
            };
            offsetDiv.appendChild(offsetInput);
            inputsRow.appendChild(offsetDiv);

            // Quantity select
            const qtyDiv = document.createElement('div');
            qtyDiv.style.flex = '1';
            const qtyLabel = document.createElement('label');
            qtyLabel.style.fontSize = '10px';
            qtyLabel.style.color = '#888';
            qtyLabel.textContent = 'QUANTITY';
            qtyDiv.appendChild(qtyLabel);

            const qtySelect = document.createElement('select');
            qtySelect.style.width = '100%';
            qtySelect.style.background = '#252526';
            qtySelect.style.color = '#ccc';
            qtySelect.style.border = '1px solid #444';
            qtySelect.style.fontSize = 'var(--font-xs)';
            qtySelect.style.padding = '2px';
            
            const QUANTITIES = [
                { value: 'pressure', label: 'Pressure' },
                { value: 'density', label: 'Density' },
                { value: 'velocity', label: 'Velocity' },
                { value: 'energy', label: 'Energy' },
                { value: 'species1', label: 'Species 1' },
                { value: 'species2', label: 'Species 2' },
                { value: 'species3', label: 'Species 3' }
            ];

            QUANTITIES.forEach(q => {
                const option = document.createElement('option');
                option.value = q.value;
                option.text = q.label;
                if (slice.quantities && slice.quantities[0] === q.value) option.selected = true;
                qtySelect.appendChild(option);
            });
            qtySelect.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, quantities: [qtySelect.value] };
                this.updateParameter('slices', updated);
            };
            qtyDiv.appendChild(qtySelect);
            inputsRow.appendChild(qtyDiv);

            // Stride select
            const strideDiv = document.createElement('div');
            strideDiv.style.flex = '1';
            const strideLabel = document.createElement('label');
            strideLabel.style.fontSize = '10px';
            strideLabel.style.color = '#888';
            strideLabel.textContent = 'STRIDE';
            strideDiv.appendChild(strideLabel);

            const strideSelect = document.createElement('select');
            strideSelect.style.width = '100%';
            strideSelect.style.background = '#252526';
            strideSelect.style.color = '#ccc';
            strideSelect.style.border = '1px solid #444';
            strideSelect.style.fontSize = 'var(--font-xs)';
            strideSelect.style.padding = '2px';

            [1, 2, 4, 8, 16].forEach(st => {
                const option = document.createElement('option');
                option.value = String(st);
                option.text = `1:${st}`;
                if ((slice.stride || 1) === st) option.selected = true;
                strideSelect.appendChild(option);
            });
            strideSelect.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, stride: Number(strideSelect.value) };
                this.updateParameter('slices', updated);
            };
            strideDiv.appendChild(strideSelect);
            inputsRow.appendChild(strideDiv);

            row.appendChild(inputsRow);
            listContainer.appendChild(row);
        });

        // Add Slice Button
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add Slice';
        addBtn.style.marginTop = '8px';
        addBtn.style.padding = '4px 8px';
        addBtn.style.background = '#38bdf8';
        addBtn.style.color = '#0f172a';
        addBtn.style.border = 'none';
        addBtn.style.borderRadius = '4px';
        addBtn.style.cursor = 'pointer';
        addBtn.style.fontWeight = 'bold';
        addBtn.onclick = (e) => {
            e.preventDefault();
            const updated = [...slices, { axis: 'xy', offset: 0.5, quantities: ['pressure'], stride: 1 }];
            this.updateParameter('slices', updated);
        };
        container.appendChild(addBtn);
    }


    private updateParameter(key: string, value: any): void {
        if (!this.currentNodeId) return;

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) return;

        const updates: Record<string, any> = { [key]: value };

        if (node.type === 'Material' && key === 'composition') {
            const EXPLOSIVE_PRESETS: Record<string, Record<string, number>> = {
                'Aluminized ANFO': {
                    rho: 1050,
                    detonation_energy: 4100000,
                    det_vel: 4900,
                    jwl_A: 76.5e9,
                    jwl_B: 1.85e9,
                    jwl_R1: 4.15,
                    jwl_R2: 1.15,
                    jwl_omega: 0.30
                },
                'Ammonal': {
                    rho: 1600,
                    detonation_energy: 4400000,
                    det_vel: 5400,
                    jwl_A: 125.0e9,
                    jwl_B: 2.5e9,
                    jwl_R1: 4.0,
                    jwl_R2: 1.0,
                    jwl_omega: 0.25
                },
                'ANFO': {
                    rho: 930,
                    detonation_energy: 3700000,
                    det_vel: 4700,
                    jwl_A: 49.46e9,
                    jwl_B: 1.891e9,
                    jwl_R1: 4.10,
                    jwl_R2: 1.15,
                    jwl_omega: 0.33
                },
                'Baratol': {
                    rho: 2550,
                    detonation_energy: 2800000,
                    det_vel: 4900,
                    jwl_A: 289.4e9,
                    jwl_B: 5.14e9,
                    jwl_R1: 4.4,
                    jwl_R2: 1.2,
                    jwl_omega: 0.25
                },
                'C-4': {
                    rho: 1601,
                    detonation_energy: 5600000,
                    det_vel: 8040,
                    jwl_A: 593.7e9,
                    jwl_B: 12.87e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.2,
                    jwl_omega: 0.38
                },
                'Composition A-3': {
                    rho: 1650,
                    detonation_energy: 5000000,
                    det_vel: 8100,
                    jwl_A: 601.5e9,
                    jwl_B: 12.0e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.2,
                    jwl_omega: 0.35
                },
                'Composition B': {
                    rho: 1717,
                    detonation_energy: 5170000,
                    det_vel: 7980,
                    jwl_A: 524.2e9,
                    jwl_B: 7.67e9,
                    jwl_R1: 4.2,
                    jwl_R2: 1.1,
                    jwl_omega: 0.34
                },
                'Composition C-3': {
                    rho: 1600,
                    detonation_energy: 5300000,
                    det_vel: 8000,
                    jwl_A: 580.0e9,
                    jwl_B: 11.5e9,
                    jwl_R1: 4.4,
                    jwl_R2: 1.2,
                    jwl_omega: 0.35
                },
                'Cyclotol': {
                    rho: 1750,
                    detonation_energy: 5200000,
                    det_vel: 8250,
                    jwl_A: 582.0e9,
                    jwl_B: 10.5e9,
                    jwl_R1: 4.3,
                    jwl_R2: 1.1,
                    jwl_omega: 0.32
                },
                'Heavy ANFO': {
                    rho: 1250,
                    detonation_energy: 3500000,
                    det_vel: 5000,
                    jwl_A: 198.0e9,
                    jwl_B: 1.45e9,
                    jwl_R1: 4.30,
                    jwl_R2: 1.00,
                    jwl_omega: 0.20
                },
                'HMX': {
                    rho: 1890,
                    detonation_energy: 5620000,
                    det_vel: 9110,
                    jwl_A: 778.3e9,
                    jwl_B: 7.071e9,
                    jwl_R1: 4.2,
                    jwl_R2: 1.0,
                    jwl_omega: 0.30
                },
                'LX-04': {
                    rho: 1860,
                    detonation_energy: 5300000,
                    det_vel: 8400,
                    jwl_A: 742.0e9,
                    jwl_B: 11.2e9,
                    jwl_R1: 4.4,
                    jwl_R2: 1.2,
                    jwl_omega: 0.30
                },
                'LX-07': {
                    rho: 1860,
                    detonation_energy: 5500000,
                    det_vel: 8600,
                    jwl_A: 785.0e9,
                    jwl_B: 12.5e9,
                    jwl_R1: 4.45,
                    jwl_R2: 1.15,
                    jwl_omega: 0.32
                },
                'LX-10': {
                    rho: 1860,
                    detonation_energy: 5800000,
                    det_vel: 8820,
                    jwl_A: 830.0e9,
                    jwl_B: 15.0e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.1,
                    jwl_omega: 0.38
                },
                'LX-14': {
                    rho: 1835,
                    detonation_energy: 6000000,
                    det_vel: 8800,
                    jwl_A: 825.8e9,
                    jwl_B: 17.24e9,
                    jwl_R1: 4.4,
                    jwl_R2: 0.9,
                    jwl_omega: 0.38
                },
                'LX-17': {
                    rho: 1900,
                    detonation_energy: 4500000,
                    det_vel: 7600,
                    jwl_A: 640.0e9,
                    jwl_B: 14.0e9,
                    jwl_R1: 4.2,
                    jwl_R2: 1.1,
                    jwl_omega: 0.30
                },
                'Mining Emulsion': {
                    rho: 1150,
                    detonation_energy: 3200000,
                    det_vel: 5300,
                    jwl_A: 215.0e9,
                    jwl_B: 1.76e9,
                    jwl_R1: 4.45,
                    jwl_R2: 1.05,
                    jwl_omega: 0.15
                },
                'Octol': {
                    rho: 1810,
                    detonation_energy: 5400000,
                    det_vel: 8380,
                    jwl_A: 718.5e9,
                    jwl_B: 13.9e9,
                    jwl_R1: 4.35,
                    jwl_R2: 1.05,
                    jwl_omega: 0.32
                },
                'PBX 9404': {
                    rho: 1840,
                    detonation_energy: 6020000,
                    det_vel: 8800,
                    jwl_A: 852.4e9,
                    jwl_B: 18.02e9,
                    jwl_R1: 4.55,
                    jwl_R2: 1.10,
                    jwl_omega: 0.38
                },
                'PBX 9501': {
                    rho: 1830,
                    detonation_energy: 5880000,
                    det_vel: 8800,
                    jwl_A: 854.5e9,
                    jwl_B: 20.49e9,
                    jwl_R1: 4.60,
                    jwl_R2: 1.35,
                    jwl_omega: 0.38
                },
                'PBX 9502': {
                    rho: 1895,
                    detonation_energy: 4100000,
                    det_vel: 7700,
                    jwl_A: 548.8e9,
                    jwl_B: 7.67e9,
                    jwl_R1: 4.4,
                    jwl_R2: 1.2,
                    jwl_omega: 0.30
                },
                'PE-10': {
                    rho: 1550,
                    detonation_energy: 5200000,
                    det_vel: 7800,
                    jwl_A: 590.0e9,
                    jwl_B: 12.0e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.4,
                    jwl_omega: 0.25
                },
                'PE-12': {
                    rho: 1520,
                    detonation_energy: 5000000,
                    det_vel: 7700,
                    jwl_A: 570.0e9,
                    jwl_B: 11.5e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.4,
                    jwl_omega: 0.25
                },
                'PE-4': {
                    rho: 1590,
                    detonation_energy: 5621000,
                    det_vel: 8100,
                    jwl_A: 609.8e9,
                    jwl_B: 12.95e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.4,
                    jwl_omega: 0.25
                },
                'PE-8': {
                    rho: 1570,
                    detonation_energy: 5400000,
                    det_vel: 8000,
                    jwl_A: 600.0e9,
                    jwl_B: 12.5e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.4,
                    jwl_omega: 0.25
                },
                'Pentolite': {
                    rho: 1660,
                    detonation_energy: 5000000,
                    det_vel: 7470,
                    jwl_A: 492.2e9,
                    jwl_B: 9.38e9,
                    jwl_R1: 4.3,
                    jwl_R2: 1.1,
                    jwl_omega: 0.31
                },
                'PETN': {
                    rho: 1770,
                    detonation_energy: 5800000,
                    det_vel: 8300,
                    jwl_A: 613.4e9,
                    jwl_B: 15.07e9,
                    jwl_R1: 4.4,
                    jwl_R2: 1.2,
                    jwl_omega: 0.28
                },
                'RDX': {
                    rho: 1806,
                    detonation_energy: 5300000,
                    det_vel: 8750,
                    jwl_A: 524.2e9,
                    jwl_B: 7.678e9,
                    jwl_R1: 4.2,
                    jwl_R2: 1.1,
                    jwl_omega: 0.34
                },
                'TATB': {
                    rho: 1800,
                    detonation_energy: 4400000,
                    det_vel: 7660,
                    jwl_A: 554.6e9,
                    jwl_B: 7.91e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.6,
                    jwl_omega: 0.25
                },
                'Tetryl': {
                    rho: 1730,
                    detonation_energy: 4230000,
                    det_vel: 7570,
                    jwl_A: 510.9e9,
                    jwl_B: 8.44e9,
                    jwl_R1: 4.5,
                    jwl_R2: 1.4,
                    jwl_omega: 0.25
                },
                'TNT': {
                    rho: 1630,
                    detonation_energy: 4290000,
                    det_vel: 6930,
                    jwl_A: 373.77e9,
                    jwl_B: 3.747e9,
                    jwl_R1: 4.15,
                    jwl_R2: 0.90,
                    jwl_omega: 0.35
                },
                'Water Gel': {
                    rho: 1200,
                    detonation_energy: 3400000,
                    det_vel: 4800,
                    jwl_A: 154.0e9,
                    jwl_B: 2.15e9,
                    jwl_R1: 4.30,
                    jwl_R2: 1.10,
                    jwl_omega: 0.25
                }
            };
            const preset = EXPLOSIVE_PRESETS[value];
            if (preset) {
                const matType = node.parameters['material_type'] || 'Air';
                if (matType === 'Ideal Gas Charge') {
                    updates['ideal_rho_0'] = preset.rho;
                    updates['ideal_e_0'] = preset.detonation_energy;
                } else {
                    Object.assign(updates, preset);
                }
            }
        } else if (node.type === 'Material' && ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].includes(key)) {
            updates['composition'] = 'Custom';
        } else if (node.type === 'Material' && ['ideal_rho_0', 'ideal_e_0'].includes(key)) {
            updates['composition'] = 'Custom';
        }

        this.stateManager.updateNodeParameters(this.currentNodeId, updates);
        
        const structuralKeys = ['material_type', 'composition', 'dimension', 'charge_shape'];
        this.render(structuralKeys.includes(key));
    }

    private getNodeDescription(type: string): string {
        switch (type) {
            case 'DomainMesh':
                return 'Cartesian grid with structured uniform mesh. Defines the spatial domain boundary conditions and discretization sizing.';
            case 'Material':
                return 'Material properties. Defines Air, JWL explosive, or Ideal Gas explosive equations of state.';
            case 'Charge1D':
                return '1D Charge configuration.';
            case 'Charge2D':
                return '2D Charge configuration.';
            case 'ThePainter':
                return 'Initial conditions painter. Maps mesh cells to physical material states for the simulation starting phase.';
            case 'CFDSolver':
                return 'High-order CFD solver. Set init_mode to Multi-Material JWL for JWL detonation products + unreacted explosive, or Ideal Gas for a simpler single-material hot-gas burst.';
            case 'TelemetryText':
                return 'Live text stream telemetry logger. Outputs simulator event timelines, iteration milestones, and system states.';
            case 'TelemetryGraph':
                return 'Real-time chart telemetry viewer. Plots grid spatial properties, cell pressure profiles, and simulation telemetry histories.';
            case 'DomainMesh2D':
                return '2D Axisymmetric mesh. Discretizes the r-z coordinates and defines boundary conditions for r_min, r_max, z_min, z_max.';
            case 'DetonatorLocation':
                return 'Detonator position and size. Defines where detonation starts in the 2D r-z space.';
            case 'DetonatorLocation3D':
                return 'Detonator position. Defines where detonation starts in the 3D Cartesian space.';
            case 'RemapNode':
                return 'Remapper node. Integrates the 1D physical state onto the 2D mesh, interpolating conservation variables at the specified trigger condition.';
            case 'HardwareConfig':
                return 'Hardware settings. Choose execution device: CPU (utilizes OpenMP threads) or GPU (utilizes CUDA math kernels).';
            case 'CFDSolver2D':
                return '2D axisymmetric CFD solver. Connects 2D domain mesh, detonators, remapper, hardware settings, and charge materials.';
            case 'TelemetryContour':
                return 'Real-time 2D contour plot (heatmap) telemetry viewer. Renders dynamic physical fields (pressure, density, speed, mass fractions).';
            case 'VTKOutput':
                return 'Controls saving simulation state snapshots in standard VTK XML Unstructured Grid (.vtu) format for external visualizers like Paraview.';
            case 'VirtualGauges':
                return 'Virtual gauges. Records and tracks simulation variables (pressure, density, velocity, species) at discrete coordinates over time.';
            default:
                return 'Simulation graph node.';
        }
    }
}
