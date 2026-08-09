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

## 7. Chat Response & Formatting Rule (ABSOLUTE RULE)
- **No Unrendered Markup / Raw Formatting:** All chat responses MUST be formatted directly as clean, rendered, human-readable text. Do NOT emit raw, escaped, or unrendered markdown markup (such as double-escaped LaTeX brackets, raw syntax delimiters, or unparsed markdown blocks that force manual translation).
- **Mandatory Directives Read:** AI assistants MUST always inspect and strictly adhere to `AGENTS.md` directives prior to generating code, making edits, or responding to user requests.

## 8. Automatic Broker Management Directive (ABSOLUTE RULE)
- **Do NOT automatically start or restart the Broker:** Under no circumstances should the agent launch, start, or restart the `./Broker` daemon automatically in the background. The Broker process is managed manually by the user in their own terminal.

## 9. 3D AMR and Subgrid Removal Directive (ABSOLUTE RULE)
- **3D AMR and 3D Subgrids/Submeshes have been completely removed:** All dynamic 3D AMR, static 3D nested subgrids, submeshes, restriction, prolongated ghost fills, and multi-mesh 3D hierarchy code have been completely purged from the backend C++ solver and frontend UI.
- **3D Uniform Grid Only:** All 3D simulation models execute strictly on standard single-block uniform grids. Do NOT attempt to reintroduce 3D AMR or 3D subgrid concepts.
- **1D/2D Unchanged:** 1D and 2D solvers retain their existing AMR/subgrid features as-is.

## 10. Architectural Consistency (ABSOLUTE RULE)
- AI assistants MUST always inspect and cross-reference [ARCHITECTURE.md](file:///home/chris/antigrav/blastdemon/ARCHITECTURE.md) to ensure consistency with existing framework layouts before suggesting or making changes.

## 11. Strict Parameter Override Prevention and Device Fail-Safe (ABSOLUTE RULE)
- **No Floating Parameter Overrides:** When serializing parameters from multiple canvas nodes (such as in FSI coupling), ensure that solver configurations (like `device` and `precision` on `CFDSolver3D`) are never silently overridden or overwritten by default parameters from other nodes (like `MPMDomain3D`). Re-apply solver parameters at the end of the serialization pipeline to guarantee precedence.
- **Fail Loudly on Device/Allocation Errors:** The solver must validate all CUDA memory allocations. Never allow execution to proceed with failed allocations or null pointers (which triggers asynchronous GPU crashes). Always throw explicit exceptions, log errors, and exit solver processes to trigger clean Broker process cleanup and UI error states.

## 12. Unified Parameter Pipeline & Mandatory State Invalidation (ABSOLUTE RULE)
- **Mandatory Model Status Invalidation:** Whenever ANY physical solver parameter (mesh dimensions, cell size, charge mass/geometry, material EOS, detonator location, boundary conditions, CFL, flux scheme, solver order, hardware device/precision, MPM properties, FSI coupling parameters) is modified on a node in the UI—whether via standard form submit, in-place edit, slider input, or inline canvas control—the state manager MUST explicitly invalidate the model state by setting `setModelStatus(modelId, 'UNINITIALIZED')`.
- **Strict Prohibition of Global Status Shims for Models:** `updateNodeParameters` and `updateNodeParametersInPlace` MUST target the specific `modelId` owning the node and call `this.setModelStatus(modelId, 'UNINITIALIZED')` for all physical parameter edits. Never call the global `this.setStatus('UNINITIALIZED')` shim in place of per-model status updates.
- **Complete Re-initialization Enforcement:** When `executeModelCommand()` receives a `STEP` or `EXEC_ALL` request for a model whose status is `'UNINITIALIZED'`, it MUST send the appropriate `INIT` / `INIT_2D` / `INIT_3D` / `INIT_FSI_2D` / `INIT_FSI_3D` command to the backend prior to issuing execution steps.
- **Precedence & Serialization Isolation:** Serializing parameters across multi-node graphs (e.g., FSI coupling, remap pipelines) MUST enforce strict parameter precedence. Solver configuration keys (`device`, `precision`, `cfl`, `init_mode`) on primary solver nodes MUST be re-applied at the end of the serialization pipeline to prevent default parameters from connected domain nodes (e.g. MPMDomain3D) from silently overwriting user selections.
- **Synchronized Numeric Casting (`numericKeys`):** Any numeric key added to any node parameter schema MUST be added to all 4 `numericKeys` lists in `serialization.ts`, `property-editor.ts`, `node-viewer.ts`, and `graph-renderer.ts`.
