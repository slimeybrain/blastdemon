export type NodeType = 'DomainMesh' | 'MaterialAir' | 'MaterialExplosive' | 'ThePainter' | 'CFDSolver' | 'TelemetryText' | 'TelemetryGraph';

export interface Port {
    id: string;
    label: string;
}

export interface Node {
    id: string;
    type: NodeType;
    x: number;
    y: number;
    width?: number;
    height?: number;
    displayMode?: 'compact' | 'normal' | 'expanded' | 'full-panel';
    parameters: Record<string, any>;
    inputs: Port[];
    outputs: Port[];
}

export interface Connection {
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
}

export type SimulationStatus = 'UNINITIALIZED' | 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'TERMINATED';

export type LayoutDirection = 'horizontal' | 'vertical';
export type PanelType = 'OUTLINER' | 'NODE_GRAPH' | 'PROPERTIES' | 'TELEMETRY_GRAPH' | 'TELEMETRY_TEXT' | 'NODE_VIEWER' | 'EXECUTION_MANAGER' | 'RESOURCE_MANAGER';

export interface SplitNode {
    type: 'split';
    id: string;
    direction: LayoutDirection;
    ratio: number; // e.g., 0.5 means 50/50 split
    firstChild: LayoutNode;
    secondChild: LayoutNode;
}

export interface PanelNode {
    type: 'panel';
    id: string;
    panelType: PanelType;
    targetNodeId?: string | null; // Used if displaying a specific Node's data
}

export type LayoutNode = SplitNode | PanelNode;

export interface SimulationState {
    nodes: Node[];
    connections: Connection[];
    layout: LayoutNode;
}
