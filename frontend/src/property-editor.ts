import { StateManager } from './state-manager.js';
import { Node } from './types.js';

export class PropertyEditor {
    private container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;

    constructor(containerId: string, stateManager: StateManager) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Property editor container #${containerId} not found`);
        }
        this.container = container;
        this.stateManager = stateManager;
    }

    public setSelectedNode(nodeId: string | null): void {
        this.currentNodeId = nodeId;
        this.render();
    }

    private render(): void {
        this.container.innerHTML = '';

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

        const editorHeader = document.createElement('div');
        editorHeader.style.padding = '10px';
        editorHeader.style.borderBottom = '1px solid #333';
        editorHeader.style.fontWeight = 'bold';
        editorHeader.innerHTML = `${node.type} (${node.id})`;
        this.container.appendChild(editorHeader);

        const form = document.createElement('div');
        form.style.padding = '10px';

        for (const [key, value] of Object.entries(node.parameters)) {
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
            row.appendChild(input);
            form.appendChild(row);
        }

        this.container.appendChild(form);
    }

    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'cfl', 'output_interval',
            'spatial_order', 'temporal_order'
        ];

        // Dropdown handling
        const dropdowns: Record<string, string[]> = {
            'left_bc': ['Reflecting', 'Transmitting', 'Terminate'],
            'right_bc': ['Reflecting', 'Transmitting', 'Terminate'],
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

        // Default to number/text input
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

        // Explosive Node Logic: "Auto-switch to Custom"
        if (node.type === 'MaterialExplosive') {
            const physicalParams = ['rho', 'detonation_energy', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
            if (physicalParams.includes(key) && node.parameters['composition'] !== 'Custom') {
                updates['composition'] = 'Custom';
            }
        }

        this.stateManager.updateNodeParameters(this.currentNodeId, updates);
        this.render(); // Re-render to reflect changes (especially if composition changed)
    }
}
