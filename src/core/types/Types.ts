export enum PortDataType {
    FLOAT = 'FLOAT',
    VECTOR3 = 'VECTOR3',
    MESH = 'MESH',
    MATERIAL_PROFILE = 'MATERIAL_PROFILE',
    TRIGGER = 'TRIGGER'
}

export enum ValidationState {
    VALID = 'VALID',
    WARNING = 'WARNING',
    ERROR_TOPOLOGY = 'ERROR_TOPOLOGY',
    ERROR_DATA = 'ERROR_DATA'
}

export interface NodeValidationContext {
    state: ValidationState;
    messages: string[];
}
