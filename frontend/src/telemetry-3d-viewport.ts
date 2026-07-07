import { Node, PanelType } from './types.js';

export class Telemetry3DViewport {
    private container: HTMLElement;
    private canvas: HTMLCanvasElement;
    private worker: Worker;

    constructor(container: HTMLElement, panelId: string) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.container.appendChild(this.canvas);

        this.worker = new Worker(new URL('./ViewportWorker.ts', import.meta.url), { type: 'module' });

        const rect = this.container.getBoundingClientRect();
        // @ts-ignore
        const offscreen = this.canvas.transferControlToOffscreen();
        this.worker.postMessage({
            type: 'init',
            data: {
                canvas: offscreen,
                width: rect.width || 800,
                height: rect.height || 600
            }
        }, [offscreen]);

        this.initInteraction();

        new ResizeObserver(entries => {
            for (let entry of entries) {
                this.worker.postMessage({
                    type: 'resize',
                    data: {
                        width: entry.contentRect.width,
                        height: entry.contentRect.height
                    }
                });
            }
        }).observe(this.container);
    }

    private initInteraction() {
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;

        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            this.worker.postMessage({ type: 'input', data: { drx: dy, dry: dx } });
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.worker.postMessage({ type: 'input', data: { dy: e.deltaY } });
        }, { passive: false });
    }

    public pushFrame(buffer: ArrayBuffer) {
        this.worker.postMessage({ type: 'frame', data: { buffer } }, [buffer]);
    }

    public updateTelemetry(data: any) {
        if (data && data.type === 'TELEMETRY_3D') {
            this.worker.postMessage({
                type: 'setConfig',
                data: {
                    minY: 101325.0,
                    maxY: 101325.0 * 100.0 // Dynamic scaling could go here
                }
            });
        }
    }

    public destroy() {
        this.worker.terminate();
        this.canvas.remove();
    }
}
