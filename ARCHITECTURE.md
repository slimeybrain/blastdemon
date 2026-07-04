# BlastDaemon Enterprise CFD Framework Architecture

This document provides a highly detailed description of the BlastDaemon application architecture, core design principles, state management, and communication protocols. It serves as the primary source of truth for understanding the application's current state and development rules.

## 1. Core Mandates & Architecture Rules (AGENTS.md)

- **Zero-Dependency Mandate (Absolute Rule):**
  - **Frontend:** Pure Vanilla TypeScript, HTML, and CSS. No external frameworks (React, Vue) or libraries allowed. Native DOM APIs and standard ES6 modules via `tsc` (with Vite permitted strictly for local development/bundling).
  - **Backend:** Pure C++20 standard library. No Boost, no gRPC. Networking uses raw OS-level sockets (POSIX `<sys/socket.h>` / Windows `<winsock2.h>`).
  - **Visuals:** Native HTML5 `<canvas>`. No 3D frameworks (Three.js/Babylon.js).
- **The ONE Exception:** HDF5 (C API) is permitted strictly for heavy volumetric disk I/O, and it may ONLY be linked to the `BlastSolver` (Worker) executable. The `Broker` daemon must remain 100% zero-dependency.
- **Single Source of Truth (SSOT):** The UI state is an immutable Directed Acyclic Graph (DAG) synchronized across the Visual Node Graph, Tree Outliner, and Text Command View.
- **Separation of Concerns:** Lightweight UI telemetry streams over WebSockets. Heavy simulation data is written directly to disk (XDMF + HDF5) by the Worker.

## 2. Process Isolation & IPC (Backend)

The backend is split into two separate processes that communicate via OS standard I/O pipes (stdin/stdout):

### The Broker (Daemon)
- **Role:** Manages WebSocket connections and acts as a router/relay. Spawns and manages the `BlastSolver` child process.
- **Network Interface:** Implements raw WebSocket handshake (SHA-1/Base64) and framing. Listens on port 8080.
- **Boot Safety:** Aggressive boot logging (`[SYSTEM] Booting Broker...`). Catches bind/listen failures, logging `[FATAL]` to `std::cerr` and terminating with `exit(1)`.
- **JSON Processing:** The payload mapping loop in `process_json` evaluates every node in the `payload["nodes"]` array without early exits. It uses robust `try/catch` blocks inside the loop so that a failure in mapping one node does not halt the processing of the rest.
- **Command Routing:** Forwards commands like `EXEC_ALL` and `EXEC_END` from the WebSocket directly to the Worker's stdin.
- **Telemetry Relay Loop:** Implements binary-safe logic using a std::vector<uint8_t> accumulator and try/catch blocks around `std::stoul` to prevent crashes on malformed `BIN_FRAME` sizes. In `emit_telemetry_2d`, the channel count `n_channels` is computed dynamically from the output frame length (e.g. 5 channels for Ideal Gas vs 7 for Multi-Material) to seamlessly support varying telemetry payloads.

### The BlastSolver (Worker)
- **Role:** Executes the high-performance CFD CUDA/C++ math.
- **2D Solver & CUDA Extension:** Spawns `CFDSolver2D` (CPU) or `CFDSolver2DCuda` (GPU) solvers depending on device config.
  - **Ideal Gas Single-Material Track:** Tracks `is_ideal_gas` state flag set upon initialization. Conditionally omits `alpha1` and `alpha2` telemetry (reducing channel count from 7 to 5) so the UI natively treats it as a single-material ideal gas simulation.
  - **Circular 1D-to-2D Remap:** Implements subgrid cell averaging ($K=5$ sub-cells per direction) to map 1D spherical solver states to 2D conservative variables. Clamps coordinate distances to the physical 1D domain boundary (`d_sub <= r_1d.back()`) to prevent flat-extrapolation into the corners of the grid, ensuring a clean circular shock boundary.
- **Simulation Loop:** Runs asynchronously via a detached `std::thread`, managed by atomic flags (`sim_running`, `sim_paused`, `sim_terminate`).
- **Termination:** `CFDSolver::is_terminated()` const method returns true when `active_r_idx >= n_cells`.
- **Parameter Binding:** The `INIT` command payload maps frontend parameters directly to the solver configuration structure. There are no default fallbacks; all values are strictly parsed from the JSON payload.
- **Telemetry Emission:** Throttle at 30Hz using `std::chrono` (approx. 33ms) to emit state to stdout, with a forced "Guarantee Frame" at execution end.
- **Resource Pulse:** Emits a 30Hz JSON payload containing mocked system metrics (CPU, RAM, GPU, VRAM, Temp) dynamically calculated against the current mesh cell count.

