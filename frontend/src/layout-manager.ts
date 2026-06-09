import { StateManager } from './state-manager.js';
import { LayoutNode, SplitNode, PanelNode, SimulationState, PanelType } from './types.js';
import { GraphRenderer } from './graph-renderer.js';
import { PropertyEditor } from './property-editor.js';
import { NodeViewer } from './node-viewer.js';

export class LayoutManager {
    private container: HTMLElement;
    private stateManager: StateManager;
    private components: Map<string, any> = new Map();
    private lastState: SimulationState | null = null;

    constructor(containerId: string, stateManager: StateManager) {
        const container = document.getElementById(containerId);
        if (!container) throw new Error(`Container #${containerId} not found`);
        this.container = container;
        this.stateManager = stateManager;

        this.stateManager.onStateChange((state) => this.render(state));
    }

    public render(state: SimulationState): void {
        // Optimization: only re-render if layout structure OR nodes (for dropdowns) changed
        const layoutJson = JSON.stringify(state.layout);
        const nodesJson = JSON.stringify(state.nodes.map(n => n.id));
        const currentData = layoutJson + nodesJson;

        const lastLayoutJson = this.lastState ? JSON.stringify(this.lastState.layout) : '';
        const lastNodesJson = this.lastState ? JSON.stringify(this.lastState.nodes.map(n => n.id)) : '';
        const lastData = lastLayoutJson + lastNodesJson;

        if (currentData !== lastData) {
            this.container.innerHTML = '';
            this.renderNode(state.layout, this.container);
        }
        this.lastState = state;
    }

    private renderNode(node: LayoutNode, parent: HTMLElement): void {
        if (node.type === 'split') {
            this.renderSplit(node, parent);
        } else {
            this.renderPanel(node, parent);
        }
    }

    private renderSplit(node: SplitNode, parent: HTMLElement): void {
        const splitEl = document.createElement('div');
        splitEl.className = `split-container ${node.direction}`;
        splitEl.style.display = 'flex';
        splitEl.style.flexDirection = node.direction === 'horizontal' ? 'row' : 'column';
        splitEl.style.width = '100%';
        splitEl.style.height = '100%';
        splitEl.style.flex = '1';

        const firstChildWrapper = document.createElement('div');
        firstChildWrapper.style.flex = `${node.ratio}`;
        firstChildWrapper.style.position = 'relative';
        firstChildWrapper.style.display = 'flex';
        this.renderNode(node.firstChild, firstChildWrapper);

        const splitter = document.createElement('div');
        splitter.className = `splitter ${node.direction}`;
        splitter.style.backgroundColor = '#333';
        splitter.style.flex = '0 0 4px';
        splitter.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';

        this.setupSplitterDrag(splitter, node);

        const secondChildWrapper = document.createElement('div');
        secondChildWrapper.style.flex = `${1 - node.ratio}`;
        secondChildWrapper.style.position = 'relative';
        secondChildWrapper.style.display = 'flex';
        this.renderNode(node.secondChild, secondChildWrapper);

        splitEl.appendChild(firstChildWrapper);
        splitEl.appendChild(splitter);
        splitEl.appendChild(secondChildWrapper);
        parent.appendChild(splitEl);
    }

    private setupSplitterDrag(splitter: HTMLElement, node: SplitNode): void {
        const onMouseDown = (e: MouseEvent) => {
            e.preventDefault();
            const startPos = node.direction === 'horizontal' ? e.clientX : e.clientY;
            const startRatio = node.ratio;
            const parentRect = splitter.parentElement!.getBoundingClientRect();
            const parentSize = node.direction === 'horizontal' ? parentRect.width : parentRect.height;

            const onMouseMove = (moveEvent: MouseEvent) => {
                const currentPos = node.direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
                const delta = currentPos - startPos;
                const newRatio = startRatio + (delta / parentSize);
                this.stateManager.setPanelRatio(node.id, newRatio);
            };

            const onMouseUp = () => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                this.stateManager.commitPanelRatio();
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };

        splitter.addEventListener('mousedown', onMouseDown);
    }

