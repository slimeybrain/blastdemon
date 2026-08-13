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

export function isParameterRelevant(node: Node, key: string): boolean {
    if (!node || !node.parameters) return true;

    // Parameters that are system paths/hashes/collections/internal properties which can be empty or managed separately
    if (['output_dir', 'vtk_dir', 'gauges', 'slices', 'stl_file', 'geometry_hash', 'primitives', 'k_file'].includes(key)) {
        return false;
    }

    if (node.type === 'FEMDomain3D') {
        const scheme = node.parameters['integration_scheme'] || 'OnePointFB';
        if ((scheme === 'FullGauss8' || scheme === 'SelectiveReduced') && ['hourglass_model', 'hourglass_coeff'].includes(key)) return false;
    } else if (node.type === 'FEMObject3D') {
        if (key === 'shape_type') return false;
        const meshSource = node.parameters['mesh_source'] || 'Box Generator';
        if (meshSource === 'Cylinder Generator') {
            if (['size_x', 'size_y', 'size_z', 'length', 'ny', 'k_file', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return false;
        } else if (meshSource === 'Box Generator') {
            if (['radius', 'inner_radius', 'height', 'length', 'k_file', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return false;
        } else if (meshSource === 'LS-DYNA Keyword File') {
            if (['pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'length', 'nx', 'ny', 'nz', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return false;
        }
    } else if (node.type === 'MPMObject3D') {
        const shape = node.parameters['shape_type'] || 'Box';
        if (shape === 'Box') {
            if (['radius', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z', 'geometry_hash'].includes(key)) return false;
        } else if (shape === 'Sphere') {
            if (['size_x', 'size_y', 'size_z', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z', 'geometry_hash'].includes(key)) return false;
        } else if (shape === 'Cylinder') {
            if (['size_x', 'size_y', 'size_z', 'stl_file', 'scale_x', 'scale_y', 'scale_z', 'geometry_hash'].includes(key)) return false;
        } else if (shape === 'STL') {
            if (['size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height'].includes(key)) return false;
        }
    } else if (node.type === 'MPMObject2D') {
        const shape = node.parameters['shape_type'] || 'Rectangle';
        if (shape === 'Rectangle') {
            if (key === 'radius') return false;
        } else if (shape === 'Circle') {
            if (['size_x', 'size_y'].includes(key)) return false;
        }
    } else if (node.type === 'Charge2D') {
        const shape = node.parameters['charge_shape'] || 'Sphere';
        if (shape === 'Sphere' && key === 'charge_height') return false;
    } else if (node.type === 'Charge3D') {
        const shape = node.parameters['charge_shape'] || 'Sphere';
        if (shape === 'Sphere') {
            if (['charge_height', 'charge_lx', 'charge_ly', 'charge_lz'].includes(key)) return false;
        } else if (shape === 'Cylinder') {
            if (['charge_lx', 'charge_ly', 'charge_lz'].includes(key)) return false;
        } else if (shape === 'Block') {
            if (['charge_radius', 'charge_height'].includes(key)) return false;
        }
    } else if (node.type === 'Material') {
        const matType = node.parameters['material_type'] || 'Air';
        const airKeys = ['gamma', 'atm_pressure', 'atm_temperature'];
        const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
        const igKeys = ['ideal_gamma', 'ideal_rho_0', 'ideal_e_0'];

        if (matType === 'Air' && (jwlKeys.includes(key) || igKeys.includes(key))) return false;
        if (matType === 'JWL Charge' && (airKeys.includes(key) || igKeys.includes(key))) return false;
        if (matType === 'Ideal Gas Charge' && (airKeys.includes(key) || jwlKeys.includes(key))) return false;
    } else if (node.type === 'MPMMaterialSteel') {
        const matModel = node.parameters['material_model'] || 'Hypoelastic';
        const jcKeys = ['jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp', 'mg_gamma0', 'mg_c0', 'mg_s'];
        if (matModel === 'Hypoelastic' && jcKeys.includes(key)) return false;
    } else if (node.type === 'DomainMesh') {
        const dim = node.parameters['dimension'] || '1D';
        if (dim === '1D' && ['y_min_bc', 'y_max_bc', 'z_min_bc', 'z_max_bc'].includes(key)) return false;
        if (dim === '2D' && ['z_min_bc', 'z_max_bc'].includes(key)) return false;
    } else if (node.type === 'CFDSolver3D') {
        if (['stl_file', 'geometry_hash', 'mesh_type', 'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size'].includes(key)) return false;
    }

    return true;
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
            addMessage(painterNode.id, 'error', "No Air node connected to Initializer. A Material node (configured as Air) is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === airConn.fromNode);
            if (!fromNode || fromNode.type !== 'Material' || fromNode.parameters?.material_type !== 'Air') {
                const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                flawedConnections.set(connKey, "Only a Material node configured as Air can be connected to the Air input.");
                addMessage(painterNode.id, 'error', "Only a Material node configured as Air can be connected to the Air input.");
            }
        }

        // Explosive connection check
        const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
        if (!expConn) {
            addMessage(painterNode.id, 'warning', "No Explosive node connected to Initializer. Simulation will run with NO explosive charge.");
        } else {
            const expNode = state.nodes.find(n => n.id === expConn.fromNode);
            if (expNode) {
                if (expNode.type !== 'Charge1D') {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Only Charge1D node can be connected to the Explosive input of Initializer.");
                    addMessage(painterNode.id, 'error', "Only Charge1D node can be connected to the Explosive input of Initializer.");
                } else {
                    // Check if Charge1D has a Material node connected
                    const matConn = state.connections.find(c => c.toNode === expNode.id && c.toPort === 'material');
                    if (!matConn) {
                        addMessage(expNode.id, 'error', "No Material connected to Charge 1D.");
                    } else {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (!matNode || matNode.type !== 'Material') {
                            const connKey = `${matConn.fromNode}:${matConn.fromPort}->${matConn.toNode}:${matConn.toPort}`;
                            flawedConnections.set(connKey, "Only Material node can be connected to the Material input of Charge 1D.");
                            addMessage(expNode.id, 'error', "Only Material node can be connected to the Material input of Charge 1D.");
                        } else {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (initMode === 'Ideal Gas' && matType === 'JWL Charge') {
                                addMessage(expNode.id, 'warning', "Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'JWL Charge'. Connect an 'Ideal Gas Charge' instead.");
                            } else if (initMode === 'Multi-Material JWL' && matType === 'Ideal Gas Charge') {
                                addMessage(expNode.id, 'warning', "Solver physics is set to 'Multi-Material JWL', but explosive input is an 'Ideal Gas Charge'. Connect a 'JWL Charge' instead.");
                            }
                        }
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
                if (!remapNode || (remapNode.type !== 'RemapNode' && remapNode.type !== 'Remap1DTo2DNode')) {
                    const connKey = `${remapConn.fromNode}:${remapConn.fromPort}->${remapConn.toNode}:${remapConn.toPort}`;
                    flawedConnections.set(connKey, "Only RemapNode or Remap1DTo2DNode can be connected to the Remap input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only RemapNode or Remap1DTo2DNode can be connected to the Remap input of CFD Solver 2D.");
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
                addMessage(solver2D.id, 'error', "No Air node connected to CFD Solver 2D. A Material node configured as Air is required.");
            } else {
                const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                if (!airNode || airNode.type !== 'Material' || airNode.parameters?.material_type !== 'Air') {
                    const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                    flawedConnections.set(connKey, "Only a Material node configured as Air can be connected to the Air input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only a Material node configured as Air can be connected to the Air input of CFD Solver 2D.");
                }
            }

            // Explosive check
            let expConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'charge');
            if (!expConn) {
                expConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'explosive');
            }
            if (!expConn) {
                addMessage(solver2D.id, 'error', "No Explosive node connected to CFD Solver 2D. A Charge node (Charge2D or Charge1D) is required.");
            } else {
                const expNode = state.nodes.find(n => n.id === expConn.fromNode);
                if (!expNode || (expNode.type !== 'Charge2D' && expNode.type !== 'Charge1D')) {
                    const connKey = `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`;
                    flawedConnections.set(connKey, "Only Charge2D or Charge1D node can be connected to the Explosive input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only Charge2D or Charge1D node can be connected to the Explosive input of CFD Solver 2D.");
                } else {
                    // Check if Charge has a Material node connected
                    const matConn = state.connections.find(c => c.toNode === expNode.id && c.toPort === 'material');
                    if (!matConn) {
                        addMessage(expNode.id, 'error', "No Material connected to Charge.");
                    } else {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (!matNode || matNode.type !== 'Material') {
                            const connKey = `${matConn.fromNode}:${matConn.fromPort}->${matConn.toNode}:${matConn.toPort}`;
                            flawedConnections.set(connKey, "Only Material node can be connected to the Material input of Charge.");
                            addMessage(expNode.id, 'error', "Only Material node can be connected to the Material input of Charge.");
                        } else {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType !== 'JWL Charge') {
                                addMessage(expNode.id, 'error', "CFD Solver 2D in JWL mode requires a 'JWL Charge' material type connected to the Charge node.");
                            }
                        }
                    }
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
                addMessage(solver2D.id, 'error', "No Air node connected to CFD Solver 2D. A Material node configured as Air is required.");
            } else {
                const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                if (!airNode || airNode.type !== 'Material' || airNode.parameters?.material_type !== 'Air') {
                    const connKey = `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`;
                    flawedConnections.set(connKey, "Only a Material node configured as Air can be connected to the Air input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only a Material node configured as Air can be connected to the Air input of CFD Solver 2D.");
                }
            }

            // Ideal Gas check
            let igConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'charge');
            if (!igConn) {
                igConn = state.connections.find(c => c.toNode === solver2D.id && c.toPort === 'explosive');
            }
            if (!igConn) {
                addMessage(solver2D.id, 'error', "No Charge node connected to CFD Solver 2D. A Charge node (Charge2D or Charge1D) is required.");
            } else {
                const igNode = state.nodes.find(n => n.id === igConn.fromNode);
                if (!igNode || (igNode.type !== 'Charge2D' && igNode.type !== 'Charge1D')) {
                    const connKey = `${igConn.fromNode}:${igConn.fromPort}->${igConn.toNode}:${igConn.toPort}`;
                    flawedConnections.set(connKey, "Only Charge2D or Charge1D node can be connected to the Charge input of CFD Solver 2D.");
                    addMessage(solver2D.id, 'error', "Only Charge2D or Charge1D node can be connected to the Charge input of CFD Solver 2D.");
                } else {
                    // Check if Charge has a Material node connected
                    const matConn = state.connections.find(c => c.toNode === igNode.id && c.toPort === 'material');
                    if (!matConn) {
                        addMessage(igNode.id, 'error', "No Material connected to Charge.");
                    } else {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (!matNode || matNode.type !== 'Material') {
                            const connKey = `${matConn.fromNode}:${matConn.fromPort}->${matConn.toNode}:${matConn.toPort}`;
                            flawedConnections.set(connKey, "Only Material node can be connected to the Material input of Charge.");
                            addMessage(igNode.id, 'error', "Only Material node can be connected to the Material input of Charge.");
                        } else {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType !== 'Ideal Gas Charge') {
                                addMessage(igNode.id, 'error', "CFD Solver 2D in Ideal Gas mode requires an 'Ideal Gas Charge' material type connected to the Charge node.");
                            }
                        }
                    }
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
            const ignoredPorts = ['remap'];
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

    // --- 4. CFD Solver 3D Validation ---
    const solvers3D = state.nodes.filter(n => n.type === 'CFDSolver3D');
    solvers3D.forEach(solver3D => {
        // CFL validation
        const cfl = Number(solver3D.parameters?.cfl ?? 0.4);
        if (isNaN(cfl) || cfl <= 0 || cfl >= 1.0) {
            addMessage(solver3D.id, 'error', "CFL parameter must be between 0.0 and 1.0 (exclusive).");
        }

        // Mesh 3D connection check
        const meshConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'mesh');
        if (!meshConn3D) {
            addMessage(solver3D.id, 'error', "No Mesh node connected to CFD Solver 3D. A DomainMesh3D or RefinementMesh3D node is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
            if (!fromNode || (fromNode.type !== 'DomainMesh3D' && fromNode.type !== 'RefinementMesh3D')) {
                const connKey = `${meshConn3D.fromNode}:${meshConn3D.fromPort}->${meshConn3D.toNode}:${meshConn3D.toPort}`;
                flawedConnections.set(connKey, "Only DomainMesh3D or RefinementMesh3D node can be connected to the Mesh input of CFD Solver 3D.");
                addMessage(solver3D.id, 'error', "Only DomainMesh3D or RefinementMesh3D node can be connected to the Mesh input of CFD Solver 3D.");
            }
        }

        // Air connection check
        const airConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'air');
        if (!airConn3D) {
            addMessage(solver3D.id, 'error', "No Air node connected to CFD Solver 3D. A Material node (configured as Air) is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === airConn3D.fromNode);
            if (!fromNode || fromNode.type !== 'Material' || fromNode.parameters?.material_type !== 'Air') {
                const connKey = `${airConn3D.fromNode}:${airConn3D.fromPort}->${airConn3D.toNode}:${airConn3D.toPort}`;
                flawedConnections.set(connKey, "Only a Material node configured as Air can be connected to the Air input of CFD Solver 3D.");
                addMessage(solver3D.id, 'error', "Only a Material node configured as Air can be connected to the Air input of CFD Solver 3D.");
            }
        }

        const initMode3D = solver3D.parameters?.init_mode || 'From1D';

        if (initMode3D === 'From1D') {
            // Remap connection check
            const remapConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'remap');
            if (!remapConn3D) {
                addMessage(solver3D.id, 'error', "No Remap node connected to CFD Solver 3D. A Remap1DTo3DNode (or RemapNode) is required for From1D mode.");
            } else {
                const remapNode3D = state.nodes.find(n => n.id === remapConn3D.fromNode);
                if (!remapNode3D || (remapNode3D.type !== 'RemapNode' && remapNode3D.type !== 'Remap1DTo3DNode')) {
                    const connKey = `${remapConn3D.fromNode}:${remapConn3D.fromPort}->${remapConn3D.toNode}:${remapConn3D.toPort}`;
                    flawedConnections.set(connKey, "Only Remap1DTo3DNode (or RemapNode) can be connected to the Remap input of CFD Solver 3D in From1D mode.");
                    addMessage(solver3D.id, 'error', "Only Remap1DTo3DNode (or RemapNode) can be connected to the Remap input of CFD Solver 3D in From1D mode.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['charge', 'detonator'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver3D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver3D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'From1D'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 3D Init Mode is 'From1D'.`);
                    }
                }
            });

        } else if (initMode3D === 'From2D') {
            // Remap 2D->3D connection check
            const remapConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'remap');
            if (!remapConn3D) {
                addMessage(solver3D.id, 'error', "No Remap node connected to CFD Solver 3D. A Remap2DTo3DNode is required for From2D mode.");
            } else {
                const remapNode3D = state.nodes.find(n => n.id === remapConn3D.fromNode);
                if (!remapNode3D || remapNode3D.type !== 'Remap2DTo3DNode') {
                    const connKey = `${remapConn3D.fromNode}:${remapConn3D.fromPort}->${remapConn3D.toNode}:${remapConn3D.toPort}`;
                    flawedConnections.set(connKey, "Only Remap2DTo3DNode can be connected to the Remap input of CFD Solver 3D in From2D mode.");
                    addMessage(solver3D.id, 'error', "Only Remap2DTo3DNode can be connected to the Remap input of CFD Solver 3D in From2D mode.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['charge', 'detonator'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver3D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver3D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'From2D'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 3D Init Mode is 'From2D'.`);
                    }
                }
            });

        } else if (initMode3D === 'Multi-Material JWL') {
            // Charge 3D connection check
            const chargeConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'charge');
            if (!chargeConn3D) {
                addMessage(solver3D.id, 'error', "No Charge node connected to CFD Solver 3D. A Charge3D node is required for Multi-Material JWL mode.");
            } else {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (!chargeNode3D || chargeNode3D.type !== 'Charge3D') {
                    const connKey = `${chargeConn3D.fromNode}:${chargeConn3D.fromPort}->${chargeConn3D.toNode}:${chargeConn3D.toPort}`;
                    flawedConnections.set(connKey, "Only Charge3D node can be connected to the Charge input of CFD Solver 3D.");
                    addMessage(solver3D.id, 'error', "Only Charge3D node can be connected to the Charge input of CFD Solver 3D.");
                } else {
                    const matConn = state.connections.find(c => c.toNode === chargeNode3D.id && c.toPort === 'material');
                    if (!matConn) {
                        addMessage(chargeNode3D.id, 'error', "No Material connected to Charge 3D.");
                    } else {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (!matNode || matNode.type !== 'Material') {
                            const connKey = `${matConn.fromNode}:${matConn.fromPort}->${matConn.toNode}:${matConn.toPort}`;
                            flawedConnections.set(connKey, "Only Material node can be connected to the Material input of Charge 3D.");
                            addMessage(chargeNode3D.id, 'error', "Only Material node can be connected to the Material input of Charge 3D.");
                        } else {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType !== 'JWL Charge') {
                                addMessage(chargeNode3D.id, 'error', "CFD Solver 3D in JWL mode requires a 'JWL Charge' material type connected to the Charge node.");
                            }
                        }
                    }
                }
            }

            // Detonator connection check
            const detConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'detonator');
            if (!detConn3D) {
                addMessage(solver3D.id, 'error', "No Detonator node connected to CFD Solver 3D. A DetonatorLocation3D node is required for Multi-Material JWL mode.");
            } else {
                const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
                if (!detNode3D || detNode3D.type !== 'DetonatorLocation3D') {
                    const connKey = `${detConn3D.fromNode}:${detConn3D.fromPort}->${detConn3D.toNode}:${detConn3D.toPort}`;
                    flawedConnections.set(connKey, "Only DetonatorLocation3D node can be connected to the Detonator input of CFD Solver 3D.");
                    addMessage(solver3D.id, 'error', "Only DetonatorLocation3D node can be connected to the Detonator input of CFD Solver 3D.");
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['remap'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver3D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver3D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'Multi-Material JWL'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 3D Init Mode is 'Multi-Material JWL'.`);
                    }
                }
            });

        } else if (initMode3D === 'Ideal Gas') {
            // Charge 3D connection check
            const chargeConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'charge');
            if (!chargeConn3D) {
                addMessage(solver3D.id, 'error', "No Charge node connected to CFD Solver 3D. A Charge3D node is required for Ideal Gas mode.");
            } else {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (!chargeNode3D || chargeNode3D.type !== 'Charge3D') {
                    const connKey = `${chargeConn3D.fromNode}:${chargeConn3D.fromPort}->${chargeConn3D.toNode}:${chargeConn3D.toPort}`;
                    flawedConnections.set(connKey, "Only Charge3D node can be connected to the Charge input of CFD Solver 3D.");
                    addMessage(solver3D.id, 'error', "Only Charge3D node can be connected to the Charge input of CFD Solver 3D.");
                } else {
                    const matConn = state.connections.find(c => c.toNode === chargeNode3D.id && c.toPort === 'material');
                    if (!matConn) {
                        addMessage(chargeNode3D.id, 'error', "No Material connected to Charge 3D.");
                    } else {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (!matNode || matNode.type !== 'Material') {
                            const connKey = `${matConn.fromNode}:${matConn.fromPort}->${matConn.toNode}:${matConn.toPort}`;
                            flawedConnections.set(connKey, "Only Material node can be connected to the Material input of Charge 3D.");
                            addMessage(chargeNode3D.id, 'error', "Only Material node can be connected to the Material input of Charge 3D.");
                        } else {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType !== 'Ideal Gas Charge') {
                                addMessage(chargeNode3D.id, 'error', "CFD Solver 3D in Ideal Gas mode requires an 'Ideal Gas Charge' material type connected to the Charge node.");
                            }
                        }
                    }
                }
            }

            // Ignored inputs warning
            const ignoredPorts = ['remap', 'detonator'];
            ignoredPorts.forEach(port => {
                const conn = state.connections.find(c => c.toNode === solver3D.id && c.toPort === port);
                if (conn) {
                    addMessage(solver3D.id, 'warning', `Input connected to '${port}' port is ignored when Init Mode is 'Ideal Gas'.`);
                    const connectedNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (connectedNode) {
                        addMessage(connectedNode.id, 'warning', `This node is ignored because the connected CFD Solver 3D Init Mode is 'Ideal Gas'.`);
                    }
                }
            });
        }

        // STL Geometry connection check
        const stlConn3D = state.connections.find(c => c.toNode === solver3D.id && c.toPort === 'stl');
        if (stlConn3D) {
            const stlNode3D = state.nodes.find(n => n.id === stlConn3D.fromNode);
            if (!stlNode3D || (stlNode3D.type !== 'STLGeometry' && stlNode3D.type !== 'PrimitiveGeometry3D')) {
                const connKey = `${stlConn3D.fromNode}:${stlConn3D.fromPort}->${stlConn3D.toNode}:${stlConn3D.toPort}`;
                flawedConnections.set(connKey, "Only STLGeometry or PrimitiveGeometry3D node can be connected to the STL input of CFD Solver 3D.");
                addMessage(solver3D.id, 'error', "Only STLGeometry or PrimitiveGeometry3D node can be connected to the STL input of CFD Solver 3D.");
            }
        }
    });

    // --- 5. Validation of Individual Nodes & Parameters ---
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
            const cell_size = Number(node.parameters?.cell_size ?? 0.005);
            const max_r = Number(node.parameters?.max_r ?? 1.0);
            const max_z = Number(node.parameters?.max_z ?? 1.0);

            if (isNaN(cell_size) || cell_size <= 0) {
                addMessage(node.id, 'error', "Mesh Cell Size must be greater than 0.");
            }
            if (isNaN(max_r) || max_r <= 0) {
                addMessage(node.id, 'error', "Mesh dimension R (max_r) must be greater than 0.");
            }
            if (isNaN(max_z) || max_z <= 0) {
                addMessage(node.id, 'error', "Mesh dimension Z (max_z) must be greater than 0.");
            }

            const coordSys = node.parameters?.coordinate_system || 'Axisymmetric';
            const bcRmin = node.parameters?.bc_r_min || 'Reflecting';
            if (coordSys === 'Axisymmetric' && bcRmin !== 'Reflecting') {
                addMessage(node.id, 'error', "In Axisymmetric coordinate system, the R-Min boundary (centerline r=0) must be Reflecting.");
            }
        }

        if (node.type === 'MPMDomain2D') {
            const meshConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'mesh');
            if (!meshConn) {
                addMessage(node.id, 'error', "No Mesh node connected to MPM Domain 2D. A DomainMesh2D node is required.");
            }
            const objConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'objects');
            if (!objConn) {
                addMessage(node.id, 'error', "No MPM Object 2D connected to MPM Domain 2D. At least one MPM Object node is required.");
            }
        }

        if (node.type === 'MPMDomain3D') {
            const meshConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'mesh');
            if (!meshConn) {
                addMessage(node.id, 'error', "No Mesh node connected to MPM Domain 3D. A DomainMesh3D node is required.");
            }
            const objConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'objects');
            if (!objConn) {
                addMessage(node.id, 'error', "No MPM Object 3D connected to MPM Domain 3D. At least one MPM Object node is required.");
            }
        }

        if (node.type === 'FEMDomain3D') {
            const meshConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'mesh');
            if (meshConn) {
                const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (meshNode && meshNode.type !== 'DomainMesh3D') {
                    addMessage(node.id, 'error', "Only DomainMesh3D can be connected to the Hex Mesh input of FEM Domain 3D.");
                }
            }
            const objConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'objects');
            if (!objConn) {
                addMessage(node.id, 'error', "No FEM Object connected to FEM Domain 3D. At least one FEM Object 3D or LS-DYNA Importer node is required.");
            }
        }

        if (node.type === 'FEMObject3D') {
            const matConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'material');
            if (!matConn) {
                addMessage(node.id, 'error', "No Material connected to FEM Object 3D.");
            }
            const outConn = state.connections.find(c => c.fromNode === node.id);
            if (!outConn) {
                addMessage(node.id, 'warning', "FEM Object 3D is not connected to a FEM Domain 3D node.");
            }
            const meshSource = node.parameters['mesh_source'] || 'Box Generator';
            const shape = node.parameters['shape_type'] || 'Box';
            if (meshSource === 'Cylinder Generator' || shape === 'Cylinder') {
                const radius = Number(node.parameters['radius'] ?? 0.1);
                const innerRadius = Number(node.parameters['inner_radius'] ?? 0.0);
                const height = Number(node.parameters['height'] ?? 0.2);
                const nx = Number(node.parameters['nx'] ?? 10);
                const nz = Number(node.parameters['nz'] ?? 10);
                if (isNaN(radius) || radius <= 0) addMessage(node.id, 'error', "Cylinder radius must be greater than 0.");
                if (isNaN(innerRadius) || innerRadius < 0) addMessage(node.id, 'error', "Cylinder inner radius cannot be negative.");
                if (innerRadius >= radius) addMessage(node.id, 'error', "Cylinder inner radius must be smaller than outer radius.");
                if (isNaN(height) || height <= 0) addMessage(node.id, 'error', "Cylinder height must be greater than 0.");
                if (isNaN(nx) || nx < 1) addMessage(node.id, 'error', "Nodal resolution NX (NR) must be at least 1.");
                if (isNaN(nz) || nz < 1) addMessage(node.id, 'error', "Nodal resolution NZ must be at least 1.");
            } else if (meshSource === 'Box Generator' || shape === 'Box') {
                const sx = Number(node.parameters['size_x'] ?? 1.0);
                const sy = Number(node.parameters['size_y'] ?? 1.0);
                const sz = Number(node.parameters['size_z'] ?? 1.0);
                const nx = Number(node.parameters['nx'] ?? 10);
                const ny = Number(node.parameters['ny'] ?? 10);
                const nz = Number(node.parameters['nz'] ?? 10);
                if (isNaN(sx) || sx <= 0) addMessage(node.id, 'error', "Box size_x must be greater than 0.");
                if (isNaN(sy) || sy <= 0) addMessage(node.id, 'error', "Box size_y must be greater than 0.");
                if (isNaN(sz) || sz <= 0) addMessage(node.id, 'error', "Box size_z must be greater than 0.");
                if (isNaN(nx) || nx < 1) addMessage(node.id, 'error', "Grid division NX must be at least 1.");
                if (isNaN(ny) || ny < 1) addMessage(node.id, 'error', "Grid division NY must be at least 1.");
                if (isNaN(nz) || nz < 1) addMessage(node.id, 'error', "Grid division NZ must be at least 1.");
            } else if (meshSource === 'LS-DYNA Keyword File' || shape === 'LS-DYNA File') {
                const kFile = node.parameters['k_file'] || '';
                const impConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'importer');
                if (!kFile && !impConn) {
                    addMessage(node.id, 'error', "LS-DYNA mesh source requires specifying a .k file path or connecting an LS-DYNA Importer node.");
                }
            }
        }

        if (node.type === 'FEMFSICoupler3D') {
            const cfdConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver'));
            if (!cfdConn) {
                addMessage(node.id, 'error', "No CFD Solver 3D connected to FEM-CFD FSI Coupler 3D.");
            }
            const femConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'fem' || c.toPort === 'fem_domain' || c.toPort === 'fem_solver'));
            if (!femConn) {
                addMessage(node.id, 'error', "No FEM Domain 3D connected to FEM-CFD FSI Coupler 3D.");
            }
        }

        if (node.type === 'MPMObject2D') {
            const matConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'material');
            if (!matConn) {
                addMessage(node.id, 'error', "No Material connected to MPM Object 2D. A Material or Solid Material node is required.");
            }
            const outConn = state.connections.find(c => c.fromNode === node.id);
            if (!outConn) {
                addMessage(node.id, 'warning', "MPM Object 2D is not connected to an MPM Domain 2D node.");
            }
        }

        if (node.type === 'MPMObject3D') {
            const matConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'material');
            if (!matConn) {
                addMessage(node.id, 'error', "No Material connected to MPM Object 3D. A Material or Solid Material node is required.");
            }
            const outConn = state.connections.find(c => c.fromNode === node.id);
            if (!outConn) {
                addMessage(node.id, 'warning', "MPM Object 3D is not connected to an MPM Domain 3D node.");
            }
            const shape = node.parameters?.shape_type || 'Box';
            if (shape === 'STL') {
                const stlConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'stl');
                const stlFile = node.parameters?.stl_file;
                if (!stlConn && (!stlFile || String(stlFile).trim() === '')) {
                    addMessage(node.id, 'error', "MPM Object 3D with STL shape requires an STL file specified or an STLGeometry node connected.");
                }
            } else if (shape === 'Cylinder') {
                const radius = Number(node.parameters?.radius ?? 0.1);
                const innerRadius = Number(node.parameters?.inner_radius ?? 0.0);
                const height = Number(node.parameters?.height ?? 0.2);
                if (isNaN(radius) || radius <= 0) {
                    addMessage(node.id, 'error', "Cylinder radius must be greater than 0.");
                }
                if (isNaN(innerRadius) || innerRadius < 0 || innerRadius >= radius) {
                    addMessage(node.id, 'error', "Cylinder inner radius must be non-negative and less than outer radius.");
                }
                if (isNaN(height) || height <= 0) {
                    addMessage(node.id, 'error', "Cylinder height must be greater than 0.");
                }
            }
        }

        if (node.type === 'Material') {
            const matType = node.parameters?.material_type || 'Air';
            if (matType === 'Air') {
                const gamma = Number(node.parameters?.gamma ?? 1.4);
                const atm_pressure = Number(node.parameters?.atm_pressure ?? 101325);
                const atm_temperature = Number(node.parameters?.atm_temperature ?? 288.0);

                if (isNaN(gamma) || gamma <= 1.0) {
                    addMessage(node.id, 'error', "Air adiabatic index (gamma) must be greater than 1.0.");
                }
                if (isNaN(atm_pressure) || atm_pressure <= 0) {
                    addMessage(node.id, 'error', "Atmospheric Pressure must be greater than 0.");
                }
                if (isNaN(atm_temperature) || atm_temperature <= 0) {
                    addMessage(node.id, 'error', "Atmospheric Temperature (Kelvin) must be greater than 0.");
                }
            } else if (matType === 'JWL Charge') {
                const rho = Number(node.parameters?.rho ?? 1630);
                const detonation_energy = Number(node.parameters?.detonation_energy ?? 4290000);
                if (isNaN(rho) || rho <= 0) {
                    addMessage(node.id, 'error', "Explosive density (rho) must be greater than 0.");
                }
                if (isNaN(detonation_energy) || detonation_energy <= 0) {
                    addMessage(node.id, 'error', "Detonation energy must be greater than 0.");
                }
            } else if (matType === 'Ideal Gas Charge') {
                const ideal_gamma = Number(node.parameters?.ideal_gamma ?? 1.4);
                const ideal_rho_0 = Number(node.parameters?.ideal_rho_0 ?? 1630.0);
                const ideal_e_0 = Number(node.parameters?.ideal_e_0 ?? 4290000);
                if (isNaN(ideal_gamma) || ideal_gamma <= 1.0) {
                    addMessage(node.id, 'error', "Ideal Gas Charge adiabatic index (gamma) must be greater than 1.0.");
                }
                if (isNaN(ideal_rho_0) || ideal_rho_0 <= 0) {
                    addMessage(node.id, 'error', "Ideal Gas Charge density (rho) must be greater than 0.");
                }
                if (isNaN(ideal_e_0) || ideal_e_0 <= 0) {
                    addMessage(node.id, 'error', "Ideal Gas Charge specific energy must be greater than 0.");
                }
            }
        }

        if (node.type === 'Charge2D') {
            const shape = node.parameters?.charge_shape || 'Sphere';
            const charge_r = Number(node.parameters?.charge_r ?? 0.0);
            const charge_z = Number(node.parameters?.charge_z ?? 0.1);
            const charge_radius = Number(node.parameters?.charge_radius ?? 0.05);
            const charge_height = Number(node.parameters?.charge_height ?? 0.1);
            const charge_mass = Number(node.parameters?.charge_mass ?? 0.0);

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
            if (isNaN(charge_mass) || charge_mass <= 0) {
                addMessage(node.id, 'error', "Charge mass must be greater than 0.");
            }
        }

        if (node.type === 'Charge1D') {
            const charge_radius = Number(node.parameters?.charge_radius ?? 0.05);
            const charge_mass = Number(node.parameters?.charge_mass ?? 0.0);
            if (isNaN(charge_radius) || charge_radius <= 0) {
                addMessage(node.id, 'error', "Charge radius must be greater than 0.");
            }
            if (isNaN(charge_mass) || charge_mass <= 0) {
                addMessage(node.id, 'error', "Charge mass must be greater than 0.");
            }
        }

        if (node.type === 'DetonatorLocation') {
            const detConn = state.connections.find(c => c.fromNode === node.id && c.fromPort === 'detonator');
            const det_radius = Number(node.parameters?.detonator_radius !== undefined ? node.parameters.detonator_radius : (node.parameters.explosive_radius ?? 0.001));
            const det_z = Number(node.parameters?.detonator_z !== undefined ? node.parameters.detonator_z : (node.parameters.explosive_z ?? 0.0));
            const det_r = Number(node.parameters?.detonator_r !== undefined ? node.parameters.detonator_r : (node.parameters.explosive_r ?? 0.0));

            if (isNaN(det_radius) || det_radius <= 0) {
                addMessage(node.id, 'error', "Detonator radius must be greater than 0.");
            }

            // Cross-validation with connected mesh
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

        if (node.type === 'DetonatorLocation3D') {
            const detConn = state.connections.find(c => c.fromNode === node.id && c.fromPort === 'detonator');
            const detX = Number(node.parameters?.detonator_x ?? 0.5);
            const detY = Number(node.parameters?.detonator_y ?? 0.5);
            const detZ = Number(node.parameters?.detonator_z ?? 0.5);

            // Cross-validation with connected mesh
            if (detConn) {
                const connectedSolver = state.nodes.find(n => n.id === detConn.toNode);
                if (connectedSolver && connectedSolver.type === 'CFDSolver3D') {
                    const meshConn3D = state.connections.find(c => c.toNode === connectedSolver.id && c.toPort === 'mesh');
                    if (meshConn3D) {
                        const meshNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                        if (meshNode && meshNode.type === 'DomainMesh3D') {
                            const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
                            const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
                            const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
                            const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
                            const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                            const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

                            if (detX < xmin || detX > xmax) {
                                addMessage(node.id, 'warning', `Detonator position (x = ${detX}) is outside the mesh domain [${xmin}, ${xmax}].`);
                            }
                            if (detY < ymin || detY > ymax) {
                                addMessage(node.id, 'warning', `Detonator position (y = ${detY}) is outside the mesh domain [${ymin}, ${ymax}].`);
                            }
                            if (detZ < zmin || detZ > zmax) {
                                addMessage(node.id, 'warning', `Detonator position (z = ${detZ}) is outside the mesh domain [${zmin}, ${zmax}].`);
                            }
                        }
                    }
                }
            }
        }

        if (node.type === 'RemapNode' || node.type === 'Remap1DTo2DNode' || node.type === 'Remap1DTo3DNode') {
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
                    flawedConnections.set(connKey, "Only 1D CFD Solver can be connected to the input of this Remap node.");
                    addMessage(node.id, 'error', "Only 1D CFD Solver can be connected to the input of this Remap node.");
                }
            }
        }

        if (node.type === 'Remap2DTo3DNode') {
            const remap_radius = Number(node.parameters?.remap_radius ?? 0.5);
            if (isNaN(remap_radius) || remap_radius <= 0) {
                addMessage(node.id, 'error', "Remap radius must be greater than 0.");
            }

            // Connection checks
            const inConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
            if (!inConn) {
                addMessage(node.id, 'error', "Remap 2D->3D node is not connected to a 2D CFD Solver.");
            } else {
                const fromNode = state.nodes.find(n => n.id === inConn.fromNode);
                if (!fromNode || fromNode.type !== 'CFDSolver2D') {
                    const connKey = `${inConn.fromNode}:${inConn.fromPort}->${inConn.toNode}:${inConn.toPort}`;
                    flawedConnections.set(connKey, "Only 2D CFD Solver (CFDSolver2D) can be connected to the input of Remap 2D->3D node.");
                    addMessage(node.id, 'error', "Only 2D CFD Solver (CFDSolver2D) can be connected to the input of Remap 2D->3D node.");
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

        if (node.type === 'Charge3D') {
            const shape = node.parameters?.charge_shape || 'Sphere';
            const cx = Number(node.parameters?.charge_x ?? 0.5);
            const cy = Number(node.parameters?.charge_y ?? 0.5);
            const cz = Number(node.parameters?.charge_z ?? 0.5);
            const charge_radius = Number(node.parameters?.charge_radius ?? 0.1);
            const charge_lx = Number(node.parameters?.charge_lx ?? 0.2);
            const charge_ly = Number(node.parameters?.charge_ly ?? 0.2);
            const charge_lz = Number(node.parameters?.charge_lz ?? 0.2);
            const charge_mass = Number(node.parameters?.charge_mass ?? 0.0);

            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) {
                addMessage(node.id, 'error', "Charge coordinates must be numeric.");
            }
            if (shape === 'Sphere' && (isNaN(charge_radius) || charge_radius <= 0)) {
                addMessage(node.id, 'error', "Charge radius must be greater than 0 for spherical charges.");
            }
            if (shape === 'Block' && (isNaN(charge_lx) || charge_lx <= 0 || isNaN(charge_ly) || charge_ly <= 0 || isNaN(charge_lz) || charge_lz <= 0)) {
                addMessage(node.id, 'error', "Block dimensions LX, LY, LZ must be greater than 0.");
            }
            if (shape === 'Cylinder' && (isNaN(charge_radius) || charge_radius <= 0 || isNaN(node.parameters?.charge_height) || Number(node.parameters.charge_height) <= 0)) {
                addMessage(node.id, 'error', "Cylinder radius and height must be greater than 0.");
            }
            if (isNaN(charge_mass) || charge_mass <= 0) {
                addMessage(node.id, 'error', "Charge mass must be greater than 0.");
            }

            // Cross-validation with connected mesh
            const chargeConn = state.connections.find(c => c.fromNode === node.id && c.fromPort === 'out');
            if (chargeConn) {
                const connectedSolver = state.nodes.find(n => n.id === chargeConn.toNode);
                if (connectedSolver && connectedSolver.type === 'CFDSolver3D') {
                    const meshConn3D = state.connections.find(c => c.toNode === connectedSolver.id && c.toPort === 'mesh');
                    if (meshConn3D) {
                        const meshNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                        if (meshNode && meshNode.type === 'DomainMesh3D') {
                            const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
                            const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
                            const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
                            const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
                            const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                            const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

                            if (cx < xmin || cx > xmax || cy < ymin || cy > ymax || cz < zmin || cz > zmax) {
                                addMessage(node.id, 'warning', `Charge center (${cx}, ${cy}, ${cz}) is outside the mesh domain.`);
                            }
                        }
                    }
                }
            }
        }

        if (node.type === 'VirtualGauges') {
            const gauges = node.parameters?.gauges || [];
            
            // Connection checks
            const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
            if (conn) {
                const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                if (fromNode) {
                    if (fromNode.type === 'CFDSolver3D') {
                        const meshConn3D = state.connections.find(c => c.toNode === fromNode.id && c.toPort === 'mesh');
                        if (meshConn3D) {
                            const meshNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                            if (meshNode && meshNode.type === 'DomainMesh3D') {
                                const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
                                const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
                                const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
                                const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
                                const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                                const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

                                gauges.forEach((g: any) => {
                                    const gx = Number(g.x ?? 0.5);
                                    const gy = Number(g.y ?? 0.5);
                                    const gz = Number(g.z ?? 0.5);
                                    const name = g.name || g.id || "Unnamed";

                                    if (gx < xmin || gx > xmax) {
                                        addMessage(node.id, 'warning', `Gauge "${name}" position (x = ${gx}) is outside the mesh domain [${xmin}, ${xmax}].`);
                                    }
                                    if (gy < ymin || gy > ymax) {
                                        addMessage(node.id, 'warning', `Gauge "${name}" position (y = ${gy}) is outside the mesh domain [${ymin}, ${ymax}].`);
                                    }
                                    if (gz < zmin || gz > zmax) {
                                        addMessage(node.id, 'warning', `Gauge "${name}" position (z = ${gz}) is outside the mesh domain [${zmin}, ${zmax}].`);
                                    }
                                });
                            }
                        }
                    } else if (fromNode.type === 'CFDSolver2D') {
                        const meshConn2D = state.connections.find(c => c.toNode === fromNode.id && c.toPort === 'mesh');
                        if (meshConn2D) {
                            const meshNode = state.nodes.find(n => n.id === meshConn2D.fromNode);
                            if (meshNode && meshNode.type === 'DomainMesh2D') {
                                const maxR = Number(meshNode.parameters?.max_r ?? 1.0);
                                const maxZ = Number(meshNode.parameters?.max_z ?? 1.0);

                                gauges.forEach((g: any) => {
                                    const gr = Number(g.r ?? 0.1);
                                    const gz = Number(g.z ?? 0.0);
                                    const name = g.name || g.id || "Unnamed";

                                    if (gr < 0 || gr > maxR) {
                                        addMessage(node.id, 'warning', `Gauge "${name}" position (r = ${gr}) is outside the mesh domain [0, ${maxR}].`);
                                    }
                                    if (gz < 0 || gz > maxZ) {
                                        addMessage(node.id, 'warning', `Gauge "${name}" position (z = ${gz}) is outside the mesh domain [0, ${maxZ}].`);
                                    }
                                });
                            }
                        }
                    } else if (fromNode.type === 'CFDSolver') {
                        const meshNode = state.nodes.find(n => n.type === 'DomainMesh');
                        if (meshNode) {
                            const radius = Number(meshNode.parameters?.domain_radius ?? 1.0);
                            gauges.forEach((g: any) => {
                                const gr = Number(g.r ?? 0.1);
                                const name = g.name || g.id || "Unnamed";

                                if (gr < 0 || gr > radius) {
                                    addMessage(node.id, 'warning', `Gauge "${name}" position (r = ${gr}) is outside the mesh domain [0, ${radius}].`);
                                }
                            });
                        }
                    }
                }
            }
        }

        if (node.type === 'TelemetryContour') {
            const connList = state.connections.filter(c => c.toNode === node.id);
            if (connList.length === 0) {
                addMessage(node.id, 'warning', "Not connected to any 2D CFD Solver, MPM Domain, or FSI Coupler. No data will be received.");
            } else {
                connList.forEach(conn => {
                    const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (!fromNode || (fromNode.type !== 'CFDSolver2D' && fromNode.type !== 'MPMDomain2D' && fromNode.type !== 'FSICoupler2D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "TelemetryContour requires a 2D CFD Solver, 2D MPM Domain, or FSI Coupler 2D source.");
                        addMessage(node.id, 'error', "TelemetryContour requires a 2D CFD Solver, 2D MPM Domain, or FSI Coupler 2D source.");
                    }
                });
            }
        } else if (node.type === 'TelemetryText') {
            const connList = state.connections.filter(c => c.toNode === node.id);
            if (connList.length === 0) {
                addMessage(node.id, 'warning', "Not connected to any solver. No data will be received.");
            } else {
                connList.forEach(conn => {
                    const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                    const solverTypes = ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MPMDomain2D', 'MPMDomain3D', 'FSICoupler2D', 'FSICoupler3D', 'FEMDomain3D', 'FEMFSICoupler3D'];
                    if (!fromNode || !solverTypes.includes(fromNode.type)) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "TelemetryText must be connected to a solver or coupler source.");
                        addMessage(node.id, 'error', "TelemetryText must be connected to a solver or coupler source.");
                    }
                });
            }
        } else if (node.type === 'TelemetryGraph' || node.type === 'VTKOutput' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport') {
            const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
            if (!conn) {
                addMessage(node.id, 'warning', `Not connected to any solver. No data will be received.`);
            } else {
                const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                if (node.type === 'Telemetry3DViewport') {
                    if (!fromNode || (fromNode.type !== 'CFDSolver3D' && fromNode.type !== 'MPMDomain3D' && fromNode.type !== 'FSICoupler3D' && fromNode.type !== 'FEMDomain3D' && fromNode.type !== 'FEMFSICoupler3D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, `${node.type} requires a 3D Solver or Coupler source.`);
                        addMessage(node.id, 'error', `${node.type} requires a 3D Solver or Coupler source.`);
                    }
                } else if (node.type === 'TelemetryGraph' || node.type === 'VirtualGauges') {
                    if (!fromNode || (fromNode.type !== 'CFDSolver' && fromNode.type !== 'CFDSolver2D' && fromNode.type !== 'CFDSolver3D' && fromNode.type !== 'MPMDomain2D' && fromNode.type !== 'MPMDomain3D' && fromNode.type !== 'FSICoupler2D' && fromNode.type !== 'FSICoupler3D' && fromNode.type !== 'FEMDomain3D' && fromNode.type !== 'FEMFSICoupler3D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, `${node.type} must be connected to a solver.`);
                        addMessage(node.id, 'error', `${node.type} must be connected to a solver.`);
                    }
                } else {
                    if (!fromNode || (fromNode.type !== 'CFDSolver' && fromNode.type !== 'CFDSolver2D' && fromNode.type !== 'CFDSolver3D' && fromNode.type !== 'MPMDomain2D' && fromNode.type !== 'MPMDomain3D' && fromNode.type !== 'FSICoupler2D' && fromNode.type !== 'FSICoupler3D' && fromNode.type !== 'FEMDomain3D' && fromNode.type !== 'FEMFSICoupler3D')) {
                        const connKey = `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`;
                        flawedConnections.set(connKey, "Telemetry/Output must be connected to a solver.");
                        addMessage(node.id, 'error', "Telemetry/Output must be connected to a solver.");
                    }
                }
            }
        }
    });

    // DomainMesh3D validation
    state.nodes.filter(n => n.type === 'DomainMesh3D').forEach(mesh3D => {
        const cellSize = Number(mesh3D.parameters?.cell_size || 0.01);
        const xmin = Number(mesh3D.parameters?.xmin ?? 0.0);
        const xmax = Number(mesh3D.parameters?.xmax ?? 1.0);
        const ymin = Number(mesh3D.parameters?.ymin ?? 0.0);
        const ymax = Number(mesh3D.parameters?.ymax ?? 1.0);
        const zmin = Number(mesh3D.parameters?.zmin ?? 0.0);
        const zmax = Number(mesh3D.parameters?.zmax ?? 1.0);
        const dimX = xmax - xmin;
        const dimY = ymax - ymin;
        const dimZ = zmax - zmin;

        if (isNaN(cellSize) || cellSize <= 0) {
            addMessage(mesh3D.id, 'error', "Mesh Cell Size must be greater than 0.");
        }
        if (isNaN(dimX) || dimX <= 0) {
            addMessage(mesh3D.id, 'error', "Mesh dimension X (xmax - xmin) must be greater than 0.");
        }
        if (isNaN(dimY) || dimY <= 0) {
            addMessage(mesh3D.id, 'error', "Mesh dimension Y (ymax - ymin) must be greater than 0.");
        }
        if (cellSize >= dimX || cellSize >= dimY || cellSize >= dimZ) {
            addMessage(mesh3D.id, 'error', "Mesh Cell Size must be smaller than domain dimensions.");
        }
    });

    // RefinementMesh3D validation
    state.nodes.filter(n => n.type === 'RefinementMesh3D').forEach(refMesh3D => {
        const parentConn = state.connections.find(c => c.toNode === refMesh3D.id && c.toPort === 'parent_mesh');
        if (!parentConn) {
            addMessage(refMesh3D.id, 'error', "No Parent Mesh connected to RefinementMesh3D. A DomainMesh3D or parent RefinementMesh3D node is required.");
        } else {
            const fromNode = state.nodes.find(n => n.id === parentConn.fromNode);
            if (!fromNode || (fromNode.type !== 'DomainMesh3D' && fromNode.type !== 'RefinementMesh3D')) {
                const connKey = `${parentConn.fromNode}:${parentConn.fromPort}->${parentConn.toNode}:${parentConn.toPort}`;
                flawedConnections.set(connKey, "Only DomainMesh3D or RefinementMesh3D node can be connected to the Parent Mesh input of RefinementMesh3D.");
                addMessage(refMesh3D.id, 'error', "Only DomainMesh3D or RefinementMesh3D node can be connected to the Parent Mesh input of RefinementMesh3D.");
            }
        }

        const sizeX = Number(refMesh3D.parameters?.submesh_size_x ?? 0.5);
        const sizeY = Number(refMesh3D.parameters?.submesh_size_y ?? 0.5);
        const sizeZ = Number(refMesh3D.parameters?.submesh_size_z ?? 0.5);
        if (isNaN(sizeX) || sizeX <= 0) {
            addMessage(refMesh3D.id, 'error', "Submesh Size X must be greater than 0.");
        }
        if (isNaN(sizeY) || sizeY <= 0) {
            addMessage(refMesh3D.id, 'error', "Submesh Size Y must be greater than 0.");
        }
        if (isNaN(sizeZ) || sizeZ <= 0) {
            addMessage(refMesh3D.id, 'error', "Submesh Size Z must be greater than 0.");
        }
    });



    // Generic validation check for missing/not-provided parameters
    state.nodes.forEach(node => {
        if (node.parameters) {
            for (const [key, value] of Object.entries(node.parameters)) {
                if (!isParameterRelevant(node, key)) {
                    continue;
                }
                if (value === undefined || value === null || value === "" || (typeof value === 'number' && isNaN(value))) {
                    addMessage(node.id, 'warning', `Parameter '${key.replace(/_/g, ' ').toUpperCase()}' is not provided.`);
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
