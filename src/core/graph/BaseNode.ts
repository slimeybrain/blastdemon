import { BasePort, PortDirection } from './BasePort.js';
import { NodeValidationContext, ValidationState } from '../types/Types.js';

export abstract class BaseNode {
    public id: string;
    public type: string;
    public inputs: Map<string, BasePort> = new Map();
    public outputs: Map<string, BasePort> = new Map();
    public validationContext: NodeValidationContext = { state: ValidationState.VALID, messages: [] };
    public isDirty: boolean = true;
    public cachedSerialization: any = null;

    constructor(id: string, type: string) {
        this.id = id;
        this.type = type;
        this.initializePorts();
    }

    public abstract initializePorts(): void;
    public abstract validateNode(): NodeValidationContext;
    public abstract serializeParams(upstreamData: Map<string, any>): any;

    protected addPort(id: string, name: string, type: any, direction: PortDirection, isRequired: boolean = true, maxConnections: number = 1): BasePort {
        const port = new BasePort(id, name, type, direction, isRequired, maxConnections, this);
        if (direction === PortDirection.INPUT) {
            this.inputs.set(id, port);
        } else {
            this.outputs.set(id, port);
        }
        return port;
    }

    public markDirty(): void {
        if (this.isDirty) return;
        this.isDirty = true;
        this.cachedSerialization = null;
        this.outputs.forEach(port => {
            port.connections.forEach(connectedPort => {
                if (connectedPort.owner) {
                    connectedPort.owner.markDirty();
                }
            });
        });
    }

    public pullSerialization(): any {
        if (!this.isDirty && this.cachedSerialization !== null) {
            return this.cachedSerialization;
        }

        this.updateValidationState();
        if (this.validationContext.state === ValidationState.ERROR_TOPOLOGY ||
            this.validationContext.state === ValidationState.ERROR_DATA) {
            throw new Error(`Node ${this.id} is invalid: ${this.validationContext.messages.join(', ')}`);
        }

        const upstreamData = new Map<string, any>();
        this.inputs.forEach((port, id) => {
            if (port.connections.length > 0) {
                const sourcePort = port.connections[0];
                const sourceNode = sourcePort.owner as BaseNode;
                if (sourceNode) {
                    upstreamData.set(id, sourceNode.pullSerialization());
                }
            }
        });

        this.cachedSerialization = {
            id: this.id,
            type: this.type,
            params: this.serializeParams(upstreamData)
        };
        this.isDirty = false;
        return this.cachedSerialization;
    }

    public updateValidationState(): void {
        this.validationContext = this.validateNode();
    }
}
