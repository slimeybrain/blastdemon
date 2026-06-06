export class NetworkManager {
    private socket: WebSocket | null = null;
    private url: string;
    private messageCallbacks: ((data: string) => void)[] = [];

    constructor(url: string) {
        this.url = url;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                console.log('Connected to BlastDaemon');
                resolve();
            };

            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };

            this.socket.onmessage = (event) => {
                console.log('Message from server:', event.data);
                this.messageCallbacks.forEach(callback => callback(event.data));
            };

            this.socket.onclose = () => {
                console.log('Disconnected from BlastDaemon');
            };
        });
    }

    send(message: string): void {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(message);
        } else {
            console.error('WebSocket is not open');
        }
    }

    onMessage(callback: (data: string) => void): void {
        this.messageCallbacks.push(callback);
    }
}