### IPC Communication Protocol
- **Broker to Worker:** Standard JSON lines pushed to `stdin`.
- **Worker to Broker (Hybrid Stream):** Standard output uses a hybrid framing protocol:
  - JSON strings for metadata, progress, and resource pulses.
  - Raw binary float arrays prefixed with a exact `BIN_FRAME <size>\n` marker for high-frequency graph telemetry.

## 3. CFD Solvers & Mathematical Engine

The simulation mathematics and physical state updates are computed in the `BlastSolver` using a set of structured, high-performance CFD solvers.

### Available Solvers
1. **1D Solver (`CFDSolverImpl<IsMultiMaterial>`)**: 
   - Templated class specializing on whether the simulation tracks a single-material (Ideal Gas) or multi-material flow (unreacted JWL explosive, JWL detonation products, and ambient air).
   - Simulates 1D spherical/radial explosion dynamics on a 1D grid.
2. **2D Solver (`CFDSolver2D` / `CFDSolver2DCuda`)**:
   - Supports 2D axisymmetric (cylindrical $r$-$z$) and Cartesian geometry configurations.
   - Solves 2D fluid dynamics equations with optional GPU acceleration via CUDA.

### Capabilities & Physical Models
* **Equation of State (EOS)**:
  - **Ideal Gas**: Used for ambient air and standalone single-material simulations. Relates pressure and energy via $E = \frac{p}{\gamma - 1}$.
  - **JWL (Jones-Wilkins-Lee)**: Relates pressure, density, and energy for high-pressure unreacted explosive and detonation products.
* **Detonation Model**: Programmed Burn (PB) calculates burn fraction $F_{pb}$ dynamically using detonation arrival times ($t_{arr} = r/D_{CJ}$) and transit times across a defined burn thickness.
* **1D-to-2D Remap**: Translates computed 1D states onto the 2D grid at a user-defined time or step. Uses subgrid cell averaging ($K=5$ sub-cells per direction) to compute 2D conservative variables. Clamps coordinate distances to the physical 1D domain boundary (`d_sub <= r_1d.back()`) to prevent flat-extrapolation into grid corners, ensuring a clean circular shock profile.

### Mathematical Discretization & Numerical Schemes
* **Finite Volume Discretization**: Formulated on structured cell-centered grids.
* **Spatial Reconstruction**: Up to 3rd-order spatial reconstruction with shock-capturing limiters (e.g. Minmod) to prevent spurious oscillations near shock waves.
* **Interface Fluxes**: Supports Rusanov (Lax-Friedrichs) or AUSM+ (Advection Upstream Splitting Method) flux schemes.
* **Temporal Integration**: Explicit Runge-Kutta time-stepping schemes (1st, 2nd, 3rd, and 4th order RK configurations).

### Memory Management
* **Contiguous Cache-Friendly Layouts**: Primitive states (density, velocities, pressure, volume fractions) and conservative variables are stored as flat, contiguous 1D vectors (`std::vector<State2D>`) to maximize CPU L1/L2 cache line utilization.
* **Zero-Allocation Time Stepping**: All temporary Runge-Kutta staging vectors (`U1`, `U2`, `k1`-`k4`, flux arrays) are pre-allocated in solver constructors. No dynamic memory allocations occur during the main simulation loop.
* **GPU Memory Optimization**: For the CUDA solver, pinned host memory buffers and direct GPU device allocations are set up once in the constructor. Simulation steps run entirely on the GPU, with only the downsampled contour data copied back to the host via asynchronous CUDA memory copies.

### Parallelization & Active Region Optimization
* **CPU Multithreading**: Spatially parallelized via OpenMP compiler directives (`#pragma omp parallel for collapse(2)`) to scale computation across multiple CPU cores.
* **GPU CUDA Acceleration**: Offloads grid cells, flux reconstruction, and conservative variable updates to custom CUDA kernels executing on thousands of GPU threads.
* **Active Region Block Tracking**: The 2D grid is divided into $16 \times 16$ spatial blocks. The solver tracks active blocks where pressure, velocity, or material concentrations deviate from ambient thresholds. Solver steps and flux updates are restricted to the bounding box of active blocks, dramatically reducing computational overhead and speeding up run times.

## 4. Network & Telemetry Flow (Frontend)

