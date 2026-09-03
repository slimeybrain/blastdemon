export type NodeType = 'DomainMesh' | 'Material' | 'Charge1D' | 'Charge2D' | 'ThePainter' | 'CFDSolver' | 'TelemetryText' | 'TelemetryGraph' | 'DomainMesh2D' | 'DetonatorLocation' | 'RemapNode' | 'Remap1DTo2DNode' | 'Remap1DTo3DNode' | 'Remap2DTo3DNode' | 'CFDSolver2D' | 'TelemetryContour' | 'VTKOutput' | 'HardwareConfig' | 'VirtualGauges' | 'DomainMesh3D' | 'Charge3D' | 'CFDSolver3D' | 'Telemetry3DViewport' | 'DetonatorLocation3D' | 'STLGeometry' | 'PrimitiveGeometry3D' | 'Obstacle3D' | 'Obstacle' | 'MPMDomain2D' | 'MPMObject2D' | 'FSICoupler2D' | 'RefinementMesh3D' | 'MPMDomain3D' | 'MPMObject3D' | 'FSICoupler3D' | 'FEMDomain3D' | 'FEMObject3D' | 'FEMBeam3D' | 'FEMRebar3D' | 'LSDynaImporter3D' | 'FEMFSICoupler3D';


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

export type SimulationStatus = 'UNINITIALIZED' | 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'TERMINATED' | 'ERROR';

export type LayoutDirection = 'horizontal' | 'vertical';
export type PanelType = 'MENU_BAR' | 'OUTLINER' | 'NODE_GRAPH' | 'PROPERTIES' | 'TELEMETRY_GRAPH' | 'TELEMETRY_TEXT' | 'NODE_VIEWER' | 'EXECUTION_MANAGER' | 'RESOURCE_MANAGER' | 'TELEMETRY_CONTOUR' | 'TELEMETRY_3D' | 'COMPARE_MODELS' | 'PIPELINE_BROWSER' | 'PROPERTY_GRID' | 'VIEWPORT' | 'TRANSPORT_BAR' | 'CLUSTER_MANAGER' | 'MULTI_VIEW_STAGE';

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

export interface ModelViewCamera {
    pitch: number;
    yaw: number;
    distance: number;
    target: [number, number, number];
    usePerspective?: boolean;
    fov?: number;
}

export interface ModelViewSlice {
    axis: 'xy' | 'yz' | 'xz';
    offset: number;
    quantity: string;
    colormap?: string;
    opacity?: number;
    enabled: boolean;
    stride?: number;
}

export interface ModelViewToggles {
    show_grid?: boolean;
    show_grid_box?: boolean;
    cell_edges?: boolean;
    show_stl?: boolean;
    stl_opacity?: number;
    show_obstacles?: boolean;
    obstacles_opacity?: number;
    refresh_rate?: number;
}

export interface ModelViewConfig {
    id: string;
    name: string;
    camera?: ModelViewCamera;
    slices?: ModelViewSlice[];
    toggles?: ModelViewToggles;
    quantityColormaps?: Record<string, string>;
}

export interface ViewportPaneOption {
    index: number;
    viewType: '3D_VIEWPORT' | '2D_CONTOUR' | '1D_CHART' | 'RESOURCE_MONITOR';
    modelId?: string | null;
    viewId?: string | null;
}
export type MultiViewStagePaneOption = ViewportPaneOption;

export interface ViewportOptions {
    preset?: '1x1' | '1x2' | '2x1' | '2x2';
    panes?: ViewportPaneOption[];
    backgroundTheme?: 'studio-slate' | 'midnight-navy' | 'technical-blueprint' | 'graphite-studio' | 'obsidian-dark';
    showStudioGrid?: boolean;
}
export type MultiViewStageOptions = ViewportOptions;

export interface Model {
    id: string;
    name: string;
    filename: string | null;
    nodes: Node[];
    connections: Connection[];
    views?: ModelViewConfig[];
    activeViewId?: string | null;
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

