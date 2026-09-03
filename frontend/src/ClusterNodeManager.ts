/**
 * BlastDaemon ClusterNodeManager
 * Multi-node Broker connection pool, remote compute orchestration, 30 Hz NVML/CPU
 * diagnostics monitoring, and POSIX process lifecycle management.
 */

export interface RemoteNodeInfo {
    id: string;
    label: string;
    url: string;
    status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
    pingMs: number;
    metrics: {
        gpuUtilPercent: number;
        vramUsedMB: number;
        vramTotalMB: number;
        gpuTempC: number;
        cpuUtilPercent: number;
        ramUsedMB: number;
        ramTotalMB: number;
        activeWorkers: number;
    };
    socket: WebSocket | null;
}

export class ClusterNodeManager {
    private nodes: Map<string, RemoteNodeInfo> = new Map();
    private activeNodeId: string = 'local';
    private container: HTMLElement | null = null;
    private pulseInterval: number | null = null;
    private listeners: (() => void)[] = [];

    constructor(container?: HTMLElement | string) {
        if (container) {
            if (typeof container === 'string') {
                const el = document.getElementById(container);
                if (el) this.container = el;
            } else {
                this.container = container;
            }
        }

        // Register default local node
        this.addNode('local', 'Local Workstation (127.0.0.1)', 'ws://127.0.0.1:9002');

        this.startHealthPolling();
        if (this.container) {
            this.render();
        }
    }

    public addNode(id: string, label: string, url: string): void {
        if (this.nodes.has(id)) return;

        const node: RemoteNodeInfo = {
            id,
            label,
            url,
            status: 'DISCONNECTED',
            pingMs: 0,
            metrics: {
                gpuUtilPercent: 0,
                vramUsedMB: 0,
                vramTotalMB: 16384,
                gpuTempC: 35,
                cpuUtilPercent: 0,
                ramUsedMB: 0,
                ramTotalMB: 32768,
                activeWorkers: 0
            },
            socket: null
        };

        this.nodes.set(id, node);
        this.connectNode(node);
        this.notifyListeners();
    }

