import { PortDataType } from '../types/Types.js';

export enum PortDirection {
    INPUT = 'INPUT',
    OUTPUT = 'OUTPUT'
}

export class BasePort {
    public id: string;
    public name: string;
    public type: PortDataType;
    public direction: PortDirection;
    public isRequired: boolean;
    public maxConnections: number;
    public connections: BasePort[] = [];
    public owner: any; // Reference to the owning BaseNode

    constructor(
        id: string,
        name: string,
        type: PortDataType,
        direction: PortDirection,
        isRequired: boolean = true,
        maxConnections: number = 1,
        owner?: any
    ) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.direction = direction;
        this.isRequired = isRequired;
        this.maxConnections = maxConnections;
        this.owner = owner;
    }

    public canConnectTo(targetPort: BasePort): boolean {
        if (this.direction === targetPort.direction) {
            return false;
        }
        if (this.type !== targetPort.type) {
            return false;
        }
        if (this.connections.length >= this.maxConnections) {
            return false;
        }
        if (targetPort.connections.length >= targetPort.maxConnections) {
            return false;
        }
        return true;
    }

    public connect(targetPort: BasePort): void {
        if (!this.canConnectTo(targetPort)) {
            throw new Error(`Cannot connect port ${this.id} to ${targetPort.id}`);
        }
        this.connections.push(targetPort);
        targetPort.connections.push(this);
    }

    public disconnect(targetPort?: BasePort): void {
        if (targetPort) {
            this.connections = this.connections.filter(p => p !== targetPort);
            targetPort.connections = targetPort.connections.filter(p => p !== this);
        } else {
            const currentConnections = [...this.connections];
            for (const conn of currentConnections) {
                this.disconnect(conn);
            }
        }
    }
}
