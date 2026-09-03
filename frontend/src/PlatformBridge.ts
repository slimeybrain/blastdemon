/**
 * BlastDaemon PlatformBridge
 * Platform abstraction layer providing uniform capabilities across standard Web Browsers
 * and standalone native desktop builds (BlastStudio).
 */

export interface FileDialogFilter {
    name: string;
    extensions: string[];
}

export type PlatformTarget = 'browser' | 'blaststudio_desktop';

export class PlatformBridge {
    private static instance: PlatformBridge;

    public static getInstance(): PlatformBridge {
        if (!PlatformBridge.instance) {
            PlatformBridge.instance = new PlatformBridge();
        }
        return PlatformBridge.instance;
    }

    public getPlatform(): PlatformTarget {
        if (typeof (window as any).__BLASTSTUDIO__ !== 'undefined') {
            return 'blaststudio_desktop';
        }
        return 'browser';
    }

    public isDesktop(): boolean {
        return this.getPlatform() === 'blaststudio_desktop';
    }

    /**
     * Open file dialog (native OS dialog in BlastStudio, HTML5 file input in browser).
     */
    public async openFileDialog(filters: FileDialogFilter[] = []): Promise<{ filename: string; data: ArrayBuffer | string } | null> {
        if (this.isDesktop() && (window as any).__BLASTSTUDIO__?.openFileDialog) {
            return (window as any).__BLASTSTUDIO__.openFileDialog(filters);
        }

        // Standard browser fallback
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            if (filters.length > 0) {
                input.accept = filters.flatMap(f => f.extensions.map(ext => `.${ext}`)).join(',');
            }
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = async () => {
                if (input.files && input.files[0]) {
                    const file = input.files[0];
                    const arrayBuffer = await file.arrayBuffer();
                    document.body.removeChild(input);
                    resolve({ filename: file.name, data: arrayBuffer });
                } else {
                    document.body.removeChild(input);
                    resolve(null);
                }
            };

            input.click();
        });
    }

    /**
     * Save file dialog / export blob.
     */
    public async saveFileDialog(
        defaultFilename: string,
        data: ArrayBuffer | string,
        mimeType: string = 'application/octet-stream'
    ): Promise<boolean> {
        if (this.isDesktop() && (window as any).__BLASTSTUDIO__?.saveFileDialog) {
            return (window as any).__BLASTSTUDIO__.saveFileDialog(defaultFilename, data);
        }

        // Standard browser download link
        const blob = data instanceof ArrayBuffer ? new Blob([data], { type: mimeType }) : new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    }

    /**
     * Query host hardware capabilities.
     */
    public async querySystemCapabilities(): Promise<{ webgpu: boolean; memoryMB: number; cores: number }> {
        const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
        const memoryMB = (navigator as any)?.deviceMemory ? (navigator as any).deviceMemory * 1024 : 8192;
        const cores = navigator?.hardwareConcurrency || 8;
        return { webgpu, memoryMB, cores };
    }
}
