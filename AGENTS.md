# Master Agent Directives. All AI coding assistants (Jules, Copilot, etc.) MUST adhere to these architectural rules before modifying any code.

# Project Name: BlastDaemon (Enterprise CFD Framework)
# Core Architecture: Zero-Dependency Broker/Worker & SSOT Node-Graph

## 1. The "Zero-Dependency" Mandate (ABSOLUTE RULE)
- **Do NOT** use external frameworks, package managers, or libraries unless explicitly approved in the ONE exception below.
- **Frontend:** Pure Vanilla TypeScript, HTML, and CSS. No React, Vue, Webpack, or Vite. Use native DOM APIs and standard ES6 modules via `tsc`.
- **Backend:** Pure C++20 standard library. No Boost, no gRPC.
- **Networking:** Use raw OS-level sockets (POSIX `<sys/socket.h>` for Linux / `<winsock2.h>` for Windows) or custom raw WebSockets.
- **Visuals:** Use native HTML5 `<canvas>` or raw WebGPU API. No Three.js or Babylon.js.

## 2. The ONE Permitted Dependency Exception
- **HDF5 (C API):** Allowed strictly for heavy volumetric disk I/O. It may ONLY be linked to the `BlastSolver` (Worker) executable. The main `BlastDaemon` (Broker) must remain 100% zero-dependency.

## 3. Core Architectural Patterns
- **Process Isolation (Broker/Worker):** The system operates as two separate binaries. The Broker manages WebSockets and UI telemetry. The Worker executes the CUDA math. They communicate via OS standard I/O pipes.
- **Single Source of Truth (SSOT):** The UI state is an immutable Directed Acyclic Graph (DAG) built in vanilla TypeScript, synchronized across a Visual Node Graph, a Tree Outliner, and a Text Command view.
- **Separation of I/O Concerns:** Lightweight UI telemetry is streamed over WebSockets. Heavy simulation data is written directly to disk by the Worker using the XDMF + HDF5 pattern.

## 4. Code Generation Guidelines
- Keep files modular and strictly typed.
- Prioritize memory safety and explicit OS-level error handling in C++.
- Write clean, human-readable vanilla TS using Object-Oriented or functional paradigms.
- Never add a dependency to `package.json` or `CMakeLists.txt` without explicit human approval.

## 5. Browser Agent & Tool Restrictions (ABSOLUTE RULE)
- **Do NOT** use the `browser_subagent` tool or start browser subagents under any circumstances.
- **Do NOT** open new browser windows or pages.
- Verify frontend layout, visual changes, and state logic through static analysis, code reviews, unit tests, or manual user inspection rather than invoking automated browser agents.

## 6. Node Parameter Alignment Rule (ABSOLUTE RULE)
- **Zero Parameter Drift:** Every configuration property / parameter defined on a node MUST be explicitly wired, validated, serialized, and handled by the C++ backend solver. No unused, phantom, or floating parameters are allowed.
- **Unified Cast Lists:** When adding a new numeric parameter to any node, it MUST be added to the `numericKeys` list in:
  - `frontend/src/serialization.ts`
  - `frontend/src/property-editor.ts`
  - `frontend/src/node-viewer.ts`
  - `frontend/src/graph-renderer.ts`
- **Default Parameter Alignment:** Default node parameters MUST be identical between `state-manager.ts` (`defaults` map) and `graph-renderer.ts` (`getDefaultParameters` method) to prevent property inspector and UI anomalies.
- **Dropdown and Widget Uniformity:** When a node parameter has discrete options (like an enum or fixed choice list), ensure it is styled and rendered as a dropdown selector or other appropriate widget *both* in the sidebar property editor (`frontend/src/property-editor.ts`) and on the node canvas representation (`frontend/src/graph-renderer.ts`). Never leave it as a plain text input when options are pre-defined.



