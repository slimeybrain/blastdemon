import { Node, Model, Connection } from './types.js';
import { StateManager, isExplosiveMaterialNode } from './state-manager.js';

/**
 * PipelineConnectionModal
 * Comprehensive connection and wiring manager allowing users to connect,
 * rewire, and verify all physical DAG dependencies directly within the Pipeline Browser.
 */
export class PipelineConnectionModal {
    private overlay: HTMLDivElement | null = null;
    private stateManager: StateManager;
    private model: Model;
    private onUpdate?: () => void;

    constructor(stateManager: StateManager, model: Model, onUpdate?: () => void) {
        this.stateManager = stateManager;
        this.model = model;
        this.onUpdate = onUpdate;
        this.createDOM();
    }

    private getConnections(): Connection[] {
        const state = this.stateManager.getCurrentState();
        return (state && state.connections) ? state.connections : (this.model.connections || []);
    }

    private saveConnections(conns: Connection[]): void {
        const state = this.stateManager.getCurrentState();
        if (state) {
            state.connections = conns;
            this.stateManager.pushState(state);
        }
        this.model.connections = conns;
        this.stateManager.setModelStatus(this.model.id, 'UNINITIALIZED');
        this.onUpdate?.();
    }

    private createDOM(): void {
        const existing = document.querySelector('.pcm-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'pcm-overlay';
        this.overlay = overlay;

        const modal = document.createElement('div');
        modal.className = 'pcm-modal';

        // 1. Header
        const header = document.createElement('div');
        header.className = 'pcm-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'pcm-title-group';

        const title = document.createElement('div');
        title.className = 'pcm-title';
        title.innerHTML = `<span>🔗</span> Model Pipeline Connections — <span class="pcm-model-name">${this.model.name || this.model.id}</span>`;

        const subtitle = document.createElement('div');
        subtitle.className = 'pcm-subtitle';
        subtitle.textContent = 'Define, wire, and connect all physical solvers, detonators, meshes, bodies, and materials directly in the pipeline.';

        titleGroup.appendChild(title);
        titleGroup.appendChild(subtitle);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pcm-close-btn';
        closeBtn.innerHTML = '✖';
        closeBtn.title = 'Close Connections Manager';
        closeBtn.onclick = () => this.close();

        header.appendChild(titleGroup);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // 2. Toolbar Actions
        const toolbar = document.createElement('div');
        toolbar.className = 'pcm-toolbar';

        const autoWireBtn = document.createElement('button');
        autoWireBtn.className = 'pcm-btn pcm-btn-autowire';
        autoWireBtn.innerHTML = '⚡ Auto-Wire All Complementary Entities';
        autoWireBtn.title = 'Automatically detects and connects all matching meshes, detonators, materials, bodies, and charges in this model';
        autoWireBtn.onclick = () => {
            this.stateManager.healModelGraph(this.model);
            const state = this.stateManager.getCurrentState();
            if (state) {
                this.stateManager.pushState(state);
            }
            this.stateManager.setModelStatus(this.model.id, 'UNINITIALIZED');
            this.onUpdate?.();
            this.refreshBody();
        };

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'pcm-btn pcm-btn-secondary';
        refreshBtn.innerHTML = '🔄 Refresh Wires';
        refreshBtn.onclick = () => this.refreshBody();

        toolbar.appendChild(autoWireBtn);
        toolbar.appendChild(refreshBtn);
        modal.appendChild(toolbar);

        // 3. Main Content Body
        const body = document.createElement('div');
        body.className = 'pcm-body';
        body.id = 'pcm-body-container';
        modal.appendChild(body);

        this.renderSections(body);

        // 4. Footer
        const footer = document.createElement('div');
        footer.className = 'pcm-footer';

        const statusEl = document.createElement('div');
        statusEl.className = 'pcm-footer-status';
        statusEl.id = 'pcm-footer-status';
        this.updateFooterStatus(statusEl);

        const doneBtn = document.createElement('button');
        doneBtn.className = 'pcm-btn pcm-btn-primary';
        doneBtn.textContent = 'Done';
        doneBtn.onclick = () => this.close();

        footer.appendChild(statusEl);
        footer.appendChild(doneBtn);
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });
    }

    private updateFooterStatus(el: HTMLElement): void {
        const conns = this.getConnections();
        const modelNodes = this.model.nodes || [];
        const modelNodeIds = new Set(modelNodes.map(n => n.id));
        const activeWires = conns.filter(c => modelNodeIds.has(c.fromNode) || modelNodeIds.has(c.toNode)).length;
        el.innerHTML = `Entities: <strong>${modelNodes.length}</strong> | Active Connections: <strong>${activeWires}</strong> wires`;
    }

    private refreshBody(): void {
        const body = document.getElementById('pcm-body-container');
        if (body) {
            body.innerHTML = '';
            this.renderSections(body);
        }
        const footerStatus = document.getElementById('pcm-footer-status');
        if (footerStatus) {
            this.updateFooterStatus(footerStatus);
        }
    }

    private renderSections(container: HTMLElement): void {
        const modelNodes = this.model.nodes || [];
        const conns = this.getConnections();

        // 1. Solvers & Domains
        const solvers = modelNodes.filter(n => ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MPMDomain2D', 'CFDSolver2D'].includes(n.type));
        if (solvers.length > 0) {
            const sec = this.createSection('⚡ Physics Solvers & Domains', '#ba68c8');
            for (const solver of solvers) {
                sec.appendChild(this.createSolverCard(solver, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 2. Charges & Detonators / Triggers
        const detonators = modelNodes.filter(n => ['TriggerLocation3D', 'TriggerLocation', 'DetonatorLocation3D', 'DetonatorLocation', 'Charge3D', 'Charge2D', 'Charge1D'].includes(n.type));
        if (detonators.length > 0) {
            const sec = this.createSection('💥 Charges, Triggers & Detonators', '#ff8a65');
            for (const det of detonators) {
                sec.appendChild(this.createDetonatorCard(det, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 3. Structural Bodies & Parts
        const bodies = modelNodes.filter(n => ['MPMObject3D', 'MPMObject2D', 'FEMObject3D'].includes(n.type));
        if (bodies.length > 0) {
            const sec = this.createSection('🏗️ Structural Bodies & Materials', '#ffd54f');
            for (const body of bodies) {
                sec.appendChild(this.createBodyCard(body, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 4. Background Grids
        const meshes = modelNodes.filter(n => ['DomainMesh3D', 'DomainMesh2D', 'DomainMesh'].includes(n.type));
        if (meshes.length > 0) {
            const sec = this.createSection('📐 Background Grids & Meshes', '#4fc3f7');
            for (const mesh of meshes) {
                sec.appendChild(this.createMeshCard(mesh, conns, modelNodes));
            }
            container.appendChild(sec);
        }
    }

    private createSection(title: string, color: string): HTMLElement {
        const sec = document.createElement('div');
        sec.className = 'pcm-section';

        const header = document.createElement('div');
        header.className = 'pcm-section-header';
        header.style.borderLeftColor = color;
        header.textContent = title;

        sec.appendChild(header);
        return sec;
    }

    private createSolverCard(solver: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        header.innerHTML = `<strong>${solver.parameters?.name || solver.id}</strong> <span class="pcm-badge">${solver.type}</span>`;
        card.appendChild(header);

        const is3D = solver.type === 'MPMDomain3D' || solver.type === 'CFDSolver3D' || solver.type === 'FEMDomain3D';

        // 1. Background Grid Connection
        const meshNodes = allNodes.filter(n => is3D ? n.type === 'DomainMesh3D' : (n.type === 'DomainMesh2D' || n.type === 'DomainMesh'));
        const currentMeshConn = conns.find(c => c.toNode === solver.id && c.toPort === 'mesh');
        const meshRow = this.createConnectionSelectRow(
            'Background Grid (mesh)',
            meshNodes,
            currentMeshConn ? currentMeshConn.fromNode : '',
            (newMeshId) => {
                let updated = conns.filter(c => !(c.toNode === solver.id && c.toPort === 'mesh'));
                if (newMeshId) {
                    updated.push({ fromNode: newMeshId, fromPort: 'mesh', toNode: solver.id, toPort: 'mesh' });
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(meshRow);

        // 2. Trigger / Detonator Connection
        if (solver.type === 'MPMDomain3D' || solver.type === 'CFDSolver3D' || solver.type === 'MPMDomain2D' || solver.type === 'CFDSolver2D') {
            const detNodes = allNodes.filter(n => is3D ? (n.type === 'TriggerLocation3D' || n.type === 'DetonatorLocation3D') : (n.type === 'TriggerLocation' || n.type === 'DetonatorLocation'));
            const currentDetConn = conns.find(c => c.toNode === solver.id && (c.toPort === 'trigger' || c.toPort === 'detonator'));
            const detRow = this.createConnectionSelectRow(
                'Initiation Trigger / Detonator',
                detNodes,
                currentDetConn ? currentDetConn.fromNode : '',
                (newDetId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && (c.toPort === 'trigger' || c.toPort === 'detonator')));
                    if (newDetId) {
                        const chosenNode = allNodes.find(n => n.id === newDetId);
                        const isTrigger = chosenNode ? chosenNode.type.startsWith('Trigger') : false;
                        const portName = isTrigger ? 'trigger' : 'detonator';
                        updated.push({ fromNode: newDetId, fromPort: portName, toNode: solver.id, toPort: portName });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(detRow);
        }

        // 3. Charge Connection (for CFD)
        if (solver.type === 'CFDSolver3D' || solver.type === 'CFDSolver2D' || solver.type === 'CFDSolver') {
            const chargeNodes = allNodes.filter(n => ['Charge3D', 'Charge2D', 'Charge1D'].includes(n.type));
            const currentChargeConn = conns.find(c => c.toNode === solver.id && c.toPort === 'charge');
            const chargeRow = this.createConnectionSelectRow(
                'High-Explosive Charge (charge)',
                chargeNodes,
                currentChargeConn ? currentChargeConn.fromNode : '',
                (newChargeId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && c.toPort === 'charge'));
                    if (newChargeId) {
                        updated.push({ fromNode: newChargeId, fromPort: 'out', toNode: solver.id, toPort: 'charge' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(chargeRow);
        }

        return card;
    }

    private createDetonatorCard(det: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        const coords = (det.type === 'DetonatorLocation3D' || det.type === 'TriggerLocation3D')
            ? `(${det.parameters?.trigger_x ?? det.parameters?.detonator_x ?? 0.5}, ${det.parameters?.trigger_y ?? det.parameters?.detonator_y ?? 0.5}, ${det.parameters?.trigger_z ?? det.parameters?.detonator_z ?? 0.5})`
            : (det.type === 'DetonatorLocation' || det.type === 'TriggerLocation')
                ? `(r: ${det.parameters?.trigger_r ?? det.parameters?.detonator_r ?? 0.0}, z: ${det.parameters?.trigger_z ?? det.parameters?.detonator_z ?? 0.1})`
                : `(${det.parameters?.charge_mass || '0.85'} kg)`;
        header.innerHTML = `<strong>${det.parameters?.name || det.id}</strong> <span class="pcm-badge">${det.type}</span> <span class="pcm-meta">${coords}</span>`;
        card.appendChild(header);

        const is3D = det.type === 'TriggerLocation3D' || det.type === 'DetonatorLocation3D' || det.type === 'Charge3D';
        const solverNodes = allNodes.filter(n => is3D 
            ? ['MPMDomain3D', 'CFDSolver3D'].includes(n.type) 
            : ['MPMDomain2D', 'CFDSolver2D'].includes(n.type));

        const isTrigger = det.type.startsWith('Trigger');
        const isDet = det.type.startsWith('Detonator');
        const targetPort = isTrigger ? 'trigger' : (isDet ? 'detonator' : 'charge');
        const currentConn = conns.find(c => c.fromNode === det.id && (c.toPort === targetPort || c.toPort === 'trigger' || c.toPort === 'detonator'));

        const row = this.createConnectionSelectRow(
            `Target Solver (${targetPort})`,
            solverNodes,
            currentConn ? currentConn.toNode : '',
            (newSolverId) => {
                let updated = conns.filter(c => !(c.fromNode === det.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'charge')));
                if (newSolverId) {
                    updated.push({ fromNode: det.id, fromPort: targetPort === 'charge' ? 'out' : targetPort, toNode: newSolverId, toPort: targetPort });
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(row);

        return card;
    }

    private createBodyCard(body: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        header.innerHTML = `<strong>${body.parameters?.name || body.id}</strong> <span class="pcm-badge">${body.type}</span> <span class="pcm-meta">${body.parameters?.shape_type || 'Body'}</span>`;
        card.appendChild(header);

        const is3D = body.type === 'MPMObject3D' || body.type === 'FEMObject3D';
        const domainNodes = allNodes.filter(n => is3D 
            ? (body.type === 'MPMObject3D' ? n.type === 'MPMDomain3D' : n.type === 'FEMDomain3D')
            : n.type === 'MPMDomain2D');

        // 1. Parent Domain Connection
        const currentDomConn = conns.find(c => c.fromNode === body.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects'));
        const domRow = this.createConnectionSelectRow(
            'Parent Domain (objects)',
            domainNodes,
            currentDomConn ? currentDomConn.toNode : '',
            (newDomId) => {
                let updated = conns.filter(c => !(c.fromNode === body.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects')));
                if (newDomId) {
                    updated.push({ fromNode: body.id, fromPort: 'out', toNode: newDomId, toPort: 'objects' });
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(domRow);

        // 2. Material Connection
        const matNodes = allNodes.filter(n => n.type === 'Material');
        const currentMatConn = conns.find(c => (c.toNode === body.id || c.fromNode === body.id) && (c.toPort === 'material' || c.fromPort === 'material'));
        const currentMatId = currentMatConn ? (currentMatConn.toNode === body.id ? currentMatConn.fromNode : currentMatConn.toNode) : (body.parameters?.material || '');

        const matRow = this.createConnectionSelectRow(
            'Assigned Material (material)',
            matNodes,
            currentMatId,
            (newMatId) => {
                let updated = conns.filter(c => !(c.toNode === body.id && c.toPort === 'material'));
                if (newMatId) {
                    updated.push({ fromNode: newMatId, fromPort: 'out', toNode: body.id, toPort: 'material' });
                    body.parameters['material'] = newMatId;
                } else {
                    delete body.parameters['material'];
                }
                this.saveConnections(updated);
            },
            (mat) => {
                const model = mat.parameters?.material_model || 'Material';
                const preset = mat.parameters?.preset;
                const summary = preset === 'Custom' ? `${model} (Custom)` : (preset || model);
                return `${mat.parameters?.name || mat.id} — ${summary}`;
            }
        );
        card.appendChild(matRow);

        return card;
    }

    private createMeshCard(mesh: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        const dims = mesh.parameters?.nx ? `${mesh.parameters.nx}x${mesh.parameters.ny || 100}x${mesh.parameters.nz || 100}` : 'Grid';
        header.innerHTML = `<strong>${mesh.parameters?.name || mesh.id}</strong> <span class="pcm-badge">${mesh.type}</span> <span class="pcm-meta">${dims}</span>`;
        card.appendChild(header);

        const is3D = mesh.type === 'DomainMesh3D';
        const solverNodes = allNodes.filter(n => is3D 
            ? ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D'].includes(n.type)
            : ['MPMDomain2D', 'CFDSolver2D'].includes(n.type));

        const currentConn = conns.find(c => c.fromNode === mesh.id && c.toPort === 'mesh');
        const row = this.createConnectionSelectRow(
            'Connected Solver (mesh)',
            solverNodes,
            currentConn ? currentConn.toNode : '',
            (newSolverId) => {
                let updated = conns.filter(c => !(c.fromNode === mesh.id && c.toPort === 'mesh'));
                if (newSolverId) {
                    updated.push({ fromNode: mesh.id, fromPort: 'mesh', toNode: newSolverId, toPort: 'mesh' });
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(row);

        return card;
    }

    private createConnectionSelectRow(
        label: string,
        candidateNodes: Node[],
        selectedId: string,
        onChange: (newId: string) => void,
        customLabelFn?: (n: Node) => string
    ): HTMLElement {
        const row = document.createElement('div');
        row.className = 'pcm-row';

        const lbl = document.createElement('span');
        lbl.className = 'pcm-row-label';
        lbl.textContent = label;

        const select = document.createElement('select');
        select.className = 'pcm-select';

        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '(None / Disconnected)';
        select.appendChild(noneOpt);

        for (const n of candidateNodes) {
            const opt = document.createElement('option');
            opt.value = n.id;
            opt.textContent = customLabelFn ? customLabelFn(n) : `${n.parameters?.name || n.id} [${n.type}]`;
            if (n.id === selectedId) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener('change', () => {
            onChange(select.value);
            this.updateFooterStatus(document.getElementById('pcm-footer-status')!);
        });

        row.appendChild(lbl);
        row.appendChild(select);
        return row;
    }

    public close(): void {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
    }
}
