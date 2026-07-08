import { StateManager } from './state-manager.js';
import { LayoutNode, SplitNode, PanelNode, SimulationState, PanelType } from './types.js';
import { GraphRenderer } from './graph-renderer.js';
import { PropertyEditor } from './property-editor.js';
import { NodeViewer } from './node-viewer.js';
import { ResourceManager } from './resource-manager.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';

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

    /** Fingerprint that captures only the *structural* shape of the layout (node
     *  IDs, panel types, split directions) but NOT ratio values or options.
     *  This lets us skip full DOM rebuilds when only ratios change (e.g. during
     *  splitter drag) and instead patch the flex values in-place.
     */
    private structuralFingerprint(layout: LayoutNode): string {
        if (layout.type === 'panel') {
            return `P:${layout.id}:${layout.panelType}:${layout.targetNodeId ?? ''}`;
        }
        return `S:${layout.id}:${layout.direction}|${this.structuralFingerprint(layout.firstChild)}|${this.structuralFingerprint(layout.secondChild)}`;
    }

    private getLayoutPanelIds(layout: LayoutNode): Set<string> {
        const ids = new Set<string>();
        const traverse = (node: LayoutNode) => {
            if (node.type === 'panel') {
                ids.add(node.id);
            } else if (node.type === 'split') {
                traverse(node.firstChild);
                traverse(node.secondChild);
            }
        };
        traverse(layout);
        return ids;
    }

    public render(state: SimulationState): void {
        const structFingerprint = this.structuralFingerprint(state.layout);
        const nodesJson = JSON.stringify(state.nodes.map(n => n.id));
        const currentStructural = structFingerprint + nodesJson;

        const lastStructural = this.lastState
            ? this.structuralFingerprint(this.lastState.layout) + JSON.stringify(this.lastState.nodes.map(n => n.id))
            : '';

        if (currentStructural !== lastStructural) {
            // Destroy any components not in the new layout
            const activePanelIds = this.getLayoutPanelIds(state.layout);
            for (const [id, comp] of this.components.entries()) {
                if (!activePanelIds.has(id)) {
                    comp.instance.destroy?.();
                    this.components.delete(id);
                }
            }

            // Structure changed — full DOM rebuild required.
            this.container.innerHTML = '';
            this.renderNode(state.layout, this.container);
        } else {
            // Structure is the same; only ratios/options may have changed.
            // Patch the flex ratios in-place to avoid destroying the DOM.
            this.patchRatios(state.layout);
        }
        this.lastState = state;
    }


    /**
     * Walk the live DOM and update the flex values of split wrappers to match
     * the new ratio, without tearing down any elements.
     */
    private patchRatios(layout: LayoutNode): void {
        if (layout.type !== 'split') return;

        const splitEl = this.container.querySelector(`[data-split-id="${layout.id}"]`) as HTMLElement | null;
        if (splitEl) {
            const wrappers = Array.from(splitEl.children).filter(
                el => !(el as HTMLElement).classList.contains('splitter')
            ) as HTMLElement[];
            if (wrappers.length === 2) {
                const isMenuSplit = (
                    layout.firstChild.type === 'panel' &&
                    layout.firstChild.panelType === 'MENU_BAR'
                );
                if (!isMenuSplit) {
                    wrappers[0].style.flex = `${layout.ratio}`;
                    wrappers[1].style.flex = `${1 - layout.ratio}`;
                    // Keep dataset in sync so collapse/expand can restore them.
                    wrappers[0].dataset.originalFlex = wrappers[0].style.flex;
                    wrappers[1].dataset.originalFlex = wrappers[1].style.flex;
                }
            }
        }

        this.patchRatios(layout.firstChild);
        this.patchRatios(layout.secondChild);
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
        splitEl.dataset.splitId = node.id;
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
        const types: PanelType[] = ['OUTLINER', 'NODE_GRAPH', 'PROPERTIES', 'NODE_VIEWER', 'EXECUTION_MANAGER', 'RESOURCE_MANAGER', 'TELEMETRY_3D'];
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

            const fitBtn = document.createElement('button');
            fitBtn.dataset.panelId = node.id;
            fitBtn.textContent = 'Fit';
            fitBtn.className = 'header-button secondary fit-view-btn';
            fitBtn.style.marginLeft = '4px';
            leftSide.appendChild(fitBtn);

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
                this.renderMenuBar(node, container);
                break;
            case 'OUTLINER':
                this.renderOutliner(node, container);
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
                this.renderExecutionManager(node, container);
                break;
            case 'RESOURCE_MANAGER':
                this.renderResourceManager(node, container);
                break;
            case 'TELEMETRY_3D':
                this.renderTelemetry3D(node, container);
                break;
            default:
                container.innerHTML = `<div style="padding:10px">Panel: ${node.panelType}</div>`;
        }

    }
    private renderMenuBar(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const menuBar = new MenuBarComponent(container, this.stateManager);
            comp = { type: 'MENU_BAR', instance: menuBar };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
            comp.instance.render();
        }
    }

    private renderTelemetry3D(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const viewport = new Telemetry3DViewport(container, node.id, this.stateManager);
            comp = { type: 'TELEMETRY_3D', instance: viewport, container };
            this.components.set(node.id, comp);
        } else {
            if (comp.container !== container) {
                comp.container = container;
            }
            comp.instance.attachTo(container);
        }
    }

    private renderOutliner(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const outliner = new OutlinerComponent(container, this.stateManager);
            comp = { type: 'OUTLINER', instance: outliner };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
            comp.instance.render();
        }
    }


    private renderNodeGraph(node: PanelNode, container: HTMLElement): void {
        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) {
            const existing = this.components.get(node.id);
            if (existing) {
                existing.instance.destroy?.();
                this.components.delete(node.id);
            }
            container.innerHTML = `
                <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#111; color:#888; font-family:var(--font-ui); font-size:13px; text-align:center; padding:20px; height:100%;">
                    <div style="font-size:24px; margin-bottom:12px;">✏</div>
                    <div>No models in this workspace.</div>
                    <div style="margin-top:8px; font-size:11px; opacity:0.7;">Go to the <b>Workspace</b> menu to add/load models.</div>
                </div>
            `;
            return;
        }

        let comp = this.components.get(node.id);
        if (!comp) {
            container.innerHTML = '';
            const renderer = new GraphRenderer(container, this.stateManager, node.id);
            renderer.onNodeSelected = (nodeId) => {
                this.stateManager.setSelectedNode(nodeId);
                this.setSelectedNodeOnAllPropertiesPanels(nodeId);
            };
            comp = { type: 'NODE_GRAPH', instance: renderer };
            this.components.set(node.id, comp);
        } else {
            if (!container.contains(comp.instance.viewport)) {
                container.innerHTML = '';
                container.appendChild(comp.instance.viewport);
            }
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

    private renderExecutionManager(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            container.innerHTML = '';
            const execMgr = new ExecutionManagerComponent(container, this.stateManager);
            comp = { type: 'EXECUTION_MANAGER', instance: execMgr };
            this.components.set(node.id, comp);
        } else {
            container.appendChild(comp.instance.container);
            comp.instance.updateTargets();
        }
    }
}

