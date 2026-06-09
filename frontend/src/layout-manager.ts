export interface PanelState {
    visible: boolean;
    size: number;
}

export interface PanelConfig {
    leftSidebar: PanelState;
    rightSidebar: PanelState;
}

export class LayoutManager {
    private config: PanelConfig;
    private container: HTMLElement;

    constructor(containerId: string) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`Container with id ${containerId} not found`);
        }
        this.container = container;
        this.config = {
            leftSidebar: { visible: true, size: 250 },
            rightSidebar: { visible: true, size: 350 }
        };
    }

    public init(): void {
        this.updateGridStructure();
        this.initSplitters();
    }

    public updateGridStructure(): void {
        const { leftSidebar, rightSidebar } = this.config;

        const colSpecs = [];
        if (leftSidebar.visible) colSpecs.push(`${leftSidebar.size}px`);
        colSpecs.push("1fr");
        if (rightSidebar.visible) colSpecs.push(`${rightSidebar.size}px`);
        this.container.style.gridTemplateColumns = colSpecs.join(" ");

        this.container.style.gridTemplateRows = "1fr";

        const topRow = [];
        if (leftSidebar.visible) topRow.push("left-sidebar");
        topRow.push("center-viewport");
        if (rightSidebar.visible) topRow.push("right-sidebar");

        this.container.style.gridTemplateAreas = `"${topRow.join(" ")}"`;

        // Also toggle visibility of panel elements for clean layout
        const leftEl = document.getElementById('left-sidebar');
        if (leftEl) leftEl.style.display = leftSidebar.visible ? 'flex' : 'none';

        const rightEl = document.getElementById('right-sidebar');
        if (rightEl) rightEl.style.display = rightSidebar.visible ? 'flex' : 'none';

        this.syncSplitters();
    }

    public addPanel(panelId: keyof PanelConfig): void {
        this.config[panelId].visible = true;
        this.updateGridStructure();
    }

    public removePanel(panelId: keyof PanelConfig): void {
        this.config[panelId].visible = false;
        this.updateGridStructure();
    }

    private initSplitters(): void {
        const leftSplitter = document.createElement('div');
        leftSplitter.id = 'left-splitter';
        leftSplitter.className = 'splitter vertical';
        this.container.appendChild(leftSplitter);

        const rightSplitter = document.createElement('div');
        rightSplitter.id = 'right-splitter';
        rightSplitter.className = 'splitter vertical';
        this.container.appendChild(rightSplitter);

        this.setupResizing();
        this.syncSplitters();
    }

    private setupResizing(): void {
        const leftSplitter = document.getElementById('left-splitter')!;
        const rightSplitter = document.getElementById('right-splitter')!;

        const onMouseDown = (e: MouseEvent, panelId: keyof PanelConfig) => {
            e.preventDefault();
            const startPos = e.clientX;
            const startSize = this.config[panelId].size;

            const onMouseMove = (moveEvent: MouseEvent) => {
                let delta = 0;
                if (panelId === 'leftSidebar') {
                    delta = moveEvent.clientX - startPos;
                    this.config[panelId].size = Math.max(100, startSize + delta);
                } else if (panelId === 'rightSidebar') {
                    delta = startPos - moveEvent.clientX;
                    this.config[panelId].size = Math.max(100, startSize + delta);
                }
                this.updateGridStructure();
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                document.body.style.cursor = 'default';
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'col-resize';
        };

        leftSplitter.addEventListener('mousedown', (e) => onMouseDown(e as MouseEvent, 'leftSidebar'));
        rightSplitter.addEventListener('mousedown', (e) => onMouseDown(e as MouseEvent, 'rightSidebar'));
    }

    private syncSplitters(): void {
        const { leftSidebar, rightSidebar } = this.config;
        const leftSplitter = document.getElementById('left-splitter') as HTMLElement;
        const rightSplitter = document.getElementById('right-splitter') as HTMLElement;

        if (leftSplitter) {
            leftSplitter.style.display = leftSidebar.visible ? 'block' : 'none';
            leftSplitter.style.left = `${leftSidebar.size}px`;
            leftSplitter.style.top = '0';
            leftSplitter.style.bottom = '0';
            leftSplitter.style.width = '4px';
        }

        if (rightSplitter) {
            rightSplitter.style.display = rightSidebar.visible ? 'block' : 'none';
            rightSplitter.style.right = `${rightSidebar.size}px`;
            rightSplitter.style.top = '0';
            rightSplitter.style.bottom = '0';
            rightSplitter.style.width = '4px';
        }
    }
}
