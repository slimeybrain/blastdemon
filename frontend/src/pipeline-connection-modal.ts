import { Node, Model, Connection } from './types.js';
import { StateManager, isExplosiveMaterialNode, isWaterMaterialNode, isSeabedMaterialNode, isSolidMaterialNode } from './state-manager.js';
import { isAirMaterialNode } from './serialization.js';

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
        const solvers = modelNodes.filter(n => ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MPMDomain2D', 'CFDSolver2D', 'CFDSolver', 'MarineHarbourDomain'].includes(n.type));
        if (solvers.length > 0) {
            const sec = this.createSection('⚡ Physics Solvers & Domains', '#ba68c8');
            for (const solver of solvers) {
                sec.appendChild(this.createSolverCard(solver, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 2. Charges & Detonators
        const detonators = modelNodes.filter(n => ['TriggerLocation3D', 'TriggerLocation', 'DetonatorLocation3D', 'DetonatorLocation', 'Charge3D', 'Charge2D', 'Charge1D'].includes(n.type));
        if (detonators.length > 0) {
            const sec = this.createSection('💥 Charges & Detonators', '#ff8a65');
            for (const det of detonators) {
                sec.appendChild(this.createDetonatorCard(det, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 3. Materials & Ambient Air
        const materials = modelNodes.filter(n => n.type === 'Material' || (n.type as string).startsWith('MPMMaterial'));
        if (materials.length > 0) {
            const sec = this.createSection('🧪 Materials & Ambient Air', '#4ade80');
            for (const mat of materials) {
                sec.appendChild(this.createMaterialCard(mat, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 4. Structural Bodies & Parts
        const bodies = modelNodes.filter(n => ['MPMObject3D', 'MPMObject2D', 'FEMObject3D', 'LSDynaImporter3D', 'FEMBeam3D', 'FEMRebar3D'].includes(n.type));
        if (bodies.length > 0) {
            const sec = this.createSection('🏗️ Structural Bodies & Materials', '#ffd54f');
            for (const body of bodies) {
                sec.appendChild(this.createBodyCard(body, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 5. Background Grids
        const meshes = modelNodes.filter(n => ['DomainMesh3D', 'DomainMesh2D', 'DomainMesh'].includes(n.type));
        if (meshes.length > 0) {
            const sec = this.createSection('📐 Background Grids & Meshes', '#4fc3f7');
            for (const mesh of meshes) {
                sec.appendChild(this.createMeshCard(mesh, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 6. Fluid-Structure Interaction (FSI) Couplers
        const couplers = modelNodes.filter(n => ['FEMFSICoupler3D', 'FSICoupler3D', 'FSICoupler2D'].includes(n.type));
        if (couplers.length > 0) {
            const sec = this.createSection('🌊 Fluid-Structure Interaction (FSI) Couplers', '#0ea5e9');
            for (const coupler of couplers) {
                sec.appendChild(this.createCouplerCard(coupler, conns, modelNodes));
            }
            container.appendChild(sec);
        }

        // 7. CAD Geometry & Obstacles
        const geometries = modelNodes.filter(n => ['STLGeometry', 'PrimitiveGeometry3D', 'Obstacle3D', 'Obstacle'].includes(n.type));
        if (geometries.length > 0) {
            const sec = this.createSection('📐 CAD Geometry & Obstacles', '#81c784');
            for (const geom of geometries) {
                sec.appendChild(this.createGeometryCard(geom, conns, modelNodes));
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

        const is3D = solver.type === 'MPMDomain3D' || solver.type === 'CFDSolver3D' || solver.type === 'FEMDomain3D' || solver.type === 'MarineHarbourDomain';

        // 1. Background Grid Connection
        const meshNodes = allNodes.filter(n => {
            if (is3D) return n.type === 'DomainMesh3D';
            if (solver.type === 'CFDSolver2D' || solver.type === 'MPMDomain2D') return n.type === 'DomainMesh2D';
            return n.type === 'DomainMesh' || n.type === 'DomainMesh2D';
        });
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
                if (!solver.parameters) solver.parameters = {};
                solver.parameters['mesh'] = newMeshId;
                this.saveConnections(updated);
            }
        );
        card.appendChild(meshRow);

        // 2. Ambient Air Material Connection (for CFD Solvers & Marine Harbour)
        if (solver.type === 'CFDSolver3D' || solver.type === 'CFDSolver2D' || solver.type === 'CFDSolver' || solver.type === 'MarineHarbourDomain') {
            const currentAirConn = conns.find(c => c.toNode === solver.id && c.toPort === 'air');
            const airCandidates = allNodes.filter(n => n.type === 'Material' && (isAirMaterialNode(n) || (currentAirConn && currentAirConn.fromNode === n.id)));
            const airRow = this.createConnectionSelectRow(
                'Ambient Air Material (air)',
                airCandidates,
                currentAirConn ? currentAirConn.fromNode : '',
                (newAirId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && c.toPort === 'air'));
                    if (newAirId) {
                        updated.push({ fromNode: newAirId, fromPort: 'out', toNode: solver.id, toPort: 'air' });
                    }
                    if (!solver.parameters) solver.parameters = {};
                    solver.parameters['ambient_air_material'] = newAirId;
                    if (newAirId) {
                        const matNode = allNodes.find(n => n.id === newAirId);
                        if (matNode) {
                            if (!matNode.parameters) matNode.parameters = {};
                            matNode.parameters['ambient_air_target'] = solver.id;
                        }
                    }
                    this.saveConnections(updated);
                },
                (mat) => {
                    const preset = mat.parameters?.preset;
                    const model = mat.parameters?.material_model || 'Material';
                    return `${mat.parameters?.name || mat.id} — ${preset || model}`;
                }
            );
            card.appendChild(airRow);
        }

        // 2b. Seawater Material Connection (for Marine Harbour Domain)
        if (solver.type === 'MarineHarbourDomain') {
            const currentWaterConn = conns.find(c => c.toNode === solver.id && (c.toPort === 'water' || c.toPort === 'seawater'));
            const waterCandidates = allNodes.filter(n => n.type === 'Material' && (isWaterMaterialNode(n) || (currentWaterConn && currentWaterConn.fromNode === n.id)));
            const waterRow = this.createConnectionSelectRow(
                'Seawater Material (water)',
                waterCandidates,
                currentWaterConn ? currentWaterConn.fromNode : (solver.parameters?.seawater_material || ''),
                (newWaterId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && (c.toPort === 'water' || c.toPort === 'seawater')));
                    if (newWaterId) {
                        updated.push({ fromNode: newWaterId, fromPort: 'out', toNode: solver.id, toPort: 'water' });
                    }
                    if (!solver.parameters) solver.parameters = {};
                    solver.parameters['seawater_material'] = newWaterId;
                    this.saveConnections(updated);
                },
                (mat) => {
                    const preset = mat.parameters?.preset;
                    const model = mat.parameters?.material_model || 'Material';
                    return `${mat.parameters?.name || mat.id} — ${preset || model}`;
                }
            );
            card.appendChild(waterRow);

            // 2c. Seabed Foundation Connection (for Marine Harbour Domain)
            const currentSeabedConn = conns.find(c => c.toNode === solver.id && (c.toPort === 'seabed' || c.toPort === 'elements'));
            const seabedCandidates = allNodes.filter(n => n.type === 'FEMObject3D' || n.type === 'MPMObject3D' || (n.type === 'Material' && (isSeabedMaterialNode(n) || isSolidMaterialNode(n) || (currentSeabedConn && currentSeabedConn.fromNode === n.id))));
            const seabedRow = this.createConnectionSelectRow(
                'Seabed Foundation (seabed)',
                seabedCandidates,
                currentSeabedConn ? currentSeabedConn.fromNode : (solver.parameters?.seabed_foundation || ''),
                (newSeabedId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && (c.toPort === 'seabed' || c.toPort === 'elements')));
                    if (newSeabedId) {
                        updated.push({ fromNode: newSeabedId, fromPort: 'out', toNode: solver.id, toPort: 'seabed' });
                    }
                    if (!solver.parameters) solver.parameters = {};
                    solver.parameters['seabed_foundation'] = newSeabedId;
                    this.saveConnections(updated);
                }
            );
            card.appendChild(seabedRow);
        }

        // 3. Detonator Connection
        if (solver.type === 'MPMDomain3D' || solver.type === 'CFDSolver3D' || solver.type === 'MPMDomain2D' || solver.type === 'CFDSolver2D' || solver.type === 'MarineHarbourDomain') {
            const detNodes = allNodes.filter(n => is3D ? (n.type === 'TriggerLocation3D' || n.type === 'DetonatorLocation3D') : (n.type === 'TriggerLocation' || n.type === 'DetonatorLocation'));
            const currentDetConn = conns.find(c => c.toNode === solver.id && (c.toPort === 'trigger' || c.toPort === 'detonator'));
            const detRow = this.createConnectionSelectRow(
                'Initiation Detonator',
                detNodes,
                currentDetConn ? currentDetConn.fromNode : '',
                (newDetId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && (c.toPort === 'trigger' || c.toPort === 'detonator')));
                    if (newDetId) {
                        const portName = 'detonator';
                        updated.push({ fromNode: newDetId, fromPort: portName, toNode: solver.id, toPort: portName });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(detRow);
        }

        // 4. Charge Connection (for CFD & Marine Harbour)
        if (solver.type === 'CFDSolver3D' || solver.type === 'CFDSolver2D' || solver.type === 'CFDSolver' || solver.type === 'MarineHarbourDomain') {
            const chargeNodes = allNodes.filter(n => {
                if (solver.type === 'CFDSolver') return n.type === 'Charge1D';
                if (solver.type === 'CFDSolver2D') return n.type === 'Charge2D';
                if (solver.type === 'CFDSolver3D' || solver.type === 'MarineHarbourDomain') return n.type === 'Charge3D';
                return ['Charge3D', 'Charge2D', 'Charge1D'].includes(n.type);
            });
            const currentChargeConn = conns.find(c => c.toNode === solver.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            const chargeRow = this.createConnectionSelectRow(
                'High-Explosive Charge (charge)',
                chargeNodes,
                currentChargeConn ? currentChargeConn.fromNode : '',
                (newChargeId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                    if (newChargeId) {
                        updated.push({ fromNode: newChargeId, fromPort: 'out', toNode: solver.id, toPort: 'charge' });
                    }
                    if (!solver.parameters) solver.parameters = {};
                    solver.parameters['explosive_charge'] = newChargeId;
                    if (newChargeId) {
                        const chgNode = allNodes.find(n => n.id === newChargeId);
                        if (chgNode) {
                            if (!chgNode.parameters) chgNode.parameters = {};
                            chgNode.parameters['target_domain'] = solver.id;
                        }
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(chargeRow);
        }

        // 4. Coupled FSI Bridge Connection
        let candidateCouplers: Node[] = [];
        let couplerTargetPort = '';
        let solverOutPort = 'telemetry';
        if (solver.type === 'CFDSolver3D') {
            candidateCouplers = allNodes.filter(n => n.type === 'FEMFSICoupler3D' || n.type === 'FSICoupler3D');
            couplerTargetPort = 'cfd';
            solverOutPort = 'telemetry';
        } else if (solver.type === 'FEMDomain3D') {
            candidateCouplers = allNodes.filter(n => n.type === 'FEMFSICoupler3D');
            couplerTargetPort = 'fem';
            solverOutPort = 'fem_out';
        } else if (solver.type === 'MPMDomain3D') {
            candidateCouplers = allNodes.filter(n => n.type === 'FSICoupler3D');
            couplerTargetPort = 'mpm';
            solverOutPort = 'mpm_out';
        } else if (solver.type === 'CFDSolver2D') {
            candidateCouplers = allNodes.filter(n => n.type === 'FSICoupler2D');
            couplerTargetPort = 'cfd';
            solverOutPort = 'telemetry';
        } else if (solver.type === 'MPMDomain2D') {
            candidateCouplers = allNodes.filter(n => n.type === 'FSICoupler2D');
            couplerTargetPort = 'mpm';
            solverOutPort = 'mpm_out';
        }

        if (candidateCouplers.length > 0) {
            const currentCouplerConn = conns.find(c => c.fromNode === solver.id && (c.toPort === couplerTargetPort || c.toPort === 'cfd_solver' || c.toPort === 'fem_domain' || c.toPort === 'mpm_domain'));
            const couplerRow = this.createConnectionSelectRow(
                'Coupled FSI Bridge / Coupler',
                candidateCouplers,
                currentCouplerConn ? currentCouplerConn.toNode : '',
                (newCouplerId) => {
                    let updated = conns.filter(c => !(c.fromNode === solver.id && (c.toPort === couplerTargetPort || c.toPort === 'cfd_solver' || c.toPort === 'fem_domain' || c.toPort === 'mpm_domain')));
                    if (newCouplerId) {
                        // Also clear any other connection on that coupler's target port
                        updated = updated.filter(c => !(c.toNode === newCouplerId && (c.toPort === couplerTargetPort || c.toPort === 'cfd_solver' || c.toPort === 'fem_domain' || c.toPort === 'mpm_domain')));
                        updated.push({ fromNode: solver.id, fromPort: solverOutPort, toNode: newCouplerId, toPort: couplerTargetPort });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(couplerRow);
        }

        // 5. CAD / Obstacle Geometry Connection (for 3D CFD or MPM)
        if (solver.type === 'CFDSolver3D' || solver.type === 'MPMDomain3D') {
            const geomNodes = allNodes.filter(n => ['STLGeometry', 'PrimitiveGeometry3D', 'Obstacle3D', 'Obstacle'].includes(n.type));
            const currentGeomConn = conns.find(c => c.toNode === solver.id && c.toPort === 'stl');
            const geomRow = this.createConnectionSelectRow(
                'Obstacle / CAD Mesh (stl)',
                geomNodes,
                currentGeomConn ? currentGeomConn.fromNode : '',
                (newGeomId) => {
                    let updated = conns.filter(c => !(c.toNode === solver.id && c.toPort === 'stl'));
                    if (newGeomId) {
                        updated.push({ fromNode: newGeomId, fromPort: 'stl', toNode: solver.id, toPort: 'stl' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(geomRow);
        }

        return card;
    }

    private createCouplerCard(coupler: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        header.innerHTML = `<strong>${coupler.parameters?.name || coupler.id}</strong> <span class="pcm-badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; border: 1px solid #0ea5e9;">${coupler.type}</span>`;
        card.appendChild(header);

        if (coupler.type === 'FEMFSICoupler3D') {
            // 1. Eulerian FV CFD Solver (cfd)
            const cfdSolvers = allNodes.filter(n => n.type === 'CFDSolver3D');
            const currentCfdConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver'));
            const cfdRow = this.createConnectionSelectRow(
                'Eulerian FV CFD Solver (cfd)',
                cfdSolvers,
                currentCfdConn ? currentCfdConn.fromNode : '',
                (newCfdId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')));
                    if (newCfdId) {
                        updated.push({ fromNode: newCfdId, fromPort: 'telemetry', toNode: coupler.id, toPort: 'cfd' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(cfdRow);

            // 2. Lagrangian Solid FEM Domain (fem)
            const femDomains = allNodes.filter(n => n.type === 'FEMDomain3D');
            const currentFemConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'fem' || c.toPort === 'fem_domain' || c.toPort === 'fem_solver'));
            const femRow = this.createConnectionSelectRow(
                'Lagrangian Solid FEM Domain (fem)',
                femDomains,
                currentFemConn ? currentFemConn.fromNode : '',
                (newFemId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'fem' || c.toPort === 'fem_domain' || c.toPort === 'fem_solver')));
                    if (newFemId) {
                        updated.push({ fromNode: newFemId, fromPort: 'fem_out', toNode: coupler.id, toPort: 'fem' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(femRow);
        } else if (coupler.type === 'FSICoupler3D') {
            // 1. Eulerian FV CFD Solver (cfd)
            const cfdSolvers = allNodes.filter(n => n.type === 'CFDSolver3D');
            const currentCfdConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver'));
            const cfdRow = this.createConnectionSelectRow(
                'Eulerian FV CFD Solver (cfd)',
                cfdSolvers,
                currentCfdConn ? currentCfdConn.fromNode : '',
                (newCfdId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')));
                    if (newCfdId) {
                        updated.push({ fromNode: newCfdId, fromPort: 'telemetry', toNode: coupler.id, toPort: 'cfd' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(cfdRow);

            // 2. Lagrangian Solid MPM Domain (mpm)
            const mpmDomains = allNodes.filter(n => n.type === 'MPMDomain3D');
            const currentMpmConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'mpm' || c.toPort === 'mpm_domain'));
            const mpmRow = this.createConnectionSelectRow(
                'Lagrangian Solid MPM Domain (mpm)',
                mpmDomains,
                currentMpmConn ? currentMpmConn.fromNode : '',
                (newMpmId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'mpm' || c.toPort === 'mpm_domain')));
                    if (newMpmId) {
                        updated.push({ fromNode: newMpmId, fromPort: 'mpm_out', toNode: coupler.id, toPort: 'mpm' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(mpmRow);
        } else if (coupler.type === 'FSICoupler2D') {
            // 1. Eulerian FV CFD Solver 2D (cfd)
            const cfdSolvers = allNodes.filter(n => n.type === 'CFDSolver2D');
            const currentCfdConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver'));
            const cfdRow = this.createConnectionSelectRow(
                'Eulerian FV CFD Solver 2D (cfd)',
                cfdSolvers,
                currentCfdConn ? currentCfdConn.fromNode : '',
                (newCfdId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')));
                    if (newCfdId) {
                        updated.push({ fromNode: newCfdId, fromPort: 'telemetry', toNode: coupler.id, toPort: 'cfd' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(cfdRow);

            // 2. Lagrangian Solid MPM Domain 2D (mpm)
            const mpmDomains = allNodes.filter(n => n.type === 'MPMDomain2D');
            const currentMpmConn = conns.find(c => c.toNode === coupler.id && (c.toPort === 'mpm' || c.toPort === 'mpm_domain'));
            const mpmRow = this.createConnectionSelectRow(
                'Lagrangian Solid MPM Domain 2D (mpm)',
                mpmDomains,
                currentMpmConn ? currentMpmConn.fromNode : '',
                (newMpmId) => {
                    let updated = conns.filter(c => !(c.toNode === coupler.id && (c.toPort === 'mpm' || c.toPort === 'mpm_domain')));
                    if (newMpmId) {
                        updated.push({ fromNode: newMpmId, fromPort: 'mpm_out', toNode: coupler.id, toPort: 'mpm' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(mpmRow);
        }

        return card;
    }

    private createDetonatorCard(det: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        const coords = (det.type === 'DetonatorLocation3D' || det.type === 'TriggerLocation3D')
            ? `(${det.parameters?.detonator_x ?? det.parameters?.trigger_x ?? 0.5}, ${det.parameters?.detonator_y ?? det.parameters?.trigger_y ?? 0.5}, ${det.parameters?.detonator_z ?? det.parameters?.trigger_z ?? 0.5})`
            : (det.type === 'DetonatorLocation' || det.type === 'TriggerLocation')
                ? `(r: ${det.parameters?.detonator_r ?? det.parameters?.trigger_r ?? 0.0}, z: ${det.parameters?.detonator_z ?? det.parameters?.trigger_z ?? 0.1})`
                : `(${det.parameters?.charge_mass || '0.85'} kg)`;
        header.innerHTML = `<strong>${det.parameters?.name || det.id}</strong> <span class="pcm-badge">${det.type}</span> <span class="pcm-meta">${coords}</span>`;
        card.appendChild(header);

        const solverNodes = allNodes.filter(n => {
            if (det.type === 'Charge1D') return n.type === 'CFDSolver';
            if (det.type === 'Charge2D') return n.type === 'CFDSolver2D';
            if (det.type === 'Charge3D') return n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain';
            const is3D = det.type === 'TriggerLocation3D' || det.type === 'DetonatorLocation3D';
            return is3D 
                ? ['MPMDomain3D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type) 
                : ['MPMDomain2D', 'CFDSolver2D', 'CFDSolver'].includes(n.type);
        });

        const isDet = det.type.startsWith('Detonator') || det.type.startsWith('Trigger');
        const targetPort = isDet ? 'detonator' : 'charge';
        const currentConn = conns.find(c => c.fromNode === det.id && (c.toPort === targetPort || c.toPort === 'explosive' || c.toPort === 'trigger' || c.toPort === 'detonator'));

        const row = this.createConnectionSelectRow(
            `Target Solver (${targetPort})`,
            solverNodes,
            currentConn ? currentConn.toNode : '',
            (newSolverId) => {
                let updated = conns.filter(c => !(c.fromNode === det.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'charge' || c.toPort === 'explosive')));
                if (newSolverId) {
                    updated.push({ fromNode: det.id, fromPort: targetPort === 'charge' ? 'out' : targetPort, toNode: newSolverId, toPort: targetPort });
                }
                if (!det.parameters) det.parameters = {};
                det.parameters['target_domain'] = newSolverId;
                if (newSolverId && (det.type === 'Charge1D' || det.type === 'Charge2D' || det.type === 'Charge3D')) {
                    const solverNode = allNodes.find(n => n.id === newSolverId);
                    if (solverNode) {
                        if (!solverNode.parameters) solverNode.parameters = {};
                        solverNode.parameters['explosive_charge'] = det.id;
                    }
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(row);

        // Assigned Explosive Material (for Charges)
        if (['Charge1D', 'Charge2D', 'Charge3D'].includes(det.type)) {
            const currentMatConn = conns.find(c => (c.toNode === det.id || c.fromNode === det.id) && (c.toPort === 'material' || c.fromPort === 'material'));
            const currentMatId = currentMatConn ? (currentMatConn.toNode === det.id ? currentMatConn.fromNode : currentMatConn.toNode) : (det.parameters?.material || '');
            const matNodes = allNodes.filter(n => (n.type === 'Material' || (n.type as string).startsWith('MPMMaterial')) && (isExplosiveMaterialNode(n) || n.id === currentMatId));

            const matRow = this.createConnectionSelectRow(
                'Assigned Explosive Material (material)',
                matNodes,
                currentMatId,
                (newMatId) => {
                    let updated = conns.filter(c => !((c.toNode === det.id || c.fromNode === det.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                    if (newMatId) {
                        updated.push({ fromNode: newMatId, fromPort: 'material', toNode: det.id, toPort: 'material' });
                        det.parameters['material'] = newMatId;
                    } else {
                        delete det.parameters['material'];
                    }
                    this.saveConnections(updated);
                },
                (mat) => {
                    const preset = mat.parameters?.preset;
                    const model = mat.parameters?.material_model || 'Material';
                    return `${mat.parameters?.name || mat.id} — ${preset || model}`;
                }
            );
            card.appendChild(matRow);
        }

        return card;
    }

    private createMaterialCard(mat: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        const preset = mat.parameters?.preset || mat.parameters?.composition || mat.parameters?.material_type || mat.parameters?.material_model || 'Material';
        header.innerHTML = `<strong>${mat.parameters?.name || mat.id}</strong> <span class="pcm-badge" style="background: rgba(74, 222, 128, 0.2); color: #4ade80; border: 1px solid #4ade80;">${mat.type}</span> <span class="pcm-meta">${preset}</span>`;
        card.appendChild(header);

        const isAir = isAirMaterialNode(mat);
        const isWater = isWaterMaterialNode(mat);
        const isExplosive = isExplosiveMaterialNode(mat);
        const isSeabed = isSeabedMaterialNode(mat);
        const isSolid = isSolidMaterialNode(mat);
        const isGeneric = !isAir && !isWater && !isExplosive && !isSeabed && !isSolid;

        // 1. Ambient Air Domain (air)
        const cfdSolvers = allNodes.filter(n => ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type));
        const currentAirConn = conns.find(c => (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'air' || c.fromPort === 'air'));
        const currentAirSolverId = currentAirConn ? (currentAirConn.toNode === mat.id ? currentAirConn.fromNode : currentAirConn.toNode) : (mat.parameters?.ambient_air_target || '');

        if (cfdSolvers.length > 0 && (isAir || isGeneric || currentAirSolverId)) {
            const airRow = this.createConnectionSelectRow(
                'Ambient Air Domain (air)',
                cfdSolvers,
                currentAirSolverId,
                (newSolverId) => {
                    let updated = conns.filter(c => !((c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'air' || c.fromPort === 'air')));
                    if (newSolverId) {
                        updated = updated.filter(c => !(c.toNode === newSolverId && c.toPort === 'air'));
                        updated.push({ fromNode: mat.id, fromPort: 'air', toNode: newSolverId, toPort: 'air' });
                    }
                    if (!mat.parameters) mat.parameters = {};
                    mat.parameters['ambient_air_target'] = newSolverId;
                    if (newSolverId) {
                        const solverNode = allNodes.find(n => n.id === newSolverId);
                        if (solverNode) {
                            if (!solverNode.parameters) solverNode.parameters = {};
                            solverNode.parameters['ambient_air_material'] = mat.id;
                        }
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(airRow);
        }

        // 2. Marine Seawater Domain (water)
        const harbourSolvers = allNodes.filter(n => ['MarineHarbourDomain', 'CFDSolver3D'].includes(n.type));
        const currentWaterConn = conns.find(c => (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'water' || c.fromPort === 'water' || c.toPort === 'seawater' || c.fromPort === 'seawater'));
        const currentWaterSolverId = currentWaterConn ? (currentWaterConn.toNode === mat.id ? currentWaterConn.fromNode : currentWaterConn.toNode) : (mat.parameters?.water_target || '');

        if (harbourSolvers.length > 0 && (isWater || isGeneric || currentWaterSolverId)) {
            const waterRow = this.createConnectionSelectRow(
                'Marine Seawater Domain (water)',
                harbourSolvers,
                currentWaterSolverId,
                (newSolverId) => {
                    let updated = conns.filter(c => !((c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'water' || c.fromPort === 'water' || c.toPort === 'seawater' || c.fromPort === 'seawater')));
                    if (newSolverId) {
                        updated = updated.filter(c => !(c.toNode === newSolverId && (c.toPort === 'water' || c.toPort === 'seawater')));
                        updated.push({ fromNode: mat.id, fromPort: 'out', toNode: newSolverId, toPort: 'water' });
                    }
                    if (!mat.parameters) mat.parameters = {};
                    mat.parameters['water_target'] = newSolverId;
                    if (newSolverId) {
                        const solverNode = allNodes.find(n => n.id === newSolverId);
                        if (solverNode) {
                            if (!solverNode.parameters) solverNode.parameters = {};
                            solverNode.parameters['seawater_material'] = mat.id;
                        }
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(waterRow);
        }

        // 3. Seabed Foundation Domain (seabed)
        const seabedSolvers = allNodes.filter(n => n.type === 'MarineHarbourDomain');
        const currentSeabedConn = conns.find(c => (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'seabed' || c.fromPort === 'seabed'));
        const currentSeabedSolverId = currentSeabedConn ? (currentSeabedConn.toNode === mat.id ? currentSeabedConn.fromNode : currentSeabedConn.toNode) : (seabedSolvers.find(h => h.parameters?.seabed_foundation === mat.id)?.id || mat.parameters?.seabed_target || '');

        if (seabedSolvers.length > 0 && (isSeabed || isSolid || isGeneric || currentSeabedSolverId)) {
            const seabedRow = this.createConnectionSelectRow(
                'Seabed Foundation Domain (seabed)',
                seabedSolvers,
                currentSeabedSolverId,
                (newSolverId) => {
                    let updated = conns.filter(c => !((c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'seabed' || c.fromPort === 'seabed')));
                    if (newSolverId) {
                        updated = updated.filter(c => !(c.toNode === newSolverId && c.toPort === 'seabed'));
                        updated.push({ fromNode: mat.id, fromPort: 'out', toNode: newSolverId, toPort: 'seabed' });
                    }
                    if (!mat.parameters) mat.parameters = {};
                    mat.parameters['seabed_target'] = newSolverId;
                    if (newSolverId) {
                        const solverNode = allNodes.find(n => n.id === newSolverId);
                        if (solverNode) {
                            if (!solverNode.parameters) solverNode.parameters = {};
                            solverNode.parameters['seabed_foundation'] = mat.id;
                        }
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(seabedRow);
        }

        // 4. Assigned High-Explosive Charge (material)
        const chargeNodes = allNodes.filter(n => ['Charge1D', 'Charge2D', 'Charge3D'].includes(n.type));
        const currentChgConn = conns.find(c => (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'material' || c.fromPort === 'material') && chargeNodes.some(ch => ch.id === c.toNode || ch.id === c.fromNode));
        const currentChgId = currentChgConn ? (currentChgConn.toNode === mat.id ? currentChgConn.fromNode : currentChgConn.toNode) : (mat.parameters?.charge_target || '');

        if (chargeNodes.length > 0 && (isExplosive || isGeneric || currentChgId)) {
            const chgRow = this.createConnectionSelectRow(
                'Target Charge (material)',
                chargeNodes,
                currentChgId,
                (newChgId) => {
                    let updated = conns.filter(c => !(chargeNodes.some(ch => ch.id === c.toNode || ch.id === c.fromNode) && (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                    if (newChgId) {
                        updated = updated.filter(c => !((c.toNode === newChgId || c.fromNode === newChgId) && (c.toPort === 'material' || c.fromPort === 'material')));
                        updated.push({ fromNode: mat.id, fromPort: 'material', toNode: newChgId, toPort: 'material' });
                        const chgNode = allNodes.find(n => n.id === newChgId);
                        if (chgNode && chgNode.parameters) chgNode.parameters['material'] = mat.id;
                    }
                    if (!mat.parameters) mat.parameters = {};
                    mat.parameters['charge_target'] = newChgId;
                    this.saveConnections(updated);
                }
            );
            card.appendChild(chgRow);
        }

        // 5. Assigned Structural Body (material)
        const bodyNodes = allNodes.filter(n => ['FEMObject3D', 'MPMObject3D', 'MPMObject2D', 'FEMBeam3D', 'FEMRebar3D'].includes(n.type));
        const currentBodyConn = conns.find(c => (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'material' || c.fromPort === 'material') && bodyNodes.some(b => b.id === c.toNode || b.id === c.fromNode));
        const currentBodyId = currentBodyConn ? (currentBodyConn.toNode === mat.id ? currentBodyConn.fromNode : currentBodyConn.toNode) : (bodyNodes.find(b => b.parameters?.material === mat.id)?.id || mat.parameters?.body_target || '');

        if (bodyNodes.length > 0 && ((isSolid && !isExplosive) || isGeneric || currentBodyId)) {
            const bodyRow = this.createConnectionSelectRow(
                'Assigned Structural Body (material)',
                bodyNodes,
                currentBodyId,
                (newBodyId) => {
                    let updated = conns.filter(c => !(bodyNodes.some(b => b.id === c.toNode || b.id === c.fromNode) && (c.fromNode === mat.id || c.toNode === mat.id) && (c.toPort === 'material' || c.fromPort === 'material')));
                    if (newBodyId) {
                        updated.push({ fromNode: mat.id, fromPort: 'material', toNode: newBodyId, toPort: 'material' });
                        const bNode = allNodes.find(n => n.id === newBodyId);
                        if (bNode) {
                            if (!bNode.parameters) bNode.parameters = {};
                            bNode.parameters['material'] = mat.id;
                        }
                    }
                    if (!mat.parameters) mat.parameters = {};
                    mat.parameters['body_target'] = newBodyId;
                    this.saveConnections(updated);
                }
            );
            card.appendChild(bodyRow);
        }

        return card;
    }

    private createBodyCard(body: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        header.innerHTML = `<strong>${body.parameters?.name || body.id}</strong> <span class="pcm-badge">${body.type}</span> <span class="pcm-meta">${body.parameters?.shape_type || 'Body'}</span>`;
        card.appendChild(header);

        const is3D = body.type === 'MPMObject3D' || body.type === 'FEMObject3D' || body.type === 'LSDynaImporter3D' || body.type === 'FEMBeam3D' || body.type === 'FEMRebar3D';
        const domainNodes = allNodes.filter(n => is3D 
            ? (body.type === 'MPMObject3D' ? ['MPMDomain3D', 'MarineHarbourDomain'].includes(n.type) : ['FEMDomain3D', 'MarineHarbourDomain'].includes(n.type))
            : n.type === 'MPMDomain2D');

        // 1. Parent Domain Connection
        const currentDomConn = conns.find(c => c.fromNode === body.id && (c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects' || c.toPort === 'seabed'));
        const domRow = this.createConnectionSelectRow(
            'Target Solver Domain',
            domainNodes,
            currentDomConn ? currentDomConn.toNode : '',
            (newDomId) => {
                let updated = conns.filter(c => !(c.fromNode === body.id && (c.toPort === 'mesh' || c.toPort === 'objects' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'mpm_objects' || c.toPort === 'fem_objects' || c.toPort === 'seabed')));
                if (newDomId) {
                    const targetDom = allNodes.find(n => n.id === newDomId);
                    const toPort = targetDom?.type === 'FEMDomain3D' ? 'mesh' : (targetDom?.type === 'MarineHarbourDomain' ? 'seabed' : 'objects');
                    updated.push({ fromNode: body.id, fromPort: 'out', toNode: newDomId, toPort: toPort });
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

        // 3. STL / CAD Shape Source Connection (for MPMObject3D)
        if (body.type === 'MPMObject3D') {
            const geomNodes = allNodes.filter(n => ['STLGeometry', 'PrimitiveGeometry3D'].includes(n.type));
            const currentGeomConn = conns.find(c => c.toNode === body.id && c.toPort === 'stl');
            const geomRow = this.createConnectionSelectRow(
                'Source CAD Shape (stl)',
                geomNodes,
                currentGeomConn ? currentGeomConn.fromNode : '',
                (newGeomId) => {
                    let updated = conns.filter(c => !(c.toNode === body.id && c.toPort === 'stl'));
                    if (newGeomId) {
                        updated.push({ fromNode: newGeomId, fromPort: 'stl', toNode: body.id, toPort: 'stl' });
                    }
                    this.saveConnections(updated);
                }
            );
            card.appendChild(geomRow);
        }

        return card;
    }

    private createGeometryCard(geom: Node, conns: Connection[], allNodes: Node[]): HTMLElement {
        const card = document.createElement('div');
        card.className = 'pcm-card';

        const header = document.createElement('div');
        header.className = 'pcm-card-header';
        const fileOrType = geom.parameters?.stl_file ? String(geom.parameters.stl_file).split('/').pop() : (geom.type === 'PrimitiveGeometry3D' ? `${(geom.parameters?.primitives || []).length} shapes` : geom.type);
        header.innerHTML = `<strong>${geom.parameters?.name || geom.id}</strong> <span class="pcm-badge" style="background: rgba(129, 199, 132, 0.2); color: #81c784; border: 1px solid #81c784;">${geom.type}</span> <span class="pcm-meta">${fileOrType}</span>`;
        card.appendChild(header);

        // Target solver or body connection (CFDSolver3D, MPMDomain3D, MPMObject3D)
        const targetNodes = allNodes.filter(n => ['CFDSolver3D', 'MPMDomain3D', 'MPMObject3D'].includes(n.type));
        const currentConn = conns.find(c => c.fromNode === geom.id && c.toPort === 'stl');

        const row = this.createConnectionSelectRow(
            'Target Solver or Body (stl)',
            targetNodes,
            currentConn ? currentConn.toNode : '',
            (newTargetId) => {
                let updated = conns.filter(c => !(c.fromNode === geom.id && c.toPort === 'stl'));
                if (newTargetId) {
                    updated.push({ fromNode: geom.id, fromPort: 'stl', toNode: newTargetId, toPort: 'stl' });
                }
                this.saveConnections(updated);
            }
        );
        card.appendChild(row);

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

        const solverNodes = allNodes.filter(n => {
            if (mesh.type === 'DomainMesh3D') return ['MPMDomain3D', 'CFDSolver3D', 'FEMDomain3D', 'MarineHarbourDomain'].includes(n.type);
            if (mesh.type === 'DomainMesh2D') return ['MPMDomain2D', 'CFDSolver2D'].includes(n.type);
            return ['CFDSolver', 'DomainMesh'].includes(n.type) || n.type === 'CFDSolver';
        });

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

        let found = false;
        for (const n of candidateNodes) {
            const opt = document.createElement('option');
            opt.value = n.id;
            opt.textContent = customLabelFn ? customLabelFn(n) : `${n.parameters?.name || n.id} [${n.type}]`;
            if (n.id === selectedId) {
                opt.selected = true;
                found = true;
            }
            select.appendChild(opt);
        }

        if (!found && selectedId) {
            const fallbackOpt = document.createElement('option');
            fallbackOpt.value = selectedId;
            fallbackOpt.textContent = `Connected Entity [${selectedId.substring(0, 8)}]`;
            fallbackOpt.selected = true;
            select.appendChild(fallbackOpt);
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
