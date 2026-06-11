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

export function serializeForSolver(state: SimulationState, command: string = "INIT"): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    const numericKeys = [
        'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
        'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
        'jwl_R1', 'jwl_R2', 'jwl_omega', 'cfl', 'output_interval',
        'spatial_order', 'temporal_order',
        'n_cells', 'gamma', 'explosive_radius', 'ambient_rho'
    ];

    // Flatten all parameters from all nodes into a single configuration object
    const flattenedParams: Record<string, any> = {};
    state.nodes.forEach(node => {
        Object.entries(node.parameters).forEach(([key, value]) => {
            if (numericKeys.includes(key)) {
                flattenedParams[key] = Number(value);
            } else {
                flattenedParams[key] = value;
            }
        });
    });

    // Derived parameters for backend (Zero-Omission Phase)
    if (command === "INIT") {
        const radius = flattenedParams['domain_radius'] || 1.0;
        const dx = flattenedParams['cell_size'] || 0.001;
        flattenedParams['n_cells'] = Math.round(radius / dx);

        flattenedParams['gamma'] = 1.4; // Default air

        const mass = flattenedParams['charge_mass'] || 1.0;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['explosive_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0);

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 298.15;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
    }

    return JSON.stringify({
        command: command,
        ...flattenedParams,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        connections: state.connections
    });
}
