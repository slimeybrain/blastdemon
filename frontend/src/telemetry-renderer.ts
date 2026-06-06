export class TelemetryRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Could not get 2D context for telemetry canvas');
        }
        this.ctx = context;
    }

    public handleMessage(data: string): void {
        try {
            const json = JSON.parse(data);
            if (json.telemetry) {
                const values = json.telemetry.split(',').map(Number);
                this.draw(values);
            }
        } catch (e) {
            // Not a telemetry message or malformed JSON
        }
    }

    private draw(values: number[]): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (values.length < 2) return;

        this.ctx.beginPath();
        this.ctx.strokeStyle = '#007bff';
        this.ctx.lineWidth = 2;

        const margin = 20;
        const width = this.canvas.width - 2 * margin;
        const height = this.canvas.height - 2 * margin;

        for (let i = 0; i < values.length; i++) {
            const x = margin + (i / (values.length - 1)) * width;
            const y = (this.canvas.height - margin) - (values[i] * height);

            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        }

        this.ctx.stroke();

        // Draw axes
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 1;
        // X-axis
        this.ctx.moveTo(margin, this.canvas.height - margin);
        this.ctx.lineTo(this.canvas.width - margin, this.canvas.height - margin);
        // Y-axis
        this.ctx.moveTo(margin, margin);
        this.ctx.lineTo(margin, this.canvas.height - margin);
        this.ctx.stroke();

        // Labels
        this.ctx.fillStyle = '#333';
        this.ctx.font = '12px Arial';
        this.ctx.fillText('Pressure', margin + 5, margin + 10);
        this.ctx.fillText('Radius (Index)', this.canvas.width - 100, this.canvas.height - margin + 15);
    }
}
