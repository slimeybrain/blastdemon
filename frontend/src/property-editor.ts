import { StateManager } from './state-manager.js';
import { Node } from './types.js';

export class PropertyEditor {
    public container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private listener: ((state: any) => void) | null = null;

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
        descBlock.textContent = this.getNodeDescription(node.type);
        this.container.appendChild(descBlock);

        // Validation warnings banner
        const warnings: string[] = [];
        const solverNode = state?.nodes.find(n => n.type === 'CFDSolver');
        if (solverNode && state) {
            const initMode = solverNode.parameters['init_mode'] || 'Multi-Material JWL';
            const painterConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'in');
            if (!painterConn) {
                warnings.push("CFD Solver is not connected to the Initializer (ThePainter).");
            } else {
                const painterNode = state.nodes.find(n => n.id === painterConn.fromNode);
                if (!painterNode || painterNode.type !== 'ThePainter') {
                    warnings.push("CFD Solver 'Initial State' port must be connected to the Initializer (ThePainter).");
                } else {
                    const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
                    if (!meshConn) {
                        warnings.push("No Mesh node connected to Initializer. A DomainMesh node is required.");
                    }
                    const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
                    if (!airConn) {
                        warnings.push("No Air node connected to Initializer. A MaterialAir node is required.");
                    }
                    const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
                    if (!expConn) {
                        warnings.push("No Explosive node connected to Initializer. Simulation will run with NO explosive charge.");
                    } else {
                        const expNode = state.nodes.find(n => n.id === expConn.fromNode);
                        if (expNode) {
                            if (initMode === 'Ideal Gas' && expNode.type === 'MaterialExplosive') {
                                warnings.push("Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                            } else if (initMode === 'Multi-Material JWL' && expNode.type === 'MaterialIdealGas') {
                                warnings.push("Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                            }
                        }
                    }
                }
            }
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
        const form = document.createElement('form');
        form.style.padding = '10px';
        form.onsubmit = (e) => e.preventDefault();

        for (const [key, value] of Object.entries(node.parameters)) {
            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'MaterialExplosive') {
                const comp = node.parameters['composition'] || 'TNT';
                const customKeys = ['det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                if (comp !== 'Custom' && customKeys.includes(key)) continue;
            }

            const row = document.createElement('div');
            row.style.marginBottom = '10px';

            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';
            label.style.marginBottom = '4px';
            label.textContent = key.replace(/_/g, ' ').toUpperCase();
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

    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'output_interval',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride'
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
            // Explosive composition — chooses JWL material set
            'composition': ['TNT', 'PETN', 'RDX', 'Custom'],
            // Solver initialisation mode
            'init_mode': ['Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3', '4'],
            'output_mode': ['By Step', 'By Time'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100']
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

        input.addEventListener('change', () => {
            let newVal: any = input.value;
            if (input.type === 'number') {
                newVal = Number(input.value);
            }
            this.updateParameter(key, newVal);
        });

        return input;
    }

    private updateParameter(key: string, value: any): void {
        if (!this.currentNodeId) return;

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) return;

        const updates: Record<string, any> = { [key]: value };

        // Auto-fill presets for MaterialExplosive when composition changes
        if (node.type === 'MaterialExplosive' && key === 'composition') {
            const EXPLOSIVE_PRESETS: Record<string, Record<string, number>> = {
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
                }
            };
            const preset = EXPLOSIVE_PRESETS[value];
            if (preset) {
                Object.assign(updates, preset);
            }
        }

        this.stateManager.updateNodeParameters(this.currentNodeId, updates);
        this.render(false);
    }

    private getNodeDescription(type: string): string {
        switch (type) {
            case 'DomainMesh':
                return 'Cartesian grid with structured uniform mesh. Defines the spatial domain boundary conditions and discretization sizing.';
            case 'MaterialAir':
                return 'Air material initialization. Configures ambient atmospheric pressure, temperature, and adiabatic index (gamma).';
            case 'MaterialExplosive':
                return 'High-explosive charge — Multi-Material JWL mode. Picks pre-calibrated JWL EOS from TNT/PETN/RDX table. Use when init_mode = Multi-Material JWL on the CFD Solver.';
            case 'MaterialIdealGas':
                return 'Ideal-gas explosive charge. Defines a hot pressurised sphere using (gamma-1)·rho·e_int EOS. Pair with init_mode = Ideal Gas on the CFD Solver.';
            case 'ThePainter':
                return 'Initial conditions painter. Maps mesh cells to physical material states for the simulation starting phase.';
            case 'CFDSolver':
                return 'High-order CFD solver. Set init_mode to Multi-Material JWL for JWL detonation products + unreacted explosive, or Ideal Gas for a simpler single-material hot-gas burst.';
            case 'TelemetryText':
                return 'Live text stream telemetry logger. Outputs simulator event timelines, iteration milestones, and system states.';
            case 'TelemetryGraph':
                return 'Real-time chart telemetry viewer. Plots grid spatial properties, cell pressure profiles, and simulation telemetry histories.';
            default:
                return 'Simulation graph node.';
        }
    }
}
