import { SimulationState } from './types.js';

export function serializeSimulationState(state: SimulationState): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);
    const dag = {
        nodes: strippedNodes,
        edges: state.edges
    };
    return JSON.stringify({
        command: "EXECUTE",
        dag: dag
    });
}

export function serializeForSolver(state: SimulationState): string {
    const domainNode = state.nodes.find(n => n.type === 'Domain1D');
    const icNode = state.nodes.find(n => n.type === 'InitialCondition');

    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    return JSON.stringify({
        command: "START",
        // Flat parameters for BlastSolver
        n_cells: domainNode?.parameters.size || 1000,
        explosive_radius: icNode?.parameters.value || 0.5,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        edges: state.edges
    });
}