- **WebSocket Initialization:** The `NetworkManager.ts` strictly sets `binaryType = 'arraybuffer'` immediately upon instantiation.
- **Debugging:** `NetworkManager` intercepts the `INIT` payload and logs it via `console.warn('[DEBUG] RAW INIT PAYLOAD:', ...)` before transmission.
- **Routing:**
  - `main.ts` uses type guards (`instanceof ArrayBuffer`) to bypass JSON parsing for binary frames.
  - Binary frames trigger `stateManager.pushTelemetry(buffer, nodeId?)` which pushes telemetry immediately to the relevant sub-systems.
  - To support dual-canvas rendering, buffers are cloned using `data.slice(0)` prior to Worker `postMessage` transfer, preventing buffer neutering.
- **High-Performance Resource Routing:** `resource_pulse` events bypass the global `StateManager` entirely. They are routed directly from the WS handler to `layoutManager.broadcastResourceData`, calling a fast `updateMetrics` method directly on DOM elements.

## 5. Frontend State Management

- **The DAG (Directed Acyclic Graph):** The global structure consists of `Node` interfaces and `Connection` interfaces (replacing legacy `Edge` terminology).
- **Serialization:** `serializeForSolver` strictly traces connected paths (from `CFDSolver` through `ThePainter` to the connected `DomainMesh`, `MaterialAir`, and `MaterialExplosive`/`MaterialIdealGas` inputs) to compile parameters. Parameters of disconnected nodes are ignored; if the explosive node is disconnected, `charge_mass` and `explosive_radius` default to `0.0`. In `INIT_2D` commands, it correctly computes `explosive_radius` from `charge_mass` and `rho` to prevent detonator preset defaults from overriding it.
- **Persistence:** `StateManager` handles workspace persistence using browser `localStorage` under the key `blast_workspace`. It mandates automatic synchronization on every state mutation and uses defensive hydration with a `try/catch` fallback.
- **Node Properties:** Standard nodes contain coordinates, `type`, `parameters`, `inputs`, `outputs`, a `displayMode` ('compact' | 'collapsed'), and optional `width`/`height` dimensions.

## 6. UI Layout Architecture

- **Nuclear CSS Overrides:** Global layout stability is enforced via `frontend/styles.css` using `min-width: 0 !important` and `min-height: 0 !important` on `.panel-container` objects, and `max-width: 100% !important` on `<canvas>`, preventing Flexbox expansion traps.
- **Strict CSS Containment:** Workspace panels (`.panel-content`) use `position: relative; flex: 1; overflow: hidden; display: flex; flex-direction: column;`. Global fixed layouts or unbounded 100vw/vh are prohibited within sub-components.
- **Panel Framework:**
  - Every workspace panel includes a compact header bar with a panel-type selector.
  - `LayoutManager` caches component instances (e.g., `RESOURCE_MANAGER`, `NODE_VIEWER`) in a map, safely re-attaching them via DOM nodes after clearing existing targets to preserve internal state during split-pane adjustments.

## 7. Sub-Components & Panels

