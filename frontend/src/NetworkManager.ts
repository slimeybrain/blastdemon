export class NetworkManager {
    private socket: WebSocket | null = null;
    private url: string;
    private terminal: HTMLElement | null;
    private messageCallbacks: ((data: string) => void)[] = [];
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
        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
            this.log('[System] WebSocket Connected to ' + this.url, 'success');
            this.openCallbacks.forEach(callback => callback());
        };

        this.socket.onmessage = (event) => {
            // For now, just stringify and append to terminal
            try {
                const data = JSON.parse(event.data);
                this.log(JSON.stringify(data), 'default');
            } catch (e) {
                this.log(event.data, 'default');
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
            this.socket.send(payload);
        } else {
            this.log('[System] Cannot send message: WebSocket is not connected.', 'error');
        }
    }

    public onMessage(callback: (data: string) => void): void {
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
