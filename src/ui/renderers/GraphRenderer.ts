import { BaseNode } from '../../core/graph/BaseNode.js';
import { BasePort } from '../../core/graph/BasePort.js';
import { ValidationState } from '../../core/types/Types.js';

export function drawNode(ctx: CanvasRenderingContext2D, node: BaseNode, x: number, y: number, width: number, height: number): void {
    const state = node.validationContext.state;

    let borderColor = '#475569'; // Default Slate-600
    let glowColor = 'transparent';
    let glowBlur = 0;

    if (state === ValidationState.ERROR_TOPOLOGY || state === ValidationState.ERROR_DATA) {
        borderColor = '#ef4444'; // Red-500
        glowColor = 'rgba(239, 68, 68, 0.5)';
        glowBlur = 10;
    } else if (state === ValidationState.WARNING) {
        borderColor = '#f59e0b'; // Amber-500
        glowColor = 'rgba(245, 158, 11, 0.5)';
        glowBlur = 10;
    }

    ctx.save();

    // Draw Shadow/Glow
    if (glowBlur > 0) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
    }

    // Draw Node Body
    ctx.fillStyle = '#1e293b'; // Slate-800
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.fill();
    ctx.stroke();

    // Draw Node Title
    ctx.fillStyle = '#f8fafc'; // Slate-50
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(node.type, x + 10, y + 20);

    ctx.restore();
}

export function drawConnection(ctx: CanvasRenderingContext2D, fromPort: BasePort, toPort: BasePort, fromX: number, fromY: number, toX: number, toY: number, isValid: boolean): void {
    ctx.save();

    ctx.lineWidth = 2;
    if (!isValid) {
        ctx.strokeStyle = '#ef4444'; // Red
        ctx.setLineDash([5, 5]);
    } else {
        ctx.strokeStyle = '#00f0ff'; // Cyan
        ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);

    // Bezier Curve
    const cp1x = fromX + (toX - fromX) / 2;
    const cp2x = fromX + (toX - fromX) / 2;
    ctx.bezierCurveTo(cp1x, fromY, cp2x, toY, toX, toY);

    ctx.stroke();

    ctx.restore();
}
