import { SimulationState, Node, Connection } from './types.js';

export interface NodeStatus {
    state: 'error' | 'warning' | 'valid';
    messages: string[];
}

export interface ValidationResult {
    nodeStatus: Record<string, NodeStatus>;
    flawedConnections: Map<string, string>; // Connection Key (fromNode:fromPort->toNode:toPort) -> Error Message
    globalWarnings: string[];
}

export function validateSimulationState(state: SimulationState): ValidationResult {
    const nodeStatus: Record<string, NodeStatus> = {};
    const flawedConnections = new Map<string, string>();
    const globalWarnings: string[] = [];

    // Initialize node status
    state.nodes.forEach(node => {
        nodeStatus[node.id] = { state: 'valid', messages: [] };
    });

    const addMessage = (nodeId: string, stateType: 'error' | 'warning', msg: string) => {
        const current = nodeStatus[nodeId];
        if (!current) return;
        if (stateType === 'error') {
            current.state = 'error';
        } else if (stateType === 'warning' && current.state !== 'error') {
            current.state = 'warning';
        }
        current.messages.push(msg);
    };

    // --- 1. CFD Solver 1D Validation ---
    const solvers1D = state.nodes.filter(n => n.type === 'CFDSolver');
    solvers1D.forEach(solver1D => {
        // CFL validation
        const cfl = Number(solver1D.parameters?.cfl ?? 0.4);
        if (isNaN(cfl) || cfl <= 0 || cfl >= 1.0) {
            addMessage(solver1D.id, 'error', "CFL parameter must be between 0.0 and 1.0 (exclusive).");
        }

        const painterConn = state.connections.find(c => c.toNode === solver1D.id && c.toPort === 'in');
        if (!painterConn) {
            addMessage(solver1D.id, 'error', "CFD Solver is not connected to the Initializer (ThePainter).");
        } else {
            const painterNode = state.nodes.find(n => n.id === painterConn.fromNode);
            if (!painterNode || painterNode.type !== 'ThePainter') {
                const connKey = `${painterConn.fromNode}:${painterConn.fromPort}->${painterConn.toNode}:${painterConn.toPort}`;
                flawedConnections.set(connKey, "CFD Solver 'Initial State' port must be connected to the Initializer (ThePainter).");
                addMessage(solver1D.id, 'error', "CFD Solver 'Initial State' port must be connected to the Initializer (ThePainter).");
            }
        }
    });

    // --- 2. ThePainter Validation (1D Mesh / Materials Initializer) ---
    const painterNodes = state.nodes.filter(n => n.type === 'ThePainter');
    painterNodes.forEach(painterNode => {
        // Find the solver connected to this specific Initializer (if any)
        const solverConn = state.connections.find(c => c.fromNode === painterNode.id && c.toPort === 'in');
        const solverNode = solverConn 
            ? state.nodes.find(n => n.id === solverConn.toNode && n.type === 'CFDSolver')
            : undefined;
            
        // Fallback to the first CFDSolver in the list if no connection is set yet
        const activeSolver = solverNode || state.nodes.find(n => n.type === 'CFDSolver');
        const initMode = activeSolver?.parameters['init_mode'] || 'Multi-Material JWL';

        // Mesh connection check
        const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
        if (!meshConn) {
            addMessage(painterNode.id, 'error', "No Mesh node connected to Initializer. A DomainMesh node is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === meshConn.fromNode);
            if (!fromNode || fromNode.type !== 'DomainMesh') {
                const connKey = `${meshConn.fromNode}:${meshConn.fromPort}->${meshConn.toNode}:${meshConn.toPort}`;
                flawedConnections.set(connKey, "Only DomainMesh node can be connected to the Mesh input.");
                addMessage(painterNode.id, 'error', "Only DomainMesh node can be connected to the Mesh input.");
            }
        }

        // Air connection check
        const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
        if (!airConn) {
            addMessage(painterNode.id, 'error', "No Air node connected to Initializer. A MaterialAir node is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === airConn.fromNode);
            if (!fromNode || fromNode.type !== 'MaterialAir') {
                const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                flawedConnections.set(connKey, "Only MaterialAir node can be connected to the Air input.");
                addMessage(painterNode.id, 'error', "Only MaterialAir node can be connected to the Air input.");
            }
        }

        // Explosive connection check
        const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
        if (!expConn) {
            addMessage(painterNode.id, 'warning', "No Explosive node connected to Initializer. Simulation will run with NO explosive charge.");
        } else {
            const expNode = state.nodes.find(n => n.id === expConn.fromNode);
            if (expNode) {
                if (expNode.type !== 'MaterialExplosive' && expNode.type !== 'MaterialIdealGas') {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Only MaterialExplosive or MaterialIdealGas node can be connected to the Explosive input.");
                    addMessage(painterNode.id, 'error', "Only MaterialExplosive or MaterialIdealGas node can be connected to the Explosive input.");
                } else if (initMode === 'Ideal Gas' && expNode.type === 'MaterialExplosive') {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                    addMessage(expNode.id, 'warning', "Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                    if (activeSolver) {
                        addMessage(activeSolver.id, 'warning', "Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                    }
                } else if (initMode === 'Multi-Material JWL' && expNode.type === 'MaterialIdealGas') {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                    addMessage(expNode.id, 'warning', "Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                    if (activeSolver) {
                        addMessage(activeSolver.id, 'warning', "Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                    }
                }
            }
        }
    });

    // --- 3. CFD Solver 2D Validation ---
    const solvers2D = state.nodes.filter(n => n.type === 'CFDSolver2D');
    solvers2D.forEach(solver2D => {
        // CFL validation
        const cfl = Number(solver2D.parameters?.cfl ?? 0.35);
        if (isNaN(cfl) || cfl <= 0 || cfl >= 1.0) {
            addMessage(solver2D.id, 'error', "CFL parameter must be between 0.0 and 1.0 (exclusive).");
        }

        const initMode2D = solver2D.parameters?.init_mode || 'From1D';

        // Mesh connection check (Always required)
        const meshConn2D = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'mesh');
        let meshNode2D: Node | undefined;
        if (!meshConn2D) {
            addMessage(solver2D.id, 'error', "No Mesh node connected to CFD Solver 2D. A DomainMesh2D node is required.");
        } else {
            meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
            if (!meshNode2D || meshNode2D.type !== 'DomainMesh2D') {
                const connKey = `${meshConn2D.fromNode}:${meshConn2D.fromPort}->${meshConn2D.toNode}:${meshConn2D.toPort}`;
                flawedConnections.set(connKey, "Only DomainMesh2D node can be connected to the Mesh input of CFD Solver 2D.");
                addMessage(solver2D.id, 'error', "Only DomainMesh2D node can be connected to the Mesh input of CFD Solver 2D.");
            }
        }

        // Hardware connection check (Optional, but if connected must be HardwareConfig)
        const hwConn2D = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'hardware');
        if (hwConn2D) {
            const hwNode = state.nodes.find(n => n.id === hwConn2D.fromNode);
            if (!hwNode || hwNode.type !== 'HardwareConfig') {
                const connKey = `${hwConn2D.fromNode}:${hwConn2D.fromPort}->${hwConn2D.toNode}:${hwConn2D.toPort}`;
                flawedConnections.set(connKey, "Only HardwareConfig node can be connected to the Hardware input of CFD Solver 2D.");
                addMessage(solver2D.id, 'error', "Only HardwareConfig node can be connected to the Hardware input of CFD Solver 2D.");
            }
        }

        if (initMode2D === 'From1D') {
            // Remap check
            const remapConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'remap');
            if (!remapConn) {
                addMessage(solver2D.id, 'error', "CFD Solver 2D requires a Remap node connected to the 'remap' input when Init Mode is 'From1D'.");
            } else {
                const remapNode = state.nodes.find(n => n.id === remapConn.fromNode);
                if (!remapNode || remapNode.type !== 'RemapNode') {
                    const connKey = `${remapConn.fromNode}:${remapConn.fromPort}->${remapConn.toNode}:${remapConn.toPort}`;
                    flawedConnections.set(connKey, "Only RemapNode can be connected to the Remap input.");
                    addMessage(solver2D.id, 'error', "Only RemapNode can be connected to the Remap input.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['air', 'explosive', 'ideal_gas'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver2D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'From1D'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 2D Init Mode is 'From1D'.`);
                    }
                }
            });

            // Detonator check (optional in From1D remap mode, but if connected must be a DetonatorLocation node)
            const detConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'detonator');
            if (detConn) {
                const detNode = state.nodes.find(n => n.id === detConn.fromNode);
                if (!detNode || detNode.type !== 'DetonatorLocation') {
                    const connKey = `${detConn.fromNode}:${detConn.fromPort}->${detConn.toNode}:${detConn.toPort}`;
                    flawedConnections.set(connKey, "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                }
            }

        } else if (initMode2D === 'Multi-Material JWL') {
            // Air check
            const airConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'air');
            if (!airConn) {
                addMessage(solver2D.id, 'error', "No Air node connected to CFD Solver 2D. A MaterialAir node is required for Multi-Material JWL mode.");
            } else {
                const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                if (!airNode || airNode.type !== 'MaterialAir') {
                    const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                    flawedConnections.set(connKey, "Only MaterialAir node can be connected to the Air input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only MaterialAir node can be connected to the Air input of CFD Solver 2D.");
                }
            }

            // Explosive check
            const expConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'explosive');
            if (!expConn) {
                addMessage(solver2D.id, 'error', "No Explosive node connected to CFD Solver 2D. A MaterialExplosive node is required for Multi-Material JWL mode.");
            } else {
                const expNode = state.nodes.find(n => n.id === expConn.fromNode);
                if (!expNode || expNode.type !== 'MaterialExplosive') {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Only MaterialExplosive node can be connected to the Explosive input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only MaterialExplosive node can be connected to the Explosive input of CFD Solver 2D.");
                }
            }

            // Detonator check
            const detConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'detonator');
            if (!detConn) {
                addMessage(solver2D.id, 'error', "No Detonator node connected to CFD Solver 2D. A DetonatorLocation node is required for Multi-Material JWL mode.");
            } else {
                const detNode = state.nodes.find(n => n.id === detConn.fromNode);
                if (!detNode || detNode.type !== 'DetonatorLocation') {
                    const connKey = `${detConn.fromNode}:${detConn.fromPort}->${detConn.toNode}:${detConn.toPort}`;
                    flawedConnections.set(connKey, "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['remap', 'ideal_gas'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver2D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'Multi-Material JWL'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 2D Init Mode is 'Multi-Material JWL'.`);
                    }
                }
            });

        } else if (initMode2D === 'Ideal Gas') {
            // Air check
            const airConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'air');
            if (!airConn) {
                addMessage(solver2D.id, 'error', "No Air node connected to CFD Solver 2D. A MaterialAir node is required for Ideal Gas mode.");
            } else {
                const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                if (!airNode || airNode.type !== 'MaterialAir') {
                    const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                    flawedConnections.set(connKey, "Only MaterialAir node can be connected to the Air input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only MaterialAir node can be connected to the Air input of CFD Solver 2D.");
                }
            }

            // Ideal Gas check
            const igConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'ideal_gas');
            if (!igConn) {
                addMessage(solver2D.id, 'error', "No Ideal Gas node connected to CFD Solver 2D. A MaterialIdealGas node is required for Ideal Gas mode.");
            } else {
                const igNode = state.nodes.find(n => n.id === igConn.fromNode);
                if (!igNode || igNode.type !== 'MaterialIdealGas') {
                    const connKey = `${igConn.fromNode}:${igConn.fromPort}->${igConn.toNode}:${igConn.toPort}`;
                    flawedConnections.set(connKey, "Only MaterialIdealGas node can be connected to the Ideal Gas input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only MaterialIdealGas node can be connected to the Ideal Gas input of CFD Solver 2D.");
                }
            }

            // Detonator check
            const detConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'detonator');
            if (!detConn) {
                addMessage(solver2D.id, 'error', "No Detonator node connected to CFD Solver 2D. A DetonatorLocation node is required for Ideal Gas mode.");
            } else {
                const detNode = state.nodes.find(n => n.id === detConn.fromNode);
                if (!detNode || detNode.type !== 'DetonatorLocation') {
                    const connKey = `${detConn.fromNode}:${detConn.fromPort}->${detConn.toNode}:${detConn.toPort}`;
                    flawedConnections.set(connKey, "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only DetonatorLocation node can be connected to the Detonator input of CFD Solver 2D.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['remap', 'explosive'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver2D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'Ideal Gas'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 2D Init Mode is 'Ideal Gas'.`);
                    }
                }
            });
        }
    });

    // --- 4. Validation of Individual Nodes & Parameters ---
    state.nodes.forEach(node => {
        if (node.type === 'DomainMesh') {
            const cell_size = Number(node.parameters?.cell_size ?? 0.001);
            const domain_radius = Number(node.parameters?.domain_radius ?? 1.0);

            if (isNaN(cell_size) || cell_size <= 0) {
                addMessage(node.id, 'error', "Mesh Cell Size must be greater than 0.");
            }
            if (isNaN(domain_radius) || domain_radius <= 0) {
                addMessage(node.id, 'error', "Mesh Domain Radius must be greater than 0.");
            }
            if (cell_size >= domain_radius) {
                addMessage(node.id, 'error', "Mesh Cell Size must be smaller than Domain Radius.");
            }
        }

        if (node.type === 'DomainMesh2D') {
            const nr = Number(node.parameters?.nr ?? 200);
            const nz = Number(node.parameters?.nz ?? 200);
            const max_r = Number(node.parameters?.max_r ?? 1.0);
            const max_z = Number(node.parameters?.max_z ?? 1.0);

            if (isNaN(nr) || nr <= 0 || !Number.isInteger(nr)) {
                addMessage(node.id, 'error', "Mesh resolution R (nr) must be a positive integer.");
            }
            if (isNaN(nz) || nz <= 0 || !Number.isInteger(nz)) {
                addMessage(node.id, 'error', "Mesh resolution Z (nz) must be a positive integer.");
            }
            if (isNaN(max_r) || max_r <= 0) {
                addMessage(node.id, 'error', "Mesh dimension R (max_r) must be greater than 0.");
            }
            if (isNaN(max_z) || max_z <= 0) {
                addMessage(node.id, 'error', "Mesh dimension Z (max_z) must be greater than 0.");
            }
        }

        if (node.type === 'MaterialAir') {
            const gamma = Number(node.parameters?.gamma ?? 1.4);
            const atm_pressure = Number(node.parameters?.atm_pressure ?? 101325);
            const atm_temperature = Number(node.parameters?.atm_temperature ?? 298.15);

            if (isNaN(gamma) || gamma <= 1.0) {
                addMessage(node.id, 'error', "Air adiabatic index (gamma) must be greater than 1.0.");
            }
            if (isNaN(atm_pressure) || atm_pressure <= 0) {
                addMessage(node.id, 'error', "Atmospheric Pressure must be greater than 0.");
            }
            if (isNaN(atm_temperature) || atm_temperature <= 0) {
                addMessage(node.id, 'error', "Atmospheric Temperature (Kelvin) must be greater than 0.");
            }
        }

        if (node.type === 'MaterialExplosive') {
            const charge_mass = Number(node.parameters?.charge_mass ?? 1.0);
            const rho = Number(node.parameters?.rho ?? 1630);
            const detonation_energy = Number(node.parameters?.detonation_energy ?? 4290000);

            if (isNaN(charge_mass) || charge_mass <= 0) {
                addMessage(node.id, 'error', "Explosive charge mass must be greater than 0.");
            }
            if (isNaN(rho) || rho <= 0) {
                addMessage(node.id, 'error', "Explosive density (rho) must be greater than 0.");
            }
            if (isNaN(detonation_energy) || detonation_energy <= 0) {
                addMessage(node.id, 'error', "Detonation energy must be greater than 0.");
            }
        }

        if (node.type === 'MaterialExplosive' || node.type === 'MaterialIdealGas') {
            const charge_mass = Number(node.parameters?.charge_mass ?? 1.0);
            const rho = Number(node.parameters?.rho ?? 1630);
            const detonation_energy = Number(node.parameters?.detonation_energy ?? 4520000);

            if (isNaN(charge_mass) || charge_mass <= 0) {
                addMessage(node.id, 'error', "Explosive charge mass must be greater than 0.");
            }
            if (isNaN(rho) || rho <= 0) {
                addMessage(node.id, 'error', "Explosive density (rho) must be greater than 0.");
            }
            if (isNaN(detonation_energy) || detonation_energy <= 0) {
                addMessage(node.id, 'error', "Detonation energy must be greater than 0.");
            }

            const shape = node.parameters?.charge_shape || 'Sphere';
            const charge_r = Number(node.parameters?.charge_r ?? 0.0);
            const charge_z = Number(node.parameters?.charge_z ?? 0.1);
            const charge_radius = Number(node.parameters?.charge_radius ?? 0.05);
            const charge_height = Number(node.parameters?.charge_height ?? 0.1);

            if (isNaN(charge_r) || charge_r < 0) {
                addMessage(node.id, 'error', "Charge radial coordinate (R) must be non-negative.");
            }
            if (isNaN(charge_z) || charge_z < 0) {
                addMessage(node.id, 'error', "Charge axial coordinate (Z) must be non-negative.");
            }
            if (isNaN(charge_radius) || charge_radius <= 0) {
                addMessage(node.id, 'error', "Charge radius must be greater than 0.");
            }
            if (shape === 'Cylinder' && (isNaN(charge_height) || charge_height <= 0)) {
                addMessage(node.id, 'error', "Charge height must be greater than 0 for cylindrical charges.");
            }
        }

        if (node.type === 'DetonatorLocation') {
            const det_radius = Number(node.parameters?.detonator_radius !== undefined ? node.parameters.detonator_radius : (node.parameters.explosive_radius ?? 0.001));
            const det_z = Number(node.parameters?.detonator_z !== undefined ? node.parameters.detonator_z : (node.parameters.explosive_z ?? 0.0));
            const det_r = Number(node.parameters?.detonator_r !== undefined ? node.parameters.detonator_r : (node.parameters.explosive_r ?? 0.0));

            if (isNaN(det_radius) || det_radius <= 0) {
                addMessage(node.id, 'error', "Detonator radius must be greater than 0.");
            }

            // Cross-validation with connected mesh
            const detConn = state.connections.find(c => c.fromNode === node.id && c.fromPort === 'detonator');
            if (detConn) {
                const connectedSolver = state.nodes.find(n => n.id === detConn.toNode);
                if (connectedSolver && connectedSolver.type === 'CFDSolver2D') {
                    const meshConn2D = state.connections.find(c => c.toNode === connectedSolver.id && c.toPort === 'mesh');
                    if (meshConn2D) {
                        const meshNode = state.nodes.find(n => n.id === meshConn2D.fromNode);
                        if (meshNode && meshNode.type === 'DomainMesh2D') {
                            const max_r = Number(meshNode.parameters?.max_r ?? 1.0);
                            const max_z = Number(meshNode.parameters?.max_z ?? 1.0);

                            if (det_z < 0 || det_z > max_z) {
                                addMessage(node.id, 'warning', `Detonator position (z = ${det_z}) is outside the mesh domain [0, ${max_z}].`);
                            }
                            if (det_r < 0 || det_r > max_r) {
                                addMessage(node.id, 'warning', `Detonator position (r = ${det_r}) is outside the mesh domain [0, ${max_r}].`);
                            }
                            if (det_radius > max_r) {
                                addMessage(node.id, 'warning', `Detonator radius (${det_radius}) exceeds mesh max R (${max_r}).`);
                            }
                        }
                    }
                }
            }
        }

        if (node.type === 'RemapNode') {
            const remap_radius = Number(node.parameters?.remap_radius ?? 0.5);
            if (isNaN(remap_radius) || remap_radius <= 0) {
                addMessage(node.id, 'error', "Remap radius must be greater than 0.");
            }

            // Connection checks
            const inConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
            if (!inConn) {
                addMessage(node.id, 'error', "Remap node is not connected to a 1D CFD Solver.");
            } else {
                const fromNode = state.nodes.find(n => n.id === inConn.fromNode);
                if (!fromNode || fromNode.type !== 'CFDSolver') {
                    const connKey = `${inConn.fromNode}:${inConn.fromPort}->${inConn.toNode}:${inConn.toPort}`;
                    flawedConnections.set(connKey, "Remap input must be connected to a 1D CFD Solver.");
                    addMessage(node.id, 'error', "Remap input must be connected to a 1D CFD Solver.");
                }
            }

            // Cross-validation with 2D mesh dimensions
            const remapConn = state.connections.find(c => c.fromNode === node.id && c.fromPort === 'remap');
            if (remapConn) {
                const connectedSolver = state.nodes.find(n => n.id === remapConn.toNode);
                if (connectedSolver && connectedSolver.type === 'CFDSolver2D') {
                    const meshConn2D = state.connections.find(c => c.toNode === connectedSolver.id && c.toPort === 'mesh');
                    if (meshConn2D) {
                        const meshNode = state.nodes.find(n => n.id === meshConn2D.fromNode);
                        if (meshNode && meshNode.type === 'DomainMesh2D') {
                            const max_r = Number(meshNode.parameters?.max_r ?? 1.0);
                            if (remap_radius > max_r) {
                                addMessage(node.id, 'warning', `Remap radius (${remap_radius}) exceeds mesh max R (${max_r}).`);
                            }
                        }
                    }
                }
            }
        }

        // --- 5. Telemetry & Output Node Validations ---
        if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'VTKOutput') {
            const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
            if (!conn) {
                addMessage(node.id, 'warning', `Not connected to any CFD Solver. No data will be received.`);
            } else {
                const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                if (node.type === 'TelemetryContour') {
                    if (!fromNode || fromNode.type !== 'CFDSolver2D') {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "TelemetryContour requires a 2D CFD Solver source.");
                        addMessage(node.id, 'error', "TelemetryContour requires a 2D CFD Solver source.");
                    }
                } else if (node.type === 'TelemetryGraph') {
                    if (!fromNode || (fromNode.type !== 'CFDSolver' && fromNode.type !== 'CFDSolver2D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "TelemetryGraph must be connected to a CFD Solver.");
                        addMessage(node.id, 'error', "TelemetryGraph must be connected to a CFD Solver.");
                    }
                } else {
                    if (!fromNode || (fromNode.type !== 'CFDSolver' && fromNode.type !== 'CFDSolver2D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "Telemetry/Output must be connected to a CFD Solver.");
                        addMessage(node.id, 'error', "Telemetry/Output must be connected to a CFD Solver.");
                    }
                }
            }
        }
    });

    // Extract any messages from errored/warned nodes to global list
    state.nodes.forEach(node => {
        const status = nodeStatus[node.id];
        if (status && status.state !== 'valid') {
            status.messages.forEach(msg => {
                const prefix = status.state === 'error' ? 'Error' : 'Warning';
                globalWarnings.push(`[${node.type} "${node.id}"] ${prefix}: ${msg}`);
            });
        }
    });

    return { nodeStatus, flawedConnections, globalWarnings };
}
