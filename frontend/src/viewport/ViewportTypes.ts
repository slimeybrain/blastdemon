export interface DiscoveredFEMPart {
    id: string;
    nodeId: string;
    name: string;
    type: 'solid' | 'beam' | 'shell' | 'rebar' | 'general';
    numElements: number;
    visible: boolean;
    renderMode: 'solid' | 'wireframe' | 'both';
    opacity: number;
    color?: string;
    isLine: boolean;
    bounds?: [number, number, number, number, number, number];
    x: number;
    y: number;
    z: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    shapeType?: string;
    originMode?: string;
    nx?: number;
    ny?: number;
    nz?: number;
    radius?: number;
    innerRadius?: number;
    height?: number;
}
