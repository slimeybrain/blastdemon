export type NodeType = 'Domain1D' | 'InitialCondition' | 'Solver1D' | 'OutputNode';

export interface Node {
    id: string;
    type: NodeType;
    x: number;
    y: number;
    parameters: Record<string, any>;
}

export interface Edge {
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
}

export interface SimulationState {
    nodes: Node[];
    edges: Edge[];
}
