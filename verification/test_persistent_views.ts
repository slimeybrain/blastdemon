/**
 * Verification test for Persistent Views & Configs in BlastDaemon.
 * Tests StateManager model view serialization, healing, and layout stage persistence.
 */

// Mock localStorage and browser environment for node
const store: Record<string, string> = {};
(globalThis as any).localStorage = {
    getItem: (k: string) => store[k] || null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
};
(globalThis as any).window = globalThis;

import { StateManager, prepareModelSavePayload } from '../frontend/src/state-manager.js';
import { ModelViewConfig, ViewportOptions, MultiViewStageOptions } from '../frontend/src/types.js';

function assert(condition: boolean, msg: string) {
    if (!condition) {
        console.error(`FAIL: ${msg}`);
        process.exit(1);
    } else {
        console.log(`PASS: ${msg}`);
    }
}

async function runTests() {
    console.log("--- Starting Persistent Views Verification Tests ---");

    const sm = new StateManager();
    const activeModel = sm.getActiveModel();
    assert(activeModel !== null, "Active model should exist");
    const modelId = activeModel!.id;

    // 1. Check auto-healing creates initial default view
    const views = sm.getModelViews(modelId);
    assert(views.length >= 1, "Model views should contain at least 1 view");
    assert(views[0].id === 'view-default', "Default view id should be 'view-default'");
    assert(views[0].name === 'Default View', "Default view name should be 'Default View'");
    assert(views[0].camera !== undefined, "Default view should have camera parameters");
    assert(views[0].slices !== undefined && Array.isArray(views[0].slices), "Default view should have slices array");
    console.log("Initial default view:", JSON.stringify(views[0], null, 2));

    const activeView = sm.getModelActiveView(modelId);
    assert(activeView !== null, "Model active view should not be null");
    assert(activeView!.id === 'view-default', "Model active view id should match 'view-default'");

    // 2. Test updating camera on active view
    sm.updateModelActiveViewCamera(modelId, {
        pitch: 0.75,
        yaw: 1.25,
        distance: 3.2,
        target: [0.5, 0.5, 0.5],
        usePerspective: false,
        fov: 50
    });

    const updatedView = sm.getModelActiveView(modelId);
    assert(updatedView!.camera!.pitch === 0.75, "Active view camera pitch updated");
    assert(updatedView!.camera!.yaw === 1.25, "Active view camera yaw updated");
    assert(updatedView!.camera!.distance === 3.2, "Active view camera distance updated");
    assert(updatedView!.camera!.target[0] === 0.5, "Active view camera target[0] updated");
    assert(updatedView!.camera!.usePerspective === false, "Active view camera usePerspective updated");

    // 3. Test updating slices on active view
    sm.updateModelActiveViewSlices(modelId, [
        { axis: 'xy', offset: 0.12, quantity: 'pressure', enabled: true, colormap: 'turbo' }
    ]);
    const slicedView = sm.getModelActiveView(modelId);
    assert(slicedView!.slices!.length === 1, "Active view has 1 slice");
    assert(slicedView!.slices![0].offset === 0.12, "Active view slice offset is 0.12");

    // 4. Test adding a new view bookmark
    const newView = sm.addModelView(modelId, "Corner Inspection");
    assert(newView !== null, "addModelView returns new view");
    assert(newView!.name === "Corner Inspection", "New view name matches");
    assert(sm.getModelViews(modelId).length === 2, "Model now has 2 views");
    assert(sm.getModelActiveView(modelId)!.id === newView!.id, "Active view switched to new view");
    assert(newView!.camera!.pitch === 0.75, "New view inherited current camera pitch");

    // 5. Test switching active view
    sm.setModelActiveViewId(modelId, 'view-default');
    assert(sm.getModelActiveView(modelId)!.id === 'view-default', "Active view switched back to view-default");

    // 6. Test prepareModelSavePayload contains views and activeViewId
    const currentModel = sm.getModel(modelId)!;
    const savePayload = prepareModelSavePayload(currentModel, '/tmp/test_model.json');
    assert(savePayload !== null, "prepareModelSavePayload returns payload");
    const parsed = JSON.parse(savePayload.modelJson);
    assert(Array.isArray(parsed.views), "modelJson contains views array");
    assert(parsed.views.length === 2, "modelJson contains 2 views");
    assert(parsed.activeViewId === 'view-default', "modelJson contains activeViewId");
    console.log("Serialized views in modelJson:", JSON.stringify(parsed.views, null, 2));

    // 7. Test Viewport options persistence in layout
    function findFirstPanel(node: any): any {
        if (!node) return null;
        if (node.type === 'panel') return node;
        if (node.type === 'split') return findFirstPanel(node.firstChild) || findFirstPanel(node.secondChild);
        return null;
    }
    const state = sm.getCurrentState()!;
    const panel = findFirstPanel(state.layout);
    assert(panel !== null, "Layout has at least one panel");
    const stagePanelId = panel.id;
    const testStageOptions: ViewportOptions = {
        preset: '2x2',
        panes: [
            { index: 0, viewType: '3D_VIEWPORT', modelId: modelId, viewId: 'view-default' },
            { index: 1, viewType: '3D_VIEWPORT', modelId: modelId, viewId: newView!.id },
            { index: 2, viewType: '2D_CONTOUR', modelId: modelId },
            { index: 3, viewType: 'RESOURCE_MONITOR', modelId: modelId }
        ]
    };
    sm.updatePanelOptions(stagePanelId, testStageOptions);

    const updatedState = sm.getCurrentState()!;
    const updatedPanel = findFirstPanel(updatedState.layout);
    assert(updatedPanel.options?.preset === '2x2', "Panel options preset persisted as 2x2");
    assert(updatedPanel.options?.panes?.length === 4, "Panel options panes persisted with 4 panes");
    console.log("Panel options persisted successfully:", JSON.stringify(updatedPanel.options, null, 2));

    // 8. Test delete view
    const deleted = sm.deleteModelView(modelId, newView!.id);
    assert(deleted === true, "deleteModelView returned true");
    assert(sm.getModelViews(modelId).length === 1, "Model back to 1 view");
    assert(sm.getModelActiveView(modelId)!.id === 'view-default', "Active view is view-default after deletion");

    // 9. Test legacy MULTI_VIEW_STAGE normalization to VIEWPORT on hydration
    const legacySavedState = JSON.stringify({
        models: {
            'model-default': { id: 'model-default', name: 'Default Model', filename: null, nodes: [], connections: [] }
        },
        workspaces: [
            {
                id: 'ws-0',
                name: 'Workspace 1',
                modelIds: ['model-default'],
                activeModelId: 'model-default',
                layout: {
                    type: 'split',
                    id: 'split-top',
                    direction: 'vertical',
                    ratio: 0.05,
                    firstChild: { type: 'panel', id: 'p-menu', panelType: 'MENU_BAR' },
                    secondChild: {
                        type: 'split',
                        id: 'split-center',
                        direction: 'horizontal',
                        ratio: 0.25,
                        firstChild: { type: 'panel', id: 'p-pipe', panelType: 'PIPELINE_BROWSER' },
                        secondChild: {
                            type: 'split',
                            id: 'split-vp',
                            direction: 'vertical',
                            ratio: 0.85,
                            firstChild: { type: 'panel', id: 'p-stage', panelType: 'MULTI_VIEW_STAGE' },
                            secondChild: { type: 'panel', id: 'p-trans', panelType: 'TRANSPORT_BAR' }
                        }
                    }
                },
                connections: []
            }
        ],
        activeWorkspaceId: 'ws-0',
        workspaceCounter: 1
    });
    store['blast_app_state'] = legacySavedState;
    const smLegacy = new StateManager();
    const hydrated = smLegacy.loadWorkspace();
    assert(hydrated !== null, "Hydrated state from legacy MULTI_VIEW_STAGE");
    function findPanelById(node: any, id: string): any {
        if (!node) return null;
        if (node.type === 'panel' && node.id === id) return node;
        if (node.type === 'split') return findPanelById(node.firstChild, id) || findPanelById(node.secondChild, id);
        return null;
    }
    const legacyPanel = findPanelById(hydrated!.layout, 'p-stage');
    assert(legacyPanel !== null, "Found p-stage panel");
    assert(legacyPanel.panelType === 'VIEWPORT', "Legacy MULTI_VIEW_STAGE panelType was normalized to VIEWPORT");

    console.log("--- All Persistent Views Tests Passed Successfully! ---");
}

runTests().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
