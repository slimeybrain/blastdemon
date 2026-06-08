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
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    // Flatten all parameters from all nodes into a single configuration object
    const flattenedParams: Record<string, any> = {};
    state.nodes.forEach(node => {
        Object.entries(node.parameters).forEach(([key, value]) => {
            flattenedParams[key] = value;
        });
    });

    return JSON.stringify({
        command: "START",
        ...flattenedParams,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        edges: state.edges
    });
}