    private renderPanel(node: PanelNode, parent: HTMLElement): void {
        const panelEl = document.createElement('div');
        panelEl.className = 'panel';
        panelEl.style.display = 'flex';
        panelEl.style.flexDirection = 'column';
        panelEl.style.flex = '1';
        panelEl.style.height = '100%';
        panelEl.style.overflow = 'hidden';

        const header = this.createPanelHeader(node);
        panelEl.appendChild(header);

        const content = document.createElement('div');
        content.className = 'panel-content';
        content.style.flex = '1';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.overflow = 'hidden';
        panelEl.appendChild(content);

        parent.appendChild(panelEl);

        this.renderPanelContent(node, content);
    }

    private createPanelHeader(node: PanelNode): HTMLElement {
        const header = document.createElement('div');
        header.className = 'panel-header';

        const leftSide = document.createElement('div');
        leftSide.style.display = 'flex';
        leftSide.style.alignItems = 'center';
        leftSide.style.gap = '8px';

        const select = document.createElement('select');
        select.className = 'header-select';
        const types: PanelType[] = ['OUTLINER', 'NODE_GRAPH', 'PROPERTIES', 'TELEMETRY_GRAPH', 'TELEMETRY_TEXT', 'NODE_VIEWER'];
        types.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t.replace('_', ' ');
            if (t === node.panelType) opt.selected = true;
            select.appendChild(opt);
        });
        select.onchange = () => this.stateManager.setPanelType(node.id, select.value as PanelType);
        leftSide.appendChild(select);

        if (node.panelType === 'NODE_VIEWER') {
            const subSelect = document.createElement('select');
            subSelect.className = 'node-sub-select';
            subSelect.style.marginLeft = '4px';
            subSelect.style.maxWidth = '120px';

            const state = this.stateManager.getCurrentState();
            if (state) {
                state.nodes.forEach(n => {
                    const opt = document.createElement('option');
                    opt.value = n.id;
                    opt.textContent = n.id;
                    if (n.id === node.targetNodeId) opt.selected = true;
                    subSelect.appendChild(opt);
                });
            }
            subSelect.onchange = () => this.stateManager.setPanelType(node.id, 'NODE_VIEWER', subSelect.value);
            leftSide.appendChild(subSelect);
        }

        if (node.panelType === 'NODE_GRAPH') {
            const statusBadge = document.createElement('div');
            statusBadge.id = 'status-badge';
            statusBadge.className = `status-badge badge-${this.stateManager.getStatus().toLowerCase()}`;
            statusBadge.textContent = this.stateManager.getStatus();
            leftSide.appendChild(statusBadge);

            // Re-sync status badge on change
            this.stateManager.onStatusChange((status) => {
                statusBadge.textContent = status;
                statusBadge.className = `status-badge badge-${status.toLowerCase()}`;
            });
        }

        header.appendChild(leftSide);

        const actions = document.createElement('div');
        actions.className = 'header-actions';

        const btnSplitV = document.createElement('button');
        btnSplitV.textContent = '|';
        btnSplitV.title = 'Split Vertically';
        btnSplitV.onclick = () => this.stateManager.splitPanel(node.id, 'horizontal');
        actions.appendChild(btnSplitV);

        const btnSplitH = document.createElement('button');
        btnSplitH.textContent = '-';
        btnSplitH.title = 'Split Horizontally';
        btnSplitH.onclick = () => this.stateManager.splitPanel(node.id, 'vertical');
        actions.appendChild(btnSplitH);

        const btnClose = document.createElement('button');
        btnClose.textContent = 'x';
        btnClose.title = 'Close Panel';
        btnClose.onclick = () => this.stateManager.closePanel(node.id);
        actions.appendChild(btnClose);

        header.appendChild(actions);

        return header;
    }

    private renderPanelContent(node: PanelNode, container: HTMLElement): void {
        // Cleanup existing component for this panel if it exists but is of different type
        const existing = this.components.get(node.id);
        if (existing && existing.type !== node.panelType) {
            existing.instance.destroy?.();
            this.components.delete(node.id);
        }

        switch (node.panelType) {
            case 'OUTLINER':
                this.renderOutliner(container);
                break;
            case 'NODE_GRAPH':
                this.renderNodeGraph(node, container);
                break;
            case 'PROPERTIES':
                this.renderProperties(node, container);
                break;
            case 'NODE_VIEWER':
                this.renderNodeViewer(node, container);
                break;
            case 'TELEMETRY_TEXT':
                container.innerHTML = '<div style="padding:10px">Telemetry Text (Move to Node Graph to see per-node logs)</div>';
                break;
            case 'TELEMETRY_GRAPH':
                container.innerHTML = '<div style="padding:10px">Telemetry Graph (Move to Node Graph to see per-node charts)</div>';
                break;
        }
    }

    private renderOutliner(container: HTMLElement): void {
        const outliner = document.createElement('ul');
        outliner.id = 'outliner';
        container.appendChild(outliner);

        const update = (state: SimulationState) => {
            outliner.innerHTML = '';
            const selectedId = this.stateManager.getSelectedNodeId();
            state.nodes.forEach(node => {
                const li = document.createElement('li');
                li.textContent = `${node.type} (${node.id})`;
                li.onclick = () => this.stateManager.setSelectedNode(node.id);
                if (node.id === selectedId) {
                    li.className = 'selected';
                }
                outliner.appendChild(li);
            });
        };
        this.stateManager.onStateChange(update);
        this.stateManager.onSelectionChange(() => update(this.stateManager.getCurrentState()!));
        update(this.stateManager.getCurrentState()!);
    }

    private renderNodeGraph(node: PanelNode, container: HTMLElement): void {
        // Reuse or create GraphRenderer
        let comp = this.components.get(node.id);
        if (!comp) {
            const renderer = new GraphRenderer(container, this.stateManager);
            renderer.onNodeSelected = (nodeId) => {
                this.stateManager.setSelectedNode(nodeId);
                this.setSelectedNodeOnAllPropertiesPanels(nodeId);
            };
            comp = { type: 'NODE_GRAPH', instance: renderer };
            this.components.set(node.id, comp);

            // Add simulation controls
            this.injectSimulationControls(container);
        } else {
            // Re-append viewport if reusing
            container.appendChild(comp.instance.viewport);
            this.injectSimulationControls(container);
        }
    }

    private renderProperties(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const editor = new PropertyEditor(container, this.stateManager);
            comp = { type: 'PROPERTIES', instance: editor };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
        }
    }

    private renderNodeViewer(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const viewer = new NodeViewer(container, this.stateManager);
            comp = { type: 'NODE_VIEWER', instance: viewer };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
        }
        comp.instance.setNode(node.targetNodeId);
    }

    private setSelectedNodeOnAllPropertiesPanels(nodeId: string | null): void {
        this.components.forEach(comp => {
            if (comp.type === 'PROPERTIES') {
                comp.instance.setSelectedNode(nodeId);
            }
        });
    }

    private injectSimulationControls(container: HTMLElement): void {
        // Check if controls already exist in this container
        if (container.querySelector('.header-actions-sim')) return;

        const simActions = document.createElement('div');
        simActions.className = 'header-actions-sim';
        simActions.style.padding = '4px';
        simActions.style.borderBottom = '1px solid #333';
        simActions.style.display = 'flex';
        simActions.style.gap = '4px';
        simActions.style.flexWrap = 'wrap';
        simActions.style.alignItems = 'center';

        const createBtn = (id: string, text: string, className: string = 'header-button') => {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.className = className;
            return btn;
        };

        simActions.appendChild(createBtn('auto-arrange-btn', 'Auto', 'header-button secondary'));
        simActions.appendChild(createBtn('init-btn', 'Init'));

        const group = document.createElement('div');
        group.className = 'button-group';
        group.appendChild(createBtn('exec-1-btn', '1', 'header-button secondary'));
        group.appendChild(createBtn('exec-10-btn', '10', 'header-button secondary'));
        group.appendChild(createBtn('exec-100-btn', '100', 'header-button secondary'));
        group.appendChild(createBtn('exec-1000-btn', '1k', 'header-button secondary'));
        group.appendChild(createBtn('exec-end-btn', 'End', 'header-button secondary'));
        simActions.appendChild(group);

        simActions.appendChild(createBtn('pause-btn', 'Pause', 'header-button warning'));
        simActions.appendChild(createBtn('terminate-btn', 'Term', 'header-button danger'));

        const progressCont = document.createElement('div');
        progressCont.className = 'progress-container';
        progressCont.style.position = 'relative';
        progressCont.style.width = '100px';
        progressCont.style.height = '10px';
        const progressBar = document.createElement('div');
        progressBar.id = 'progress-bar';
        progressBar.className = 'progress-bar';
        progressCont.appendChild(progressBar);
        simActions.appendChild(progressCont);

        container.prepend(simActions);
    }
}
