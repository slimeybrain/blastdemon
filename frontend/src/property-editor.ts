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
        descBlock.style.fontSize = '0.75rem';
        descBlock.style.color = '#aaa';
        descBlock.style.background = '#252526';
        descBlock.style.borderBottom = '1px solid #333';
        descBlock.textContent = this.getNodeDescription(node.type);
        this.container.appendChild(descBlock);

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

            const row = document.createElement('div');
            row.style.marginBottom = '10px';

            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.fontSize = '0.75rem';
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
        ioTitle.style.fontSize = '0.75rem';
        ioTitle.style.color = '#888';
        ioTitle.style.marginBottom = '8px';
        ioTitle.style.fontWeight = 'bold';
        ioTitle.textContent = 'I/O CONNECTIONS';
        ioSection.appendChild(ioTitle);

        const list = document.createElement('div');
        list.style.fontSize = '0.7rem';
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
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'cfl', 'output_interval',
            'spatial_order', 'temporal_order'
        ];

        const dropdowns: Record<string, string[]> = {
            'dimension': ['1D', '2D', '3D'],
            'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'composition': ['TNT', 'IdealGas', 'Custom'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3', '4'],
            'output_mode': ['By Step', 'By Time']
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

        if (node.type === 'MaterialExplosive') {
            const physicalParams = ['rho', 'detonation_energy', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
            if (physicalParams.includes(key) && node.parameters['composition'] !== 'Custom') {
                updates['composition'] = 'Custom';
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
                return 'Air material initialization. Configures ambient atmospheric pressure and temperature coefficients.';
            case 'MaterialExplosive':
                return 'High-explosive chemical charge initialization. Configures composition, charge mass, density, and JWL state properties.';
            case 'ThePainter':
                return 'Initial conditions painter. Maps mesh cells to physical material states for the simulation starting phase.';
            case 'CFDSolver':
                return 'High-order CFD simulation engine. Solves Euler equations using high-resolution reconstruction and flux splitting schemes.';
            case 'TelemetryText':
                return 'Live text stream telemetry logger. Outputs simulator event timelines, iteration milestones, and system states.';
            case 'TelemetryGraph':
                return 'Real-time chart telemetry viewer. Plots grid spatial properties, cell pressure profiles, and simulation telemetry histories.';
            default:
                return 'Simulation graph node.';
        }
    }
}
