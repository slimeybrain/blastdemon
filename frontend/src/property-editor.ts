import { StateManager, calculateRefinementMeshInfo, getMeshDisplayHTML, getMPMDisplayHTML } from './state-manager.js';
import { Node } from './types.js';
import { validateSimulationState } from './validation.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { MPM_MATERIAL_PRESET_NAMES, MPM_MATERIAL_PRESETS, MPM_MATERIAL_CATEGORIES } from './mpm-presets.js';

export class PropertyEditor {
    public container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private listener: ((state: any) => void) | null = null;
    private activeTabIdx: number = 0;
    private _forceNextFull: boolean = false;
    private _lastSlicesJson: string = '';
    private _lastStructJson: string = '';
    private selectedPrimitiveIndex: number = 0;

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.id = 'property-editor-container';
        this.container.className = 'panel-content scrollable';
        parent.appendChild(this.container);

        this.stateManager = stateManager;
        this.currentNodeId = this.stateManager.getSelectedNodeId();
        this.listener = () => {
            const state = this.stateManager.getCurrentState();
            const node = state?.nodes.find(n => n.id === this.currentNodeId);
            let force = false;
            if (node) {
                const slicesJson = JSON.stringify(node.parameters.slices || []);
                if (slicesJson !== this._lastSlicesJson) {
                    this._lastSlicesJson = slicesJson;
                    force = true;
                }
                const structJson = JSON.stringify([
                    node.parameters.material_model,
                    node.parameters.material_type,
                    node.parameters.composition,
                    node.parameters.charge_shape,
                    node.parameters.shape_type,
                    node.parameters.dimension,
                    node.parameters.velocity_scheme
                ]);
                if (structJson !== this._lastStructJson) {
                    this._lastStructJson = structJson;
                    force = true;
                }
            }
            this.render(force);
        };
        this.stateManager.onStateChange(this.listener);
        
        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);
        this._lastSlicesJson = node ? JSON.stringify(node.parameters.slices || []) : '';
        this._lastStructJson = node ? JSON.stringify([
            node.parameters.material_model,
            node.parameters.material_type,
            node.parameters.composition,
            node.parameters.charge_shape,
            node.parameters.shape_type,
            node.parameters.dimension,
            node.parameters.velocity_scheme
        ]) : '';
        
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
        
        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        this._lastSlicesJson = node ? JSON.stringify(node.parameters.slices || []) : '';
        
        this.render(true);
    }

    private render(forceFull: boolean = false): void {
        // Consume the _forceNextFull flag set by updateSlicesInPlace so that
        // slice add/remove always causes a full DOM rebuild, not a fast-path no-op.
        if (this._forceNextFull) {
            this._forceNextFull = false;
            forceFull = true;
        }
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
                const el = this.container.querySelector(`[data-key="${key}"]`) as HTMLInputElement | HTMLSelectElement;
                if (el && document.activeElement !== el) {
                    // FIX 8: Handle checkbox type — setting .value does nothing for checkboxes
                    if ((el as HTMLInputElement).type === 'checkbox') {
                        (el as HTMLInputElement).checked = !!value;
                    } else {
                        el.value = value.toString();
                    }
                }
            }

            const stsEl = this.container.querySelector('[data-key="space_time_scheme"]') as HTMLSelectElement;
            if (stsEl && document.activeElement !== stsEl) {
                const so = node.parameters['spatial_order'] ?? 2;
                const to = node.parameters['temporal_order'] ?? 2;
                let currentVal = 'RK2 (2nd-Order Space/Time)';
                if (so === 1 && to === 1) currentVal = 'Euler (1st-Order Space/Time)';
                else if (so === 2 && to === 2) currentVal = 'RK2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 3) currentVal = 'RK3 (3rd-Order Space/Time)';
                else if (so === 2 && to === 4) currentVal = 'MUSCL-Hancock (2nd-Order Space/Time)';
                else if (so === 2 && to === 5) currentVal = 'ADER-2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 6) currentVal = 'ADER-3 (3rd-Order Space/Time)';
                stsEl.value = currentVal;
            }

            const gridInfo = this.container.querySelector('#grid-info-display') as HTMLDivElement;
            if (gridInfo) {
                gridInfo.innerHTML = getMeshDisplayHTML(node, state ?? undefined);
            }

            const mpmInfo = this.container.querySelector('#mpm-info-display') as HTMLDivElement;
            if (mpmInfo) {
                mpmInfo.innerHTML = getMPMDisplayHTML(node, state ?? undefined);
            }


            // Refresh validation warnings banner even in fast-update path
            const warnings: string[] = [];
            if (state) {
                const valResults = validateSimulationState(state);
                const activeWs = this.stateManager.getActiveWorkspace();
                const activeModelId = activeWs ? activeWs.activeModelId : null;
                const activeModel = activeModelId ? this.stateManager.getAppState().models[activeModelId] : null;
                const activeNodeIds = activeModel ? new Set(activeModel.nodes.map(n => n.id)) : new Set<string>();

                valResults.globalWarnings.forEach(w => {
                    const match = w.match(/^\[[^\]]+?\s+"([^"]+)"\]/);
                    if (match) {
                        const nodeId = match[1];
                        if (activeNodeIds.has(nodeId)) {
                            warnings.push(w);
                        }
                    } else {
                        warnings.push(w);
                    }
                });
            }

            let warnBox = this.container.querySelector('.validation-warning-box') as HTMLDivElement;
            if (warnings.length > 0) {
                if (!warnBox) {
                    warnBox = document.createElement('div');
                    warnBox.className = 'validation-warning-box';
                    warnBox.style.background = '#dc262622';
                    warnBox.style.border = '1px solid #dc2626';
                    warnBox.style.borderRadius = '4px';
                    warnBox.style.margin = '10px';
                    warnBox.style.padding = '10px';
                    warnBox.style.color = '#ef4444';
                    warnBox.style.fontSize = 'var(--font-sm)';
                    warnBox.style.fontWeight = 'bold';
                    
                    const form = this.container.querySelector('form');
                    if (form) {
                        this.container.insertBefore(warnBox, form);
                    } else {
                        this.container.appendChild(warnBox);
                    }
                }
                
                warnBox.innerHTML = '';
                warnings.forEach(w => {
                    const p = document.createElement('div');
                    p.style.marginBottom = '4px';
                    p.innerHTML = `⚠️ ${w}`;
                    warnBox.appendChild(p);
                });
            } else if (warnBox) {
                warnBox.remove();
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
        } else if (node.type === 'MPMMaterialSteel') {
            const presetName = node.parameters['preset'] || 'Structural Steel (A36)';
            const presetData = MPM_MATERIAL_PRESETS[presetName];
            const ref = presetData?.reference || 'N/A';
            descText += ` | Preset: ${presetName} (Reference: ${ref})`;
        }
        descBlock.textContent = descText;
        this.container.appendChild(descBlock);

        // Validation warnings banner
        const warnings: string[] = [];
        if (state) {
            const valResults = validateSimulationState(state);
            const activeWs = this.stateManager.getActiveWorkspace();
            const activeModelId = activeWs ? activeWs.activeModelId : null;
            const activeModel = activeModelId ? this.stateManager.getAppState().models[activeModelId] : null;
            const activeNodeIds = activeModel ? new Set(activeModel.nodes.map(n => n.id)) : new Set<string>();

            valResults.globalWarnings.forEach(w => {
                const match = w.match(/^\[[^\]]+?\s+"([^"]+)"\]/);
                if (match) {
                    const nodeId = match[1];
                    if (activeNodeIds.has(nodeId)) {
                        warnings.push(w);
                    }
                } else {
                    warnings.push(w);
                }
            });
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
        if (node.type === 'VirtualGauges' || node.type === 'VTKOutput' || node.type === 'Telemetry3DViewport') {
            this.renderTabbedProperties(node);
            return;
        }
        if (node.type === 'PrimitiveGeometry3D') {
            this.renderPrimitiveGeometryEditor(node);
            return;
        }
 
        const form = document.createElement('form');
        form.style.padding = '10px';
        form.onsubmit = (e) => e.preventDefault();

        let paramKeys = Object.keys(node.parameters);
        if (node.type === 'MPMMaterialSteel') {
            if (!node.parameters['material_model']) {
                node.parameters['material_model'] = 'Hypoelastic';
            }
            if (!node.parameters['preset']) {
                node.parameters['preset'] = 'Structural Steel (A36)';
            }
            const matModel = node.parameters['material_model'];
            const baseKeys = ['material_model', 'preset', 'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus', 'failure_strain', 'tensile_failure_stress'];
            const jcKeys = ['jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp', 'mg_gamma0', 'mg_c0', 'mg_s'];
            paramKeys = (matModel === 'Johnson-Cook + Mie-Grüneisen') ? [...baseKeys, ...jcKeys] : baseKeys;
        } else if (node.type === 'MPMDomain2D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            paramKeys = ['precision', 'transfer_scheme', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) {
                paramKeys.push('flip_blend');
            }
            paramKeys.push('ppc', 'cfl');
        } else if (node.type === 'MPMDomain3D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            paramKeys = ['device', 'precision', 'transfer_scheme', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) {
                paramKeys.push('flip_blend');
            }
            paramKeys.push('ppc', 'cfl');
        } else if (node.type === 'CFDSolver3D' || node.type === 'CFDSolver2D') {
            paramKeys = paramKeys.filter(k => k !== 'spatial_order' && k !== 'temporal_order');
            const idx = Object.keys(node.parameters).indexOf('spatial_order');
            if (idx !== -1) {
                paramKeys.splice(idx, 0, 'space_time_scheme');
            } else {
                paramKeys.push('space_time_scheme');
            }
        }

        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            paramKeys.sort((a, b) => {
                if (a === 'cell_size') return -1;
                if (b === 'cell_size') return 1;
                return 0;
            });
        } else if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
            paramKeys.sort((a, b) => {
                if (a === 'charge_mass') return -1;
                if (b === 'charge_mass') return 1;
                return 0;
            });
        }
        
        let gridInfoDiv: HTMLDivElement | null = null;
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            const info = document.createElement('div');
            info.id = 'grid-info-display';
            info.style.fontSize = 'var(--font-sm)';
            info.style.color = '#569cd6';
            info.style.marginTop = '10px';
            info.style.lineHeight = '1.3';
            info.innerHTML = getMeshDisplayHTML(node, state ?? undefined);
            gridInfoDiv = info;
        }

        let mpmInfoDiv: HTMLDivElement | null = null;
        if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D' || node.type === 'MPMDomain3D' || node.type === 'MPMDomain2D') {
            const info = document.createElement('div');
            info.id = 'mpm-info-display';
            info.innerHTML = getMPMDisplayHTML(node, state ?? undefined);
            mpmInfoDiv = info;
        }

        let addedQtyHeader = false;
        for (const key of paramKeys) {
            let value = node.parameters[key];
            if (key === 'space_time_scheme') {
                const so = node.parameters['spatial_order'] ?? 2;
                const to = node.parameters['temporal_order'] ?? 2;
                if (so === 1 && to === 1) value = 'Euler (1st-Order Space/Time)';
                else if (so === 2 && to === 2) value = 'RK2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 3) value = 'RK3 (3rd-Order Space/Time)';
                else if (so === 2 && to === 4) value = 'MUSCL-Hancock (2nd-Order Space/Time)';
                else if (so === 2 && to === 5) value = 'ADER-2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 6) value = 'ADER-3 (3rd-Order Space/Time)';
                else value = 'RK2 (2nd-Order Space/Time)';
            }
            if (key === 'nr' || key === 'nz' || key === 'n_cells') continue;
            if (node.type === 'CFDSolver3D' && (key === 'mesh_type' || key === 'amr_max_levels' || key === 'amr_threshold' || key === 'amr_coarsen_ratio' || key === 'amr_tile_size')) continue;

            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'MPMMaterialSteel') {
                const matModel = node.parameters['material_model'] || 'Hypoelastic';
                const jcKeys = ['jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp', 'mg_gamma0', 'mg_c0', 'mg_s'];
                if (matModel === 'Hypoelastic' && jcKeys.includes(key)) continue;
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
            if (node.type === 'MPMObject3D') {
                const shape = node.parameters['shape_type'] || 'Box';
                if (shape === 'Box') {
                    if (key === 'radius' || key === 'inner_radius' || key === 'height' || key === 'stl_file' || key === 'scale_x' || key === 'scale_y' || key === 'scale_z') continue;
                } else if (shape === 'Sphere') {
                    if (key === 'size_x' || key === 'size_y' || key === 'size_z' || key === 'inner_radius' || key === 'height' || key === 'stl_file' || key === 'scale_x' || key === 'scale_y' || key === 'scale_z') continue;
                } else if (shape === 'Cylinder') {
                    if (key === 'size_x' || key === 'size_y' || key === 'size_z' || key === 'stl_file' || key === 'scale_x' || key === 'scale_y' || key === 'scale_z') continue;
                } else if (shape === 'STL') {
                    if (key === 'size_x' || key === 'size_y' || key === 'size_z' || key === 'radius' || key === 'inner_radius' || key === 'height') continue;
                }
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
            else if (key === 'flip_blend') labelText = 'FLIP BLEND (% FLIP / % PIC)';
            label.textContent = labelText;
            row.appendChild(label);

            if (key === 'stl_file') {
                const wrapper = document.createElement('div');
                wrapper.style.display = 'flex';
                wrapper.style.gap = '8px';
                wrapper.style.alignItems = 'center';

                const input = this.createInputElement(node, key, value);
                input.dataset.key = key;
                input.style.flex = '1';
                wrapper.appendChild(input);

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
                    const browser = new HostFileBrowserModal((window as any).networkManager, 'open', 'select_file', (path: string) => {
                        this.updateParameter(key, path);
                        const rand = Math.floor(Math.random() * 1000000);
                        const simpleHash = 'stl_' + rand.toString(36);
                        this.updateParameter('geometry_hash', simpleHash);
                    });
                    browser.open(startPath);
                };
                wrapper.appendChild(browseBtn);
                row.appendChild(wrapper);
            } else {
                const input = this.createInputElement(node, key, value);
                input.dataset.key = key;
                row.appendChild(input);
            }
            form.appendChild(row);
        }
        if (gridInfoDiv) {
            form.appendChild(gridInfoDiv);
        }
        if (mpmInfoDiv) {
            form.appendChild(mpmInfoDiv);
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
            // FIX 8: Add data-key so fast-path render can sync checkbox state
            cb.dataset.key = key;
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
            } else if (key === 'stl_file') {
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
                    const browser = new HostFileBrowserModal((window as any).networkManager, 'open', 'select_file', (path) => {
                        this.updateParameter(key, path);
                        const rand = Math.floor(Math.random() * 1000000);
                        const simpleHash = 'stl_' + rand.toString(36);
                        this.updateParameter('geometry_hash', simpleHash);
                        const net = (window as any).networkManager;
                        if (net && net.isConnected()) {
                            const activeWs = this.stateManager.getActiveWorkspace();
                            const modelId = activeWs?.activeModelId || 'default';
                            net.send({ command: "LOAD_STL_GEOMETRY", filePath: path, modelId });
                        }
                    });
                    browser.open(startPath);
                };
                wrapper.appendChild(browseBtn);
                row.appendChild(wrapper);
            } else {
                row.appendChild(inputEl);
            }
            
            panels[panelIdx].appendChild(row);
        };

        if (node.type === 'VirtualGauges') {
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

            const state = this.stateManager.getCurrentState();
            const conn = state?.connections.find(c => c.toNode === node.id);
            const sourceNode = conn ? state?.nodes.find(n => n.id === conn.fromNode) : null;
            const is3D = sourceNode 
                ? (sourceNode.type === 'CFDSolver3D') 
                : (state?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'DomainMesh3D') ?? false);

            if (is3D) {
                const triggersGrid = document.createElement('div');
                triggersGrid.style.display = 'grid';
                triggersGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
                triggersGrid.style.gap = '8px';
                triggersGrid.style.marginTop = '8px';

                triggersGrid.appendChild(createCheckboxField('export_slices', !!node.parameters['export_slices'], 'Export Slices'));
                triggersGrid.appendChild(createCheckboxField('export_volumes', !!node.parameters['export_volumes'], 'Export Volumes'));
                panels[0].appendChild(triggersGrid);
            }

            // FILES/CONFIG Tab
            const fileEl = this.createInputElement(node, 'custom_filename', node.parameters['custom_filename'] ?? 'vtk_output');
            addRowToPanel('custom_filename', 'CUSTOM FILENAME', fileEl, 1);

            const dirEl = this.createInputElement(node, 'vtk_dir', node.parameters['vtk_dir'] ?? '');
            addRowToPanel('vtk_dir', 'VTK DIR', dirEl, 1);
        } else if (node.type === 'Telemetry3DViewport') {
            // VIEWPORT Tab
            const cmapEl = this.createInputElement(node, 'colormap', node.parameters['colormap'] ?? 'plasma');
            addRowToPanel('colormap', 'COLORMAP', cmapEl, 0);

            const rateEl = this.createInputElement(node, 'refresh_rate', node.parameters['refresh_rate'] ?? 2.0);
            addRowToPanel('refresh_rate', 'REFRESH RATE (SECONDS)', rateEl, 0);

            const minEl = this.createInputElement(node, 'min_val', node.parameters['min_val'] ?? 101325.0);
            addRowToPanel('min_val', 'MIN VALUE', minEl, 0);

            const maxEl = this.createInputElement(node, 'max_val', node.parameters['max_val'] ?? 101325.0 * 100.0);
            addRowToPanel('max_val', 'MAX VALUE', maxEl, 0);

            const ambEl = this.createInputElement(node, 'ambientLevel', node.parameters['ambientLevel'] ?? 0.3);
            addRowToPanel('ambientLevel', 'AMBIENT LEVEL', ambEl, 0);

            const specEl = this.createInputElement(node, 'specularIntensity', node.parameters['specularIntensity'] ?? 0.4);
            addRowToPanel('specularIntensity', 'SPECULAR LEVEL', specEl, 0);

            const stlCmapEl = this.createInputElement(node, 'stl_colormap', node.parameters['stl_colormap'] ?? 'plasma');
            addRowToPanel('stl_colormap', 'STL COLORMAP', stlCmapEl, 0);

            const stlQtyEl = this.createInputElement(node, 'stl_quantity', node.parameters['stl_quantity'] ?? 'pressure');
            addRowToPanel('stl_quantity', 'STL RESULTS QTY', stlQtyEl, 0);

            const stlSampleEl = this.createInputElement(node, 'stl_sampling_mode', node.parameters['stl_sampling_mode'] ?? 'nearest');
            addRowToPanel('stl_sampling_mode', 'STL SAMPLING MODE', stlSampleEl, 0);

            const gaugeQtyEl = this.createInputElement(node, 'gauge_quantity', node.parameters['gauge_quantity'] ?? 'pressure');
            addRowToPanel('gauge_quantity', 'GAUGE DISPLAY MODE', gaugeQtyEl, 0);

            const cbSourceEl = this.createInputElement(node, 'colorbar_source', node.parameters['colorbar_source'] ?? 'slice');
            addRowToPanel('colorbar_source', 'COLOR BAR SOURCE', cbSourceEl, 0);

            const mpmQtyEl = this.createInputElement(node, 'mpmParticleQuantity', node.parameters['mpmParticleQuantity'] ?? 'vonMises');
            addRowToPanel('mpmParticleQuantity', 'MPM PARTICLE QTY', mpmQtyEl, 0);

            const mpmCmapEl = this.createInputElement(node, 'mpmParticleColormap', node.parameters['mpmParticleColormap'] ?? 'plasma');
            addRowToPanel('mpmParticleColormap', 'MPM PARTICLE COLORMAP', mpmCmapEl, 0);

            const mpmSizeEl = this.createInputElement(node, 'mpmParticleSize', node.parameters['mpmParticleSize'] ?? 4.0);
            addRowToPanel('mpmParticleSize', 'MPM PARTICLE POINT SIZE', mpmSizeEl, 0);

            const cbGrid = document.createElement('div');
            cbGrid.style.display = 'grid';
            cbGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            cbGrid.style.gap = '8px';
            cbGrid.style.marginTop = '8px';
            cbGrid.appendChild(createCheckboxField('log_scale', !!node.parameters['log_scale'], 'Log Scale'));
            cbGrid.appendChild(createCheckboxField('auto_scale', !!node.parameters['auto_scale'], 'Auto Scale'));
            cbGrid.appendChild(createCheckboxField('show_grid', node.parameters['show_grid'] !== false, 'Show Grid'));
            cbGrid.appendChild(createCheckboxField('show_grid_box', node.parameters['show_grid_box'] !== false, 'Bounding Outline'));
            cbGrid.appendChild(createCheckboxField('interpolate', !!node.parameters['interpolate'], 'Interpolate'));
            cbGrid.appendChild(createCheckboxField('lightingEnabled', node.parameters['lightingEnabled'] !== false, 'Enable Lighting'));
            cbGrid.appendChild(createCheckboxField('aoEnabled', node.parameters['aoEnabled'] !== false, 'Enable AO'));
            cbGrid.appendChild(createCheckboxField('show_stl', node.parameters['show_stl'] !== false, 'Show STL'));
            cbGrid.appendChild(createCheckboxField('stl_show_results', node.parameters['stl_show_results'] !== false, 'STL Results Map'));
            cbGrid.appendChild(createCheckboxField('stl_wireframe', !!node.parameters['stl_wireframe'], 'STL Wireframe'));
            cbGrid.appendChild(createCheckboxField('stl_solids', node.parameters['stl_solids'] !== false, 'STL Solids'));
            cbGrid.appendChild(createCheckboxField('show_gauges', node.parameters['show_gauges'] !== false, 'Show Gauges'));
            cbGrid.appendChild(createCheckboxField('gauge_solid', node.parameters['gauge_solid'] !== false, 'Gauge Solid Spheres'));
            cbGrid.appendChild(createCheckboxField('showMPMParticles', node.parameters['showMPMParticles'] !== false, 'Show MPM Particles'));
            cbGrid.appendChild(createCheckboxField('mpmParticleLogScale', !!node.parameters['mpmParticleLogScale'], 'MPM Log Scale'));
            panels[0].appendChild(cbGrid);

            const opacRow = document.createElement('div');
            opacRow.style.marginTop = '8px';
            const opacLabel = document.createElement('label');
            opacLabel.style.display = 'block';
            opacLabel.style.fontSize = 'var(--font-sm)';
            opacLabel.style.color = '#888';
            opacLabel.textContent = `STL OPACITY: ${Number(node.parameters['stl_opacity'] ?? 0.5).toFixed(2)}`;
            opacRow.appendChild(opacLabel);

            const opacSlider = document.createElement('input');
            opacSlider.type = 'range';
            opacSlider.min = '0';
            opacSlider.max = '1';
            opacSlider.step = '0.05';
            opacSlider.value = String(node.parameters['stl_opacity'] ?? 0.5);
            opacSlider.style.width = '100%';
            opacSlider.oninput = () => {
                opacLabel.textContent = `STL OPACITY: ${Number(opacSlider.value).toFixed(2)}`;
                this.updateParameter('stl_opacity', Number(opacSlider.value));
            };
            opacRow.appendChild(opacSlider);
            panels[0].appendChild(opacRow);

            const gaugeSizeRow = document.createElement('div');
            gaugeSizeRow.style.marginTop = '8px';
            const gaugeSizeLabel = document.createElement('label');
            gaugeSizeLabel.style.display = 'block';
            gaugeSizeLabel.style.fontSize = 'var(--font-sm)';
            gaugeSizeLabel.style.color = '#888';
            gaugeSizeLabel.textContent = `GAUGE SIZE: ${Number(node.parameters['gauge_size'] ?? 0.03).toFixed(3)}`;
            gaugeSizeRow.appendChild(gaugeSizeLabel);

            const gaugeSizeSlider = document.createElement('input');
            gaugeSizeSlider.type = 'range';
            gaugeSizeSlider.min = '0.005';
            gaugeSizeSlider.max = '0.2';
            gaugeSizeSlider.step = '0.005';
            gaugeSizeSlider.value = String(node.parameters['gauge_size'] ?? 0.03);
            gaugeSizeSlider.style.width = '100%';
            gaugeSizeSlider.oninput = () => {
                gaugeSizeLabel.textContent = `GAUGE SIZE: ${Number(gaugeSizeSlider.value).toFixed(3)}`;
                this.updateParameter('gauge_size', Number(gaugeSizeSlider.value));
            };
            gaugeSizeRow.appendChild(gaugeSizeSlider);
            panels[0].appendChild(gaugeSizeRow);

            const gaugeOpacRow = document.createElement('div');
            gaugeOpacRow.style.marginTop = '8px';
            const gaugeOpacLabel = document.createElement('label');
            gaugeOpacLabel.style.display = 'block';
            gaugeOpacLabel.style.fontSize = 'var(--font-sm)';
            gaugeOpacLabel.style.color = '#888';
            gaugeOpacLabel.textContent = `GAUGE OPACITY: ${Number(node.parameters['gauge_opacity'] ?? 1.0).toFixed(2)}`;
            gaugeOpacRow.appendChild(gaugeOpacLabel);

            const gaugeOpacSlider = document.createElement('input');
            gaugeOpacSlider.type = 'range';
            gaugeOpacSlider.min = '0';
            gaugeOpacSlider.max = '1';
            gaugeOpacSlider.step = '0.05';
            gaugeOpacSlider.value = String(node.parameters['gauge_opacity'] ?? 1.0);
            gaugeOpacSlider.style.width = '100%';
            gaugeOpacSlider.oninput = () => {
                gaugeOpacLabel.textContent = `GAUGE OPACITY: ${Number(gaugeOpacSlider.value).toFixed(2)}`;
                this.updateParameter('gauge_opacity', Number(gaugeOpacSlider.value));
            };
            gaugeOpacRow.appendChild(gaugeOpacSlider);
            panels[0].appendChild(gaugeOpacRow);

            const mpmOpacRow = document.createElement('div');
            mpmOpacRow.style.marginTop = '8px';
            const mpmOpacLabel = document.createElement('label');
            mpmOpacLabel.style.display = 'block';
            mpmOpacLabel.style.fontSize = 'var(--font-sm)';
            mpmOpacLabel.style.color = '#888';
            mpmOpacLabel.textContent = `MPM PARTICLE OPACITY: ${Number(node.parameters['mpmParticleOpacity'] ?? 1.0).toFixed(2)}`;
            mpmOpacRow.appendChild(mpmOpacLabel);

            const mpmOpacSlider = document.createElement('input');
            mpmOpacSlider.type = 'range';
            mpmOpacSlider.min = '0';
            mpmOpacSlider.max = '1';
            mpmOpacSlider.step = '0.05';
            mpmOpacSlider.value = String(node.parameters['mpmParticleOpacity'] ?? 1.0);
            mpmOpacSlider.style.width = '100%';
            mpmOpacSlider.oninput = () => {
                mpmOpacLabel.textContent = `MPM PARTICLE OPACITY: ${Number(mpmOpacSlider.value).toFixed(2)}`;
                this.updateParameter('mpmParticleOpacity', Number(mpmOpacSlider.value));
            };
            mpmOpacRow.appendChild(mpmOpacSlider);
            panels[0].appendChild(mpmOpacRow);

            const gridOpacRow = document.createElement('div');
            gridOpacRow.style.marginTop = '8px';
            const gridOpacLabel = document.createElement('label');
            gridOpacLabel.style.display = 'block';
            gridOpacLabel.style.fontSize = 'var(--font-sm)';
            gridOpacLabel.style.color = '#888';
            gridOpacLabel.textContent = `GRID OPACITY: ${Number(node.parameters['grid_opacity'] ?? 1.0).toFixed(2)}`;
            gridOpacRow.appendChild(gridOpacLabel);

            const gridOpacSlider = document.createElement('input');
            gridOpacSlider.type = 'range';
            gridOpacSlider.min = '0';
            gridOpacSlider.max = '1';
            gridOpacSlider.step = '0.05';
            gridOpacSlider.value = String(node.parameters['grid_opacity'] ?? 1.0);
            gridOpacSlider.style.width = '100%';
            gridOpacSlider.oninput = () => {
                gridOpacLabel.textContent = `GRID OPACITY: ${Number(gridOpacSlider.value).toFixed(2)}`;
                this.updateParameter('grid_opacity', Number(gridOpacSlider.value));
            };
            gridOpacRow.appendChild(gridOpacSlider);
            panels[0].appendChild(gridOpacRow);

            // Obstacles Section
            const obsDivider = document.createElement('div');
            obsDivider.style.borderTop = '1px solid #333';
            obsDivider.style.margin = '12px 0 8px 0';
            panels[0].appendChild(obsDivider);

            const cbGridObs = document.createElement('div');
            cbGridObs.style.display = 'grid';
            cbGridObs.style.gridTemplateColumns = 'repeat(2, 1fr)';
            cbGridObs.style.gap = '8px';
            cbGridObs.appendChild(createCheckboxField('show_obstacles', !!node.parameters['show_obstacles'], 'Show Obstacles'));
            cbGridObs.appendChild(createCheckboxField('obstacles_gridlines', node.parameters['obstacles_gridlines'] !== false, 'Obstacles Grid'));
            cbGridObs.appendChild(createCheckboxField('obstacles_solid', node.parameters['obstacles_solid'] !== false, 'Obstacles Solid'));
            cbGridObs.appendChild(createCheckboxField('obstacles_lighting', node.parameters['obstacles_lighting'] !== false, 'Obstacles Lighting'));
            cbGridObs.appendChild(createCheckboxField('obstacles_auto_scale', node.parameters['obstacles_auto_scale'] !== false, 'Obstacles Auto Scale'));
            cbGridObs.appendChild(createCheckboxField('obstacles_log_scale', !!node.parameters['obstacles_log_scale'], 'Obstacles Log Scale'));
            cbGridObs.appendChild(createCheckboxField('obstacles_interpolate', node.parameters['obstacles_interpolate'] !== false, 'Obstacles Interpolate'));
            panels[0].appendChild(cbGridObs);

            const obsQtyEl = this.createInputElement(node, 'obstacles_quantity', node.parameters['obstacles_quantity'] ?? 'pressure');
            addRowToPanel('obstacles_quantity', 'OBSTACLES QTY', obsQtyEl, 0);

            const obsCmapEl = this.createInputElement(node, 'obstacles_colormap', node.parameters['obstacles_colormap'] ?? 'plasma');
            addRowToPanel('obstacles_colormap', 'OBSTACLES COLORMAP', obsCmapEl, 0);

            const obsMinEl = this.createInputElement(node, 'obstacles_min_val', node.parameters['obstacles_min_val'] ?? 101325.0);
            addRowToPanel('obstacles_min_val', 'OBSTACLES MIN VAL', obsMinEl, 0);

            const obsMaxEl = this.createInputElement(node, 'obstacles_max_val', node.parameters['obstacles_max_val'] ?? 1013250.0);
            addRowToPanel('obstacles_max_val', 'OBSTACLES MAX VAL', obsMaxEl, 0);

            const obsOpacRow = document.createElement('div');
            obsOpacRow.style.marginTop = '8px';
            const obsOpacLabel = document.createElement('label');
            obsOpacLabel.style.display = 'block';
            obsOpacLabel.style.fontSize = 'var(--font-sm)';
            obsOpacLabel.style.color = '#888';
            obsOpacLabel.textContent = `OBSTACLES OPACITY: ${Number(node.parameters['obstacles_opacity'] ?? 1.0).toFixed(2)}`;
            obsOpacRow.appendChild(obsOpacLabel);

            const obsOpacSlider = document.createElement('input');
            obsOpacSlider.type = 'range';
            obsOpacSlider.min = '0';
            obsOpacSlider.max = '1';
            obsOpacSlider.step = '0.05';
            obsOpacSlider.value = String(node.parameters['obstacles_opacity'] ?? 1.0);
            obsOpacSlider.style.width = '100%';
            obsOpacSlider.oninput = () => {
                obsOpacLabel.textContent = `OBSTACLES OPACITY: ${Number(obsOpacSlider.value).toFixed(2)}`;
                this.updateParameter('obstacles_opacity', Number(obsOpacSlider.value));
            };
            obsOpacRow.appendChild(obsOpacSlider);
            panels[0].appendChild(obsOpacRow);

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
            qtyGrid.appendChild(createCheckboxField('qty_overpressure', !!node.parameters['qty_overpressure'], 'Overpressure'));
            qtyGrid.appendChild(createCheckboxField('qty_impulse', !!node.parameters['qty_impulse'], 'Impulse'));
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
            if (node.type === 'VirtualGauges' || node.type === 'VTKOutput') {
                qtyGrid.appendChild(createCheckboxField('qty_overpressure', !!node.parameters['qty_overpressure'], 'Overpressure'));
                qtyGrid.appendChild(createCheckboxField('qty_impulse', !!node.parameters['qty_impulse'], 'Impulse'));
            }

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
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
            'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride',
            'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
            // 2D CFD keys
            'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
            'charge_r', 'charge_z', 'charge_radius', 'charge_height',
            'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
            'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
            // 3D CFD keys
            'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
            'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
            'detonator_x', 'detonator_y', 'detonator_z', 'xmin', 'ymin', 'zmin',
            'origin_x', 'origin_y', 'origin_z', 'dim_x', 'dim_y', 'dim_z', 'scale_factor',
            'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
            'refinement_opacity', 'charge_opacity',
            'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
            'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'refinement_level',
            'submesh_x', 'submesh_y', 'submesh_z', 'submesh_size_x', 'submesh_size_y', 'submesh_size_z',
            'offset', 'stride',
            // MPM keys
            'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'radius', 'inner_radius',
            'scale_x', 'scale_y', 'scale_z',
            'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
            'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
            'failure_strain', 'tensile_failure_stress',
            'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp',
            'mg_gamma0', 'mg_c0', 'mg_s',
            'ppc',
            'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend'
        ];

        const dropdowns: Record<string, string[]> = {
            'preset': [...MPM_MATERIAL_PRESET_NAMES],
            'material_model': ['Hypoelastic', 'Johnson-Cook + Mie-Grüneisen'],
            'mpmParticleQuantity': ['vonMises', 'pressure', 'velocity', 'density', 'plastic_strain', 'damage', 'has_failed', 'object_id'],

            'mpmParticleColormap': ['plasma', 'viridis', 'coolwarm', 'rainbow', 'cividis', 'grayscale'],
            'telemetry_mode': ['Enabled', 'Throttled (1 Hz)', 'Throttled (0.2 Hz)', 'Disabled'],
            'enable_gauges': ['Enabled', 'Disabled'],
            'enable_vtk': ['Disabled', 'Enabled'],
            'shape': ['box', 'sphere', 'cylinder'],
            'mesh_type': ['regular', 'amr'],
            'amr_tile_size': ['8', '16'],
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
            'init_mode': node.type === 'CFDSolver3D' ? ['From1D', 'From2D', 'Multi-Material JWL', 'Ideal Gas'] : ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': node.type === 'Charge3D' ? ['Sphere', 'Cylinder', 'Block'] : ['Sphere', 'Cylinder'],
            'material_type': ['Air', 'JWL Charge', 'Ideal Gas Charge'],
            'colormap': ['plasma', 'viridis', 'rainbow', 'coolwarm', 'cividis', 'grayscale'],
            'stl_colormap': ['plasma', 'viridis', 'rainbow', 'coolwarm', 'cividis', 'grayscale'],
            'stl_quantity': ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse'],
            'stl_sampling_mode': ['nearest', 'linear'],
            'obstacles_colormap': ['plasma', 'viridis', 'rainbow', 'coolwarm', 'cividis', 'grayscale'],
            'obstacles_quantity': ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse'],
            'gauge_quantity': ['pressure', 'velocity', 'peak_overpressure', 'status'],
            'refresh_rate': ['0.0', '0.016', '0.033', '0.05', '0.1', '0.2', '0.5', '1.0', '2.0', '5.0', '10.0'],
            'ascii_delimiter': ['Comma', 'Tab', 'Space'],
            'vtk_format': ['ASCII', 'Binary', 'Compressed Binary'],
            'voxelization_method': ['watertight_floodfill', 'watertight_raycast', 'thin_shell', 'winding_number'],
            'colorbar_source': ['slice', 'mpm', 'obstacles', 'stl'],
            'transfer_scheme': ['BSpline', 'GIMP', 'Standard'],
            'velocity_scheme': ['APIC', 'PIC', 'FLIP'],
            'shape_type': (node.type === 'MPMObject3D') ? ['Box', 'Sphere', 'Cylinder', 'STL'] : ['Rectangle', 'Circle'],
            'space_time_scheme': (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') ? 
                ['USL', 'USF', 'RK2'] : 
                ['Euler (1st-Order Space/Time)', 'RK2 (2nd-Order Space/Time)', 'RK3 (3rd-Order Space/Time)', 'MUSCL-Hancock (2nd-Order Space/Time)', 'ADER-2 (2nd-Order Space/Time)', 'ADER-3 (3rd-Order Space/Time)']
        };

        if (dropdowns[key]) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';

            if (key === 'preset') {
                MPM_MATERIAL_CATEGORIES.forEach(group => {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = group.category;
                    group.presets.forEach(opt => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.textContent = opt;
                        if (opt === String(value ?? '')) option.selected = true;
                        optgroup.appendChild(option);
                    });
                    select.appendChild(optgroup);
                });
            } else {
                dropdowns[key].forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    let text = opt;
                    if (key === 'device') {
                        if (opt === 'cpu') text = 'CPU';
                        else if (opt === 'cuda') text = 'CUDA GPU';
                    } else if (key === 'refresh_rate') {
                        if (opt === '0.0') text = 'Max Rate (0s)';
                        else if (opt === '0.016') text = '60 FPS (0.016s)';
                        else if (opt === '0.033') text = '30 FPS (0.033s)';
                        else if (opt === '0.05') text = '20 FPS (0.05s)';
                        else if (opt === '0.1') text = '10 FPS (0.1s)';
                        else if (opt === '0.2') text = '5 FPS (0.2s)';
                        else if (opt === '0.5') text = '2 FPS (0.5s)';
                        else if (opt === '1.0') text = '1 FPS (1.0s)';
                        else if (opt === '2.0') text = '0.5 FPS (2.0s / Default)';
                        else if (opt === '5.0') text = '0.2 FPS (5.0s)';
                        else if (opt === '10.0') text = '0.1 FPS (10.0s)';
                    }
                    if (Math.abs(Number(opt) - Number(value)) < 0.001 || opt === String(value ?? '')) option.selected = true;
                    select.appendChild(option);
                });
            }
            select.value = String(value ?? dropdowns[key][0]);


            select.addEventListener('change', () => {
                let val: any = select.value;
                if (key === 'space_time_scheme') {
                    if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                        this.updateParameter(key, val);
                    } else {
                        let s_order = 2;
                        let t_order = 2;
                        if (val === 'Euler (1st-Order Space/Time)') { s_order = 1; t_order = 1; }
                        else if (val === 'RK2 (2nd-Order Space/Time)') { s_order = 2; t_order = 2; }
                        else if (val === 'RK3 (3rd-Order Space/Time)') { s_order = 3; t_order = 3; }
                        else if (val === 'MUSCL-Hancock (2nd-Order Space/Time)') { s_order = 2; t_order = 4; }
                        else if (val === 'ADER-2 (2nd-Order Space/Time)') { s_order = 2; t_order = 5; }
                        else if (val === 'ADER-3 (3rd-Order Space/Time)') { s_order = 3; t_order = 6; }
                        
                        if (this.currentNodeId) {
                            this.stateManager.updateNodeParameters(this.currentNodeId, {
                                spatial_order: s_order,
                                temporal_order: t_order
                            });
                        }
                    }
                } else {
                    if (numericKeys.includes(key)) val = Number(val);
                    this.updateParameter(key, val);
                }
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

    private renderPrimitiveGeometryEditor(node: Node): void {
        const primitives = node.parameters.primitives || [];
        const voxelizationMethod = node.parameters.voxelization_method || 'watertight_floodfill';

        const header = document.createElement('div');
        header.style.padding = '10px';
        header.style.borderBottom = '1px solid #3c3c3c';
        header.style.marginBottom = '10px';

        const title = document.createElement('h3');
        title.style.margin = '0 0 5px 0';
        title.style.fontSize = 'var(--font-md)';
        title.style.color = '#fff';
        title.textContent = 'Primitive Geometry Editor';
        header.appendChild(title);

        const desc = document.createElement('div');
        desc.style.fontSize = 'var(--font-xs)';
        desc.style.color = '#888';
        desc.textContent = 'Define analytic primitive shapes to voxelize into solid reflecting obstacles.';
        header.appendChild(desc);
        this.container.appendChild(header);

        const voxDiv = document.createElement('div');
        voxDiv.style.padding = '0 10px 10px 10px';
        voxDiv.style.display = 'flex';
        voxDiv.style.flexDirection = 'column';
        voxDiv.style.gap = '4px';

        const voxLabel = document.createElement('label');
        voxLabel.style.fontSize = 'var(--font-xs)';
        voxLabel.style.color = '#888';
        voxLabel.style.fontWeight = 'bold';
        voxLabel.textContent = 'VOXELIZATION METHOD';
        voxDiv.appendChild(voxLabel);

        const voxSelect = document.createElement('select');
        voxSelect.style.width = '100%';
        voxSelect.style.background = '#252526';
        voxSelect.style.color = '#ccc';
        voxSelect.style.border = '1px solid #444';
        voxSelect.style.padding = '4px';
        voxSelect.style.fontSize = 'var(--font-sm)';

        const methods = [
            { value: 'watertight_floodfill', label: 'Watertight Floodfill' },
            { value: 'watertight_raycast', label: 'Watertight Raycast' },
            { value: 'thin_shell', label: 'Thin Shell' },
            { value: 'winding_number', label: 'Winding Number' }
        ];
        methods.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.text = m.label;
            if (m.value === voxelizationMethod) opt.selected = true;
            voxSelect.appendChild(opt);
        });
        voxSelect.onchange = () => {
            this.stateManager.updateNodeParameters(node.id, {
                voxelization_method: voxSelect.value
            });
        };
        voxDiv.appendChild(voxSelect);
        this.container.appendChild(voxDiv);

        const layout = document.createElement('div');
        layout.style.display = 'flex';
        layout.style.height = 'calc(100% - 130px)';
        layout.style.borderTop = '1px solid #3c3c3c';

        const leftPane = document.createElement('div');
        leftPane.style.width = '40%';
        leftPane.style.borderRight = '1px solid #3c3c3c';
        leftPane.style.display = 'flex';
        leftPane.style.flexDirection = 'column';
        leftPane.style.background = '#1e1e1e';

        const leftHeader = document.createElement('div');
        leftHeader.style.padding = '8px';
        leftHeader.style.borderBottom = '1px solid #2d2d2d';
        leftHeader.style.display = 'flex';
        leftHeader.style.flexDirection = 'column';
        leftHeader.style.gap = '6px';

        const addLabel = document.createElement('div');
        addLabel.style.fontSize = '10px';
        addLabel.style.color = '#888';
        addLabel.style.fontWeight = 'bold';
        addLabel.textContent = 'ADD SHAPE';
        leftHeader.appendChild(addLabel);

        const addButtonsDiv = document.createElement('div');
        addButtonsDiv.style.display = 'flex';
        addButtonsDiv.style.gap = '4px';

        const createAddBtn = (labelStr: string, shapeType: string, defaultParams: any) => {
            const btn = document.createElement('button');
            btn.textContent = labelStr;
            btn.style.flex = '1';
            btn.style.padding = '4px 2px';
            btn.style.fontSize = 'var(--font-xs)';
            btn.style.background = '#252526';
            btn.style.color = '#fff';
            btn.style.border = '1px solid #444';
            btn.style.cursor = 'pointer';
            btn.style.borderRadius = '3px';
            btn.onclick = (e) => {
                e.preventDefault();
                const nameStr = `${shapeType.charAt(0).toUpperCase() + shapeType.slice(1)} ${primitives.length + 1}`;
                const updated = [...primitives, { type: shapeType, name: nameStr, subtractive: false, ...defaultParams }];
                this.selectedPrimitiveIndex = updated.length - 1;
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            return btn;
        };

        addButtonsDiv.appendChild(createAddBtn('Cube', 'cuboid', { xmin: 0.0, xmax: 0.2, ymin: 0.0, ymax: 0.2, zmin: 0.0, zmax: 0.2, voxelization_method: 'use_node_default' }));
        addButtonsDiv.appendChild(createAddBtn('Cyl', 'cylinder', { x: 0.5, y: 0.5, z: 0.5, radius: 0.1, length: 0.2, orientation: 'Z', voxelization_method: 'use_node_default' }));
        addButtonsDiv.appendChild(createAddBtn('Wedge', 'wedge', { xmin: 0.0, xmax: 0.2, ymin: 0.0, ymax: 0.2, zmin: 0.0, zmax: 0.2, orientation: '+X', voxelization_method: 'use_node_default' }));
        leftHeader.appendChild(addButtonsDiv);
        leftPane.appendChild(leftHeader);

        const shapeList = document.createElement('div');
        shapeList.style.flex = '1';
        shapeList.style.overflowY = 'auto';
        shapeList.style.display = 'flex';
        shapeList.style.flexDirection = 'column';

        if (this.selectedPrimitiveIndex >= primitives.length) {
            this.selectedPrimitiveIndex = primitives.length - 1;
        }
        if (this.selectedPrimitiveIndex < 0 && primitives.length > 0) {
            this.selectedPrimitiveIndex = 0;
        }

        primitives.forEach((prim: any, idx: number) => {
            const item = document.createElement('div');
            item.style.padding = '8px';
            item.style.borderBottom = '1px solid #2d2d2d';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.cursor = 'pointer';
            item.style.background = idx === this.selectedPrimitiveIndex ? '#37373d' : 'transparent';

            const name = document.createElement('span');
            name.style.fontSize = 'var(--font-xs)';
            name.style.color = idx === this.selectedPrimitiveIndex ? '#fff' : '#ccc';
            name.textContent = `${idx + 1}. ${prim.name || prim.type.toUpperCase()}`;
            item.appendChild(name);

            const delBtn = document.createElement('button');
            delBtn.innerHTML = '✕';
            delBtn.style.background = 'transparent';
            delBtn.style.border = 'none';
            delBtn.style.color = '#ef4444';
            delBtn.style.cursor = 'pointer';
            delBtn.style.fontSize = '12px';
            delBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const updated = primitives.filter((_: any, i: number) => i !== idx);
                if (this.selectedPrimitiveIndex >= updated.length) {
                    this.selectedPrimitiveIndex = updated.length - 1;
                }
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            item.appendChild(delBtn);

            item.onclick = () => {
                this.selectedPrimitiveIndex = idx;
                this.render(true);
            };

            shapeList.appendChild(item);
        });

        leftPane.appendChild(shapeList);
        layout.appendChild(leftPane);

        const rightPane = document.createElement('div');
        rightPane.style.width = '60%';
        rightPane.style.padding = '10px';
        rightPane.style.overflowY = 'auto';
        rightPane.style.display = 'flex';
        rightPane.style.flexDirection = 'column';
        rightPane.style.gap = '8px';

        const activePrim = primitives[this.selectedPrimitiveIndex];
        if (activePrim) {
            const paneTitle = document.createElement('div');
            paneTitle.style.fontWeight = 'bold';
            paneTitle.style.fontSize = 'var(--font-sm)';
            paneTitle.style.color = '#569cd6';
            paneTitle.textContent = `SHAPE #${this.selectedPrimitiveIndex + 1} (${activePrim.type.toUpperCase()})`;
            rightPane.appendChild(paneTitle);

            const form = document.createElement('form');
            form.style.display = 'flex';
            form.style.flexDirection = 'column';
            form.style.gap = '8px';

            const updatePrimVal = (key: string, val: any) => {
                const updated = [...primitives];
                updated[this.selectedPrimitiveIndex] = { ...activePrim, [key]: val };
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };

            Object.entries(activePrim).forEach(([key, value]) => {
                if (key === 'type') return;

                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.flexDirection = 'column';
                row.style.gap = '4px';

                const label = document.createElement('label');
                label.style.fontSize = 'var(--font-xs)';
                label.style.color = '#888';
                label.textContent = key.toUpperCase();
                row.appendChild(label);

                if (key === 'name') {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.style.background = '#252526';
                    input.style.color = '#ccc';
                    input.style.border = '1px solid #444';
                    input.style.padding = '4px';
                    input.style.fontSize = 'var(--font-sm)';
                    input.value = String(value);
                    input.onchange = () => {
                        updatePrimVal(key, input.value);
                    };
                    row.appendChild(input);
                } else if (key === 'subtractive') {
                    const labelCheckbox = document.createElement('label');
                    labelCheckbox.style.display = 'flex';
                    labelCheckbox.style.alignItems = 'center';
                    labelCheckbox.style.gap = '6px';
                    labelCheckbox.style.fontSize = 'var(--font-sm)';
                    labelCheckbox.style.color = '#ccc';
                    labelCheckbox.style.cursor = 'pointer';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = !!value;
                    checkbox.onchange = () => {
                        updatePrimVal(key, checkbox.checked);
                    };
                    labelCheckbox.appendChild(checkbox);
                    labelCheckbox.appendChild(document.createTextNode('Subtractive Shape'));
                    row.innerHTML = '';
                    row.appendChild(labelCheckbox);
                } else if (key === 'voxelization_method') {
                    const select = document.createElement('select');
                    select.style.background = '#252526';
                    select.style.color = '#ccc';
                    select.style.border = '1px solid #444';
                    select.style.padding = '4px';
                    select.style.fontSize = 'var(--font-sm)';

                    const opts = ['use_node_default', 'watertight_floodfill', 'watertight_raycast', 'thin_shell', 'winding_number'];
                    opts.forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o;
                        opt.text = (o === 'use_node_default') ? 'Use Node Default' : o.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        if (o === (value || 'use_node_default')) opt.selected = true;
                        select.appendChild(opt);
                    });
                    select.onchange = () => {
                        updatePrimVal(key, select.value);
                    };
                    row.appendChild(select);
                } else if (key === 'orientation') {
                    const select = document.createElement('select');
                    select.style.background = '#252526';
                    select.style.color = '#ccc';
                    select.style.border = '1px solid #444';
                    select.style.padding = '4px';
                    select.style.fontSize = 'var(--font-sm)';

                    const opts = activePrim.type === 'cylinder' ? ['X', 'Y', 'Z'] : ['+X', '-X', '+Y', '-Y'];
                    opts.forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o;
                        opt.text = o;
                        if (o === value) opt.selected = true;
                        select.appendChild(opt);
                    });
                    select.onchange = () => {
                        updatePrimVal(key, select.value);
                    };
                    row.appendChild(select);
                } else {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = 'any';
                    input.style.background = '#252526';
                    input.style.color = '#ccc';
                    input.style.border = '1px solid #444';
                    input.style.padding = '4px';
                    input.style.fontSize = 'var(--font-sm)';
                    input.value = String(value);
                    input.onchange = () => {
                        updatePrimVal(key, Number(input.value));
                    };
                    row.appendChild(input);
                }
                form.appendChild(row);
            });
            rightPane.appendChild(form);
        } else {
            const placeholder = document.createElement('div');
            placeholder.style.color = '#666';
            placeholder.style.fontSize = 'var(--font-sm)';
            placeholder.style.textAlign = 'center';
            placeholder.style.marginTop = '40px';
            placeholder.textContent = 'Select or add a primitive shape to begin.';
            rightPane.appendChild(placeholder);
        }

        layout.appendChild(rightPane);
        this.container.appendChild(layout);
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

            row.style.opacity = slice.enabled !== false ? '1.0' : '0.55';

            // Header of the slice row (Enable Checkbox, Slice # and Delete button)
            const rowHeader = document.createElement('div');
            rowHeader.style.display = 'flex';
            rowHeader.style.justifyContent = 'space-between';
            rowHeader.style.alignItems = 'center';

            const titleWrap = document.createElement('div');
            titleWrap.style.display = 'flex';
            titleWrap.style.alignItems = 'center';
            titleWrap.style.gap = '6px';

            const enableCb = document.createElement('input');
            enableCb.type = 'checkbox';
            enableCb.checked = slice.enabled !== false;
            enableCb.title = 'Activate/Deactivate slice';
            enableCb.onchange = (e) => {
                e.stopPropagation();
                const updated = [...slices];
                updated[idx] = { ...slice, enabled: enableCb.checked };
                this.updateSlicesInPlace(updated);
            };
            titleWrap.appendChild(enableCb);

            const title = document.createElement('span');
            title.style.fontSize = 'var(--font-xs)';
            title.style.fontWeight = 'bold';
            title.style.color = slice.enabled !== false ? '#569cd6' : '#666';
            title.textContent = `Slice #${idx + 1}`;
            titleWrap.appendChild(title);

            rowHeader.appendChild(titleWrap);

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
                this.updateSlicesInPlace(updated);
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
            
            const axisOptions = [
                { value: 'yz', label: 'X-Normal' },
                { value: 'xz', label: 'Y-Normal' },
                { value: 'xy', label: 'Z-Normal' }
            ];
            axisOptions.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.text = opt.label;
                if (opt.value === slice.axis) option.selected = true;
                axisSelect.appendChild(option);
            });
            axisSelect.value = slice.axis;
            axisSelect.onchange = () => {
                let newMin = 0.0;
                let newMax = 1.0;
                const state = this.stateManager.getCurrentState();
                const node = state?.nodes.find(n => n.id === this.currentNodeId);
                if (node) {
                    const meshNode = this.findMeshNodeForViewport(state, node.id);

                    if (meshNode && meshNode.type === 'DomainMesh3D') {
                        const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
                        const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
                        const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
                        const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
                        const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                        const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

                        if (axisSelect.value === 'xy') {
                            newMin = zmin;
                            newMax = zmax;
                        } else if (axisSelect.value === 'xz') {
                            newMin = ymin;
                            newMax = ymax;
                        } else if (axisSelect.value === 'yz') {
                            newMin = xmin;
                            newMax = xmax;
                        }
                    }
                }
                const newOffset = (newMin + newMax) / 2.0;

                const updated = [...slices];
                updated[idx] = { ...slice, axis: axisSelect.value, offset: newOffset };
                this.updateSlicesInPlace(updated);
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
                this.updateSlicesInPlace(updated);
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
                { value: 'species1', label: 'Products' },
                { value: 'species2', label: 'Unburnt' },
                { value: 'species3', label: 'Air' },
                { value: 'solid', label: 'Solid Cells' },
                { value: 'overpressure', label: 'Peak Overpressure' },
                { value: 'impulse', label: 'Peak Impulse' }
            ];

            QUANTITIES.forEach(q => {
                const option = document.createElement('option');
                option.value = q.value;
                option.text = q.label;
                if (slice.quantities && slice.quantities[0] === q.value) option.selected = true;
                qtySelect.appendChild(option);
            });
            qtySelect.value = slice.quantities && slice.quantities[0] ? slice.quantities[0] : 'pressure';
            qtySelect.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, quantities: [qtySelect.value] };
                this.updateSlicesInPlace(updated);
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
            strideSelect.value = String(slice.stride || 1);
            strideSelect.onchange = () => {
                const updated = [...slices];
                updated[idx] = { ...slice, stride: Number(strideSelect.value) };
                this.updateSlicesInPlace(updated);
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

            let minVal = 0.0;
            let maxVal = 1.0;
            const state = this.stateManager.getCurrentState();
            const node = state?.nodes.find(n => n.id === this.currentNodeId);
            if (node) {
                const meshNode = this.findMeshNodeForViewport(state, node.id);

                if (meshNode && meshNode.type === 'DomainMesh3D') {
                    const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                    const zmax = Number(meshNode.parameters?.zmax ?? 1.0);
                    minVal = zmin;
                    maxVal = zmax;
                }
            }
            const defaultOffset = (minVal + maxVal) / 2.0;

            // FIX 6: Create complete slice object with all required fields (matches overlay's addSlice structure)
            const updated = [...slices, {
                axis: 'xy',
                offset: defaultOffset,
                quantities: ['pressure'],
                stride: 1,
                opacity: 1.0,
                colormap: 'plasma',
                auto_scale: true,
                log_scale: false,
                interpolate: true,
                min_val: 101325.0,
                max_val: 101325.0 * 10.0,
                enabled: true
            }];
            // FIX 4: Use in-place update (no undo entry, no simulation reset) for interactive slice control
            this.updateSlicesInPlace(updated);
        };
        container.appendChild(addBtn);
    }


    private findMeshNodeForViewport(state: any, viewportNodeId: string): any {
        if (!state) return null;
        const node = state.nodes.find((n: any) => n.id === viewportNodeId);
        if (!node) return null;

        const queue: string[] = [viewportNodeId];
        const visited = new Set<string>([viewportNodeId]);
        
        while (queue.length > 0) {
            const currId = queue.shift()!;
            const currNode = state.nodes.find((n: any) => n.id === currId);
            if (currNode && (currNode.type === 'DomainMesh3D' || currNode.type === 'DomainMesh2D')) {
                return currNode;
            }
            
            const incoming = state.connections.filter((c: any) => c.toNode === currId);
            for (const conn of incoming) {
                if (!visited.has(conn.fromNode)) {
                    visited.add(conn.fromNode);
                    queue.push(conn.fromNode);
                }
            }
        }
        
        const is3D = node.type.includes('3D') || node.type === 'Telemetry3DViewport';
        const targetType = is3D ? 'DomainMesh3D' : 'DomainMesh2D';
        return state.nodes.find((n: any) => n.type === targetType) || null;
    }

    private sendView3DConfigForNode(nodeId: string, slices: any[]): void {
        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            const state = this.stateManager.getCurrentState();
            const node = state?.nodes.find(n => n.id === nodeId);
            if (!node || node.type !== 'Telemetry3DViewport') return;
            
            let targetModelId = nodeId;
            const models = this.stateManager.getAppState().models;
            for (const [mid, m] of Object.entries(models)) {
                if (m.nodes.some(n => n.id === node.id)) {
                    targetModelId = mid;
                    break;
                }
            }
            const showObstacles = node.parameters.show_obstacles === true;
            const obstaclesQuantity = node.parameters.obstacles_quantity || 'pressure';
            const showSTL = node.parameters.show_stl !== false;
            const stlShowResults = node.parameters.stl_show_results !== false;
            const stlQuantity = node.parameters.stl_quantity || 'pressure';

            const fullSlices = [...slices];
            if (showObstacles) {
                fullSlices.push({
                    axis: 'obstacles',
                    offset: 0.0,
                    quantities: [obstaclesQuantity],
                    stride: 1
                });
            }
            if (showSTL && stlShowResults) {
                let volStride = 1;
                const targetModel = this.stateManager.getAppState().models[targetModelId];
                const meshNode = this.findMeshNodeForViewport(targetModel, nodeId);
                if (meshNode) {
                    const cellSize = Number(meshNode.parameters.cell_size ?? 0.05);
                    const xmin = Number(meshNode.parameters.xmin ?? 0.0);
                    const xmax = Number(meshNode.parameters.xmax ?? 1.0);
                    const ymin = Number(meshNode.parameters.ymin ?? 0.0);
                    const ymax = Number(meshNode.parameters.ymax ?? 1.0);
                    const zmin = Number(meshNode.parameters.zmin ?? 0.0);
                    const zmax = Number(meshNode.parameters.zmax ?? 1.0);
                    const nx = Math.max(1, Math.round((xmax - xmin) / cellSize));
                    const ny = Math.max(1, Math.round((ymax - ymin) / cellSize));
                    const nz = Math.max(1, Math.round((zmax - zmin) / cellSize));
                    const totalCells = nx * ny * nz;
                    if (totalCells > 1000000) {
                        volStride = 4;
                    } else if (totalCells > 200000) {
                        volStride = 2;
                    }
                }
                fullSlices.push({
                    axis: 'volume',
                    offset: 0.0,
                    quantities: [stlQuantity],
                    stride: volStride
                });
            }
            net.send({
                command: "VIEW3D_CONFIG",
                modelId: targetModelId,
                slices: fullSlices,
                refresh_rate: Number(node.parameters.refresh_rate ?? 2.0)
            });
        }
    }

    // FIX 4: For interactive slice mutations, use in-place update to avoid polluting undo history
    // and avoid incorrectly resetting simulation status (matches overlay panel behavior).
    // Set _forceNextFull so the state-change notification causes an immediate full DOM rebuild
    // (slice add/remove changes list structure, which the fast-path cannot handle).
    private updateSlicesInPlace(slices: any[]): void {
        if (!this.currentNodeId) return;
        this._forceNextFull = true;
        this.stateManager.updateNodeParametersInPlace(this.currentNodeId, { slices });
        this.sendView3DConfigForNode(this.currentNodeId, slices);
    }

    private updateParameter(key: string, value: any): void {
        if (!this.currentNodeId) return;

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) return;

        const updates: Record<string, any> = { [key]: value };

        if (node.type === 'STLGeometry' && key === 'voxelization_method') {
            const rand = Math.floor(Math.random() * 1000000);
            const simpleHash = 'stl_' + rand.toString(36);
            updates['geometry_hash'] = simpleHash;
        }

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
        } else if (node.type === 'Material' && ['ideal_rho_0', 'ideal_e_0', 'ideal_gamma'].includes(key)) {
            updates['composition'] = 'Custom';
        }

        const visualKeys = [
            'colormap', 'refresh_rate', 'min_val', 'max_val', 'ambientLevel', 
            'specularIntensity', 'log_scale', 'auto_scale', 'show_grid', 
            'interpolate', 'lightingEnabled', 'aoEnabled', 'slices', 
            'focusedSliceIndex', 'show_stl', 'stl_wireframe', 'stl_solids', 'stl_opacity', 'stl_show_results', 'stl_quantity', 'stl_sampling_mode',
            'show_obstacles', 'obstacles_gridlines', 'obstacles_lighting', 'obstacles_opacity', 'obstacles_quantity', 'obstacles_colormap'
        ];

        const isDynamicCfl = (node.type === 'CFDSolver3D' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver') && key === 'cfl';

        if ((node.type === 'Telemetry3DViewport' && visualKeys.includes(key)) || isDynamicCfl) {
            this.stateManager.updateNodeParametersInPlace(this.currentNodeId, updates);
        } else {
            this.stateManager.updateNodeParameters(this.currentNodeId, updates);
        }

        if (key === 'material_model' || key === 'material_type' || key === 'charge_shape' || key === 'shape_type') {
            this.render(true);
        }


        if (isDynamicCfl) {
            const net = (window as any).networkManager;
            if (net && net.isConnected()) {
                let targetModelId = node.id;
                const models = this.stateManager.getAppState().models;
                for (const [mid, m] of Object.entries(models)) {
                    if (m.nodes.some(n => n.id === node.id)) {
                        targetModelId = mid;
                        break;
                    }
                }
                let scope = "1d";
                if (node.type === 'CFDSolver3D') scope = "3d";
                else if (node.type === 'CFDSolver2D') scope = "2d";
                net.send({
                    command: "UPDATE_CFL",
                    modelId: targetModelId,
                    cfl: Number(value),
                    scope: scope
                });
            }
        }

        if (node.type === 'Telemetry3DViewport' && (key === 'slices' || key === 'refresh_rate' || key === 'show_obstacles' || key === 'obstacles_quantity' || key === 'stl_show_results' || key === 'stl_quantity' || key === 'show_stl')) {
            const net = (window as any).networkManager;
            if (net && net.isConnected()) {
                let targetModelId = node.id;
                const models = this.stateManager.getAppState().models;
                for (const [mid, m] of Object.entries(models)) {
                    if (m.nodes.some(n => n.id === node.id)) {
                        targetModelId = mid;
                        break;
                    }
                }
                const showObstacles = key === 'show_obstacles' ? value : (node.parameters.show_obstacles === true);
                const obstaclesQuantity = key === 'obstacles_quantity' ? value : (node.parameters.obstacles_quantity || 'pressure');
                const showSTL = key === 'show_stl' ? value : (node.parameters.show_stl !== false);
                const stlShowResults = key === 'stl_show_results' ? value : (node.parameters.stl_show_results !== false);
                const stlQuantity = key === 'stl_quantity' ? value : (node.parameters.stl_quantity || 'pressure');

                const slices = [...(key === 'slices' ? value : (node.parameters.slices || []))];
                if (showObstacles) {
                    slices.push({
                        axis: 'obstacles',
                        offset: 0.0,
                        quantities: [obstaclesQuantity],
                        stride: 1
                    });
                }
                if (showSTL && stlShowResults) {
                    let volStride = 1;
                    const targetModel = this.stateManager.getAppState().models[targetModelId];
                    const meshNode = targetModel?.nodes.find(n => n.type === 'DomainMesh3D');
                    if (meshNode) {
                        const cellSize = Number(meshNode.parameters.cell_size ?? 0.05);
                        const xmin = Number(meshNode.parameters.xmin ?? 0.0);
                        const xmax = Number(meshNode.parameters.xmax ?? 1.0);
                        const ymin = Number(meshNode.parameters.ymin ?? 0.0);
                        const ymax = Number(meshNode.parameters.ymax ?? 1.0);
                        const zmin = Number(meshNode.parameters.zmin ?? 0.0);
                        const zmax = Number(meshNode.parameters.zmax ?? 1.0);
                        const nx = Math.max(1, Math.round((xmax - xmin) / cellSize));
                        const ny = Math.max(1, Math.round((ymax - ymin) / cellSize));
                        const nz = Math.max(1, Math.round((zmax - zmin) / cellSize));
                        const totalCells = nx * ny * nz;
                        if (totalCells > 1000000) {
                            volStride = 4;
                        } else if (totalCells > 200000) {
                            volStride = 2;
                        }
                    }
                    slices.push({
                        axis: 'volume',
                        offset: 0.0,
                        quantities: [stlQuantity],
                        stride: volStride
                    });
                }
                net.send({
                    command: "VIEW3D_CONFIG",
                    modelId: targetModelId,
                    slices: slices,
                    refresh_rate: key === 'refresh_rate' ? Number(value) : Number(node.parameters.refresh_rate ?? 2.0)
                });
            }
        }
        
        const structuralKeys = ['material_type', 'composition', 'preset', 'material_model', 'dimension', 'charge_shape', 'init_mode', 'velocity_scheme'];
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
            case 'Remap1DTo2DNode':
                return 'Remapper node (1D -> 2D). Integrates the 1D physical state onto the 2D r-z mesh at the specified origin and trigger condition.';
            case 'Remap1DTo3DNode':
                return 'Remapper node (1D -> 3D). Integrates the 1D physical state onto the 3D Cartesian mesh at the specified origin and trigger condition.';
            case 'Remap2DTo3DNode':
                return 'Remapper node (2D -> 3D). Integrates and revolves the 2D physical state onto the 3D Cartesian mesh at the specified origin and trigger condition.';
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
            case 'STLGeometry':
                return 'STL Geometry boundary. Specifies the STL file path for Immersed Boundary Method solid obstacles in 3D.';
            case 'PrimitiveGeometry3D':
                return 'Primitive Geometry boundary. Specifies analytic cuboids, cylinders, or wedges for Immersed Boundary Method solid obstacles in 3D.';
            case 'MPMDomain2D':
                return `<strong>Material Point Method (MPM) 2D Domain</strong> solver settings.<br/><br/>` +
                       `<strong>1. Transfer Schemes:</strong><br/>` +
                       `• <i>Standard:</i> Dirac-delta interpolation. Fast but suffers from high grid-crossing noise.<br/>` +
                       `• <i>GIMP:</i> Generalized Interpolation Material Point. Uses particle domains to completely eliminate grid-crossing noise, though slightly more expensive.<br/><br/>` +
                       `<strong>2. Velocity Schemes:</strong><br/>` +
                       `• <i>PIC:</i> Highly stable but extremely dissipative (damps kinetic energy rapidly).<br/>` +
                       `• <i>FLIP:</i> Low dissipation but prone to noise accumulation. Blended with APIC (APIC-FLIP) via <i>flip_blend</i> (default 0.95).<br/>` +
                       `• <i>APIC:</i> Conserves angular momentum and suppresses noise without damping energy. Recommended default.`;
            case 'MPMDomain3D':
                return `<strong>Material Point Method (MPM) 3D Domain</strong> solver settings.<br/><br/>` +
                       `<strong>1. Transfer Schemes:</strong><br/>` +
                       `• <i>Standard:</i> Dirac-delta interpolation. Fast but suffers from high grid-crossing noise.<br/>` +
                       `• <i>GIMP:</i> Generalized Interpolation Material Point. Eliminates grid-crossing noise using a contiguous particle domain.<br/><br/>` +
                       `<strong>2. Velocity Schemes:</strong><br/>` +
                       `• <i>PIC:</i> Highly stable but extremely dissipative (damps energy quickly).<br/>` +
                       `• <i>FLIP:</i> Low dissipation but prone to high-frequency noise. Blended with APIC (APIC-FLIP) via <i>flip_blend</i>.<br/>` +
                       `• <i>APIC:</i> Affine Particle-in-Cell. Conserves angular momentum and suppresses noise. Recommended default.<br/><br/>` +
                       `<strong>3. Space-Time Integration:</strong><br/>` +
                       `• <i>USL:</i> Update Stress Last. 1st-order symplectic Euler, energy-conserving on average.<br/>` +
                       `• <i>USF:</i> Update Stress First. 1st-order alternative, updates stress prior to grid velocities.<br/>` +
                       `• <i>RK2:</i> 2nd-Order Midpoint Predictor-Corrector. 2nd-order space/time accurate, energy-conserving, highly stable, and objective with CFL changes.`;
            case 'MPMObject2D':
                return '2D MPM Primitive Object. Defines shape geometry, initial position, translation/rotation velocities, and material binding.';
            case 'MPMMaterialSteel':
                return 'MPM Steel Material properties. Defines density, elastoplasticity (Young\'s modulus, Poisson\'s ratio), Von Mises yield stress, and strain hardening.';
            case 'FSICoupler2D':
                return 'Two-Way Fluid-Structure Interaction (FSI) Coupler. Dynamically couples Eulerian CFD gas dynamics with Lagrangian MPM solid/fluid particles.';
            default:
                return 'Simulation graph node.';
        }
    }
}
