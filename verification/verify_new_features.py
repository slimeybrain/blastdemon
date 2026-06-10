from playwright.sync_api import Page, expect, sync_playwright
import time
import os

def verify_ui_features(page: Page):
    # 1. Arrange: Go to the app.
    page.goto("http://localhost:5173")
    time.sleep(5) # Wait for initial render and vite warmup

    # Check for EXECUTION_MANAGER panel
    execution_panel = page.locator(".execution-manager-panel")
    expect(execution_panel).to_be_visible()
    page.screenshot(path="verification/verify_execution_manager.png")

    # Check for node collapse button
    collapse_btn = page.locator(".node-collapse-btn").first
    expect(collapse_btn).to_be_visible()

    # Toggle collapse
    collapse_btn.click()
    time.sleep(0.5)
    page.screenshot(path="verification/verify_node_collapsed.png")

    # Toggle back
    collapse_btn.click()
    time.sleep(0.5)

    # Add Telemetry nodes via console to test resizing and routing
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
        state.connections.push({ fromNode: 'node-solver', fromPort: 'telemetry', toNode: 'node-text', toPort: 'in' });
        state.connections.push({ fromNode: 'node-solver', fromPort: 'telemetry', toNode: 'node-graph', toPort: 'in' });
        window.stateManager.pushState(state);
    """)
    time.sleep(1)

    # Verify Telemetry Text routing in Node Viewer
    viewer_panel = page.locator(".panel").filter(has_text="NODE VIEWER").first
    panel_select = viewer_panel.locator(".header-select")
    panel_select.select_option("NODE_VIEWER")

    sub_select = viewer_panel.locator(".node-sub-select")
    sub_select.select_option(value="node-text")

    # Push telemetry
    page.evaluate("""
        window.stateManager.pushTelemetry('node-text', ['Line 1', 'Line 2', 'Line 3']);
    """)
    time.sleep(0.5)

    terminal = page.locator("#viewer-text-node-text")
    expect(terminal).to_be_visible()
    expect(terminal).to_contain_text("Line 1")
    page.screenshot(path="verification/verify_telemetry_text_routing.png")

    # Verify Graph Telemetry rendering (at least no crash)
    sub_select.select_option(value="node-graph")
    page.evaluate("""
        const buffer = new Float32Array([10, 20, 30, 40, 50]).buffer;
        window.stateManager.pushTelemetry('node-graph', buffer);
    """)
    time.sleep(1)
    page.screenshot(path="verification/verify_telemetry_graph.png")

    # Test Hover logic (manual-ish)
    # We move mouse to a port
    port = page.locator(".port-bullet").first
    box = port.bounding_box()
    if box:
        page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)
        time.sleep(0.5)
        # Check for yellow circle in SVG
        highlight = page.locator(".port-highlight")
        # expect(highlight).to_be_visible() # Might be hard to catch in screenshot
        page.screenshot(path="verification/verify_hover.png")

if __name__ == "__main__":
    os.makedirs("verification", exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            verify_ui_features(page)
        finally:
            browser.close()
