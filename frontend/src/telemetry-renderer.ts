export class TelemetryRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private lastValues: number[] = [];

    private readonly COLORS = {
        bg: '#1a1a1a',
        line: '#007acc',
        axis: '#444444',
        text: '#888888',
        grid: '#252525'
    };

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
                this.lastValues = json.telemetry.split(',').map(Number);
                this.draw(this.lastValues);
            }
        } catch (e) {
            // Not a telemetry message
        }
    }

    public draw(values: number[] = this.lastValues): void {
        this.ctx.fillStyle = this.COLORS.bg;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (values.length < 2) {
            this.drawAxes();
            return;
        }

        const margin = 30;
        const width = this.canvas.width - 2 * margin;
        const height = this.canvas.height - 2 * margin;

        // Draw Grid
        this.ctx.strokeStyle = this.COLORS.grid;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        for (let i = 1; i < 4; i++) {
            const y = margin + (i / 4) * height;
            this.ctx.moveTo(margin, y);
            this.ctx.lineTo(this.canvas.width - margin, y);
        }
        this.ctx.stroke();

        // Draw Line
        this.ctx.beginPath();
        this.ctx.strokeStyle = this.COLORS.line;
        this.ctx.lineWidth = 2;
        this.ctx.lineJoin = 'round';

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

        this.drawAxes();
    }

    private drawAxes(): void {
        const margin = 30;
        this.ctx.beginPath();
        this.ctx.strokeStyle = this.COLORS.axis;
        this.ctx.lineWidth = 1;

        // X-axis
        this.ctx.moveTo(margin, this.canvas.height - margin);
        this.ctx.lineTo(this.canvas.width - margin, this.canvas.height - margin);

        // Y-axis
        this.ctx.moveTo(margin, margin);
        this.ctx.lineTo(margin, this.canvas.height - margin);
        this.ctx.stroke();

        // Labels
        this.ctx.fillStyle = this.COLORS.text;
        this.ctx.font = '10px Consolas';
        this.ctx.fillText('Pressure', margin, margin - 10);
        this.ctx.fillText('Radius', this.canvas.width - margin - 35, this.canvas.height - margin + 15);
    }
}