// --- Managed Component Classes ---

class MenuBarComponent {
    public container: HTMLElement;
    private stateManager: StateManager;
    private listener: () => void;

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.overflow = 'visible';
        parent.appendChild(this.container);
        this.stateManager = stateManager;
        this.listener = () => this.render();
        this.stateManager.onStateChange(this.listener);
        this.render();
    }

    destroy() {
        this.stateManager.offStateChange(this.listener);
        this.container.remove();
    }

    render() {
        const activeWs = this.stateManager.getActiveWorkspace();
        const workspaces = this.stateManager.getAllWorkspaces();
        
        let fileMenuHTML = `
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
                    <div class="menu-separator"></div>
                    <div id="menu-copy-model">Copy Active Model</div>
                    <div id="menu-paste-model">Paste Model</div>
                </div>
            </div>
        `;

        let wsMenuHTML = `
            <div class="menu-item dropdown">
                <span class="menu-title">Workspace</span>
                <div class="dropdown-content">
                    <div id="menu-new-workspace">New Workspace</div>
                    <div id="menu-dup-layout">Duplicate Layout</div>
                    <div class="menu-separator"></div>
                    <div id="menu-add-model">Add Model to Workspace...</div>
                    <div id="menu-remove-model">Remove Model...</div>
                    <div class="menu-separator"></div>
                    <div id="menu-save-workspace">Save All</div>
                    <div id="menu-export-workspace">Export Workspace (JSON)...</div>
                    <div id="menu-import-workspace">Import Workspace (JSON)...</div>
                    <div class="menu-separator"></div>
                    <div id="menu-reset-all" style="color:#ef4444">Reset All (Danger)</div>
                </div>
            </div>
        `;

        let tabsHTML = `<div class="workspace-tabs-container">`;
        workspaces.forEach((ws) => {
            const isActive = ws.id === activeWs.id;
            const modelCount = ws.modelIds.length;
            const badgeText = modelCount === 0 ? 'empty' : `${modelCount} model${modelCount > 1 ? 's' : ''}`;
            const closeBtnHTML = workspaces.length > 1 ? `<span class="workspace-tab-close" data-ws-id="${ws.id}" title="Close Workspace">×</span>` : '';
            
            tabsHTML += `
                <div class="workspace-tab ${isActive ? 'active' : ''}" data-ws-id="${ws.id}">
                    <span class="workspace-tab-name" data-ws-id="${ws.id}">${ws.name}</span>
                    <span class="workspace-tab-badge">${badgeText}</span>
                    ${closeBtnHTML}
                </div>
            `;
        });
        tabsHTML += `
            <button class="add-workspace-btn" id="btn-add-workspace" title="New Workspace">+</button>
        </div>`;

        this.container.innerHTML = `
            <div id="global-menu-bar">
                ${fileMenuHTML}
                ${wsMenuHTML}
                ${tabsHTML}
            </div>
        `;

        this.container.querySelectorAll('.workspace-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const target = e.currentTarget as HTMLElement;
                const wsId = target.dataset.wsId;
                if (wsId) this.stateManager.switchWorkspace(wsId);
            });

            const closeBtn = tab.querySelector('.workspace-tab-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const wsId = (closeBtn as HTMLElement).dataset.wsId;
                    if (wsId && confirm("Close this workspace? All its unsaved layouts will be discarded.")) {
                        this.stateManager.deleteWorkspace(wsId);
                    }
                });
            }

            const nameEl = tab.querySelector('.workspace-tab-name') as HTMLElement;
            if (nameEl) {
                nameEl.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const wsId = nameEl.dataset.wsId;
                    const oldName = nameEl.textContent || '';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = oldName;
                    input.style.fontSize = '11px';
                    input.style.background = '#1e1e24';
                    input.style.border = '1px solid #00f0ff';
                    input.style.color = '#fff';
                    input.style.padding = '0 2px';
                    input.style.outline = 'none';
                    input.style.width = '100px';

                    const finishRename = () => {
                        const newName = input.value.trim();
                        if (newName && wsId) {
                            this.stateManager.renameWorkspace(wsId, newName);
                        } else {
                            nameEl.textContent = oldName;
                        }
                    };

                    input.addEventListener('blur', finishRename);
                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter') finishRename();
                        if (ev.key === 'Escape') {
                            nameEl.textContent = oldName;
                        }
                    });

                    nameEl.innerHTML = '';
                    nameEl.appendChild(input);
                    input.focus();
                    input.select();
                });
            }
        });

        const addBtn = this.container.querySelector('#btn-add-workspace');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.stateManager.createWorkspace();
            });
        }
    }
}