### GraphRenderer (The Node Graph)
- **Viewport Structure:** Dynamically creates an infinite canvas within the parent container (viewport -> canvas-container -> absolute node layer & SVG Bezier paths).
- **Aesthetics:** Data-type port coloration (Domain: Blue #2563eb, Material: Slate #64748b, Explosive: Red #dc2626, Telemetry: Green #16a34a). Node headers display full descriptive names (e.g. `Material - Explosive (JWL)`) instead of compact initials, allowing node widths to dynamically auto-expand to show the full name.
- **Header Controls:** The orient and collapse buttons are placed on the left side of the header (`justify-content: flex-start` with a `gap: 8px` on `.node-header`), ensuring they stay in a constant position relative to the node when zoom or node width changes.
- **Scale & Transform:** Default view scale zoom is initialized to `1.25` (expanded) and applied immediately in the constructor via `updateTransform()`.
- **Ergonomics:** Wires have magnetic snapping (15px threshold) with a glowing cyan (#00f0ff) ring outline. Ports highlight on hover (10px threshold).
- **Stability:** Wire anchor points are calculated against physical DOM elements (`.port-bullet`) via `getBoundingClientRect()` on every animation frame to ensure perfect attachment. `ResizeObserver` instances trigger redraws on layout shifts.
- **Direction:** Supports vertical vs. horizontal sequencing toggle from the panel header, adjusting layout flow and cubic Bezier control vectors dynamically.
- **Interaction:** Nodes created via Context Menu, deleted via Delete/Backspace, and clicked for global state selection.

### Telemetry Graph (ChartWorker)
- **Web Worker Offloading:** `ChartWorker.ts` runs rendering out-of-band using `OffscreenCanvas`.
- **Canvas Resolution Sync:** The main thread fetches `getBoundingClientRect()` bounds to set `canvas.width/height` BEFORE executing `transferControlToOffscreen()`.
- **Resize Handling:** Workers listen for resize messages and execute `requestAnimationFrame(render)` immediately.
- **Drawing Loop:** Implements dynamic auto-scaling and pixel binning. Uses a strict 40-pixel padding margin and `#475569` baseline reference axes.
- **Plotting Channels:** Supports plotting of pressure, density, velocity, internal energy, and mass fraction telemetry data.
- **Throttled Rendering:** Telemetry graphs support a plot stride (`plot_stride`) control allowing the user to select the plot rate (every 1, 2, 5, 10, 20, 50, 100 frames) to throttle chart redraws and maintain UI responsiveness.
- **Lifecycle:** Paths are strictly wrapped via `ctx.beginPath()`, colored using the selected channel color, and committed via `ctx.stroke()`.
- **Feedback Loop:** The worker calculates dynamic bounds (minY, maxY) and posts them back to the main thread via `postMessage({ type: 'bounds', minY, maxY })`.

### NodeViewer
- **Expanded Views:** Implements the "Absolute Canvas Trick" to decouple `OffscreenCanvas` from Flexbox (wrapper container `position: relative`, inner child `position: absolute; inset: 0`). Uses a `setTimeout(..., 0)` microtask to sync resolution, guaranteeing styles have been applied.
- **Sub-Selector:** The panel header contains a reactive dropdown listing all specific nodes.
- **Live Binding:** Generates native `<input>` fields for node parameters (e.g., `domain_radius`) when focused. Mutating these updates the master state instantly for subsequent solver initialization.
- **Dynamic Chart Bounds:** Reuses `viewer-min-y-${nodeId}` and `viewer-max-y-${nodeId}` fields in headers, receiving bounds from the worker via exponential notation.

### Telemetry Text
- **Log Interception:** Incoming telemetry JSON logs are mapped by `StateManager` into prettified human-readable string formats (`[0.0125s] [PROGRESS] ...`) prior to display.
- **Layout Confinement:** The terminal wrapper container enforces `relative` positioning, while the exact text `div` uses `position: absolute; inset: 0; word-break: break-all; white-space: pre-wrap; overflow-y: auto;` to prevent layout breaking.
- **Auto-Scroll:** Specifically targets text wrappers in the NodeViewer using `viewer-text-${nodeId}` to enforce a scroll-to-bottom on every update tick.

### ResourceManager
- **High-Density UI:** Uses horizontal metric bars (GPU UTILIZATION, VRAM ALLOCATION, CORE TEMPERATURE) avoiding SVG dials or sparklines.
- **Namespace Collision Defense:** Elements use a `panelId` prefix (e.g., `${this.panelId}-gpu-bar`).
- **Direct DOM Manipulation:** Updates metrics via `updateMetrics` scoped to the ID without destroying or generic `innerHTML` re-renders. Constructor enforces an `if (!container)` defense.

### ExecutionManager
- **Consolidation:** Hosts the primary simulation controls (Init, Step, Pause, Terminate).
- **Aesthetics:** Integrates the neon-cyan solver progress bar.
- **Reset Utility:** Includes a 'Reset Workspace' button that fires `localStorage.clear()` and `window.location.reload()` following a `window.confirm()` verification.

### Other Panels
- **OUTLINER:** Renders a hierarchical DAG via nested `<ul>` and `<li>` lists starting strictly from Root nodes (0 incoming connections).
- **PROPERTIES:** Includes an 'I/O Connections' sector listing inputs/outputs driven strictly by the global `state.connections` store. Displays descriptive validation warning boxes if key connections (CFD Solver, DomainMesh, MaterialAir, or MaterialExplosive) are missing from the graph path.

## 8. Development & CI Lifecycle

- **Build Systems:**
  - C++ Backend: Compiled via CMake in a distinct build directory (`mkdir build && cd build && cmake .. && make Broker` / `make BlastSolver`).
  - Frontend: `npm run dev` (Vite on port 5173).
- **Verification:** Integration tested using `python3 verification/verify_ui.py`, verifying both the C++ daemon (port 8080) and frontend (port 5173) are active and responding.
- **Clean Commits:** All patches and pushes must exclude build artifacts, `.log` files, `node_modules`, and temporary metadata.
