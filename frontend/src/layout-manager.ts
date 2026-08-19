import { StateManager } from './state-manager.js';
import { LayoutNode, SplitNode, PanelNode, SimulationState, PanelType } from './types.js';
import { GraphRenderer } from './graph-renderer.js';
import { PropertyEditor } from './property-editor.js';
import { NodeViewer } from './node-viewer.js';
import { ResourceManager } from './resource-manager.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';
import { CustomDialog } from './custom-dialog.js';

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
        this.stateManager.onSelectionChange((nodeId) => {
            this.setSelectedNodeOnAllPropertiesPanels(nodeId);
        });
    }

    public broadcastResourceData(data: any): void {
        this.components.forEach(comp => {
            if (comp.type === 'RESOURCE_MANAGER') {
                comp.instance.updateMetrics(data);
            }
        });
    }

    public resetAllResourceManagers(): void {
        this.components.forEach(comp => {
            if (comp.type === 'RESOURCE_MANAGER') {
                comp.instance.resetMetrics();
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
        const types: PanelType[] = ['OUTLINER', 'NODE_GRAPH', 'PROPERTIES', 'NODE_VIEWER', 'EXECUTION_MANAGER', 'RESOURCE_MANAGER', 'TELEMETRY_3D', 'COMPARE_MODELS'];
        types.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t.replace('_', ' ');
            if (t === node.panelType) opt.selected = true;
            select.appendChild(opt);
        });
        select.onchange = () => this.stateManager.setPanelType(node.id, select.value as PanelType);
        leftSide.appendChild(select);

                if (node.panelType === 'NODE_VIEWER' || node.panelType === 'TELEMETRY_3D') {
            const subSelect = document.createElement('select');
            subSelect.className = 'node-sub-select';
            subSelect.style.marginLeft = '4px';
            subSelect.style.maxWidth = '120px';

            const state = this.stateManager.getCurrentState();
            if (state) {
                const placeholder = document.createElement('option');
                placeholder.value = "";
                placeholder.textContent = node.panelType === 'TELEMETRY_3D' ? "-- Select Viewport --" : "-- Select Node --";
                if (!node.targetNodeId) placeholder.selected = true;
                subSelect.appendChild(placeholder);

                const targetNodes = node.panelType === 'TELEMETRY_3D'
                    ? state.nodes.filter(n => n.type === 'Telemetry3DViewport')
                    : state.nodes;

                if (node.panelType === 'TELEMETRY_3D') {
                    // Offer models as choices so panels work without a canvas Telemetry3DViewport node
                    const allModels = this.stateManager.getWorkspaceModels();
                    const has3DModels = allModels.some(m => m.nodes.some(n => n.type === 'CFDSolver3D'));

                    if (targetNodes.length > 0) {
                        // Prefer canvas Telemetry3DViewport nodes if they exist
                        targetNodes.forEach(n => {
                            const opt = document.createElement('option');
                            opt.value = n.id;
                            opt.textContent = `${n.type}: ${n.id.slice(-6)}`;
                            if (n.id === node.targetNodeId) opt.selected = true;
                            subSelect.appendChild(opt);
                        });
                    }

                    // Always also list 3D models by name for direct binding
                    allModels.filter(m => m.nodes.some(n => n.type === 'CFDSolver3D')).forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;  // store model ID
                        opt.textContent = `📦 ${m.name || m.id.slice(-6)}`;
                        if (m.id === node.targetNodeId) opt.selected = true;
                        subSelect.appendChild(opt);
                    });
                } else {
                    targetNodes.forEach(n => {
                        const opt = document.createElement('option');
                        opt.value = n.id;
                        opt.textContent = `${n.type}: ${n.id}`;
                        if (n.id === node.targetNodeId) opt.selected = true;
                        subSelect.appendChild(opt);
                    });
                }
            }
            subSelect.onchange = () => this.stateManager.setPanelType(node.id, node.panelType, subSelect.value);
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
            case 'COMPARE_MODELS':
                this.renderCompareModels(node, container);
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
        // Auto-assign targetNodeId to an unclaimed Telemetry3DViewport if it is currently null/empty
        if (!node.targetNodeId) {
            const activeWs = this.stateManager.getActiveWorkspace();
            const activeModelId = activeWs?.activeModelId;
            const allModels = this.stateManager.getWorkspaceModels();
            
            const activeModel = allModels.find(m => m.id === activeModelId);
            const activeVpNodes = activeModel ? activeModel.nodes.filter(n => n.type === 'Telemetry3DViewport') : [];
            const otherVpNodes: any[] = [];
            allModels.filter(m => m.id !== activeModelId).forEach(m => {
                otherVpNodes.push(...m.nodes.filter(n => n.type === 'Telemetry3DViewport'));
            });
            const vpNodes = [...activeVpNodes, ...otherVpNodes];

            const claimedIds = new Set<string>();
            const collectClaimed = (layoutNode: LayoutNode) => {
                if (layoutNode.type === 'panel') {
                    if (layoutNode.panelType === 'TELEMETRY_3D' && layoutNode.targetNodeId) {
                        claimedIds.add(layoutNode.targetNodeId);
                    }
                } else if (layoutNode.type === 'split') {
                    collectClaimed(layoutNode.firstChild);
                    collectClaimed(layoutNode.secondChild);
                }
            };
            if (activeWs) {
                collectClaimed(activeWs.layout);
            }

            const unclaimed = vpNodes.find(n => !claimedIds.has(n.id));
            if (unclaimed) {
                console.log(`[Layout] Auto-assigning unclaimed viewport ${unclaimed.id} to panel ${node.id}`);
                node.targetNodeId = unclaimed.id;
                setTimeout(() => {
                    this.stateManager.setPanelType(node.id, 'TELEMETRY_3D', unclaimed.id);
                }, 0);
            } else {
                // No canvas Telemetry3DViewport nodes — auto-bind to a 3D model by ID
                const claimedModelIds = new Set<string>();
                const collectClaimedModels = (layoutNode: LayoutNode) => {
                    if (layoutNode.type === 'panel' && layoutNode.panelType === 'TELEMETRY_3D' && layoutNode.targetNodeId) {
                        claimedModelIds.add(layoutNode.targetNodeId);
                    } else if (layoutNode.type === 'split') {
                        collectClaimedModels(layoutNode.firstChild);
                        collectClaimedModels(layoutNode.secondChild);
                    }
                };
                if (activeWs) collectClaimedModels(activeWs.layout);

                let unclaimedModel = (activeModel && activeModel.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'FSICoupler3D' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D') && !claimedModelIds.has(activeModel.id)) ? activeModel : null;
                if (!unclaimedModel) {
                    unclaimedModel = allModels.find(m =>
                        m.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'FSICoupler3D' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D') && !claimedModelIds.has(m.id)
                    ) || null;
                }
                if (unclaimedModel) {
                    console.log(`[Layout] Auto-assigning model ${unclaimedModel.id} to 3D panel ${node.id}`);
                    node.targetNodeId = unclaimedModel.id;
                    setTimeout(() => {
                        this.stateManager.setPanelType(node.id, 'TELEMETRY_3D', unclaimedModel.id);
                    }, 0);
                }
            }
        }

        let comp = this.components.get(node.id);
        if (!comp) {
            const viewport = new Telemetry3DViewport(container, node.id, this.stateManager, '-telemetry', node.targetNodeId);
            comp = { type: 'TELEMETRY_3D', instance: viewport, container };
            this.components.set(node.id, comp);
        } else {
            if (comp.container !== container) {
                comp.container = container;
            }
            comp.instance.attachTo(container);
            comp.instance.setViewportNodeId(node.targetNodeId);
        }
    }

    private renderCompareModels(node: PanelNode, container: HTMLElement): void {
        let comp = this.components.get(node.id);
        if (!comp) {
            const comparison = new CompareModelsComponent(container, this.stateManager, node.id);
            comp = { type: 'COMPARE_MODELS', instance: comparison, container };
            this.components.set(node.id, comp);
        } else {
            if (comp.container !== container) {
                comp.container = container;
            }
            container.appendChild(comp.instance.container);
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
                    <div id="menu-rename-model">Rename Active Model...</div>
                    <div class="menu-separator"></div>
                    <div id="menu-load-json">Load Model (JSON)...</div>
                    <div id="menu-save-json">Save Model (JSON)</div>
                    <div id="menu-save-as-local">Save Model As...</div>
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
                    <div id="menu-save-workspace-host">Save Workspace to Host...</div>
                    <div id="menu-load-workspace-host">Load Workspace from Host...</div>
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
                closeBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const wsId = (closeBtn as HTMLElement).dataset.wsId;
                    if (wsId && await CustomDialog.confirm("Close this workspace? All its unsaved layouts will be discarded.")) {
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
    'Remap1DTo2DNode': '🔄',
    'Remap1DTo3DNode': '🔄',
    'Remap2DTo3DNode': '🔄',
    'HardwareConfig': '⚙️',
    'CFDSolver2D': '⚡',
    'TelemetryContour': '🗺️',
    'VTKOutput': '💾',
    'VirtualGauges': '⏱️',
    'MPMDomain2D': '🧱',
    'MPMObject2D': '🟥',
    'MPMMaterialSteel': '⚙️',
    'FSICoupler2D': '🔗'
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
    private collapsedModels: Set<string> = new Set();

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

        // Outliner Toolbar: Collapse All and Expand All buttons
        const toolbar = document.createElement('div');
        toolbar.className = 'outliner-toolbar';
        toolbar.style.display = 'flex';
        toolbar.style.alignItems = 'center';
        toolbar.style.gap = '6px';
        toolbar.style.marginBottom = '8px';
        toolbar.style.paddingBottom = '6px';
        toolbar.style.borderBottom = '1px solid #2a2a2a';

        const expandAllBtn = document.createElement('button');
        expandAllBtn.className = 'header-button secondary';
        expandAllBtn.style.fontSize = '10px';
        expandAllBtn.style.padding = '2px 8px';
        expandAllBtn.style.display = 'inline-flex';
        expandAllBtn.style.alignItems = 'center';
        expandAllBtn.style.gap = '4px';
        expandAllBtn.title = 'Expand All Models and Nodes';
        expandAllBtn.innerHTML = '<span>▼</span><span>Expand All</span>';
        expandAllBtn.onclick = () => {
            this.collapsedModels.clear();
            this.collapsedNodes.clear();
            this.render();
        };

        const collapseAllBtn = document.createElement('button');
        collapseAllBtn.className = 'header-button secondary';
        collapseAllBtn.style.fontSize = '10px';
        collapseAllBtn.style.padding = '2px 8px';
        collapseAllBtn.style.display = 'inline-flex';
        collapseAllBtn.style.alignItems = 'center';
        collapseAllBtn.style.gap = '4px';
        collapseAllBtn.title = 'Collapse All Models and Nodes';
        collapseAllBtn.innerHTML = '<span>▶</span><span>Collapse All</span>';
        collapseAllBtn.onclick = () => {
            models.forEach(m => {
                this.collapsedModels.add(m.id);
                m.nodes.forEach(n => this.collapsedNodes.add(n.id));
            });
            this.render();
        };

        toolbar.appendChild(expandAllBtn);
        toolbar.appendChild(collapseAllBtn);
        this.container.appendChild(toolbar);

        models.forEach(model => {
            const isModelCollapsed = this.collapsedModels.has(model.id);

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

            const accentColor = this.stateManager.getModelColors(model.id).base;
            const isActive = ws.activeModelId === model.id;

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '6px';

            // Individual Expand/Collapse Button for Model
            const modelArrow = document.createElement('span');
            modelArrow.className = 'outliner-node-arrow';
            modelArrow.style.fontSize = '10px';
            modelArrow.style.width = '14px';
            modelArrow.style.height = '14px';
            modelArrow.style.display = 'inline-flex';
            modelArrow.style.alignItems = 'center';
            modelArrow.style.justifyContent = 'center';
            modelArrow.style.cursor = 'pointer';
            modelArrow.title = isModelCollapsed ? 'Expand Model' : 'Collapse Model';
            modelArrow.innerHTML = isModelCollapsed ? '▶' : '▼';
            modelArrow.onclick = (e) => {
                e.stopPropagation();
                if (this.collapsedModels.has(model.id)) {
                    this.collapsedModels.delete(model.id);
                } else {
                    this.collapsedModels.add(model.id);
                }
                this.render();
            };
            left.appendChild(modelArrow);

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
            nameSpan.style.cursor = 'pointer';
            nameSpan.title = 'Double-click to rename';

            const startRename = (e: Event) => {
                e.stopPropagation();
                const oldName = model.name;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = oldName;
                input.style.fontSize = '11px';
                input.style.fontWeight = 'bold';
                input.style.background = '#1e1e24';
                input.style.border = '1px solid #00f0ff';
                input.style.color = '#fff';
                input.style.padding = '0 2px';
                input.style.outline = 'none';
                input.style.width = '100px';

                const finishRename = () => {
                    const newName = input.value.trim();
                    if (newName && newName !== oldName) {
                        this.stateManager.renameModel(model.id, newName);
                    } else {
                        nameSpan.textContent = oldName;
                    }
                };

                input.addEventListener('blur', finishRename);
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') finishRename();
                    if (ev.key === 'Escape') {
                        nameSpan.textContent = oldName;
                    }
                });

                nameSpan.innerHTML = '';
                nameSpan.appendChild(input);
                input.focus();
                input.select();
            };

            nameSpan.addEventListener('dblclick', startRename);
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
            
            const renameModelBtn = document.createElement('button');
            renameModelBtn.innerHTML = '✏️';
            renameModelBtn.title = 'Rename Model';
            renameModelBtn.style.background = 'none';
            renameModelBtn.style.border = 'none';
            renameModelBtn.style.color = '#888';
            renameModelBtn.style.cursor = 'pointer';
            renameModelBtn.style.fontSize = '11px';
            renameModelBtn.style.padding = '0 4px';
            renameModelBtn.style.lineHeight = '1';
            renameModelBtn.onmouseenter = () => renameModelBtn.style.color = '#00f0ff';
            renameModelBtn.onmouseleave = () => renameModelBtn.style.color = '#888';
            renameModelBtn.onclick = startRename;
            right.appendChild(renameModelBtn);

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
            closeModelBtn.onclick = async (e) => {
                e.stopPropagation();
                if (await CustomDialog.confirm(`Close model "${model.name}" in this workspace?`)) {
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
            if (isModelCollapsed) {
                list.style.display = 'none';
            }

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
    private viewModeSelect!: HTMLSelectElement;
    private viewMode: 'auto' | 'active' | 'all' = 'auto';
    private collapsedModels: Set<string> = new Set();
    

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
        headerRow.style.marginBottom = '10px';
        
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

        // Targets Header & View Toolbar Row
        const toolbarRow = document.createElement('div');
        toolbarRow.className = 'execution-toolbar-row';
        toolbarRow.style.display = 'flex';
        toolbarRow.style.justifyContent = 'space-between';
        toolbarRow.style.alignItems = 'center';
        toolbarRow.style.marginBottom = '8px';

        const targetsHeader = document.createElement('div');
        targetsHeader.style.fontWeight = 'bold';
        targetsHeader.style.fontSize = '11px';
        targetsHeader.style.color = '#888';
        targetsHeader.style.letterSpacing = '0.05em';
        targetsHeader.textContent = 'EXECUTION TARGETS';
        toolbarRow.appendChild(targetsHeader);

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.alignItems = 'center';
        actionsDiv.style.gap = '4px';

        // View Mode Selector Dropdown
        this.viewModeSelect = document.createElement('select');
        this.viewModeSelect.className = 'execution-view-select';
        this.viewModeSelect.style.fontSize = '10px';
        this.viewModeSelect.style.background = '#222';
        this.viewModeSelect.style.color = '#ccc';
        this.viewModeSelect.style.border = '1px solid #444';
        this.viewModeSelect.style.borderRadius = '3px';
        this.viewModeSelect.style.padding = '2px 4px';
        this.viewModeSelect.style.outline = 'none';

        const optAuto = document.createElement('option');
        optAuto.value = 'auto';
        optAuto.textContent = 'Auto-Collapse Inactive';
        this.viewModeSelect.appendChild(optAuto);

        const optActive = document.createElement('option');
        optActive.value = 'active';
        optActive.textContent = 'Active Only';
        this.viewModeSelect.appendChild(optActive);

        const optAll = document.createElement('option');
        optAll.value = 'all';
        optAll.textContent = 'Show All';
        this.viewModeSelect.appendChild(optAll);

        this.viewModeSelect.value = this.viewMode;
        this.viewModeSelect.onchange = () => {
            this.viewMode = this.viewModeSelect.value as 'auto' | 'active' | 'all';
            this.updateTargets();
        };
        actionsDiv.appendChild(this.viewModeSelect);

        // Expand / Collapse All buttons
        const expandAllBtn = document.createElement('button');
        expandAllBtn.innerHTML = '▼';
        expandAllBtn.title = 'Expand All Cards';
        expandAllBtn.className = 'execution-icon-btn';
        expandAllBtn.onclick = () => {
            this.collapsedModels.clear();
            if (this.viewMode === 'auto') {
                this.viewMode = 'all';
                this.viewModeSelect.value = 'all';
            }
            this.updateTargets();
        };

        const collapseAllBtn = document.createElement('button');
        collapseAllBtn.innerHTML = '▶';
        collapseAllBtn.title = 'Collapse All Cards';
        collapseAllBtn.className = 'execution-icon-btn';
        collapseAllBtn.onclick = () => {
            const models = this.stateManager.getWorkspaceModels();
            models.forEach(m => this.collapsedModels.add(m.id));
            this.updateTargets();
        };

        actionsDiv.appendChild(expandAllBtn);
        actionsDiv.appendChild(collapseAllBtn);
        toolbarRow.appendChild(actionsDiv);

        this.container.appendChild(toolbarRow);

        // Targets list container
        this.targetsListContainer = document.createElement('div');
        this.targetsListContainer.style.display = 'flex';
        this.targetsListContainer.style.flexDirection = 'column';
        this.targetsListContainer.style.gap = '8px';
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
        card.setAttribute('draggable', 'true');

        // Drag events for HTML5 drag-and-drop reordering
        card.ondragstart = (e: DragEvent) => {
            if (e.dataTransfer) {
                e.dataTransfer.setData('text/plain', model.id);
                e.dataTransfer.effectAllowed = 'move';
            }
            card.classList.add('is-dragging');
        };

        card.ondragend = () => {
            card.classList.remove('is-dragging');
            if (this.targetsListContainer) {
                Array.from(this.targetsListContainer.children).forEach(el => el.classList.remove('drag-over'));
            }
        };

        card.ondragover = (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'move';
            }
            card.classList.add('drag-over');
        };

        card.ondragleave = () => {
            card.classList.remove('drag-over');
        };

        card.ondrop = (e: DragEvent) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            if (e.dataTransfer) {
                const draggedModelId = e.dataTransfer.getData('text/plain');
                if (draggedModelId && draggedModelId !== model.id) {
                    const models = this.stateManager.getWorkspaceModels();
                    const currentIds = models.map(m => m.id);
                    const fromIndex = currentIds.indexOf(draggedModelId);
                    const toIndex = currentIds.indexOf(model.id);
                    if (fromIndex !== -1 && toIndex !== -1) {
                        const newOrder = [...currentIds];
                        const [moved] = newOrder.splice(fromIndex, 1);
                        newOrder.splice(toIndex, 0, moved);
                        this.stateManager.reorderModelsInWorkspace(newOrder);
                    }
                }
            }
        };

        // Header row (Clicking activates model or toggles collapse)
        const headerRow = document.createElement('div');
        headerRow.className = 'execution-target-header';

        const dragHandle = document.createElement('span');
        dragHandle.className = 'execution-target-drag-handle';
        dragHandle.innerHTML = '⋮⋮';
        dragHandle.title = 'Drag to reorder position';
        headerRow.appendChild(dragHandle);

        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'execution-target-fold-arrow';
        arrowSpan.textContent = '▼';
        arrowSpan.onclick = (e) => {
            e.stopPropagation();
            if (this.collapsedModels.has(model.id)) {
                this.collapsedModels.delete(model.id);
            } else {
                this.collapsedModels.add(model.id);
            }
            this.updateTargets();
        };
        headerRow.appendChild(arrowSpan);

        const activeBadge = document.createElement('span');
        activeBadge.className = 'execution-target-active-badge';
        activeBadge.textContent = 'ACTIVE';
        activeBadge.style.display = 'none';
        headerRow.appendChild(activeBadge);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'execution-target-meta';

        const accentColor = this.stateManager.getModelColors(model.id).base;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'execution-target-name';
        nameSpan.textContent = model.name;
        nameSpan.style.color = accentColor;
        nameSpan.style.cursor = 'pointer';
        nameSpan.title = 'Click to activate model, double-click to rename';

        const startRename = (e: Event) => {
            e.stopPropagation();
            const oldName = model.name;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = oldName;
            input.style.fontSize = '11px';
            input.style.fontWeight = 'bold';
            input.style.background = '#1e1e24';
            input.style.border = '1px solid #00f0ff';
            input.style.color = '#fff';
            input.style.padding = '0 2px';
            input.style.outline = 'none';
            input.style.width = '100px';

            const finishRename = () => {
                const newName = input.value.trim();
                if (newName && newName !== oldName) {
                    this.stateManager.renameModel(model.id, newName);
                } else {
                    nameSpan.textContent = oldName;
                }
            };

            input.addEventListener('blur', finishRename);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') finishRename();
                if (ev.key === 'Escape') {
                    nameSpan.textContent = oldName;
                }
            });

            nameSpan.innerHTML = '';
            nameSpan.appendChild(input);
            input.focus();
            input.select();
        };

        nameSpan.addEventListener('dblclick', startRename);

        const renameBtn = document.createElement('span');
        renameBtn.innerHTML = '✏️';
        renameBtn.title = 'Rename Model';
        renameBtn.style.cursor = 'pointer';
        renameBtn.style.fontSize = '11px';
        renameBtn.style.marginLeft = '4px';
        renameBtn.style.opacity = '0.6';
        renameBtn.onmouseenter = () => renameBtn.style.opacity = '1';
        renameBtn.onmouseleave = () => renameBtn.style.opacity = '0.6';
        renameBtn.onclick = startRename;

        metaDiv.appendChild(nameSpan);
        metaDiv.appendChild(renameBtn);
        headerRow.appendChild(metaDiv);

        // Compact progress text (visible when collapsed)
        const compactProgressSpan = document.createElement('span');
        compactProgressSpan.className = 'execution-target-compact-progress';
        headerRow.appendChild(compactProgressSpan);

        // Reorder button group (Top, Up, Down, Bottom)
        const reorderGroup = document.createElement('div');
        reorderGroup.className = 'execution-reorder-btn-group';

        const createReorderBtn = (text: string, title: string, direction: 'top' | 'up' | 'down' | 'bottom') => {
            const btn = document.createElement('button');
            btn.className = `execution-reorder-btn execution-reorder-${direction}`;
            btn.textContent = text;
            btn.title = title;
            btn.onclick = (e) => {
                e.stopPropagation();
                this.stateManager.moveModelInWorkspace(model.id, direction);
            };
            return btn;
        };

        reorderGroup.appendChild(createReorderBtn('⤊', 'Move to Top', 'top'));
        reorderGroup.appendChild(createReorderBtn('▲', 'Move Up', 'up'));
        reorderGroup.appendChild(createReorderBtn('▼', 'Move Down', 'down'));
        reorderGroup.appendChild(createReorderBtn('⤋', 'Move to Bottom', 'bottom'));
        headerRow.appendChild(reorderGroup);

        // Quick mini action button on header (visible when collapsed)
        const quickBtn = document.createElement('button');
        quickBtn.className = 'execution-target-quick-btn';
        quickBtn.title = 'Quick Run / Pause';
        quickBtn.style.display = 'none';
        quickBtn.onclick = (e) => {
            e.stopPropagation();
            this.stateManager.setActiveModel(model.id);
            const status = this.stateManager.getModelStatus(model.id);
            if (status === 'RUNNING') {
                document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'PAUSE' } }));
            } else {
                document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'EXEC_ALL' } }));
            }
        };
        headerRow.appendChild(quickBtn);

        const badge = document.createElement('div');
        badge.className = `status-badge`;
        headerRow.appendChild(badge);

        // Click header row to activate model
        headerRow.onclick = (e) => {
            const target = e.target as HTMLElement;
            if (target.classList.contains('execution-target-fold-arrow') || 
                target.classList.contains('execution-target-quick-btn') ||
                target.classList.contains('execution-reorder-btn') ||
                target.classList.contains('execution-target-drag-handle')) {
                return;
            }
            this.stateManager.setActiveModel(model.id);
            if (this.viewMode === 'auto') {
                this.collapsedModels.delete(model.id);
            }
            this.updateTargets();
        };

        card.appendChild(headerRow);

        // Collapsible Card Body Wrapper
        const cardBody = document.createElement('div');
        cardBody.className = 'execution-target-body';

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
        cardBody.appendChild(progressContainer);

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
            this.stateManager.setActiveModel(model.id);
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'INIT' } }));
        });
        const playBtn = createMiniBtn('Run', 'Run to Completion', 'execution-btn-run', () => {
            this.stateManager.setActiveModel(model.id);
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'EXEC_ALL' } }));
        });
        const pauseBtn = createMiniBtn('Pause', 'Pause execution', 'execution-btn-pause', () => {
            this.stateManager.setActiveModel(model.id);
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'PAUSE' } }));
        });
        const termBtn = createMiniBtn('Term', 'Terminate Solver & Clear Memory', 'execution-btn-term', () => {
            this.stateManager.setActiveModel(model.id);
            document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'TERMINATE' } }));
        });

        actionsRow.appendChild(initBtn);
        actionsRow.appendChild(playBtn);
        actionsRow.appendChild(pauseBtn);
        actionsRow.appendChild(termBtn);
        cardBody.appendChild(actionsRow);

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
                this.stateManager.setActiveModel(model.id);
                document.dispatchEvent(new CustomEvent('model-action', { detail: { modelId: model.id, command: 'STEP', steps } }));
            };
            stepGrid.appendChild(btn);
        });

        stepRow.appendChild(stepGrid);
        cardBody.appendChild(stepRow);

        card.appendChild(cardBody);

        return card;
    }

    private updateCard(card: HTMLElement, model: any, isConnected: boolean): void {
        const status = this.stateManager.getModelStatus(model.id);
        const progress = this.stateManager.getModelProgress(model.id);
        const simTime = this.stateManager.getModelSimTime(model.id);
        const has2D = model.nodes.some((n: any) => n.type === 'CFDSolver2D');
        const activeWs = this.stateManager.getActiveWorkspace();
        const isActive = activeWs?.activeModelId === model.id;

        // Models reorder boundary state check
        const models = this.stateManager.getWorkspaceModels();
        const modelIndex = models.findIndex(m => m.id === model.id);
        const isFirst = modelIndex === 0;
        const isLast = modelIndex === models.length - 1;

        const btnTop = card.querySelector('.execution-reorder-top') as HTMLButtonElement;
        const btnUp = card.querySelector('.execution-reorder-up') as HTMLButtonElement;
        const btnDown = card.querySelector('.execution-reorder-down') as HTMLButtonElement;
        const btnBottom = card.querySelector('.execution-reorder-bottom') as HTMLButtonElement;

        if (btnTop) btnTop.disabled = isFirst;
        if (btnUp) btnUp.disabled = isFirst;
        if (btnDown) btnDown.disabled = isLast;
        if (btnBottom) btnBottom.disabled = isLast;

        // View Mode Filter
        if (this.viewMode === 'active') {
            card.style.display = isActive ? 'flex' : 'none';
        } else {
            card.style.display = 'flex';
        }

        // Active model highlighting
        if (isActive) {
            card.classList.add('is-active');
        } else {
            card.classList.remove('is-active');
        }

        // Active Badge
        const activeBadge = card.querySelector('.execution-target-active-badge') as HTMLElement;
        if (activeBadge) {
            activeBadge.style.display = isActive ? 'inline-block' : 'none';
        }

        // Determine collapse state
        let isCollapsed = false;
        if (this.viewMode === 'auto') {
            isCollapsed = !isActive || this.collapsedModels.has(model.id);
        } else if (this.viewMode === 'all') {
            isCollapsed = this.collapsedModels.has(model.id);
        }

        // Card fold arrow
        const arrowSpan = card.querySelector('.execution-target-fold-arrow') as HTMLElement;
        if (arrowSpan) {
            arrowSpan.textContent = isCollapsed ? '▶' : '▼';
        }

        // Card body display
        const cardBody = card.querySelector('.execution-target-body') as HTMLElement;
        if (cardBody) {
            cardBody.style.display = isCollapsed ? 'none' : 'flex';
        }

        // Update badge
        const badge = card.querySelector('.status-badge') as HTMLElement;
        if (badge) {
            badge.className = `status-badge badge-${status.toLowerCase()}`;
            badge.textContent = status;
        }

        // Compact progress text for collapsed view
        const compactProgress = card.querySelector('.execution-target-compact-progress') as HTMLElement;
        if (compactProgress) {
            if (isCollapsed) {
                compactProgress.style.display = 'inline';
                if (status === 'RUNNING') {
                    compactProgress.textContent = `${progress}% | ${simTime.toExponential(2)}s`;
                } else if (simTime > 0) {
                    compactProgress.textContent = `${simTime.toExponential(2)}s`;
                } else {
                    compactProgress.textContent = '';
                }
            } else {
                compactProgress.style.display = 'none';
            }
        }

        // Quick mini action button on header (visible when collapsed & connected)
        const quickBtn = card.querySelector('.execution-target-quick-btn') as HTMLButtonElement;
        if (quickBtn) {
            if (isCollapsed && isConnected) {
                quickBtn.style.display = 'inline-block';
                if (status === 'RUNNING') {
                    quickBtn.textContent = '⏸';
                    quickBtn.title = 'Pause Execution';
                    quickBtn.style.color = '#fb923c';
                    quickBtn.disabled = false;
                } else if (status === 'INITIALIZED' || status === 'PAUSED') {
                    quickBtn.textContent = '▶';
                    quickBtn.title = 'Run Execution';
                    quickBtn.style.color = '#4ade80';
                    quickBtn.disabled = false;
                } else {
                    quickBtn.textContent = '▶';
                    quickBtn.title = 'Initialize / Run Execution';
                    quickBtn.style.color = '#00f0ff';
                    quickBtn.disabled = false;
                }
            } else {
                quickBtn.style.display = 'none';
            }
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
        const stepRow = card.querySelector('.execution-step-row') as HTMLElement;

        if (!isConnected) {
            if (initBtn) initBtn.disabled = true;
            if (playBtn) playBtn.disabled = true;
            if (pauseBtn) pauseBtn.disabled = true;
            if (termBtn) termBtn.disabled = true;
            stepButtons.forEach(b => b.disabled = true);
        } else {
            // Keep all buttons visible side-by-side in fixed positions
            if (playBtn) playBtn.style.display = 'inline-flex';
            if (pauseBtn) pauseBtn.style.display = 'inline-flex';
            if (stepRow) stepRow.style.display = 'flex';

            // Initialise button is ALWAYS active when connected
            if (initBtn) initBtn.disabled = false;

            if (status === 'RUNNING') {
                if (playBtn) playBtn.disabled = false;
                if (pauseBtn) pauseBtn.disabled = false;
                if (termBtn) termBtn.disabled = false;
                stepButtons.forEach(b => b.disabled = false);
            } else if (status === 'INITIALIZED' || status === 'PAUSED') {
                if (playBtn) playBtn.disabled = false;
                if (pauseBtn) pauseBtn.disabled = true;
                if (termBtn) termBtn.disabled = false;
                stepButtons.forEach(b => b.disabled = false);
            } else if (status === 'ERROR') {
                if (playBtn) playBtn.disabled = false;
                if (pauseBtn) pauseBtn.disabled = true;
                if (termBtn) termBtn.disabled = false; // Enabled to allow manual process cleanup
                stepButtons.forEach(b => b.disabled = true);
            } else {
                // Not initialised (UNINITIALIZED or TERMINATED)
                if (playBtn) playBtn.disabled = false; // Enabled for Auto-Run
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

class CompareModelsComponent {
    public container: HTMLElement;
    private stateManager: StateManager;
    private panelId: string;
    
    private stateListener: () => void;
    private telemetryListener: (nodeId: string, data: any) => void;
    
    private chartContainer!: HTMLElement;
    private canvas!: HTMLCanvasElement;
    private controlsContainer!: HTMLElement;
    private legendContainer!: HTMLElement;
    
    private channelSelect!: HTMLSelectElement;
    private channelLabel!: HTMLElement;
    private xAxisSelect!: HTMLSelectElement;
    private xAxisLabel!: HTMLElement;
    
    private isControlsOpen: boolean = true;
    private selectedModelIds: Set<string> = new Set();
    private selectedChannel: number = 0;
    private xAxisMode: string = 'radius';
    private compareMode: 'spatial' | 'gauges' = 'spatial';
    
    private hoverX: number | null = null;
    private hoverY: number | null = null;
    
    private zoomedOrPanned: boolean = false;
    private zoomMinX: number = 0;
    private zoomMaxX: number = 1.0;
    private zoomMinY: number = 0.0;
    private zoomMaxY: number = 1.0;
    
    private isDragging: boolean = false;
    private dragStartX: number = 0;
    private dragStartY: number = 0;
    private dragStartMinX: number = 0;
    private dragStartMaxX: number = 1.0;
    private dragStartMinY: number = 0.0;
    private dragStartMaxY: number = 1.0;

    constructor(parent: HTMLElement, stateManager: StateManager, panelId: string) {
        this.container = document.createElement('div');
        this.container.className = 'compare-models-panel';
        parent.appendChild(this.container);
        
        this.stateManager = stateManager;
        this.panelId = panelId;
        
        // Load initial options
        const state = this.stateManager.getCurrentState();
        if (state) {
            const findNode = (layout: any): any => {
                if (layout.type === 'panel' && layout.id === panelId) return layout;
                if (layout.type === 'split') {
                    return findNode(layout.firstChild) || findNode(layout.secondChild);
                }
                return null;
            };
            const pNode = findNode(state.layout);
            if (pNode && pNode.options) {
                if (Array.isArray(pNode.options.selectedModelIds)) {
                    this.selectedModelIds = new Set(pNode.options.selectedModelIds);
                }
                if (typeof pNode.options.channel === 'number') {
                    this.selectedChannel = pNode.options.channel;
                }
                if (typeof pNode.options.isControlsOpen === 'boolean') {
                    this.isControlsOpen = pNode.options.isControlsOpen;
                }
                if (typeof pNode.options.xAxisMode === 'string') {
                    this.xAxisMode = pNode.options.xAxisMode;
                }
                if (typeof pNode.options.compareMode === 'string') {
                    this.compareMode = pNode.options.compareMode as 'spatial' | 'gauges';
                }
            }
        }
        
        this.buildStructure();
        
        this.stateListener = () => {
            this.updateModelList();
            this.draw();
        };
        this.stateManager.onStateChange(this.stateListener);
        
        this.telemetryListener = (nodeId: string, data: any) => {
            this.draw();
        };
        this.stateManager.onTelemetryUpdate(this.telemetryListener);
        
        // Force canvas dimension sync
        setTimeout(() => {
            if (this.canvas) {
                this.canvas.width = this.canvas.clientWidth;
                this.canvas.height = this.canvas.clientHeight;
                this.draw();
            }
        }, 50);
        
        const ro = new ResizeObserver(() => {
            if (this.canvas) {
                this.canvas.width = this.canvas.clientWidth;
                this.canvas.height = this.canvas.clientHeight;
                this.draw();
            }
        });
        ro.observe(this.container);
    }
    
    destroy() {
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.container.remove();
    }
    
    private buildStructure() {
        this.container.innerHTML = '';
        this.container.style.display = 'flex';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.overflow = 'hidden';
        
        // Chart Container (Left)
        this.chartContainer = document.createElement('div');
        this.chartContainer.className = 'compare-chart-container';
        this.chartContainer.style.flex = '1';
        this.chartContainer.style.display = 'flex';
        this.chartContainer.style.flexDirection = 'column';
        this.chartContainer.style.minWidth = '0';
        this.chartContainer.style.height = '100%';
        this.container.appendChild(this.chartContainer);
        
        // Chart Header
        const chartHeader = document.createElement('div');
        chartHeader.className = 'compare-chart-header';
        chartHeader.style.display = 'flex';
        chartHeader.style.alignItems = 'center';
        chartHeader.style.gap = '12px';
        chartHeader.style.padding = '8px 12px';
        chartHeader.style.background = '#18181c';
        chartHeader.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
        chartHeader.style.height = '38px';
        chartHeader.style.boxSizing = 'border-box';
        chartHeader.style.flexShrink = '0';
        
        const titleSpan = document.createElement('span');
        titleSpan.style.fontWeight = '600';
        titleSpan.style.fontSize = '11px';
        titleSpan.style.color = '#fff';
        titleSpan.style.marginRight = 'auto';
        titleSpan.textContent = 'COMPARE MODELS';
        chartHeader.appendChild(titleSpan);
        
        // Mode Selector dropdown
        const modeLabel = document.createElement('span');
        modeLabel.textContent = 'Mode:';
        modeLabel.style.fontSize = '10px';
        modeLabel.style.color = '#888';
        chartHeader.appendChild(modeLabel);
        
        const modeSelect = document.createElement('select');
        modeSelect.style.fontSize = '10px';
        modeSelect.style.background = '#2a2a30';
        modeSelect.style.color = '#ccc';
        modeSelect.style.border = '1px solid #444';
        modeSelect.style.padding = '2px 4px';
        modeSelect.style.borderRadius = '3px';
        
        const modeOptSpatial = document.createElement('option');
        modeOptSpatial.value = 'spatial';
        modeOptSpatial.textContent = 'Spatial Profile';
        if (this.compareMode === 'spatial') modeOptSpatial.selected = true;
        modeSelect.appendChild(modeOptSpatial);
        
        const modeOptGauges = document.createElement('option');
        modeOptGauges.value = 'gauges';
        modeOptGauges.textContent = 'Virtual Gauges';
        if (this.compareMode === 'gauges') modeOptGauges.selected = true;
        modeSelect.appendChild(modeOptGauges);
        
        modeSelect.onchange = () => {
            this.compareMode = modeSelect.value as 'spatial' | 'gauges';
            this.selectedChannel = 0;
            this.zoomedOrPanned = false;
            this.updateChannelDropdown();
            this.saveOptions();
            this.draw();
        };
        chartHeader.appendChild(modeSelect);
        
        // Channel Selector dropdown
        this.channelLabel = document.createElement('span');
        this.channelLabel.textContent = 'Variable:';
        this.channelLabel.style.fontSize = '10px';
        this.channelLabel.style.color = '#888';
        chartHeader.appendChild(this.channelLabel);
        
        this.channelSelect = document.createElement('select');
        this.channelSelect.style.fontSize = '10px';
        this.channelSelect.style.background = '#2a2a30';
        this.channelSelect.style.color = '#ccc';
        this.channelSelect.style.border = '1px solid #444';
        this.channelSelect.style.padding = '2px 4px';
        this.channelSelect.style.borderRadius = '3px';
        this.channelSelect.onchange = () => {
            this.selectedChannel = Number(this.channelSelect.value);
            this.zoomedOrPanned = false;
            this.saveOptions();
            this.draw();
        };
        chartHeader.appendChild(this.channelSelect);
        
        // X-Axis mode dropdown
        this.xAxisLabel = document.createElement('span');
        this.xAxisLabel.textContent = 'X-Axis:';
        this.xAxisLabel.style.fontSize = '10px';
        this.xAxisLabel.style.color = '#888';
        chartHeader.appendChild(this.xAxisLabel);
        
        this.xAxisSelect = document.createElement('select');
        this.xAxisSelect.style.fontSize = '10px';
        this.xAxisSelect.style.background = '#2a2a30';
        this.xAxisSelect.style.color = '#ccc';
        this.xAxisSelect.style.border = '1px solid #444';
        this.xAxisSelect.style.padding = '2px 4px';
        this.xAxisSelect.style.borderRadius = '3px';
        
        const xOptRadius = document.createElement('option');
        xOptRadius.value = 'radius';
        xOptRadius.textContent = 'Radius';
        if (this.xAxisMode === 'radius') xOptRadius.selected = true;
        this.xAxisSelect.appendChild(xOptRadius);
        
        const xOptCell = document.createElement('option');
        xOptCell.value = 'cell_id';
        xOptCell.textContent = 'Cell ID';
        if (this.xAxisMode === 'cell_id') xOptCell.selected = true;
        this.xAxisSelect.appendChild(xOptCell);
        
        this.xAxisSelect.onchange = () => {
            this.xAxisMode = this.xAxisSelect.value;
            this.zoomedOrPanned = false;
            this.saveOptions();
            this.draw();
        };
        chartHeader.appendChild(this.xAxisSelect);
        
        // Populate channel select values
        this.updateChannelDropdown();
        
        // Settings Gear Button
        const gearBtn = document.createElement('button');
        gearBtn.style.background = 'none';
        gearBtn.style.border = 'none';
        gearBtn.style.color = '#888';
        gearBtn.style.cursor = 'pointer';
        gearBtn.style.fontSize = '12px';
        gearBtn.innerHTML = '⚙️';
        gearBtn.onclick = () => {
            this.isControlsOpen = !this.isControlsOpen;
            this.controlsContainer.style.display = this.isControlsOpen ? 'flex' : 'none';
            this.saveOptions();
            this.canvas.width = this.canvas.clientWidth;
            this.canvas.height = this.canvas.clientHeight;
            this.draw();
        };
        chartHeader.appendChild(gearBtn);
        
        this.chartContainer.appendChild(chartHeader);
        
        // Canvas wrapper
        const canvasWrapper = document.createElement('div');
        canvasWrapper.style.flex = '1';
        canvasWrapper.style.position = 'relative';
        canvasWrapper.style.minHeight = '0';
        this.chartContainer.appendChild(canvasWrapper);
        
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        canvasWrapper.appendChild(this.canvas);
        
        const getActiveCompareBounds = () => {
            const defaults = this.getDefaultBounds();
            if (!defaults) return null;
            if (this.zoomedOrPanned) {
                return {
                    minX: this.zoomMinX,
                    maxX: this.zoomMaxX,
                    minY: defaults.minY,
                    maxY: defaults.maxY
                };
            }
            return defaults;
        };

        this.canvas.addEventListener('pointerdown', (e) => {
            const active = getActiveCompareBounds();
            if (!active) return;
            
            this.canvas.setPointerCapture(e.pointerId);
            const rect = this.canvas.getBoundingClientRect();
            this.isDragging = true;
            this.dragStartX = e.clientX - rect.left;
            
            this.dragStartMinX = active.minX;
            this.dragStartMaxX = active.maxX;
            
            e.preventDefault();
        });
        
        this.canvas.addEventListener('pointermove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.hoverX = e.clientX - rect.left;
            this.hoverY = e.clientY - rect.top;
            
            if (this.isDragging && this.canvas.hasPointerCapture(e.pointerId)) {
                const paddingLeft = 55;
                const paddingRight = 15;
                const plotW = rect.width - paddingLeft - paddingRight;
                
                if (plotW > 0) {
                    const dxScreen = this.hoverX - this.dragStartX;
                    const rangeX = this.dragStartMaxX - this.dragStartMinX;
                    const dx = (dxScreen / plotW) * rangeX;
                    
                    this.zoomMinX = this.dragStartMinX - dx;
                    this.zoomMaxX = this.dragStartMaxX - dx;
                    
                    this.zoomedOrPanned = true;
                }
            }
            this.draw();
        });
        
        const releaseCompareCapture = (e: PointerEvent) => {
            if (this.canvas.hasPointerCapture(e.pointerId)) {
                this.canvas.releasePointerCapture(e.pointerId);
                this.isDragging = false;
            }
        };

        this.canvas.addEventListener('pointerup', releaseCompareCapture);
        this.canvas.addEventListener('pointercancel', releaseCompareCapture);
        this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
        
        this.canvas.addEventListener('wheel', (e) => {
            const active = getActiveCompareBounds();
            if (!active) return;
            
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            
            const paddingLeft = 55;
            const paddingRight = 15;
            const plotW = rect.width - paddingLeft - paddingRight;
            
            if (plotW <= 0) return;
            
            const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
            
            const pctX = (mouseX - paddingLeft) / plotW;
            const targetX = active.minX + pctX * (active.maxX - active.minX);
            const newRangeX = (active.maxX - active.minX) * zoomFactor;
            
            this.zoomMinX = targetX - pctX * newRangeX;
            this.zoomMaxX = this.zoomMinX + newRangeX;
            
            this.zoomedOrPanned = true;
            this.draw();
            e.preventDefault();
        }, { passive: false });
        
        this.canvas.addEventListener('dblclick', (e) => {
            this.zoomedOrPanned = false;
            this.draw();
            e.preventDefault();
        });
        
        // Controls Panel (Right)
        this.controlsContainer = document.createElement('div');
        this.controlsContainer.className = 'compare-controls-panel';
        this.controlsContainer.style.width = '240px';
        this.controlsContainer.style.background = '#15151a';
        this.controlsContainer.style.borderLeft = '1px solid rgba(255, 255, 255, 0.08)';
        this.controlsContainer.style.display = this.isControlsOpen ? 'flex' : 'none';
        this.controlsContainer.style.flexDirection = 'column';
        this.controlsContainer.style.flexShrink = '0';
        this.controlsContainer.style.height = '100%';
        this.controlsContainer.style.overflow = 'hidden';
        this.container.appendChild(this.controlsContainer);
        
        // Controls Header
        const controlsHeader = document.createElement('div');
        controlsHeader.style.display = 'flex';
        controlsHeader.style.justifyContent = 'space-between';
        controlsHeader.style.alignItems = 'center';
        controlsHeader.style.padding = '8px 12px';
        controlsHeader.style.background = '#1c1c22';
        controlsHeader.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
        controlsHeader.style.fontSize = '10px';
        controlsHeader.style.fontWeight = 'bold';
        controlsHeader.style.color = '#00adff';
        controlsHeader.style.letterSpacing = '1px';
        controlsHeader.style.textTransform = 'uppercase';
        controlsHeader.textContent = 'Models Legend';
        
        const closeBtn = document.createElement('button');
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#888';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '11px';
        closeBtn.textContent = '▶';
        closeBtn.onclick = () => {
            this.isControlsOpen = false;
            this.controlsContainer.style.display = 'none';
            this.saveOptions();
            this.canvas.width = this.canvas.clientWidth;
            this.canvas.height = this.canvas.clientHeight;
            this.draw();
        };
        controlsHeader.appendChild(closeBtn);
        this.controlsContainer.appendChild(controlsHeader);
        
        // Legend Container
        this.legendContainer = document.createElement('div');
        this.legendContainer.style.flex = '1';
        this.legendContainer.style.overflowY = 'auto';
        this.legendContainer.style.padding = '12px';
        this.legendContainer.style.display = 'flex';
        this.legendContainer.style.flexDirection = 'column';
        this.legendContainer.style.gap = '8px';
        this.controlsContainer.appendChild(this.legendContainer);
        
        this.updateModelList();
    }
    
    private updateChannelDropdown() {
        if (!this.channelSelect) return;
        this.channelSelect.innerHTML = '';
        
        const channels = this.compareMode === 'spatial'
            ? ['Pressure', 'Density', 'Velocity', 'Int. Energy', 'Mass Fraction']
            : ['Pressure', 'Density', 'Velocity', 'Int. Energy', 'Reacted (Alpha1)', 'Unreacted (Alpha2)', 'Air', 'Overpressure', 'Impulse'];
            
        channels.forEach((ch, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = ch;
            if (idx === this.selectedChannel) opt.selected = true;
            this.channelSelect.appendChild(opt);
        });
        
        if (this.compareMode === 'gauges') {
            this.xAxisSelect.style.display = 'none';
            this.xAxisLabel.style.display = 'none';
        } else {
            this.xAxisSelect.style.display = '';
            this.xAxisLabel.style.display = '';
        }
    }
    
    private updateModelList() {
        if (!this.legendContainer) return;
        this.legendContainer.innerHTML = '';
        
        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) {
            this.legendContainer.innerHTML = `<div style="color:#666; font-style:italic; font-size:11px; text-align:center; padding:10px;">No models in workspace</div>`;
            return;
        }
        
        models.forEach(model => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            item.style.padding = '4px 6px';
            item.style.borderRadius = '4px';
            item.style.background = 'rgba(255, 255, 255, 0.02)';
            item.style.border = '1px solid rgba(255, 255, 255, 0.04)';
            
            const color = this.getModelColor(model.id);
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedModelIds.has(model.id);
            checkbox.style.cursor = 'pointer';
            checkbox.style.accentColor = color;
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this.selectedModelIds.add(model.id);
                } else {
                    this.selectedModelIds.delete(model.id);
                }
                this.saveOptions();
                this.draw();
            };
            
            const colorBadge = document.createElement('div');
            colorBadge.style.width = '12px';
            colorBadge.style.height = '12px';
            colorBadge.style.borderRadius = '3px';
            colorBadge.style.background = color;
            colorBadge.style.flexShrink = '0';
            
            const nameLabel = document.createElement('span');
            nameLabel.textContent = model.name;
            nameLabel.style.fontSize = '11px';
            nameLabel.style.color = '#eee';
            nameLabel.style.textOverflow = 'ellipsis';
            nameLabel.style.overflow = 'hidden';
            nameLabel.style.whiteSpace = 'nowrap';
            nameLabel.style.cursor = 'pointer';
            nameLabel.onclick = () => {
                checkbox.click();
            };
            
            item.appendChild(checkbox);
            item.appendChild(colorBadge);
            item.appendChild(nameLabel);
            
            this.legendContainer.appendChild(item);
        });
    }
    
    private getModelColor(id: string): string {
        return this.stateManager.getModelColors(id).base;
    }
    
    private getGaugeColor(modelId: string, gaugeId: string): string {
        const key = `${modelId}-${gaugeId}`;
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            hash = key.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return `hsl(${h}, 85%, 60%)`;
    }
    
    private saveOptions() {
        this.stateManager.updatePanelOptions(this.panelId, {
            selectedModelIds: Array.from(this.selectedModelIds),
            channel: this.selectedChannel,
            isControlsOpen: this.isControlsOpen,
            xAxisMode: this.xAxisMode,
            compareMode: this.compareMode
        });
    }
    
    private handleMouseMove(e: MouseEvent) {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        this.hoverX = e.clientX - rect.left;
        this.hoverY = e.clientY - rect.top;
        this.draw();
    }
    
    private handleMouseLeave() {
        this.hoverX = null;
        this.hoverY = null;
        this.draw();
    }
    
    private getDefaultBounds() {
        const models = this.stateManager.getWorkspaceModels();
        const activeModels = models.filter(m => this.selectedModelIds.has(m.id));
        
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        
        activeModels.forEach(model => {
            if (this.compareMode === 'spatial') {
                const solverNode = model.nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D');
                if (!solverNode) return;
                
                let telemetryBuffer = this.stateManager.getTelemetry(solverNode.id + "-binary");
                if (!telemetryBuffer) telemetryBuffer = this.stateManager.getTelemetry(solverNode.id);
                
                if (telemetryBuffer && telemetryBuffer instanceof ArrayBuffer) {
                    const MIN_HEADER = 8;
                    if (telemetryBuffer.byteLength >= MIN_HEADER) {
                        const headerView = new DataView(telemetryBuffer);
                        const n_cells = headerView.getUint32(0, true);
                        const n_channels = headerView.getUint32(4, true);
                        const expectedPayload = n_cells * n_channels * 4;
                        
                        if (telemetryBuffer.byteLength >= MIN_HEADER + expectedPayload) {
                            const clampedChannel = Math.max(0, Math.min(this.selectedChannel, n_channels - 1));
                            const offset = MIN_HEADER + clampedChannel * n_cells * 4;
                            const yPoints = new Float32Array(telemetryBuffer, offset, n_cells);
                            
                            const meshNode = model.nodes.find(n => n.type === 'DomainMesh' || n.type === 'DomainMesh2D' || n.type === 'DomainMesh3D');
                            const cellSize = Number(meshNode?.parameters?.cell_size ?? 0.001);
                            
                            for (let i = 0; i < n_cells; i++) {
                                const x = this.xAxisMode === 'radius' ? (i + 0.5) * cellSize : i;
                                if (x < minX) minX = x;
                                if (x > maxX) maxX = x;
                            }
                            
                            yPoints.forEach(v => {
                                if (isFinite(v)) {
                                    if (v < minY) minY = v;
                                    if (v > maxY) maxY = v;
                                }
                            });
                        }
                    }
                }
            } else {
                // Virtual Gauges Mode
                const gaugesNode = model.nodes.find(n => n.type === 'VirtualGauges');
                if (!gaugesNode) return;
                
                const history = this.stateManager.getTelemetry(gaugesNode.id);
                if (history && history.times && history.values && history.times.length > 0) {
                    const times = history.times;
                    const values = history.values;
                    const gaugesList = gaugesNode.parameters?.gauges || [];
                    
                    gaugesList.filter((g: any) => g.plot !== false).forEach((g: any) => {
                        const gData = values[g.id || g.name];
                        if (gData && gData[this.selectedChannel]) {
                            const yVals = gData[this.selectedChannel];
                            for (let i = 0; i < times.length; i++) {
                                const t = times[i];
                                if (t < minX) minX = t;
                                if (t > maxX) maxX = t;
                                const v = yVals[i] !== undefined ? yVals[i] : 0.0;
                                if (isFinite(v)) {
                                    if (v < minY) minY = v;
                                    if (v > maxY) maxY = v;
                                }
                            }
                        }
                    });
                }
            }
        });
        
        if (minX === Infinity || maxX === -Infinity || minY === Infinity || maxY === -Infinity) {
            return null;
        }
        
        // Apply default padding
        const padX = maxX - minX === 0 ? 0.1 : (maxX - minX) * 0.02;
        let paddedMinX = minX - padX;
        let paddedMaxX = maxX + padX;
        
        const rangeY = maxY - minY === 0 ? 1 : maxY - minY;
        let paddedMinY = minY - rangeY * 0.05;
        let paddedMaxY = maxY + rangeY * 0.05;
        
        if (paddedMinY >= 0 && this.compareMode === 'spatial' && (this.selectedChannel === 0 || this.selectedChannel === 1 || this.selectedChannel === 3 || this.selectedChannel === 4)) {
            paddedMinY = Math.max(0, paddedMinY);
        }
        
        return { minX: paddedMinX, maxX: paddedMaxX, minY: paddedMinY, maxY: paddedMaxY };
    }

    public draw() {
        if (!this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        
        const cssW = Math.round(rect.width) || 300;
        const cssH = Math.round(rect.height) || 200;
        
        if (this.canvas.width !== cssW * dpr || this.canvas.height !== cssH * dpr) {
            this.canvas.width = cssW * dpr;
            this.canvas.height = cssH * dpr;
        }
        
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;
        
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssW, cssH);
        
        const models = this.stateManager.getWorkspaceModels();
        const activeModels = models.filter(m => this.selectedModelIds.has(m.id));
        
        const curves: Array<{
            xPoints: Float32Array;
            yPoints: Float32Array;
            name: string;
            color: string;
        }> = [];
        
        activeModels.forEach(model => {
            if (this.compareMode === 'spatial') {
                const solverNode = model.nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D');
                if (!solverNode) return;
                
                let telemetryBuffer = this.stateManager.getTelemetry(solverNode.id + "-binary");
                if (!telemetryBuffer) telemetryBuffer = this.stateManager.getTelemetry(solverNode.id);
                
                if (telemetryBuffer && telemetryBuffer instanceof ArrayBuffer) {
                    const MIN_HEADER = 8;
                    if (telemetryBuffer.byteLength >= MIN_HEADER) {
                        const headerView = new DataView(telemetryBuffer);
                        const n_cells = headerView.getUint32(0, true);
                        const n_channels = headerView.getUint32(4, true);
                        const expectedPayload = n_cells * n_channels * 4;
                        
                        if (telemetryBuffer.byteLength >= MIN_HEADER + expectedPayload) {
                            const clampedChannel = Math.max(0, Math.min(this.selectedChannel, n_channels - 1));
                            const offset = MIN_HEADER + clampedChannel * n_cells * 4;
                            const yPoints = new Float32Array(telemetryBuffer, offset, n_cells);
                            
                            const meshNode = model.nodes.find(n => n.type === 'DomainMesh' || n.type === 'DomainMesh2D' || n.type === 'DomainMesh3D');
                            const cellSize = Number(meshNode?.parameters?.cell_size ?? 0.001);
                            
                            const xPoints = new Float32Array(n_cells);
                            for (let i = 0; i < n_cells; i++) {
                                if (this.xAxisMode === 'radius') {
                                    xPoints[i] = (i + 0.5) * cellSize;
                                } else {
                                    xPoints[i] = i;
                                }
                            }
                            
                            curves.push({
                                xPoints,
                                yPoints,
                                name: model.name,
                                color: this.getModelColor(model.id)
                            });
                        }
                    }
                }
            } else {
                // Virtual Gauges Mode
                const gaugesNode = model.nodes.find(n => n.type === 'VirtualGauges');
                if (!gaugesNode) return;
                
                const history = this.stateManager.getTelemetry(gaugesNode.id);
                if (history && history.times && history.values && history.times.length > 0) {
                    const times = history.times;
                    const values = history.values;
                    const gaugesList = gaugesNode.parameters?.gauges || [];
                    
                    gaugesList.filter((g: any) => g.plot !== false).forEach((g: any) => {
                        const gData = values[g.id || g.name];
                        if (gData && gData[this.selectedChannel]) {
                            const yVals = gData[this.selectedChannel];
                            const xPoints = new Float32Array(times.length);
                            const yPoints = new Float32Array(times.length);
                            
                            for (let i = 0; i < times.length; i++) {
                                xPoints[i] = times[i];
                                yPoints[i] = yVals[i] !== undefined ? yVals[i] : 0.0;
                            }
                            
                            curves.push({
                                xPoints,
                                yPoints,
                                name: `${model.name} (${g.id || g.name})`,
                                color: this.getGaugeColor(model.id, g.id || g.name)
                            });
                        }
                    });
                }
            }
        });
        
        if (curves.length === 0) {
            ctx.fillStyle = '#666';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const msg = this.compareMode === 'spatial'
                ? 'Select models and run simulations to compare spatial profiles...'
                : 'Select models with virtual gauges and run simulations to compare time-series...';
            ctx.fillText(msg, cssW / 2, cssH / 2);
            ctx.restore();
            return;
        }
        
        const defaults = this.getDefaultBounds();
        if (!defaults) {
            ctx.fillStyle = '#666';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for valid simulation data...', cssW / 2, cssH / 2);
            ctx.restore();
            return;
        }
        
        let activeMinX = defaults.minX;
        let activeMaxX = defaults.maxX;
        const activeMinY = defaults.minY;
        const activeMaxY = defaults.maxY;
        
        if (this.zoomedOrPanned) {
            activeMinX = this.zoomMinX;
            activeMaxX = this.zoomMaxX;
        } else {
            this.zoomMinX = defaults.minX;
            this.zoomMaxX = defaults.maxX;
        }
        
        const paddingLeft = 55;
        const paddingRight = 15;
        const paddingTop = 25;
        const paddingBottom = 35;
        
        const plotW = cssW - paddingLeft - paddingRight;
        const plotH = cssH - paddingTop - paddingBottom;
        
        if (plotW <= 0 || plotH <= 0) {
            ctx.restore();
            return;
        }
        
        // Draw Grid lines
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#71717a';
        ctx.font = '9px monospace';
        
        // Y Grid & Ticks
        const ticksY = 5;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < ticksY; i++) {
            const pct = i / (ticksY - 1);
            const val = activeMinY + pct * (activeMaxY - activeMinY);
            const y = paddingTop + plotH - pct * plotH;
            
            ctx.beginPath();
            ctx.moveTo(paddingLeft, y);
            ctx.lineTo(cssW - paddingRight, y);
            ctx.stroke();
            
            ctx.fillText(val.toExponential(2), paddingLeft - 6, y);
        }
        
        // X Grid & Ticks
        const ticksX = 5;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < ticksX; i++) {
            const pct = i / (ticksX - 1);
            const val = activeMinX + pct * (activeMaxX - activeMinX);
            const x = paddingLeft + pct * plotW;
            
            ctx.beginPath();
            ctx.moveTo(x, paddingTop);
            ctx.lineTo(x, cssH - paddingBottom);
            ctx.stroke();
            
            let labelStr = '';
            if (this.compareMode === 'spatial') {
                labelStr = this.xAxisMode === 'radius' ? val.toFixed(3) : Math.round(val).toString();
            } else {
                labelStr = val.toFixed(5);
            }
            ctx.fillText(labelStr, x, cssH - paddingBottom + 6);
        }
        
        // Axis Lines
        ctx.strokeStyle = '#444';
        ctx.beginPath();
        ctx.moveTo(paddingLeft, paddingTop);
        ctx.lineTo(paddingLeft, cssH - paddingBottom);
        ctx.lineTo(cssW - paddingRight, cssH - paddingBottom);
        ctx.stroke();
        
        ctx.save();
        // Clip to the plotting area so lines don't bleed into the axes/padding
        ctx.beginPath();
        ctx.rect(paddingLeft, paddingTop, plotW, plotH);
        ctx.clip();

        // Curves
        curves.forEach(curve => {
            ctx.strokeStyle = curve.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            
            let first = true;
            for (let i = 0; i < curve.xPoints.length; i++) {
                const cx = paddingLeft + ((curve.xPoints[i] - activeMinX) / (activeMaxX - activeMinX || 1)) * plotW;
                const cy = paddingTop + plotH - ((curve.yPoints[i] - activeMinY) / (activeMaxY - activeMinY || 1)) * plotH;
                
                if (first) {
                    ctx.moveTo(cx, cy);
                    first = false;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();
        });
        ctx.restore();
        
        // Tooltip Crosshair
        if (this.hoverX !== null && this.hoverX >= paddingLeft && this.hoverX <= cssW - paddingRight &&
            this.hoverY !== null && this.hoverY >= paddingTop && this.hoverY <= cssH - paddingBottom) {
            
            const hoverRadius = activeMinX + ((this.hoverX - paddingLeft) / plotW) * (activeMaxX - activeMinX);
            
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(this.hoverX, paddingTop);
            ctx.lineTo(this.hoverX, cssH - paddingBottom);
            ctx.stroke();
            ctx.setLineDash([]);
            
            const tooltipItems: Array<{ name: string; valStr: string; color: string; cy: number }> = [];
            
            curves.forEach(curve => {
                let bestIdx = 0;
                let minDiff = Infinity;
                for (let i = 0; i < curve.xPoints.length; i++) {
                    const diff = Math.abs(curve.xPoints[i] - hoverRadius);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestIdx = i;
                    }
                }
                
                const cx = paddingLeft + ((curve.xPoints[bestIdx] - activeMinX) / (activeMaxX - activeMinX || 1)) * plotW;
                const cy = paddingTop + plotH - ((curve.yPoints[bestIdx] - activeMinY) / (activeMaxY - activeMinY || 1)) * plotH;
                
                ctx.fillStyle = curve.color;
                ctx.beginPath();
                ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
                ctx.fill();
                
                tooltipItems.push({
                    name: curve.name,
                    valStr: curve.yPoints[bestIdx].toExponential(3),
                    color: curve.color,
                    cy: cy
                });
            });
            
            ctx.save();
            ctx.font = '10px monospace';
            
            let maxNameW = 0;
            let maxValW = 0;
            tooltipItems.forEach(item => {
                maxNameW = Math.max(maxNameW, ctx.measureText(item.name).width);
                maxValW = Math.max(maxValW, ctx.measureText(item.valStr).width);
            });
            
            const radStr = this.compareMode === 'spatial'
                ? (this.xAxisMode === 'radius' ? `Radius: ${hoverRadius.toFixed(3)} m` : `Cell ID: ${Math.round(hoverRadius)}`)
                : `Time: ${hoverRadius.toFixed(5)} s`;
            const headerW = ctx.measureText(radStr).width;
            
            const boxW = Math.max(headerW, maxNameW + maxValW + 20) + 16;
            const boxH = 16 + (tooltipItems.length + 1) * 14;
            
            let tooltipX = this.hoverX + 12;
            let tooltipY = this.hoverY + 12;
            
            if (tooltipX + boxW > cssW) tooltipX = this.hoverX - boxW - 12;
            if (tooltipY + boxH > cssH) tooltipY = this.hoverY - boxH - 12;
            
            ctx.fillStyle = 'rgba(24, 24, 28, 0.95)';
            ctx.strokeStyle = '#3f3f46';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (typeof (ctx as any).roundRect === 'function') {
                (ctx as any).roundRect(tooltipX, tooltipY, boxW, boxH, 4);
            } else {
                ctx.rect(tooltipX, tooltipY, boxW, boxH);
            }
            ctx.fill();
            ctx.stroke();
            
            ctx.fillStyle = '#a1a1aa';
            ctx.fillText(radStr, tooltipX + 8, tooltipY + 18);
            
            tooltipItems.forEach((item, idx) => {
                const itemY = tooltipY + 32 + idx * 14;
                
                ctx.fillStyle = item.color;
                ctx.fillRect(tooltipX + 8, itemY - 6, 8, 8);
                
                ctx.fillStyle = '#e4e4e7';
                ctx.fillText(item.name, tooltipX + 22, itemY);
                
                ctx.fillStyle = '#f4f4f5';
                ctx.textAlign = 'right';
                ctx.fillText(item.valStr, tooltipX + boxW - 8, itemY);
                ctx.textAlign = 'left';
            });
            ctx.restore();
        }
        
        ctx.restore();
    }
}
