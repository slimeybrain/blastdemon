import { StateManager } from './state-manager.js';
import { LayoutNode, SplitNode, PanelNode, SimulationState, PanelType } from './types.js';
import { GraphRenderer } from './graph-renderer.js';
import { PropertyEditor } from './property-editor.js';
import { NodeViewer } from './node-viewer.js';
import { ResourceManager } from './resource-manager.js';

export class LayoutManager {
    private container: HTMLElement;
    private stateManager: StateManager;
    public components: Map<string, any> = new Map();
    private lastState: SimulationState | null = null;

    constructor(containerId: string, stateManager: StateManager) {
        const container = document.getElementById(containerId);
        if (!container) throw new Error(`Container #${containerId} not found`);
        this.container = container;
        this.stateManager = stateManager;

        this.stateManager.onStateChange((state) => this.render(state));
    }

    public broadcastResourceData(data: any): void {
        this.components.forEach(comp => {
            if (comp.type === 'RESOURCE_MANAGER') {
                comp.instance.updateMetrics(data);
            }
        });
    }

    public render(state: SimulationState): void {
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
        const types: PanelType[] = ['OUTLINER', 'NODE_GRAPH', 'PROPERTIES', 'NODE_VIEWER', 'EXECUTION_MANAGER', 'RESOURCE_MANAGER'];
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
                const placeholder = document.createElement('option');
                placeholder.value = "";
                placeholder.textContent = "-- Select Node --";
                if (!node.targetNodeId) placeholder.selected = true;
                subSelect.appendChild(placeholder);

                state.nodes.forEach(n => {
                    const opt = document.createElement('option');
                    opt.value = n.id;
                    opt.textContent = `${n.type}: ${n.id}`;
                    if (n.id === node.targetNodeId) opt.selected = true;
                    subSelect.appendChild(opt);
                });
            }
            subSelect.onchange = () => this.stateManager.setPanelType(node.id, 'NODE_VIEWER', subSelect.value);
            leftSide.appendChild(subSelect);
        }

        if (node.panelType === 'NODE_GRAPH') {
            const layoutToggle = document.createElement('select');
            layoutToggle.className = 'header-select';
            layoutToggle.style.width = '60px';
            ['HORIZ', 'VERT'].forEach(l => {
                const opt = document.createElement('option');
                opt.value = l;
                opt.textContent = l;
                layoutToggle.appendChild(opt);
            });
            layoutToggle.onchange = () => {
                const comp = this.components.get(node.id);
                if (comp && comp.type === 'NODE_GRAPH') {
                    comp.instance.setLayoutOrientation(layoutToggle.value);
                }
            };
            leftSide.appendChild(layoutToggle);

            const statusBadge = document.createElement('div');
            statusBadge.id = 'status-badge';
            statusBadge.className = `status-badge badge-${this.stateManager.getStatus().toLowerCase()}`;
            statusBadge.textContent = this.stateManager.getStatus();
            leftSide.appendChild(statusBadge);

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
            case 'EXECUTION_MANAGER':
                this.renderExecutionManager(container);
                break;
            case 'RESOURCE_MANAGER':
                this.renderResourceManager(node, container);
                break;
            default:
                container.innerHTML = `<div style="padding:10px">Panel: ${node.panelType}</div>`;
        }
    }

    private renderOutliner(container: HTMLElement): void {
        const outliner = document.createElement('ul');
        outliner.id = 'outliner';
        outliner.className = 'outliner-container';
        outliner.style.listStyle = 'none';
        outliner.style.padding = '0';
        outliner.style.margin = '0';
        container.appendChild(outliner);

        const renderNodeTree = (state: SimulationState, nodeId: string, parentEl: HTMLElement, level: number, visited: Set<string>) => {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);

            const node = state.nodes.find(n => n.id === nodeId);
            if (!node) return;

            const li = document.createElement('li');
            li.className = this.stateManager.getSelectedNodeId() === nodeId ? 'selected' : '';
            li.style.paddingLeft = `${level * 16 + 8}px`;
            li.style.cursor = 'pointer';
            li.textContent = `${node.type} (${node.id})`;
            li.onclick = (e) => {
                e.stopPropagation();
                this.stateManager.setSelectedNode(node.id);
            };
            parentEl.appendChild(li);

            const children = state.connections
                .filter(c => c.fromNode === nodeId)
                .map(c => c.toNode);

            if (children.length > 0) {
                const subUl = document.createElement('ul');
                subUl.style.listStyle = 'none';
                subUl.style.padding = '0';
                subUl.style.margin = '0';
                parentEl.appendChild(subUl);
                children.forEach(childId => renderNodeTree(state, childId, subUl, level + 1, visited));
            }
        };

        const update = (state: SimulationState) => {
            outliner.innerHTML = '';
            const visited = new Set<string>();

            const rootNodes = state.nodes.filter(node =>
                !state.connections.some(conn => conn.toNode === node.id)
            );

            rootNodes.forEach(root => renderNodeTree(state, root.id, outliner, 0, visited));

            state.nodes.forEach(node => {
                if (!visited.has(node.id)) {
                    renderNodeTree(state, node.id, outliner, 0, visited);
                }
            });
        };

        this.stateManager.onStateChange(update);
        this.stateManager.onSelectionChange(() => update(this.stateManager.getCurrentState()!));
        update(this.stateManager.getCurrentState()!);
    }

    private renderNodeGraph(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const renderer = new GraphRenderer(container, this.stateManager);
            renderer.onNodeSelected = (nodeId) => {
                this.stateManager.setSelectedNode(nodeId);
                this.setSelectedNodeOnAllPropertiesPanels(nodeId);
            };
            comp = { type: 'NODE_GRAPH', instance: renderer };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.viewport);
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

    private renderResourceManager(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            container.innerHTML = '';
            const resourceManager = new ResourceManager(container, this.stateManager, node.id);
            comp = { type: 'RESOURCE_MANAGER', instance: resourceManager };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
        }
    }

    private renderExecutionManager(container: HTMLElement): void {
        const simActions = document.createElement('div');
        simActions.className = 'execution-manager-panel';
        simActions.style.padding = '12px';
        simActions.style.display = 'flex';
        simActions.style.flexDirection = 'column';
        simActions.style.gap = '10px';

        const createBtn = (id: string, text: string, className: string = 'header-button') => {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.className = className;
            btn.style.width = '100%';
            btn.style.padding = '8px';
            return btn;
        };

        const statusRow = document.createElement('div');
        statusRow.style.display = 'flex';
        statusRow.style.justifyContent = 'space-between';
        statusRow.style.alignItems = 'center';
        statusRow.innerHTML = `<span>Status:</span><div id="exec-status-badge" class="status-badge badge-${this.stateManager.getStatus().toLowerCase()}">${this.stateManager.getStatus()}</div>`;
        simActions.appendChild(statusRow);

        this.stateManager.onStatusChange((status) => {
            const badge = simActions.querySelector('#exec-status-badge');
            if (badge) {
                badge.textContent = status;
                badge.className = `status-badge badge-${status.toLowerCase()}`;
            }
        });

        const mainControls = document.createElement('div');
        mainControls.style.display = 'grid';
        mainControls.style.gridTemplateColumns = '1fr 1fr';
        mainControls.style.gap = '8px';
        mainControls.appendChild(createBtn('init-btn', 'Initialize', 'header-button'));
        mainControls.appendChild(createBtn('auto-arrange-btn', 'Auto Layout', 'header-button secondary'));
        simActions.appendChild(mainControls);

        const stepControls = document.createElement('div');
        stepControls.style.display = 'grid';
        stepControls.style.gridTemplateColumns = 'repeat(3, 1fr)';
        stepControls.style.gap = '4px';
        stepControls.appendChild(createBtn('exec-1-btn', '1 Step', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-100-btn', '100', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-end-btn', 'ToEnd', 'header-button success'));
        simActions.appendChild(stepControls);

        const runControls = document.createElement('div');
        runControls.style.display = 'grid';
        runControls.style.gridTemplateColumns = '1fr 1fr 1fr';
        runControls.style.gap = '8px';
        runControls.appendChild(createBtn('resume-btn', 'Resume', 'header-button success'));
        runControls.appendChild(createBtn('pause-btn', 'Pause', 'header-button warning'));
        runControls.appendChild(createBtn('terminate-btn', 'Terminate', 'header-button danger'));
        simActions.appendChild(runControls);

        const persistenceControls = document.createElement('div');
        persistenceControls.style.display = 'grid';
        persistenceControls.style.gridTemplateColumns = '1fr 1fr';
        persistenceControls.style.gap = '8px';
        persistenceControls.appendChild(createBtn('save-workspace-btn', 'Save', 'header-button success'));

        const resetBtn = createBtn('reset-workspace-btn', 'Reset System', 'header-button danger');
        resetBtn.onclick = () => {
            if (window.confirm("CRITICAL: This will flush all local storage and reload the application. Proceed?")) {
                this.stateManager.clearWorkspace();
                window.location.reload();
            }
        };
        persistenceControls.appendChild(resetBtn);
        simActions.appendChild(persistenceControls);

        const progressCont = document.createElement('div');
        progressCont.className = 'progress-container';
        progressCont.style.height = '10px';
        progressCont.style.background = '#333';
        progressCont.style.marginTop = '10px';
        const progressBar = document.createElement('div');
        progressBar.id = 'progress-bar';
        progressBar.className = 'progress-bar';
        progressBar.style.width = '0%';
        progressCont.appendChild(progressBar);
        simActions.appendChild(progressCont);

        container.appendChild(simActions);
    }
}
