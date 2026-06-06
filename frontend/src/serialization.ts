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
