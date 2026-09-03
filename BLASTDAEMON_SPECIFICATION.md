# BLASTDAEMON ARCHITECTURAL SPECIFICATION & COMPLETE ENGINEERING BLUEPRINT
Document ID: BD-CAE-SPEC-2026-REV1
Project: BlastDaemon Multi-Physics Framework
Scope: UI Paradigm Shift, Multi-Node Orchestration, Dynamic In-Flight Steering, Monte-Carlo/AI Dataset Engine, Standalone Desktop Shell, and Headless CLI

================================================================================
1. MASTER DIRECTIVES AND SYSTEM CONSTRAINTS
================================================================================
- Zero-Dependency Frontend: Written purely in Vanilla TypeScript, native HTML5 DOM APIs, and CSS. No React, Vue, Svelte, or external UI component libraries. Standard ES6 modules via tsc. Local dev bundler limited strictly to Vite.
- Zero-Dependency Broker Daemon: Pure C++17 standard library. No Boost, no gRPC, no external JSON linkage. Single-file nlohmann/json.hpp embedded in-tree. Raw POSIX sockets with self-contained RFC 6455 WebSocket implementation.
- Zero-Dependency Visuals: Native HTML5 canvas and raw WebGPU / WebGL2 APIs. No Three.js or Babylon.js.
- Permitted Volumetric I/O Exception: HDF5 (C API) is permitted strictly for heavy volumetric simulation disk I/O and linked only to the BlastSolver worker executable.
- Strict Process Isolation: Broker and Worker run as separate OS processes communicating over standard OS pipes (stdin/stdout).
- Single Source of Truth (SSOT): State is an immutable Directed Acyclic Graph (DAG) under the hood, managed through the ParaView-style Pipeline Browser.
- Mandatory Model Status Invalidation: Modifying any physical parameter explicitly invalidates the model status via setModelStatus(modelId, 'UNINITIALIZED').
- Mandatory Minimum 2nd-Order Temporal Accuracy: Lagrangian solvers default to 2nd-Order Symplectic Central Difference / Staggered Leapfrog; Eulerian CFD defaults to 2nd-Order ADER-2 or TVD/SSP-RK2.
- 3D Uniform Grid Mandate: 3D CFD executes strictly on single-block uniform Cartesian grids (DomainMesh3D). 3D AMR and subgrids remain completely purged.
- Math & Equation Presentation: Raw LaTeX math formatting is prohibited. All equations use inline code, standard Unicode math symbols (dt, rho, sigma, gamma, div u, sqrt), or fenced text blocks.

================================================================================
2. WORKSTATION UI SPECIFICATION (PARAVIEW + HYPERMESH PARADIGM)
================================================================================
- Pipeline Browser (Left Rail): Hierarchical tree browser replacing the 2D node-graph canvas. Manages parent-child entity nesting, visibility toggles, filter pipelines, and collector sets.
- Property Grid (Right Rail): High-density, two-column key-value matrix with [Parameters] and [Display] tabs, collapsible accordions, and unified numeric casting.
- Viewport (Center): Arbitrary split container supporting 1x1, 1x2, 2x1, and 2x2 grids routing off-thread to WebGPU 3D Viewports, 2D Contours, and 1D Profile / Gauge Charts.
- Docked Bottom Bar: Time transport scrubber (Play, Pause, Step, Reverse), Live-Lock synchronization, camera snap buttons, orthogonal slice toggles, and scalar field colormap pickers.

================================================================================
3. DECOUPLED 4-TIER COMPUTE & STREAMING PIPELINE
================================================================================
- Tier 1 (Compute): BlastSolver C++20 / CUDA worker running high-priority stepping loop with non-blocking stdin command polling.
- Tier 2 (Network): Broker C++17 daemon managing WebSocket RFC 6455 binary frame broadcasting.
- Tier 3 (Client Main Thread): In-memory PlaybackRingBuffer caching the last N binary frames for 60 FPS non-blocking scrubbing and reverse playback.
- Tier 4 (Off-Thread Workers): ViewportWorker (WebGPU), ContourWorker (2D Canvas), and ChartWorker (1D Plots) owning OffscreenCanvas handles.

