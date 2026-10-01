/**
 * PlatformBridge.ts
 * Clean abstraction layer bridging the Web Browser GUI and the Standalone Native Desktop Shell (BlastStudio).
 * Handles platform detection, IPC communication channels, file I/O abstraction, and shared-memory telemetry hooks.
 */

export interface HardwareStats {
    cpuUsage: number;
    ramUsageMB: number;
    vramUsageMB: number;
    gpuName?: string;
}

export type PlatformType = 'desktop' | 'web';

export class PlatformBridge {
    private static instance: PlatformBridge | null = null;
    private platformType: PlatformType = 'web';
    private messageListeners: Set<(data: any) => void> = new Set();

    private constructor() {
        this.detectPlatform();
        this.initBridge();
    }

    public static getInstance(): PlatformBridge {
        if (!PlatformBridge.instance) {
            PlatformBridge.instance = new PlatformBridge();
        }
        return PlatformBridge.instance;
    }

    private detectPlatform(): void {
        // Detect native desktop shell injection (BlastStudio webview host API)
        const win = window as any;
        if (win.__BLAST_STUDIO_NATIVE__ || win.blastStudio || win.chrome?.webview?.hostObjects?.blastStudio) {
            this.platformType = 'desktop';
        } else {
            this.platformType = 'web';
        }
    }

    private initBridge(): void {
        const win = window as any;
        if (this.platformType === 'desktop' && win.blastStudio?.onMessage) {
            win.blastStudio.onMessage((msg: any) => {
                this.dispatchMessage(msg);
            });
        }
    }

    public isNativeDesktop(): boolean {
        return this.platformType === 'desktop';
    }

    public getPlatform(): PlatformType {
        return this.platformType;
    }

    public addMessageListener(listener: (data: any) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    public dispatchMessage(data: any): void {
        for (const listener of this.messageListeners) {
            try {
                listener(data);
            } catch (err) {
                console.error('[PlatformBridge] Listener error:', err);
            }
        }
    }

    public async sendCommand(cmd: any): Promise<void> {
        const win = window as any;
        if (this.platformType === 'desktop' && win.blastStudio?.sendCommand) {
            await win.blastStudio.sendCommand(cmd);
        }
        // In web mode, commands route through the established WebSocket connection
    }

    public async saveFile(filename: string, content: Uint8Array | string): Promise<boolean> {
        const win = window as any;
        if (this.platformType === 'desktop' && win.blastStudio?.saveFile) {
            return await win.blastStudio.saveFile(filename, content);
        }

        // Web fallback: Trigger browser download via Blob
        try {
            const blob = typeof content === 'string' 
                ? new Blob([content], { type: 'text/plain;charset=utf-8' })
                : new Blob([content as any], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            return true;
        } catch (e) {
            console.error('[PlatformBridge] saveFile web fallback failed:', e);
            return false;
        }
    }

    public getSharedMemoryAvailable(): boolean {
        const win = window as any;
        return this.platformType === 'desktop' && !!win.blastStudio?.hasSharedMemory;
    }
}
