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
    private collapseState: Map<string, { collapsed: boolean; orientation: 'h' | 'v' }> = new Map();

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
        splitEl.style.overflow = 'visible';

        const isMenuSplit = (node.firstChild.type === 'panel' && node.firstChild.panelType === 'MENU_BAR');

        const firstChildWrapper = document.createElement('div');
        if (isMenuSplit) {
            firstChildWrapper.style.flex = '0 0 30px';
            firstChildWrapper.style.overflow = 'visible';
            firstChildWrapper.style.zIndex = '1000';
        } else {
            firstChildWrapper.style.flex = `${node.ratio}`;
            firstChildWrapper.style.overflow = 'visible';
        }
        firstChildWrapper.style.position = 'relative';
        firstChildWrapper.style.display = 'flex';
        firstChildWrapper.style.minWidth = '0';
        firstChildWrapper.style.minHeight = '0';
        // Store original flex so collapse/expand can restore the split ratio
        firstChildWrapper.dataset.originalFlex = firstChildWrapper.style.flex;

        const splitter = document.createElement('div');
        splitter.className = `splitter ${node.direction}`;
        splitter.style.backgroundColor = '#333';
        if (isMenuSplit) {
            splitter.style.flex = '0 0 1px';
            splitter.style.cursor = 'default';
        } else {
            splitter.style.flex = '0 0 4px';
            splitter.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
            this.setupSplitterDrag(splitter, node);
        }

        const secondChildWrapper = document.createElement('div');
        if (isMenuSplit) {
            secondChildWrapper.style.flex = '1';
        } else {
            secondChildWrapper.style.flex = `${1 - node.ratio}`;
        }
        secondChildWrapper.style.overflow = 'visible';
        secondChildWrapper.style.position = 'relative';
        secondChildWrapper.style.display = 'flex';
        secondChildWrapper.style.minWidth = '0';
        secondChildWrapper.style.minHeight = '0';
        // Store original flex so collapse/expand can restore the split ratio
        secondChildWrapper.dataset.originalFlex = secondChildWrapper.style.flex;

        // IMPORTANT: Append the full skeleton to the live DOM BEFORE rendering children.
        // applyCollapse (called during child renderNode) needs parent.parentElement to be
        // valid so it can find sibling wrappers and the adjacent splitter.
        splitEl.appendChild(firstChildWrapper);
        splitEl.appendChild(splitter);
        splitEl.appendChild(secondChildWrapper);
        parent.appendChild(splitEl);

        // Render children after the skeleton is in the live tree
        this.renderNode(node.firstChild, firstChildWrapper);
        this.renderNode(node.secondChild, secondChildWrapper);
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
        parent.dataset.panelId = node.id;
        parent.dataset.panelType = node.panelType;
        const panelEl = document.createElement('div');
        panelEl.className = 'panel';
        panelEl.style.display = 'flex';
        panelEl.style.flexDirection = 'column';
        panelEl.style.flex = '1';
        panelEl.style.height = '100%';
        panelEl.style.minWidth = '0';
        panelEl.style.minHeight = '0';
        if (node.panelType === 'MENU_BAR') {
            panelEl.style.overflow = 'visible';
            panelEl.style.zIndex = '1000';
        } else {
            panelEl.style.overflow = 'hidden';
        }

        const state = this.collapseState.get(node.id) ?? { collapsed: false, orientation: 'h' as 'h' | 'v' };

        // Apply collapse state to DOM elements
        const applyCollapse = (s: { collapsed: boolean; orientation: 'h' | 'v' }) => {
            const splitContainer = parent.parentElement;

            /** All non-splitter sibling wrappers in the same split container */
            const siblingWrappers = splitContainer
                ? (Array.from(splitContainer.children) as HTMLElement[])
                    .filter(el => !el.classList.contains('splitter') && el !== parent)
                : [];

            /** The splitter element(s) immediately adjacent to this wrapper */
            const adjacentSplitters = (): HTMLElement[] => {
                if (!splitContainer) return [];
                const children = Array.from(splitContainer.children) as HTMLElement[];
                const idx = children.indexOf(parent);
                const result: HTMLElement[] = [];
                if (idx > 0 && children[idx - 1].classList.contains('splitter'))
                    result.push(children[idx - 1] as HTMLElement);
                if (idx < children.length - 1 && children[idx + 1].classList.contains('splitter'))
                    result.push(children[idx + 1] as HTMLElement);
                return result;
            };

            if (!s.collapsed) {
                // ── EXPANDED ──
                header.style.display = '';
                content.style.display = 'flex';
                vStrip.style.display = 'none';
                // Restore this wrapper to its original split ratio
                parent.style.flex = parent.dataset.originalFlex || '';
                panelEl.style.height = '100%';
                panelEl.style.flex = '1';
                panelEl.style.width = '';
                // Restore siblings to their pre-collapse flex values
                siblingWrappers.forEach(sib => {
                    if (sib.dataset.savedFlex !== undefined) {
                        sib.style.flex = sib.dataset.savedFlex || sib.dataset.originalFlex || '';
                        delete sib.dataset.savedFlex;
                    }
                });
                // Restore adjacent splitters
                adjacentSplitters().forEach(sp => { sp.style.display = ''; });
                // Propagate expand upward in both directions to restore parent/grandparent wrappers
                this.propagateExpandUpward(splitContainer, 'h');
                this.propagateExpandUpward(splitContainer, 'v');

            } else if (s.orientation === 'h') {
                // ── HORIZONTAL COLLAPSE: thin header bar ──
                header.style.display = '';
                content.style.display = 'none';
                vStrip.style.display = 'none';
                
                panelEl.style.height = 'auto';
                panelEl.style.flex = '0 0 auto';
                panelEl.style.width = '';

                const isHorizontalSplit = splitContainer ? splitContainer.classList.contains('horizontal') : true;
                if (!isHorizontalSplit) {
                    // Match: parent split is vertical (column), so collapsing height collapses wrapper main axis
                    parent.style.flex = '0 0 auto';
                    
                    // Give uncollapsed siblings all freed space
                    siblingWrappers.forEach(sib => {
                        const f = sib.style.flex;
                        if (f !== '0 0 30px' && f !== '0 0 auto') {
                            sib.dataset.savedFlex = f;
                            sib.style.flex = '1';
                        }
                    });
                    // Hide adjacent splitter
                    adjacentSplitters().forEach(sp => { sp.style.display = 'none'; });
                    // Propagate upward
                    this.propagateCollapseUpward(splitContainer, 'h');
                } else {
                    // Mismatch: parent split is horizontal (row), keep wrapper width, only collapse panel height
                    parent.style.flex = parent.dataset.originalFlex || '';
                    // Check if this collapse propagates a horizontal collapse to ancestors
                    this.propagateCollapseUpward(splitContainer, 'h');
                }

            } else {
                // ── VERTICAL COLLAPSE: thin sidebar strip ──
                header.style.display = 'none';
                content.style.display = 'none';
                vStrip.style.display = 'flex';
                
                panelEl.style.flex = '1';
                panelEl.style.height = '100%';
                panelEl.style.width = '30px';

                const isHorizontalSplit = splitContainer ? splitContainer.classList.contains('horizontal') : true;
                if (isHorizontalSplit) {
                    // Match: parent split is horizontal (row), so collapsing width collapses wrapper main axis
                    parent.style.flex = '0 0 30px';
                    
                    // Give uncollapsed siblings all freed space
                    siblingWrappers.forEach(sib => {
                        const f = sib.style.flex;
                        if (f !== '0 0 30px' && f !== '0 0 auto') {
                            sib.dataset.savedFlex = f;
                            sib.style.flex = '1';
                        }
                    });
                    // Hide adjacent splitter
                    adjacentSplitters().forEach(sp => { sp.style.display = 'none'; });
                    // Propagate upward
                    this.propagateCollapseUpward(splitContainer, 'v');
                } else {
                    // Mismatch: parent split is vertical (column), keep wrapper height, only collapse panel width
                    parent.style.flex = parent.dataset.originalFlex || '';
                    // Check if this collapse propagates a vertical collapse to ancestors
                    this.propagateCollapseUpward(splitContainer, 'v');
                }
            }
        };

        const header = this.createPanelHeader(node, state, (newState) => {
            this.collapseState.set(node.id, newState);
            applyCollapse(newState);
        });
        panelEl.appendChild(header);

        const content = document.createElement('div');
        content.className = 'panel-content';
        if (node.panelType !== 'NODE_GRAPH' && node.panelType !== 'MENU_BAR') {
            content.classList.add('scrollable');
        }
        content.style.flex = '1';
        content.style.flexDirection = 'column';
        if (node.panelType === 'NODE_GRAPH') {
            content.style.overflow = 'hidden';
        } else if (node.panelType === 'MENU_BAR') {
            content.style.overflow = 'visible';
        } else {
            content.style.overflowY = 'auto';
            content.style.overflowX = 'hidden';
        }
        panelEl.appendChild(content);

        // Vertical strip — shown only when collapsed vertically
        const vStrip = this.createVerticalStrip(node, () => {
            const expanded = { collapsed: false, orientation: 'v' as 'h' | 'v' };
            this.collapseState.set(node.id, expanded);
            applyCollapse(expanded);
        });
        panelEl.appendChild(vStrip);

        // Apply initial state
        applyCollapse(state);

        parent.appendChild(panelEl);

        this.renderPanelContent(node, content);
    }

    /** Thin vertical strip shown when a panel is collapsed to the v-orientation. */
    private createVerticalStrip(node: PanelNode, onExpand: () => void): HTMLElement {
        const strip = document.createElement('div');
        strip.className = 'panel-v-strip';
        strip.style.display = 'none'; // hidden until v-collapse is active

        const expandBtn = document.createElement('button');
        expandBtn.textContent = '▶';
        expandBtn.title = 'Expand Panel';
        expandBtn.onclick = (e) => { e.stopPropagation(); onExpand(); };
        strip.appendChild(expandBtn);

        const label = document.createElement('span');
        label.className = 'panel-v-strip-label';
        label.textContent = node.panelType.replace(/_/g, ' ');
        strip.appendChild(label);

        // Clicking the strip itself also expands
        strip.onclick = () => onExpand();

        return strip;
    }

    private isWrapperCollapsed(wrapper: HTMLElement, dir: 'h' | 'v'): boolean {
        const panelEl = wrapper.querySelector(':scope > .panel') as HTMLElement | null;
        if (panelEl) {
            const panelType = wrapper.dataset.panelType;
            if (panelType === 'MENU_BAR') return true;

            const panelId = wrapper.dataset.panelId;
            if (!panelId) return false;
            const state = this.collapseState.get(panelId);
            return !!(state && state.collapsed && state.orientation === dir);
        }

        const splitEl = wrapper.querySelector(':scope > .split-container') as HTMLElement | null;
        if (splitEl) {
            const innerWrappers = (Array.from(splitEl.children) as HTMLElement[])
                .filter(el => !el.classList.contains('splitter'));
            return innerWrappers.length > 0 && innerWrappers.every(w => this.isWrapperCollapsed(w, dir));
        }

        return false;
    }

    /**
     * Called after a panel collapses.
     * Collapses ancestors if all children in their child splits are collapsed in the direction
     * demanded by the grandparent split. Recurses upward.
     */
    private propagateCollapseUpward(splitEl: HTMLElement | null, dir: 'h' | 'v'): void {
        if (!splitEl) return;
        const outerWrapper = splitEl.parentElement as HTMLElement | null;
        // Only managed wrappers (created by renderSplit) carry dataset.originalFlex
        if (!outerWrapper?.dataset.originalFlex) return;

        // Check if all children of splitEl are collapsed in dir
        const innerWrappers = (Array.from(splitEl.children) as HTMLElement[])
            .filter(el => !el.classList.contains('splitter'));
        const allCollapsed = innerWrappers.length > 0 && innerWrappers.every(
            w => this.isWrapperCollapsed(w, dir)
        );
        if (!allCollapsed) return;

        const outerSplitEl = outerWrapper.parentElement as HTMLElement | null;
        if (!outerSplitEl) return;

        const isOuterHorizontal = outerSplitEl.classList.contains('horizontal');
        const outerMainAxisMatchesDir = (dir === 'v' && isOuterHorizontal) || (dir === 'h' && !isOuterHorizontal);

        if (outerMainAxisMatchesDir) {
            // Skip if already propagation-collapsed (avoid double-processing)
            if (!outerWrapper.dataset.propCollapsed) {
                const outerChildren = Array.from(outerSplitEl.children) as HTMLElement[];
                const outerIdx = outerChildren.indexOf(outerWrapper);
                const outerSiblings = outerChildren.filter(
                    el => !el.classList.contains('splitter') && el !== outerWrapper
                ) as HTMLElement[];

                // Save & collapse the outer wrapper
                outerWrapper.dataset.propSavedFlex = outerWrapper.style.flex;
                outerWrapper.dataset.propCollapsed = '1';
                outerWrapper.style.flex = dir === 'v' ? '0 0 30px' : '0 0 auto';

                // Hide adjacent splitters at the outer level
                if (outerIdx > 0 && outerChildren[outerIdx - 1].classList.contains('splitter'))
                    (outerChildren[outerIdx - 1] as HTMLElement).style.display = 'none';
                if (outerIdx < outerChildren.length - 1 && outerChildren[outerIdx + 1].classList.contains('splitter'))
                    (outerChildren[outerIdx + 1] as HTMLElement).style.display = 'none';

                // Give uncollapsed outer siblings the freed space
                outerSiblings.forEach(sib => {
                    const f = sib.style.flex;
                    if (f !== '0 0 auto' && f !== '0 0 30px') {
                        sib.dataset.propSibSavedFlex = f;
                        sib.style.flex = '1';
                    }
                });
            }
        }

        // Recurse upward in the same collapse direction
        this.propagateCollapseUpward(outerSplitEl, dir);
    }

    /**
     * Called after a panel expands.
     * Restores parent wrappers if their child splits contain at least one expanded child.
     * Recurses upward.
     */
    private propagateExpandUpward(splitEl: HTMLElement | null, dir: 'h' | 'v'): void {
        if (!splitEl) return;
        const outerWrapper = splitEl.parentElement as HTMLElement | null;
        if (!outerWrapper) return;

        if (outerWrapper.dataset.propCollapsed) {
            const outerSplitEl = outerWrapper.parentElement as HTMLElement | null;
            if (outerSplitEl) {
                const isOuterHorizontal = outerSplitEl.classList.contains('horizontal');
                const outerMainAxisMatchesDir = (dir === 'v' && isOuterHorizontal) || (dir === 'h' && !isOuterHorizontal);

                if (outerMainAxisMatchesDir) {
                    // Check if any child wrapper of splitEl is NOT collapsed in dir
                    const innerWrappers = (Array.from(splitEl.children) as HTMLElement[])
                        .filter(el => !el.classList.contains('splitter'));
                    const anyExpanded = innerWrappers.some(
                        w => !this.isWrapperCollapsed(w, dir)
                    );

                    if (anyExpanded) {
                        const outerChildren = Array.from(outerSplitEl.children) as HTMLElement[];
                        const outerIdx = outerChildren.indexOf(outerWrapper);
                        const outerSiblings = outerChildren.filter(
                            el => !el.classList.contains('splitter') && el !== outerWrapper
                        ) as HTMLElement[];

                        // Restore the outer wrapper
                        outerWrapper.style.flex = outerWrapper.dataset.propSavedFlex || outerWrapper.dataset.originalFlex || '';
                        delete outerWrapper.dataset.propSavedFlex;
                        delete outerWrapper.dataset.propCollapsed;

                        // Show adjacent outer splitters
                        if (outerIdx > 0 && outerChildren[outerIdx - 1].classList.contains('splitter'))
                            (outerChildren[outerIdx - 1] as HTMLElement).style.display = '';
                        if (outerIdx < outerChildren.length - 1 && outerChildren[outerIdx + 1].classList.contains('splitter'))
                            (outerChildren[outerIdx + 1] as HTMLElement).style.display = '';

                        // Restore outer sibling flex values
                        outerSiblings.forEach(sib => {
                            if (sib.dataset.propSibSavedFlex !== undefined) {
                                sib.style.flex = sib.dataset.propSibSavedFlex || sib.dataset.originalFlex || '';
                                delete sib.dataset.propSibSavedFlex;
                            }
                        });

                        // Recurse upward
                        this.propagateExpandUpward(outerSplitEl, dir);
                    }
                }
            }
        } else {
            // Recurse upward to check outer ancestors
            this.propagateExpandUpward(outerWrapper.parentElement, dir);
        }
    }

    private createPanelHeader(
        node: PanelNode,
        state: { collapsed: boolean; orientation: 'h' | 'v' } = { collapsed: false, orientation: 'h' },
        onToggleCollapse?: (newState: { collapsed: boolean; orientation: 'h' | 'v' }) => void
    ): HTMLElement {
        if (node.panelType === 'MENU_BAR') {
            const emptyHeader = document.createElement('div');
            emptyHeader.style.display = 'none';
            return emptyHeader;
        }

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
            const currentOrientation = node.options?.layoutOrientation ?? 'HORIZ';
            const showGridVal = node.options?.showGrid !== false;
            const snapToGridVal = node.options?.snapToGrid !== false;
            const gridSpacingVal = node.options?.gridSpacing ?? 20;

            const layoutToggle = document.createElement('select');
            layoutToggle.className = 'header-select';
            layoutToggle.style.width = '60px';
            ['HORIZ', 'VERT'].forEach(l => {
                const opt = document.createElement('option');
                opt.value = l;
                opt.textContent = l;
                if (l === currentOrientation) opt.selected = true;
                layoutToggle.appendChild(opt);
            });
            layoutToggle.onchange = () => {
                const comp = this.components.get(node.id);
                if (comp && comp.type === 'NODE_GRAPH') {
                    comp.instance.setLayoutOrientation(layoutToggle.value);
                }
            };
            leftSide.appendChild(layoutToggle);

            const arrangeBtn = document.createElement('button');
            arrangeBtn.dataset.panelId = node.id;
            arrangeBtn.textContent = 'Arrange';
            arrangeBtn.className = 'header-button secondary auto-arrange-btn';
            arrangeBtn.style.marginLeft = '4px';
            leftSide.appendChild(arrangeBtn);

            const gridLabel = document.createElement('label');
            gridLabel.style.display = 'flex';
            gridLabel.style.alignItems = 'center';
            gridLabel.style.gap = '2px';
            gridLabel.style.fontSize = 'var(--font-xs)';
            gridLabel.style.marginLeft = '6px';
            gridLabel.innerHTML = '<input type="checkbox"> Grid';
            const gridCheckbox = gridLabel.querySelector('input')!;
            gridCheckbox.checked = showGridVal;
            gridCheckbox.onchange = () => {
                const comp = this.components.get(node.id);
                if (comp && comp.type === 'NODE_GRAPH') {
                    comp.instance.setShowGrid(gridCheckbox.checked);
                }
            };
            leftSide.appendChild(gridLabel);

            const snapLabel = document.createElement('label');
            snapLabel.style.display = 'flex';
            snapLabel.style.alignItems = 'center';
            snapLabel.style.gap = '2px';
            snapLabel.style.fontSize = 'var(--font-xs)';
            snapLabel.style.marginLeft = '6px';
            snapLabel.innerHTML = '<input type="checkbox"> Snap';
            const snapCheckbox = snapLabel.querySelector('input')!;
            snapCheckbox.checked = snapToGridVal;
            snapCheckbox.onchange = () => {
                const comp = this.components.get(node.id);
                if (comp && comp.type === 'NODE_GRAPH') {
                    comp.instance.setSnapToGrid(snapCheckbox.checked);
                }
            };
            leftSide.appendChild(snapLabel);

            const spacingSelect = document.createElement('select');
            spacingSelect.className = 'header-select';
            spacingSelect.style.width = '48px';
            spacingSelect.style.marginLeft = '6px';
            [10, 20, 40, 50].forEach(sz => {
                const opt = document.createElement('option');
                opt.value = sz.toString();
                opt.textContent = `${sz}px`;
                if (sz === gridSpacingVal) opt.selected = true;
                spacingSelect.appendChild(opt);
            });
            spacingSelect.onchange = () => {
                const comp = this.components.get(node.id);
                if (comp && comp.type === 'NODE_GRAPH') {
                    comp.instance.setGridSpacing(parseInt(spacingSelect.value));
                }
            };
            leftSide.appendChild(spacingSelect);

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

        // Fold horizontal — collapses to a thin header bar
        const btnCollapseH = document.createElement('button');
        btnCollapseH.className = 'panel-collapse-btn';
        btnCollapseH.title = state.collapsed && state.orientation === 'h' ? 'Expand Panel' : 'Collapse Horizontal';
        btnCollapseH.textContent = state.collapsed && state.orientation === 'h' ? '▲' : '▼';
        btnCollapseH.onclick = () => {
            const currentState = this.collapseState.get(node.id) ?? { collapsed: false, orientation: 'h' as 'h' | 'v' };
            const isHCollapsed = currentState.collapsed && currentState.orientation === 'h';
            const newState = isHCollapsed
                ? { collapsed: false, orientation: 'h' as 'h' | 'v' }
                : { collapsed: true, orientation: 'h' as 'h' | 'v' };
            btnCollapseH.textContent = newState.collapsed ? '▲' : '▼';
            btnCollapseH.title = newState.collapsed ? 'Expand Panel' : 'Collapse Horizontal';
            // Reset the v button if switching from v-collapse
            btnCollapseV.textContent = '◀';
            btnCollapseV.title = 'Collapse Vertical';
            onToggleCollapse?.(newState);
        };
        // Fold vertical — collapses to a thin sidebar strip
        const btnCollapseV = document.createElement('button');
        btnCollapseV.className = 'panel-collapse-btn';
        btnCollapseV.title = 'Collapse Vertical';
        btnCollapseV.textContent = '◀';
        btnCollapseV.onclick = () => {
            const currentState = this.collapseState.get(node.id) ?? { collapsed: false, orientation: 'h' as 'h' | 'v' };
            const isVCollapsed = currentState.collapsed && currentState.orientation === 'v';
            const newState = isVCollapsed
                ? { collapsed: false, orientation: 'v' as 'h' | 'v' }
                : { collapsed: true, orientation: 'v' as 'h' | 'v' };
            // When collapsing vertically the header disappears anyway, so no icon update needed
            btnCollapseH.textContent = '▼';
            btnCollapseH.title = 'Collapse Horizontal';
            onToggleCollapse?.(newState);
        };

        actions.appendChild(btnCollapseH);
        actions.appendChild(btnCollapseV);

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
            case 'MENU_BAR':
                this.renderMenuBar(container);
                break;
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

    private renderMenuBar(container: HTMLElement): void {
        container.innerHTML = `
            <div id="global-menu-bar">
                <div class="menu-item dropdown">
                    <span class="menu-title">File</span>
                    <div class="dropdown-content">
                        <div id="menu-new-model">New Model</div>
                        <div class="menu-separator"></div>
                        <div id="menu-load-json">Load Model (JSON)...</div>
                        <div id="menu-save-json">Save Model (JSON)</div>
                        <div class="menu-separator"></div>
                        <div id="menu-load-binary">Load Model (Binary)...</div>
                        <div id="menu-save-binary">Save Model (Binary)</div>
                    </div>
                </div>
            </div>
        `;
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
            const renderer = new GraphRenderer(container, this.stateManager, node.id);
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
        mainControls.style.gridTemplateColumns = '1fr';
        mainControls.style.gap = '8px';
        mainControls.appendChild(createBtn('init-btn', 'Initialize', 'header-button'));
        simActions.appendChild(mainControls);

        const stepControls = document.createElement('div');
        stepControls.style.display = 'grid';
        stepControls.style.gridTemplateColumns = 'repeat(5, 1fr)';
        stepControls.style.gap = '4px';
        stepControls.appendChild(createBtn('exec-1-btn', '1', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-10-btn', '10', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-100-btn', '100', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-1000-btn', '1000', 'header-button secondary'));
        stepControls.appendChild(createBtn('exec-end-btn', 'End', 'header-button success'));
        simActions.appendChild(stepControls);

        const runControls = document.createElement('div');
        runControls.style.display = 'grid';
        runControls.style.gridTemplateColumns = '1fr 1fr';
        runControls.style.gap = '8px';
        runControls.appendChild(createBtn('interrupt-btn', 'Interrupt', 'header-button warning'));
        runControls.appendChild(createBtn('terminate-btn', 'Terminate', 'header-button danger'));
        simActions.appendChild(runControls);

        const workspaceControls = document.createElement('div');
        workspaceControls.style.display = 'flex';
        workspaceControls.style.gap = '8px';
        workspaceControls.style.alignItems = 'center';

        const wsSelect = document.createElement('select');
        wsSelect.className = 'header-select';
        wsSelect.style.flex = '1';
        (this.stateManager as any).workspaces.forEach((_: any, i: number) => {
            const opt = document.createElement('option');
            opt.value = i.toString();
            opt.textContent = `Workspace ${i + 1}`;
            opt.selected = i === (this.stateManager as any).activeWorkspaceIndex;
            wsSelect.appendChild(opt);
        });

        wsSelect.onchange = () => {
            this.components.clear();
            this.container.innerHTML = '';
            (this.stateManager as any).switchWorkspace(parseInt(wsSelect.value));
        };

        workspaceControls.appendChild(wsSelect);

        const newWsBtn = createBtn('new-workspace-btn', 'New Page', 'header-button success');
        newWsBtn.style.width = 'auto';
        newWsBtn.onclick = () => {
            this.components.clear();
            this.container.innerHTML = '';
            (this.stateManager as any).createWorkspace();
        };
        workspaceControls.appendChild(newWsBtn);

        simActions.appendChild(workspaceControls);

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

        const progressLabel = document.createElement('div');
        progressLabel.id = 'progress-label';
        progressLabel.style.fontSize = 'var(--font-sm)';
        progressLabel.style.textAlign = 'center';
        progressLabel.style.marginTop = '4px';
        progressLabel.style.color = '#888';
        progressLabel.textContent = 'Ready';
        simActions.appendChild(progressLabel);

        container.appendChild(simActions);
    }
}