================================================================================
4. REMOTE COMPUTE, HARDWARE & PROCESS ORCHESTRATION
================================================================================
- Cluster Manager: Multi-node WebSocket connection pool streaming 30 Hz RESOURCE_PULSE diagnostics (NVML GPU %, VRAM used/free, temperatures, and CPU core utilization).
- Process Manager: POSIX process lifecycle management (SPAWN_WORKER, PAUSE, RESUME, RESTART, KILL_FORCE) with CPU core affinity pinning and CUDA_VISIBLE_DEVICES allocation.

================================================================================
5. IN-FLIGHT STEERING, CHECKPOINT ROLLBACKS & AST EVENT ENGINE
================================================================================
- Deep Checkpoint Pool: In-memory GPU VRAM snapshot ring buffer enabling mid-run rollback and branch continuation on numerical instability.
- Dynamic CFL Scheduling: Automated multi-stage CFL schedules (Linear Time Ramp, Step Warmup) for high-gradient blast initiations.
- AST Event Engine: C++ zero-dependency in-situ event dispatcher evaluating triggers (TIME_GE, STEP_GE, SCALAR_MAX_GE) and executing actions (SET_PARAM, TRIGGER_SNAPSHOT, ROLLBACK_BRANCH).

================================================================================
6. DESIGN OF EXPERIMENTS (DOE), MONTE-CARLO & AI DATASET ENGINE
================================================================================
- DOELatinHypercubeSampler: Pure C++20 Latin Hypercube (LHS), Uniform, Normal, and Discrete-set parameter space sampler.
- AI Structured Dataset Output: Automated batch execution writing bit-exact config.json, telemetry_probes.csv, binary field tensors, and master summary.csv / manifest.json for surrogate model training.

================================================================================
7. HEADLESS & INTERACTIVE C++ CLI (blastcli)
================================================================================
- Standalone zero-dependency C++20 CLI supporting interactive REPL terminal control and headless SLURM/PBS batch script execution.

================================================================================
8. STANDALONE DESKTOP SHELL (BlastStudio) & PLATFORM ABSTRACTION
================================================================================
- Single-binary native desktop application embedding a lightweight native OS webview (WebKitGTK/WebView2) with an embedded background Broker daemon.
- PlatformBridge interface maintaining 100% code parity between in-browser WebGPU and standalone desktop builds.

================================================================================
9. REPOSITORY FILE MIGRATION MATRIX
================================================================================
- frontend/src/pipeline-browser.ts      [CREATE] ParaView-style hierarchical pipeline tree
- frontend/src/property-grid.ts         [CREATE] HyperMesh-style key-value property inspector
- frontend/src/workspace-manager.ts     [CREATE] Multi-view split container & presets
- frontend/src/transport-controller.ts  [CREATE] Bottom transport bar & time scrubber
- frontend/src/playback-buffer.ts       [CREATE] Client-side in-memory frame cache
- frontend/src/ClusterNodeManager.ts    [CREATE] Multi-broker pool & NVML monitor
- frontend/src/PlatformBridge.ts        [CREATE] Platform abstraction layer
- backend/BlastSolver/event_engine.hpp  [CREATE] C++ AST event & trigger engine
- backend/BlastSolver/batch_sampler.hpp [CREATE] Zero-dependency C++20 DOE sampler
- backend/BlastSolver/batch_runner.hpp  [CREATE] Batch execution pool & dataset writer
- backend/BlastStudio/main.cpp          [CREATE] Single-binary C++ native desktop shell
- backend/BlastCLI/main.cpp             [CREATE] Zero-dependency C++20 CLI runner
- frontend/src/graph-renderer.ts        [RETIRE] Purge visual 2D node-graph canvas
