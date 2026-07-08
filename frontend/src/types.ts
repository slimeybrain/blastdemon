export type NodeType = 'DomainMesh' | 'Material' | 'Charge1D' | 'Charge2D' | 'ThePainter' | 'CFDSolver' | 'TelemetryText' | 'TelemetryGraph' | 'DomainMesh2D' | 'DetonatorLocation' | 'RemapNode' | 'CFDSolver2D' | 'TelemetryContour' | 'VTKOutput' | 'HardwareConfig' | 'VirtualGauges' | 'DomainMesh3D' | 'Charge3D' | 'CFDSolver3D' | 'Telemetry3DViewport' | 'VirtualGauges3D' | 'DetonatorLocation3D';

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
    orientation?: 'HORIZ' | 'VERT';
}

export interface Connection {
    fromNode: string;
    fromPort: string;
    toNode: string;
    toPort: string;
}

export type SimulationStatus = 'UNINITIALIZED' | 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'TERMINATED';

export type LayoutDirection = 'horizontal' | 'vertical';
export type PanelType = 'MENU_BAR' | 'OUTLINER' | 'NODE_GRAPH' | 'PROPERTIES' | 'TELEMETRY_GRAPH' | 'TELEMETRY_TEXT' | 'NODE_VIEWER' | 'EXECUTION_MANAGER' | 'RESOURCE_MANAGER' | 'TELEMETRY_CONTOUR' | 'TELEMETRY_3D';

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
    options?: Record<string, any>;
}

export type LayoutNode = SplitNode | PanelNode;

export interface SimulationState {
    nodes: Node[];
    connections: Connection[];
    layout: LayoutNode;
}

export interface Model {
    id: string;
    name: string;
    filename: string | null;
    nodes: Node[];
    connections: Connection[];
}

export interface Workspace {
    id: string;
    name: string;
    modelIds: string[];
    activeModelId: string | null;
    layout: LayoutNode;
    connections: Connection[];
    selectedModelIds?: string[];
}

export interface AppState {
    models: Record<string, Model>;
    workspaces: Workspace[];
    activeWorkspaceId: string;
    workspaceCounter: number;
}

