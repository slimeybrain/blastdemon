export class NetworkManager {
    private socket: WebSocket | null = null;
    private url: string;
    private terminal: HTMLElement | null;
    private messageCallbacks: ((data: string | ArrayBuffer) => void)[] = [];
    private openCallbacks: (() => void)[] = [];
    private reconnectTimeout: number = 3000;
    private isManuallyClosed: boolean = false;

    constructor(url: string, terminalId: string = 'terminal-output') {
        this.url = url;
        this.terminal = document.getElementById(terminalId);
        this.connect();
    }

    public connect(): void {
        this.isManuallyClosed = false;
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        this.socket = ws;

        this.socket.onopen = () => {
            this.log('[System] WebSocket Connected to ' + this.url, 'success');
            this.openCallbacks.forEach(callback => callback());
        };

        this.socket.onmessage = (event) => {
            if (typeof event.data === "string") {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'IO_SUCCESS') {
                        const formattedTime = (typeof data.time === 'number') ? data.time.toExponential(6) : data.time;
                        this.log(`[System] Frame written to disk at t=${formattedTime}s`, 'system');
                    } else if (data.type !== 'TELEMETRY' && data.type !== 'progress') {
                        this.log(JSON.stringify(data), 'default');
                    }
                } catch (e) {
                    this.log(event.data, 'default');
                }
            }
            this.messageCallbacks.forEach(callback => callback(event.data));
        };

        this.socket.onclose = () => {
            if (!this.isManuallyClosed) {
                this.log('[System] WebSocket Disconnected. Retrying in 3s...', 'error');
                setTimeout(() => this.connect(), this.reconnectTimeout);
            }
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket Error:', error);
            // onclose will handle the reconnection logic
        };
    }

    public send(message: string | object): void {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const payload = typeof message === 'string' ? message : JSON.stringify(message);
            if (payload.includes('"command":"INIT"')) {
                console.warn("[DEBUG] RAW INIT PAYLOAD:", payload);
            }
            this.socket.send(payload);
        } else {
            this.log('[System] Cannot send message: WebSocket is not connected.', 'error');
        }
    }

    public onMessage(callback: (data: string | ArrayBuffer) => void): void {
        this.messageCallbacks.push(callback);
    }

    public onOpen(callback: () => void): void {
        this.openCallbacks.push(callback);
    }

    public close(): void {
        this.isManuallyClosed = true;
        if (this.socket) {
            this.socket.close();
        }
    }

    public log(message: string, type: 'success' | 'error' | 'system' | 'default'): void {
        console.log(`[${type.toUpperCase()}] ${message}`);
        if (!this.terminal) return;

        const line = document.createElement('div');
        line.className = 'terminal-line';

        if (type === 'success') line.classList.add('terminal-success');
        if (type === 'error') line.classList.add('terminal-error');
        if (type === 'system') line.classList.add('terminal-system');

        line.textContent = message;
        this.terminal.appendChild(line);
        this.terminal.scrollTop = this.terminal.scrollHeight;
    }
}
