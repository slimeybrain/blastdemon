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
        this.container.className = 'panel-content';
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
            // Update existing values to prevent focus loss
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

        const form = document.createElement('form');
        form.style.padding = '10px';
        form.onsubmit = (e) => e.preventDefault();

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
            input.dataset.key = key;
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
}