const NODE_ICONS: Record<string, string> = {
    'DomainMesh': '🌐',
    'Material': '💨',
    'Charge1D': '💥',
    'Charge2D': '💥',
    'ThePainter': '🎨',
    'CFDSolver': '⚡',
    'TelemetryText': '📝',
    'TelemetryGraph': '📈',
    'DomainMesh2D': '🌐',
    'DetonatorLocation': '🎯',
    'RemapNode': '🔄',
    'HardwareConfig': '⚙️',
    'CFDSolver2D': '⚡',
    'TelemetryContour': '🗺️',
    'VTKOutput': '💾',
    'VirtualGauges': '⏱️'
};

function getNodeIcon(type: string): string {
    return NODE_ICONS[type] || '📦';
}

class OutlinerComponent {
    public container: HTMLElement;
    private stateManager: StateManager;
    private listener: () => void;
    private selectionListener: () => void;
    private collapsedNodes: Set<string> = new Set();

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.id = 'outliner';
        this.container.className = 'outliner-container';
        this.container.style.padding = '8px';
        this.container.style.fontFamily = 'var(--font-ui)';
        this.container.style.fontSize = '12px';
        this.container.style.height = '100%';
        this.container.style.overflowY = 'auto';
        parent.appendChild(this.container);

        this.stateManager = stateManager;
        this.listener = () => this.render();
        this.selectionListener = () => this.render();
        this.stateManager.onStateChange(this.listener);
        this.stateManager.onSelectionChange(this.selectionListener);
        this.render();
    }

    destroy() {
        this.stateManager.offStateChange(this.listener);
        this.stateManager.offSelectionChange(this.selectionListener);
        this.container.remove();
    }

    render() {
        this.container.innerHTML = '';
        const ws = this.stateManager.getActiveWorkspace();
        if (!ws) return;

        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) {
            this.container.innerHTML = `
                <div style="color:#666; font-style:italic; text-align:center; padding:20px;">
                    No models loaded.
                </div>
            `;
            return;
        }

        models.forEach(model => {
            const modelSection = document.createElement('div');
            modelSection.style.marginBottom = '12px';

            const header = document.createElement('div');
            header.className = 'outliner-model-header';
            header.style.display = 'flex';
            header.style.alignItems = 'center';
            header.style.justifyContent = 'space-between';
            header.style.cursor = 'pointer';
            header.style.padding = '4px 6px';
            header.style.borderRadius = '3px';
            header.style.background = '#252526';
            header.style.border = '1px solid #333';

            const getColors = (id: string) => {
                let hash = 0;
                for (let i = 0; i < id.length; i++) {
                    hash = id.charCodeAt(i) + ((hash << 5) - hash);
                }
                const h = Math.abs(hash) % 360;
                return `hsl(${h}, 75%, 60%)`;
            };

            const accentColor = getColors(model.id);
            const isActive = ws.activeModelId === model.id;

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '6px';

            const radio = document.createElement('span');
            radio.innerHTML = isActive ? '●' : '○';
            radio.style.color = isActive ? '#00f0ff' : '#888';
            radio.style.fontSize = '12px';
            left.appendChild(radio);

            const info = document.createElement('div');
            info.style.display = 'flex';
            info.style.flexDirection = 'column';
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = model.name;
            nameSpan.style.fontWeight = 'bold';
            nameSpan.style.color = accentColor;
            info.appendChild(nameSpan);

            const fileSpan = document.createElement('span');
            fileSpan.textContent = model.filename || 'unsaved.json';
            fileSpan.style.fontSize = '10px';
            fileSpan.style.color = '#888';
            fileSpan.style.fontStyle = 'italic';
            info.appendChild(fileSpan);

            left.appendChild(info);
            header.appendChild(left);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            
            const closeModelBtn = document.createElement('button');
            closeModelBtn.innerHTML = '×';
            closeModelBtn.title = 'Close Model';
            closeModelBtn.style.background = 'none';
            closeModelBtn.style.border = 'none';
            closeModelBtn.style.color = '#888';
            closeModelBtn.style.cursor = 'pointer';
            closeModelBtn.style.fontSize = '14px';
            closeModelBtn.style.padding = '0 4px';
            closeModelBtn.style.lineHeight = '1';
            closeModelBtn.onmouseenter = () => closeModelBtn.style.color = '#ef4444';
            closeModelBtn.onmouseleave = () => closeModelBtn.style.color = '#888';
            closeModelBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Close model "${model.name}" in this workspace?`)) {
                    this.stateManager.removeModelFromWorkspace(model.id);
                }
            };
            right.appendChild(closeModelBtn);
            header.appendChild(right);

            header.addEventListener('click', () => {
                this.stateManager.setActiveModel(model.id);
            });

            modelSection.appendChild(header);

            const list = document.createElement('ul');
            list.style.listStyle = 'none';
            list.style.padding = '0';
            list.style.margin = '4px 0 0 0';

            const renderNodeTree = (nodeId: string, parentEl: HTMLElement, level: number, visited: Set<string>) => {
                if (visited.has(nodeId)) return;
                visited.add(nodeId);

                const node = model.nodes.find(n => n.id === nodeId);
                if (!node) return;

                const children = model.connections
                    .filter(c => c.fromNode === nodeId)
                    .map(c => c.toNode);

                const unvisitedChildren = children.filter(cId => !visited.has(cId));

                const li = document.createElement('li');
                li.className = 'outliner-item';
                li.style.listStyle = 'none';
                li.style.margin = '0';
                li.style.padding = '0';

                const row = document.createElement('div');
                row.className = 'outliner-node-row';
                if (this.stateManager.getSelectedNodeId() === node.id) {
                    row.classList.add('selected');
                }

                // Indentation of the row based on level
                const indent = level * 12;
                row.style.paddingLeft = `${indent + 6}px`;
                row.style.paddingTop = '6px';
                row.style.paddingBottom = '6px';
                row.style.paddingRight = '8px';

                // Arrow
                const arrow = document.createElement('span');
                arrow.className = 'outliner-node-arrow';
                const isCollapsed = this.collapsedNodes.has(node.id);

                if (unvisitedChildren.length > 0) {
                    arrow.innerHTML = isCollapsed ? '▶' : '▼';
                    arrow.onclick = (e) => {
                        e.stopPropagation();
                        if (isCollapsed) {
                            this.collapsedNodes.delete(node.id);
                        } else {
                            this.collapsedNodes.add(node.id);
                        }
                        this.render();
                    };
                } else {
                    arrow.innerHTML = '&nbsp;';
                    arrow.style.opacity = '0';
                }
                row.appendChild(arrow);

                // Icon
                const icon = document.createElement('span');
                icon.className = 'outliner-node-icon';
                icon.innerHTML = getNodeIcon(node.type);
                icon.style.marginRight = '4px';
                row.appendChild(icon);

                // Label
                const label = document.createElement('span');
                label.className = 'outliner-node-label';
                
                const typeSpan = document.createElement('span');
                typeSpan.textContent = node.type;
                typeSpan.style.fontWeight = '500';
                
                const idSpan = document.createElement('span');
                idSpan.textContent = ` (${node.id})`;
                idSpan.style.color = '#888';
                idSpan.style.fontSize = '10px';

                label.appendChild(typeSpan);
                label.appendChild(idSpan);
                row.appendChild(label);

                row.onclick = (e) => {
                    e.stopPropagation();
                    this.stateManager.setSelectedNode(node.id);
                };

                li.appendChild(row);
                parentEl.appendChild(li);

                if (unvisitedChildren.length > 0) {
                    const subUl = document.createElement('ul');
                    subUl.className = 'outliner-sub-list';
                    subUl.style.listStyle = 'none';
                    subUl.style.padding = '0';
                    subUl.style.margin = '0';
                    if (isCollapsed) {
                        subUl.style.display = 'none';
                    }
                    li.appendChild(subUl);
                    unvisitedChildren.forEach(childId => renderNodeTree(childId, subUl, level + 1, visited));
                }
            };

            const visited = new Set<string>();
            const rootNodes = model.nodes.filter(node =>
                !model.connections.some(conn => conn.toNode === node.id)
            );

            rootNodes.forEach(root => renderNodeTree(root.id, list, 0, visited));
            model.nodes.forEach(node => {
                if (!visited.has(node.id)) {
                    renderNodeTree(node.id, list, 0, visited);
                }
            });

            modelSection.appendChild(list);
            this.container.appendChild(modelSection);
        });
    }
}

class ExecutionManagerComponent {
    public container: HTMLElement;
    private stateManager: StateManager;
    private statusListener: (status: any) => void;
    private stateListener: () => void;
    private modelStatusListener: (modelId: string, status: any) => void;
    private telemetryListener: (nodeId: string, data: any) => void;
    
    private connectionBadge!: HTMLElement;
    private targetsListContainer!: HTMLElement;
    

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.className = 'execution-manager-panel';
        parent.appendChild(this.container);

        this.stateManager = stateManager;

        this.buildStructure();

        this.statusListener = () => this.updateTargets();
        this.stateManager.onStatusChange(this.statusListener);

        this.modelStatusListener = () => this.updateTargets();
        this.stateManager.onModelStatusChange(this.modelStatusListener);

        this.stateListener = () => this.updateTargets();
        this.stateManager.onStateChange(this.stateListener);

        this.telemetryListener = (nodeId, data) => {
            if (data && typeof data === 'object') {
                if (data.type === 'progress' || data.type === 'progress_2d' || data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D') {
                    this.updateTargets();
                }
            }
        };
        this.stateManager.onTelemetryUpdate(this.telemetryListener);

        this.updateTargets();
    }

    destroy() {
        this.stateManager.offStatusChange(this.statusListener);
        this.stateManager.offModelStatusChange(this.modelStatusListener);
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.container.remove();
    }
    
    private buildStructure() {
        this.container.innerHTML = '';

        // Title and connection header
        const headerRow = document.createElement('div');
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        headerRow.style.borderBottom = '1px solid #333';
        headerRow.style.paddingBottom = '8px';
        headerRow.style.marginBottom = '12px';
        
        const titleSpan = document.createElement('span');
        titleSpan.style.fontWeight = 'bold';
        titleSpan.style.fontSize = '12px';
        titleSpan.style.color = '#00f0ff';
        titleSpan.textContent = 'Execution Control';
        headerRow.appendChild(titleSpan);

        this.connectionBadge = document.createElement('span');
        this.connectionBadge.className = 'execution-connection-status connection-disconnected';
        this.connectionBadge.textContent = 'Offline';
        headerRow.appendChild(this.connectionBadge);

        this.container.appendChild(headerRow);



        // Targets Header
        const targetsHeader = document.createElement('div');
        targetsHeader.style.fontWeight = 'bold';
        targetsHeader.style.fontSize = '11px';
        targetsHeader.style.color = '#888';
        targetsHeader.style.letterSpacing = '0.05em';
        targetsHeader.style.marginBottom = '8px';
        targetsHeader.textContent = 'EXECUTION TARGETS';
        this.container.appendChild(targetsHeader);

        // Targets list container
        this.targetsListContainer = document.createElement('div');
        this.targetsListContainer.style.display = 'flex';
        this.targetsListContainer.style.flexDirection = 'column';
        this.targetsListContainer.style.gap = '10px';
        this.container.appendChild(this.targetsListContainer);
    }

    private findPipeline(modelId: string) {
        const ws = this.stateManager.getActiveWorkspace();
        if (!ws) return null;

        const wsConns = ws.connections as Array<{fromNode:string,fromPort:string,toNode:string,toPort:string}>;
        const allModels = this.stateManager.getAllModels();

        const nodeToModel = new Map<string, string>();
        for (const mId of ws.modelIds) {
            const m = allModels.find(x => x.id === mId);
            m?.nodes.forEach(n => nodeToModel.set(n.id, mId));
        }

        for (const conn of wsConns) {
            const fromModelId = nodeToModel.get(conn.fromNode);
            const toModelId   = nodeToModel.get(conn.toNode);
            if (!fromModelId || !toModelId || fromModelId === toModelId) continue;

            const toModel  = allModels.find(m => m.id === toModelId);
            const toNode   = toModel?.nodes.find(n => n.id === conn.toNode);
            if (toNode?.type !== 'RemapNode') continue;

            const fromModel = allModels.find(m => m.id === fromModelId);
            if (!fromModel?.nodes.some(n => n.type === 'CFDSolver')) continue;

            // ONLY match if modelId is the 2D target model!
            if (modelId === toModelId) {
                return {
                    model1dId: fromModelId,
                    model2dId: toModelId,
                    processId: toModelId,
                };
            }
        }
        return null;
    }

    private createCard(model: any): HTMLElement {
        const card = document.createElement('div');
        card.className = 'execution-target-card';
        card.dataset.modelId = model.id;

        // Header row
        const headerRow = document.createElement('div');
        headerRow.className = 'execution-target-header';

        const metaDiv = document.createElement('div');
        metaDiv.className = 'execution-target-meta';

        const getColors = (id: string) => {
            let hash = 0;
            for (let i = 0; i < id.length; i++) {
                hash = id.charCodeAt(i) + ((hash << 5) - hash);
            }
            const h = Math.abs(hash) % 360;
            return `hsl(${h}, 75%, 60%)`;
        };
        const accentColor = getColors(model.id);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'execution-target-name';
        nameSpan.textContent = model.name;
        nameSpan.style.color = accentColor;

        metaDiv.appendChild(nameSpan);
        headerRow.appendChild(metaDiv);

        const badge = document.createElement('div');
        badge.className = `status-badge`;
        headerRow.appendChild(badge);
        card.appendChild(headerRow);

        // Progress bar and details
        const progressContainer = document.createElement('div');
        progressContainer.className = 'progress-bar-container';

        const progressBg = document.createElement('div');
        progressBg.className = 'progress-bar-bg';

        const progressFill = document.createElement('div');
        progressFill.className = 'progress-bar-fill';
        progressBg.appendChild(progressFill);

        const progressText = document.createElement('span');
        progressText.className = 'progress-bar-text';

        progressContainer.appendChild(progressBg);
        progressContainer.appendChild(progressText);
        card.appendChild(progressContainer);

        // State Actions Row
        const actionsRow = document.createElement('div');
        actionsRow.className = 'execution-controls-row';

        const createMiniBtn = (text: string, title: string, classes: string, onClick: () => void) => {
            const btn = document.createElement('button');
            btn.className = `execution-btn execution-btn-state ${classes}`;
            btn.textContent = text;
            btn.title = title;
            btn.onclick = (e) => {
                e.stopPropagation();
                onClick();
            };
            return btn;
        };

        const initBtn = createMiniBtn('Init', 'Initialize Solver Process', 'execution-btn-init', () => {
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'INIT' } }));
        });
        const playBtn = createMiniBtn('Run', 'Run to Completion', 'execution-btn-run', () => {
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'EXEC_ALL' } }));
        });
        const pauseBtn = createMiniBtn('Pause', 'Pause execution', 'execution-btn-pause', () => {
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'PAUSE' } }));
        });
        const termBtn = createMiniBtn('Term', 'Terminate Solver & Clear Memory', 'execution-btn-term', () => {
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'TERMINATE' } }));
        });

        actionsRow.appendChild(initBtn);
        actionsRow.appendChild(playBtn);
        actionsRow.appendChild(pauseBtn);
        actionsRow.appendChild(termBtn);
        card.appendChild(actionsRow);

        // Stepping Row (Large square step keys)
        const stepRow = document.createElement('div');
        stepRow.className = 'execution-step-row';

        const stepRowLabel = document.createElement('span');
        stepRowLabel.className = 'execution-step-label';
        stepRowLabel.textContent = 'Step:';
        stepRow.appendChild(stepRowLabel);

        const stepGrid = document.createElement('div');
        stepGrid.className = 'execution-btn-grid';

        [1, 10, 100, 1000].forEach(steps => {
            const btn = document.createElement('button');
            btn.className = 'execution-btn execution-btn-step';
            btn.textContent = String(steps);
            btn.title = `Step by ${steps} steps`;
            btn.onclick = (e) => {
                e.stopPropagation();
                document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'STEP', steps } }));
            };
            stepGrid.appendChild(btn);
        });

        stepRow.appendChild(stepGrid);
        card.appendChild(stepRow);

        return card;
    }

    private updateCard(card: HTMLElement, model: any, isConnected: boolean): void {
        const status = this.stateManager.getModelStatus(model.id);
        const progress = this.stateManager.getModelProgress(model.id);
        const simTime = this.stateManager.getModelSimTime(model.id);
        const has2D = model.nodes.some((n: any) => n.type === 'CFDSolver2D');

        // Update badge
        const badge = card.querySelector('.status-badge') as HTMLElement;
        if (badge) {
            badge.className = `status-badge badge-${status.toLowerCase()}`;
            badge.textContent = status;
        }

        // Update progress bar fill
        const progressFill = card.querySelector('.progress-bar-fill') as HTMLElement;
        if (progressFill) {
            const isIndeterminate = has2D && status === 'RUNNING' && progress === 0;
            if (isIndeterminate) {
                progressFill.classList.add('indeterminate');
                progressFill.style.width = '';
            } else {
                progressFill.classList.remove('indeterminate');
                progressFill.style.width = `${progress}%`;
            }
        }

        // Update progress bar text
        const progressText = card.querySelector('.progress-bar-text') as HTMLElement;
        if (progressText) {
            if (status === 'RUNNING') {
                const isIndeterminate = has2D && status === 'RUNNING' && progress === 0;
                if (isIndeterminate) {
                    progressText.textContent = `${simTime.toExponential(3)}s`;
                } else {
                    progressText.textContent = `${progress}% | ${simTime.toExponential(3)}s`;
                }
            } else if (status === 'INITIALIZED' || status === 'PAUSED' || status === 'TERMINATED') {
                progressText.textContent = `${simTime.toExponential(3)}s`;
            } else {
                progressText.textContent = 'Ready';
            }
        }

        // Update buttons disabled state
        const initBtn = card.querySelector('.execution-btn-init') as HTMLButtonElement;
        const playBtn = card.querySelector('.execution-btn-run') as HTMLButtonElement;
        const pauseBtn = card.querySelector('.execution-btn-pause') as HTMLButtonElement;
        const termBtn = card.querySelector('.execution-btn-term') as HTMLButtonElement;
        const stepButtons = Array.from(card.querySelectorAll('.execution-btn-step')) as HTMLButtonElement[];

        const pipeline = this.findPipeline(model.id);

        if (!isConnected) {
            if (initBtn) initBtn.disabled = true;
            if (playBtn) playBtn.disabled = true;
            if (pauseBtn) pauseBtn.disabled = true;
            if (termBtn) termBtn.disabled = true;
            stepButtons.forEach(b => b.disabled = true);
        } else {
            if (status === 'RUNNING') {
                if (initBtn) initBtn.disabled = true;
                if (playBtn) playBtn.disabled = !pipeline;
                if (pauseBtn) pauseBtn.disabled = false;
                if (termBtn) termBtn.disabled = false;
                stepButtons.forEach(b => b.disabled = true);
            } else if (status === 'INITIALIZED' || status === 'PAUSED') {
                if (initBtn) initBtn.disabled = false;
                if (playBtn) playBtn.disabled = false;
                if (pauseBtn) pauseBtn.disabled = true;
                if (termBtn) termBtn.disabled = false;
                stepButtons.forEach(b => b.disabled = false);
            } else {
                if (initBtn) initBtn.disabled = false;
                if (playBtn) playBtn.disabled = false;
                if (pauseBtn) pauseBtn.disabled = true;
                if (termBtn) termBtn.disabled = true;
                stepButtons.forEach(b => b.disabled = true);
            }
        }
    }

    updateTargets() {
        if (!this.targetsListContainer) return;

        const isConnected = (window as any).networkManager?.isConnected() ?? false;
        
        // Update connection badge
        if (isConnected) {
            this.connectionBadge.className = 'execution-connection-status connection-connected';
            this.connectionBadge.textContent = 'Online';
        } else {
            this.connectionBadge.className = 'execution-connection-status connection-disconnected';
            this.connectionBadge.textContent = 'Offline';
        }

        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) {
            this.targetsListContainer.innerHTML = `<div style="padding:15px; color:#666; font-style:italic; font-size:11px; text-align:center; background:#18181f; border:1px solid #222; border-radius:4px;">No models in active workspace</div>`;
            return;
        }

        // Remove any existing cards that are not in the current models list
        const modelIds = new Set(models.map(m => m.id));
        Array.from(this.targetsListContainer.children).forEach(child => {
            const childEl = child as HTMLElement;
            if (childEl.dataset.modelId && !modelIds.has(childEl.dataset.modelId)) {
                childEl.remove();
            }
        });

        // Ensure we show correct cards in the correct order
        models.forEach((model, index) => {
            let card = this.targetsListContainer.querySelector(`[data-model-id="${model.id}"]`) as HTMLElement;
            if (!card) {
                // If it is the empty placeholder, clear it first
                if (this.targetsListContainer.innerHTML.includes('No models')) {
                    this.targetsListContainer.innerHTML = '';
                }
                card = this.createCard(model);
                this.targetsListContainer.appendChild(card);
            }
            
            // Ensure card is in the correct order/index (e.g. if ordering changed)
            if (this.targetsListContainer.children[index] !== card) {
                this.targetsListContainer.insertBefore(card, this.targetsListContainer.children[index] || null);
            }

            this.updateCard(card, model, isConnected);
        });
    }
}
