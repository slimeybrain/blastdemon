from playwright.sync_api import Page, expect, sync_playwright
import time

def verify_ui_polish(page: Page):
    # 1. Arrange: Go to the app.
    page.goto("http://localhost:5173")
    time.sleep(2) # Wait for initial render

    # 2. Verify Transport Cleanup (Play button should be gone)
    play_btn = page.locator("#play-btn")
    expect(play_btn).not_to_be_visible()

    # 3. Verify Outliner Selection
    outliner_item = page.locator("#outliner li").first
    outliner_item.click()
    expect(outliner_item).to_have_class("selected")

    # 5. Verify Panel Type NODE_VIEWER
    panel_select = page.locator(".header-select").first
    panel_select.select_option("NODE_VIEWER")

    # Sub-selector should appear
    sub_select = page.locator(".node-sub-select")
    expect(sub_select).to_be_visible()

    # Select a node in the viewer
    sub_select.select_option(index=1)
    page.screenshot(path="verification/verification_standard.png")

    # Add Telemetry nodes via console
    page.evaluate("""
        const state = window.stateManager.getCurrentState();
        state.nodes.push({
            id: 'node-text', type: 'TelemetryText', x: 800, y: 50,
            inputs: [{ id: 'in', label: 'Data Stream' }], outputs: [], parameters: {}
        });
        state.nodes.push({
            id: 'node-graph', type: 'TelemetryGraph', x: 800, y: 300,
            inputs: [{ id: 'in', label: 'Data Stream' }], outputs: [], parameters: {}
        });
        state.edges.push({ fromNode: 'node-solver', fromPort: 'telemetry', toNode: 'node-text', toPort: 'in' });
        state.edges.push({ fromNode: 'node-solver', fromPort: 'telemetry', toNode: 'node-graph', toPort: 'in' });
        window.stateManager.pushState(state);
    """)
    time.sleep(1)

    # Show Text Telemetry in Viewer
    sub_select.select_option(value="node-text")
    page.evaluate("""
        window.stateManager.pushTelemetry({ type: 'log', time: 1.234, message: 'Test Log Message' });
    """)
    time.sleep(0.5)
    page.screenshot(path="verification/verification_text.png")

    # Show Graph Telemetry in Viewer
    sub_select.select_option(value="node-graph")
    page.evaluate("""
        window.stateManager.pushTelemetry({ type: 'frame', time: 1.234, data: Array.from({length: 100}, (_, i) => Math.sin(i/10) * 100000) });
    """)
    time.sleep(0.5)
    page.screenshot(path="verification/verification_graph.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            verify_ui_polish(page)
        finally:
            browser.close()