    private connectNode(node: RemoteNodeInfo): void {
        try {
            node.status = 'CONNECTING';
            const ws = new WebSocket(node.url);
            ws.binaryType = 'arraybuffer';
            node.socket = ws;

            const connectStart = performance.now();

            ws.onopen = () => {
                node.status = 'CONNECTED';
                node.pingMs = Math.round(performance.now() - connectStart);
                this.notifyListeners();
            };

            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'RESOURCE_PULSE' || msg.type === 'HEARTBEAT') {
                            this.updateNodeMetrics(node, msg);
                        }
                    } catch {
                        // ignore unparsed strings
                    }
                }
            };

            ws.onclose = () => {
                node.status = 'DISCONNECTED';
                node.socket = null;
                this.notifyListeners();
            };

            ws.onerror = () => {
                node.status = 'ERROR';
                this.notifyListeners();
            };
        } catch {
            node.status = 'ERROR';
            this.notifyListeners();
        }
    }

    private updateNodeMetrics(node: RemoteNodeInfo, msg: any): void {
        if (msg.gpu_percent !== undefined) node.metrics.gpuUtilPercent = Number(msg.gpu_percent);
        if (msg.vram_used_mb !== undefined) node.metrics.vramUsedMB = Number(msg.vram_used_mb);
        if (msg.vram_total_mb !== undefined) node.metrics.vramTotalMB = Number(msg.vram_total_mb);
        if (msg.gpu_temp_c !== undefined) node.metrics.gpuTempC = Number(msg.gpu_temp_c);
        if (msg.cpu_percent !== undefined) node.metrics.cpuUtilPercent = Number(msg.cpu_percent);
        if (msg.ram_used_mb !== undefined) node.metrics.ramUsedMB = Number(msg.ram_used_mb);
        if (msg.ram_total_mb !== undefined) node.metrics.ramTotalMB = Number(msg.ram_total_mb);
        if (msg.workers !== undefined) node.metrics.activeWorkers = Number(msg.workers);

        this.notifyListeners();
    }

    public sendProcessCommand(
        command: 'SPAWN_WORKER' | 'PAUSE' | 'RESUME' | 'RESTART' | 'KILL_FORCE',
        options: { coreAffinity?: string; cudaDevice?: number; workerId?: string } = {}
    ): void {
        const activeNode = this.nodes.get(this.activeNodeId);
        if (activeNode && activeNode.socket && activeNode.status === 'CONNECTED') {
            const payload = {
                command,
                core_affinity: options.coreAffinity || '0-15',
                cuda_device: options.cudaDevice ?? 0,
                worker_id: options.workerId || 'default'
            };
            activeNode.socket.send(JSON.stringify(payload));
        }
    }

    public getNodes(): RemoteNodeInfo[] {
        return Array.from(this.nodes.values());
    }

    public getActiveNode(): RemoteNodeInfo | undefined {
        return this.nodes.get(this.activeNodeId);
    }

    public setActiveNode(id: string): void {
        if (this.nodes.has(id)) {
            this.activeNodeId = id;
            this.notifyListeners();
        }
    }

    public onClusterUpdate(listener: () => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    private notifyListeners(): void {
        this.listeners.forEach(l => l());
        if (this.container) {
            this.render();
        }
    }

    private startHealthPolling(): void {
        this.pulseInterval = window.setInterval(() => {
            this.nodes.forEach(node => {
                if (node.status === 'DISCONNECTED' && !node.socket) {
                    this.connectNode(node);
                } else if (node.status === 'CONNECTED' && node.socket) {
                    try {
                        node.socket.send(JSON.stringify({ command: 'QUERY_RESOURCES' }));
                    } catch {
                        // ignore send errors
                    }
                }
            });
        }, 3000);
    }

    public render(): void {
        if (!this.container) return;
        this.container.innerHTML = '';

        const card = document.createElement('div');
        card.className = 'cluster-manager-card';

        const header = document.createElement('div');
        header.className = 'cluster-header';
        header.innerHTML = `<strong>Compute Cluster & Remote Daemons</strong> <span class="badge">${this.nodes.size} Nodes</span>`;
        card.appendChild(header);

        const list = document.createElement('div');
        list.className = 'cluster-node-list';

        this.nodes.forEach(node => {
            const row = document.createElement('div');
            row.className = `cluster-node-row ${node.id === this.activeNodeId ? 'active' : ''}`;
            row.addEventListener('click', () => this.setActiveNode(node.id));

            const statusDot = document.createElement('span');
            statusDot.className = `cluster-status-dot status-${node.status.toLowerCase()}`;

            const nameBox = document.createElement('div');
            nameBox.className = 'cluster-node-info';
            nameBox.innerHTML = `<strong>${node.label}</strong><small>${node.url} (${node.pingMs} ms)</small>`;

            const metricsBox = document.createElement('div');
            metricsBox.className = 'cluster-node-metrics';
            metricsBox.innerHTML = `
                <span title="GPU NVML Utilization">GPU: ${node.metrics.gpuUtilPercent.toFixed(0)}%</span>
                <span title="GPU Temperature">Temp: ${node.metrics.gpuTempC}°C</span>
                <span title="CPU Core Utilization">CPU: ${node.metrics.cpuUtilPercent.toFixed(0)}%</span>
                <span title="VRAM Used">${(node.metrics.vramUsedMB / 1024).toFixed(1)} GB</span>
            `;

            row.appendChild(statusDot);
            row.appendChild(nameBox);
            row.appendChild(metricsBox);
            list.appendChild(row);
        });

        card.appendChild(list);
        this.container.appendChild(card);
    }

    public destroy(): void {
        if (this.pulseInterval !== null) {
            clearInterval(this.pulseInterval);
            this.pulseInterval = null;
        }
        this.nodes.forEach(node => {
            if (node.socket) {
                node.socket.close();
                node.socket = null;
            }
        });
        this.nodes.clear();
        if (this.container) this.container.innerHTML = '';
    }
}
