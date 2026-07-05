import { SimulationState } from './types.js';

export function serializeSimulationState(state: SimulationState): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);
    const dag = {
        nodes: strippedNodes,
        connections: state.connections
    };
    return JSON.stringify({
        command: "EXECUTE",
        dag: dag
    });
}

export function serializeForSolver(state: SimulationState, command: string = "INIT", modelId?: string): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    const numericKeys = [
        'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
        'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
        'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'output_interval',
        'spatial_order', 'temporal_order',
        'n_cells', 'gamma', 'explosive_radius', 'ambient_rho',
        // 2D CFD keys
        'nr', 'nz', 'max_r', 'max_z', 'explosive_z', 'explosive_r', 'remap_radius', 'trigger_value',
        'charge_r', 'charge_z', 'charge_radius', 'charge_height',
        'detonator_r', 'detonator_z', 'detonator_radius'
    ];

    const flattenedParams: Record<string, any> = {};

    // 1. Trace 1D Solver if it exists
    const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
    if (solverNode) {
        Object.entries(solverNode.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        const solverConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'in');
        if (solverConn) {
            const painterNode = state.nodes.find(n => n.id === solverConn.fromNode);
            if (painterNode && painterNode.type === 'ThePainter') {
                const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
                if (meshConn) {
                    const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                    if (meshNode) {
                        Object.entries(meshNode.parameters).forEach(([key, value]) => {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        });
                    }
                }

                const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
                if (airConn) {
                    const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                    if (airNode && airNode.type === 'Material' && airNode.parameters?.material_type === 'Air') {
                        Object.entries(airNode.parameters).forEach(([key, value]) => {
                            if (key !== 'material_type') {
                                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                            }
                        });
                    }
                }

                const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
                if (expConn) {
                    const chargeNode = state.nodes.find(n => n.id === expConn.fromNode);
                    if (chargeNode && chargeNode.type === 'Charge1D') {
                        // Radius comes from Charge1D parameter
                        const radius = Number(chargeNode.parameters?.charge_radius ?? 0.05);
                        flattenedParams['charge_radius'] = radius;
                        flattenedParams['explosive_radius'] = radius;

                        // Trace to Material node
                        const matConn = state.connections.find(c => c.toNode === chargeNode.id && c.toPort === 'material');
                        if (matConn) {
                            const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                            if (matNode && matNode.type === 'Material') {
                                const matType = matNode.parameters?.material_type || 'Air';
                                if (matType === 'JWL Charge') {
                                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                                    Object.entries(matNode.parameters).forEach(([key, value]) => {
                                        if (key !== 'material_type') {
                                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                                        }
                                    });
                                } else if (matType === 'Ideal Gas Charge') {
                                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                    flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                                    flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1.25);
                                    flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                                    Object.entries(matNode.parameters).forEach(([key, value]) => {
                                        if (key !== 'material_type' && key !== 'ideal_gamma' && key !== 'ideal_rho_0' && key !== 'ideal_e_0') {
                                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Trace 2D Solver if it exists
    const solverNode2D = state.nodes.find(n => n.type === 'CFDSolver2D');
    if (solverNode2D) {
        // Apply CFDSolver2D parameters
        Object.entries(solverNode2D.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        // Trace mesh input
        const meshConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'mesh');
        if (meshConn2D) {
            const meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
            if (meshNode2D) {
                Object.entries(meshNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace remap input
        const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
        if (remapConn2D) {
            const remapNode2D = state.nodes.find(n => n.id === remapConn2D.fromNode);
            if (remapNode2D) {
                Object.entries(remapNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace detonator input
        const detConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'detonator');
        if (detConn2D) {
            const detNode2D = state.nodes.find(n => n.id === detConn2D.fromNode);
            if (detNode2D) {
                Object.entries(detNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace hardware config
        const hwConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'hardware');
        if (hwConn2D) {
            const hwNode2D = state.nodes.find(n => n.id === hwConnConnNode(hwConn2D.fromNode));
            function hwConnConnNode(id: string) { return id; } // helper
            const hwNode = state.nodes.find(n => n.id === hwConn2D.fromNode);
            if (hwNode) {
                Object.entries(hwNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace air input
        const airConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'air');
        if (airConn2D) {
            const airNode = state.nodes.find(n => n.id === airConn2D.fromNode);
            if (airNode && airNode.type === 'Material' && airNode.parameters?.material_type === 'Air') {
                Object.entries(airNode.parameters).forEach(([key, value]) => {
                    if (key !== 'material_type') {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        // Trace charge input (Charge2D or Charge1D)
        let expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'charge');
        if (!expConn2D) {
            expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'explosive');
        }
        if (expConn2D) {
            const chargeNode = state.nodes.find(n => n.id === expConn2D.fromNode);
            if (chargeNode && (chargeNode.type === 'Charge2D' || chargeNode.type === 'Charge1D')) {
                // Charge geometry parameters
                Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });

                // Trace material node connected to Charge
                const matConn = state.connections.find(c => c.toNode === chargeNode.id && c.toPort === 'material');
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode && matNode.type === 'Material') {
                        const matType = matNode.parameters?.material_type ?? 'JWL Charge';
                        if (matType === 'JWL Charge') {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            Object.entries(matNode.parameters).forEach(([key, value]) => {
                                if (key !== 'material_type') {
                                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                                }
                            });
                        } else if (matType === 'Ideal Gas Charge') {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1.25);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            Object.entries(matNode.parameters).forEach(([key, value]) => {
                                if (key !== 'material_type' && key !== 'ideal_gamma' && key !== 'ideal_rho_0' && key !== 'ideal_e_0') {
                                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                                }
                            });
                        }
                    }
                }
            }
        }
    }

    // Derived parameters for backend (Zero-Omission Phase)
    if (command === "INIT") {
        const radius = flattenedParams['domain_radius'] || 1.0;
        const dx = flattenedParams['cell_size'] || 0.001;
        flattenedParams['n_cells'] = Math.round(radius / dx);

        // gamma comes from MaterialAir's gamma parameter (default 1.4 if not set)
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['charge_mass'] = mass;
        flattenedParams['rho'] = rho;
        flattenedParams['explosive_radius'] = mass > 0 ? Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0) : 0.0;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 298.15;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Ensure init_mode and composition are present with safe defaults
        if (!flattenedParams['init_mode']) flattenedParams['init_mode'] = 'Multi-Material JWL';
        if (flattenedParams['init_mode'] === 'Multi-Material JWL' && !flattenedParams['composition']) {
            flattenedParams['composition'] = 'TNT';
        }
    } else if (command === "INIT_2D") {
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 298.15;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Map and heal detonator locations if old naming is present
        if (flattenedParams['detonator_r'] === undefined) {
            flattenedParams['detonator_r'] = flattenedParams['explosive_r'] !== undefined ? flattenedParams['explosive_r'] : 0.0;
        }
        if (flattenedParams['detonator_z'] === undefined) {
            flattenedParams['detonator_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['detonator_radius'] === undefined) {
            flattenedParams['detonator_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.001;
        }

        if (flattenedParams['charge_shape'] === undefined) {
            flattenedParams['charge_shape'] = 'Sphere';
        }
        if (flattenedParams['charge_r'] === undefined) {
            flattenedParams['charge_r'] = 0.0;
        }
        if (flattenedParams['charge_z'] === undefined) {
            flattenedParams['charge_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['charge_radius'] === undefined) {
            flattenedParams['charge_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.05;
        }
        if (flattenedParams['charge_height'] === undefined) {
            flattenedParams['charge_height'] = 0.1;
        }

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        flattenedParams['charge_mass'] = mass;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['rho'] = rho;

        if (flattenedParams['charge_radius'] === undefined || flattenedParams['charge_radius'] === 0.0) {
            if (mass > 0) {
                if (flattenedParams['charge_shape'] === 'Cylinder') {
                    const height = flattenedParams['charge_height'] || 0.1;
                    flattenedParams['charge_radius'] = Math.sqrt(mass / (Math.PI * rho * height));
                } else {
                    flattenedParams['charge_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0);
                }
            } else {
                flattenedParams['charge_radius'] = 0.05;
            }
        }

        // Only default to 'From1D' when a 1D solver is actually present in the graph.
        // Otherwise infer from the connected explosive type so the 2D worker
        // initialises directly instead of waiting for a remap that will never come.
        if (!flattenedParams['init_mode']) {
            const has1DSolver = state.nodes.some(n => n.type === 'CFDSolver');
            if (has1DSolver) {
                flattenedParams['init_mode'] = 'From1D';
            } else if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'JWL';
            }
        }
        if (!flattenedParams['composition']) flattenedParams['composition'] = 'TNT';
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const maxR = flattenedParams['max_r'] || 1.0;
        const maxZ = flattenedParams['max_z'] || 1.0;

        flattenedParams['nr'] = Math.round(maxR / cellSize);
        flattenedParams['nz'] = Math.round(maxZ / cellSize);
        flattenedParams['max_r'] = maxR;
        flattenedParams['max_z'] = maxZ;
    }

    return JSON.stringify({
        command: command,
        modelId: modelId,
        ...flattenedParams,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        connections: state.connections
    });
}

export function serializeToBinary(state: SimulationState): ArrayBuffer {
    const jsonString = JSON.stringify(state);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonString);
    
    const buffer = new ArrayBuffer(4 + 1 + 1 + 4 + jsonBytes.length + 4);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    
    // Magic: 'BLST'
    view.setUint8(0, 0x42); // B
    view.setUint8(1, 0x4c); // L
    view.setUint8(2, 0x53); // S
    view.setUint8(3, 0x54); // T
    
    // Version: 1
    view.setUint8(4, 1);
    
    // Flags: 0
    view.setUint8(5, 0);
    
    // JSON Length (Big Endian)
    view.setUint32(6, jsonBytes.length, false);
    
    // JSON Bytes
    uint8.set(jsonBytes, 10);
    
    // Simple sum checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    view.setUint32(10 + jsonBytes.length, checksum, false);
    
    return buffer;
}

export function deserializeFromBinary(buffer: ArrayBuffer): SimulationState {
    const view = new DataView(buffer);
    if (buffer.byteLength < 14) {
        throw new Error("Invalid model: buffer too short");
    }
    
    // Verify Magic
    const m0 = view.getUint8(0);
    const m1 = view.getUint8(1);
    const m2 = view.getUint8(2);
    const m3 = view.getUint8(3);
    if (m0 !== 0x42 || m1 !== 0x4c || m2 !== 0x53 || m3 !== 0x54) {
        throw new Error("Invalid model: missing magic header");
    }
    
    const version = view.getUint8(4);
    if (version !== 1) {
        throw new Error(`Unsupported model version: ${version}`);
    }
    
    const jsonLength = view.getUint32(6, false);
    if (buffer.byteLength < 10 + jsonLength + 4) {
        throw new Error("Invalid model: payload truncated");
    }
    
    const uint8 = new Uint8Array(buffer);
    const jsonBytes = uint8.subarray(10, 10 + jsonLength);
    
    // Verify checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    const savedChecksum = view.getUint32(10 + jsonLength, false);
    if (checksum !== savedChecksum) {
        throw new Error("Invalid model: checksum mismatch");
    }
    
    const decoder = new TextDecoder();
    const jsonString = decoder.decode(jsonBytes);
    return JSON.parse(jsonString) as SimulationState;
}
