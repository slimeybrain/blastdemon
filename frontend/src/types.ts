export type NodeType = 'DomainMesh' | 'MaterialAir' | 'MaterialExplosive' | 'ThePainter' | 'CFDSolver';

export interface Port {
    id: string;
    label: string;
}

export interface Node {
    id: string;
    type: NodeType;
    x: number;
    y: number;
    parameters: Record<string, any>;
    inputs: Port[];
    outputs: Port[];
}

export interface Edge {
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
}

export type SimulationStatus = 'UNINITIALIZED' | 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'TERMINATED';

export interface SimulationState {
    nodes: Node[];
    edges: Edge[];
}
