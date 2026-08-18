# BlastDaemon Enterprise CFD & Multi-Physics Framework — Architecture

This document is the master technical reference for the BlastDaemon codebase. It describes every layer of the system: core architectural mandates, build system, backend process isolation, multi-physics solver mathematics (Eulerian CFD, Lagrangian MPM, and Lagrangian Hexahedral FEM), two-way Fluid-Structure Interaction (FSI) couplers, IPC and networking protocols, frontend Directed Acyclic Graph (DAG) state management, UI panel subsystems, and the development lifecycle.

---

## 1. Core Mandates & Master Directives ([AGENTS.md](file:///home/chris/antigrav/blastdemon/AGENTS.md))

These architectural rules are absolute, immutable, and strictly enforced across the framework:

| Rule / Directive | Description & Enforcement |
|---|---|
| **Zero-Dependency Frontend** | Pure Vanilla TypeScript, native HTML5 DOM APIs, and CSS. No React, Vue, Webpack, or external UI component libraries. Native ES6 modules compiled via `tsc`. Vite is utilized strictly as a zero-runtime local development server and bundler. |
| **Zero-Dependency Broker** | Pure C++17 standard library. No Boost, no gRPC, no external JSON linkage. The `nlohmann/json.hpp` single-file header is embedded in `backend/BlastSolver/include/`. Networking uses raw OS sockets (`<sys/socket.h>`) with a self-contained RFC 6455 WebSocket implementation. |
| **Zero-Dependency Visuals** | Native HTML5 `<canvas>` and raw WebGPU / WebGL2 APIs. No Three.js, Babylon.js, or external 3D visualization libraries. |
| **The Permitted Exception** | HDF5 (C API) is permitted strictly for heavy volumetric simulation disk I/O. It may **only** be linked to the `BlastSolver` worker executable. The `Broker` daemon remains 100% zero-dependency. |
| **Process Isolation (Broker/Worker)** | Broker and Worker run as separate operating system processes communicating exclusively via OS standard I/O pipes (`stdin`/`stdout`). The Broker manages network clients, WebSockets, and process orchestration; the Worker executes the multi-physics mathematics and CUDA kernels. |
| **Single Source of Truth (SSOT)** | The UI state is an immutable Directed Acyclic Graph (DAG) of `Node` and `Connection` objects synchronized across the Visual Node Graph, Tree Outliner, Property Inspector, and Telemetry Viewers. |
| **Mandatory State Invalidation** | Modifying any physical solver parameter (dimensions, cell size, charge mass, material EOS, detonator location, boundary conditions, CFL, flux scheme, solver order, hardware device/precision, MPM properties, FEM properties, FSI coupling parameters) MUST explicitly invalidate the model status via `setModelStatus(modelId, 'UNINITIALIZED')`. |
| **Mandatory Minimum 2nd-Order Temporal Accuracy** | 1st-order time integration schemes (Forward Euler or 1st-order un-staggered steps) are **strictly prohibited** as defaults. Lagrangian solvers (FEM and MPM) default to **2nd-Order Symplectic Central Difference / Staggered Leapfrog** (`O(dt^2)` trajectory accuracy and exact Hamiltonian phase/energy preservation). Eulerian CFD fluid solvers default to **2nd-Order ADER-2** or **2nd-Order TVD/SSP-RK2**. |
| **3D Uniform Grid Only (Purge of 3D AMR/Subgrids)** | Dynamic 3D AMR, nested 3D subgrids, submeshes, restriction, and prolongated ghost fills have been completely purged from the 3D solver and UI. 3D CFD executes strictly on single-block uniform Cartesian grids (`DomainMesh3D`). 1D and 2D solvers retain their existing AMR/subgrid features as-is. |
| **Node Parameter Alignment & Unified Casting** | Every numeric parameter key defined on a node MUST be registered in all 4 `numericKeys` lists: [serialization.ts](file:///home/chris/antigrav/blastdemon/frontend/src/serialization.ts), [property-editor.ts](file:///home/chris/antigrav/blastdemon/frontend/src/property-editor.ts), [node-viewer.ts](file:///home/chris/antigrav/blastdemon/frontend/src/node-viewer.ts), and [graph-renderer.ts](file:///home/chris/antigrav/blastdemon/frontend/src/graph-renderer.ts). Default parameter values must be identical between [state-manager.ts](file:///home/chris/antigrav/blastdemon/frontend/src/state-manager.ts) and [graph-renderer.ts](file:///home/chris/antigrav/blastdemon/frontend/src/graph-renderer.ts). |
| **Master Parameter & Node Type Documentation** | All node types (38 types) and physical parameters (250+ properties) must be documented in [parameter-definitions.ts](file:///home/chris/antigrav/blastdemon/frontend/src/parameter-definitions.ts) with complete engineering descriptions, physical units, governing equations, and stability criteria. |
| **Strict Prohibition of Raw LaTeX Math** | NEVER emit raw LaTeX delimiters (`$`, `$$`, `\(`, `\)`, `\[`, `\]`, `\frac`, etc.) in documentation or chat responses. All mathematical formulas must use inline code, standard Unicode math symbols (`Δt`, `ρ`, `σ`, `γ`, `∇·u`, `√`), or fenced code blocks. |
| **Browser Agent Prohibition** | The `browser_subagent` tool must never be invoked. UI layout, visual changes, and state logic are verified via static analysis, code reviews, and manual inspection. |
| **Automatic Broker Management Directive** | AI assistants must **never** automatically launch or restart `./Broker` in the background; the user manages the Broker process manually in their own terminal. |

---

## 2. Repository Layout

```
blastdemon/
├── backend/
│   ├── BlastDaemon/                          # The Broker (WebSocket & Process Management Daemon)
│   │   ├── Broker.cpp                        # Zero-dependency C++17 WebSocket server & process multiplexer
│   │   └── ProcessManager.hpp                # RAII child-process management (pipes, fork/execv)
│   └── BlastSolver/                          # The Worker (Multi-Physics Math Engine)
│       ├── main.cpp                          # Command dispatch loop & worker thread orchestration (8,700+ lines)
│       ├── cfd_states.hpp                    # Conservative & primitive CFD state structs (1D/2D/3D)
│       ├── cfd_tile.hpp                      # Structure of Arrays (SoA) tile memory layout definitions
│       ├── cfd_solver.hpp/.cpp               # 1D High-Order Compressible Euler Solver (Spherical/Planar)
│       ├── cfd_solver_init.cpp               # 1D Initial conditions & JWL/Ideal Gas setup
│       ├── cfd_solver_step.cpp               # 1D Temporal integration (RK2/RK3/RK4, ADER)
│       ├── cfd_solver_fluxes.cpp             # 1D Numerical fluxes (AUSM+, Rusanov, MUSCL/WENO)
│       ├── cfd_solver_2d.hpp                 # 2D Axisymmetric & Cartesian CFD CPU Solver
│       ├── cfd_solver_2d_init.cpp            # 2D Initial conditions & charge positioning
│       ├── cfd_solver_2d_step.cpp            # 2D Low-Storage Runge-Kutta & ADER time-stepping
│       ├── cfd_solver_2d_fluxes.cpp          # 2D Numerical flux splitting & ghost cell boundary stencils
│       ├── cfd_solver_2d_cuda.hpp/.cu        # 2D GPU CUDA Solver (tiled SoA execution)
│       ├── cfd_solver_2d_amr.hpp/.cpp        # 2D Block-Structured Adaptive Mesh Refinement (CPU)
│       ├── cfd_solver_2d_amr_cuda.hpp/.cu    # 2D Block-Structured AMR (CUDA GPU)
│       ├── cfd_solver_3d.hpp/.cpp            # 3D Uniform Cartesian CFD CPU Solver (Single/Multi-Mat templates)
│       ├── cfd_solver_3d_cuda.hpp            # 3D GPU CUDA Solver Interface
│       ├── cfd_solver_3d_cuda_impl.cuh       # 3D GPU CUDA Solver Kernels (ADER-2/3, TVD, AUSM+, Rusanov)
│       ├── cfd_solver_3d_cuda_f32_single.cu  # 3D CUDA FP32 Single-Material compilation unit
│       ├── cfd_solver_3d_cuda_f32_multi.cu   # 3D CUDA FP32 Multi-Material compilation unit
│       ├── cfd_solver_3d_cuda_f64_single.cu  # 3D CUDA FP64 Single-Material compilation unit
│       ├── cfd_solver_3d_cuda_f64_multi.cu   # 3D CUDA FP64 Multi-Material compilation unit
│       ├── ImmersedBoundary.hpp/.cpp         # STL reader, OpenMP/CUDA voxelizer, slip wall ghost cell reflection
│       ├── remapper_3d.cpp                   # 1D->2D, 1D->3D, and 2D->3D conservative state remap kernels
│       ├── mpm_solver_2d.hpp/.cpp            # 2D Lagrangian Material Point Method (MPM) Solver
│       ├── mpm_solver_3d.hpp/.cpp            # 3D Lagrangian MPM CPU Solver (PIC/FLIP, APIC, GIMP, B-Spline)
│       ├── mpm_solver_3d_cuda.hpp/.cu        # 3D Lagrangian MPM CUDA GPU Solver
│       ├── fem_solver_3d.hpp/.cpp            # 3D Hexahedral Solid FEM Solver (1-pt reduced + Hourglass control)
│       ├── fem_solver_3d_cuda.hpp/.cu        # 3D Hexahedral Solid FEM CUDA GPU Solver
│       ├── ls_dyna_reader_3d.hpp/.cpp        # LS-DYNA (*.k, *.key) Keyword deck parser & mesh importer
│       ├── fem_contact_3d.hpp/.cpp           # 3D FEM Contact Mechanics (Segment penalty, sliding, Coulomb friction)
│       ├── fsi_coupler_3d.hpp/.cpp           # 3D MPM Fluid-Structure Interaction Coupler
│       ├── fem_fsi_coupler_3d.hpp/.cpp       # 3D FEM Fluid-Structure Coupler (SAT cut-cell aperture, Gauss quadrature)
│       ├── fem_fsi_coupler_3d_cuda.hpp/.cu   # 3D FEM Fluid-Structure Coupler (CUDA GPU)
│       ├── materials.hpp                     # Fluid EOS, JWL parameters, Baer-Nunziato mixture, Programmed Burn
│       ├── constitutive_concrete_models.hpp  # Advanced Concrete Models (RHT, HJC, CSCM / Mat 159, K&C / Mat 72R3)
│       ├── constitutive_crest_davis.hpp      # CREST Reactive Burn & Davis Solid/Product EOS for High Explosives
│       ├── HDF5Writer.hpp/.cpp               # HDF5 heavy volumetric disk output
│       ├── XDMFWriter.hpp/.cpp               # XDMF XML metadata wrapper for ParaView
│       ├── VTKWriter.hpp/.cpp                # VTK XML Unstructured Grid (.vtu / .pvd) writer with ZLIB compression
│       └── AsyncVTKWriter.hpp                # Asynchronous background VTK disk streaming
├── frontend/
│   ├── index.html                            # App entry shell
│   ├── styles.css                            # Comprehensive CSS styling & design tokens (~38 KB)
│   ├── package.json                          # Dev dependencies: typescript@5, vite@5 only
│   ├── tsconfig.json                         # Strict TypeScript configuration
│   └── src/
│       ├── main.ts                           # Application bootstrap, WebSocket dispatch, command routing
│       ├── types.ts                          # TypeScript interfaces (Node, Connection, AppState, LayoutNode)
│       ├── state-manager.ts                  # Global SSOT state store with undo/redo & model isolation
│       ├── serialization.ts                  # DAG traversal, parameter casting, solver JSON compilation, .blst binary
│       ├── NetworkManager.ts                 # WebSocket client with reconnection logic and binary dispatch
│       ├── layout-manager.ts                 # Recursive split-pane dockable layout system
│       ├── graph-renderer.ts                 # Visual Node Graph infinite SVG/DOM canvas editor
│       ├── property-editor.ts                # Dynamic Property Inspector with parameter popovers & validation
│       ├── node-viewer.ts                    # Per-node specialized viewers and parameter inspectors
│       ├── parameter-definitions.ts          # Master SSOT Parameter & Node Definitions Registry (118 KB)
│       ├── mpm-presets.ts                    # Solid material & constitutive parameter presets library (131 KB)
│       ├── host-file-browser.ts              # Interactive host filesystem browser (STL, LS-DYNA, VTK, .blst)
│       ├── resource-manager.ts               # Hardware telemetry monitor (CPU, RAM, GPU NVML)
│       ├── validation.ts                     # Deep DAG validation & graph topology rules
│       ├── ViewportRenderer.ts               # Main-thread 3D viewport canvas bridge
│       ├── ViewportWorker.ts                 # Off-thread WebGPU/WebGL2 3D interactive viewport renderer (314 KB)
│       ├── ChartWorker.ts                    # Off-thread 1D spatial profile & gauge chart renderer
│       ├── ContourWorker.ts                  # Off-thread 2D contour heatmap renderer
│       ├── mpm-renderer-2d.ts                # 2D MPM particle canvas visualization helper
│       └── mpm-renderer-3d.ts                # 3D MPM particle viewport binding helper
├── CMakeLists.txt                            # CMake build definition (Broker C++17, BlastSolver C++20+CUDA)
├── AGENTS.md                                 # Master Agent Directives (Enforced)
└── ARCHITECTURE.md                           # Master Architecture Reference Document (This file)
```

---

## 3. Build System & Compilation

### 3.1 Target Matrix

| Target | Type | C++ Standard | CUDA Standard | Dependencies | Purpose |
|---|---|---|---|---|---|
| `Broker` | Executable | C++17 (Forced) | N/A | POSIX sockets, `nlohmann/json.hpp` (header-only) | WebSocket broker & process manager |
| `BlastSolverCore` | Static Library | C++20 | CUDA 17 (`native`) | OpenMP, ZLIB, HDF5 (C API, optional), NVML (`dlopen`) | Unified multi-physics engine library |
| `BlastSolver` | Executable | C++20 | CUDA 17 (`native`) | Links `BlastSolverCore` | Worker simulation executable |
| `test_cuda_solver` | Test Executable | C++20 | CUDA 17 (`native`) | Links `BlastSolverCore` | Standalone GPU CFD test harness |
| `test_fem_3d_...` | Test Executables | C++20 | CUDA 17 (`native`) | Links `BlastSolverCore` | Standalone FEM/FSI/MPM test suite |

### 3.2 Compiler Optimization Flags

- **C++ Compilation Flags:** `-Wall -Wextra -O3 -march=native -fopenmp`
- **CUDA Compilation Flags:** `--expt-relaxed-constexpr -O3 --use_fast_math --threads 0 -march=native`, `CMAKE_CUDA_ARCHITECTURES native`, `CUDA_SEPARABLE_COMPILATION ON`
- **Conditional HDF5:** If HDF5 C libraries are present on the host system, `HDF5Writer` compiles natively. If missing, `NO_HDF5` is defined and `HDF5Writer` reverts to a safe no-op stub while VTK XML export remains fully functional.

### 3.3 Build Commands

```bash
# Build backend targets from project root
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc) Broker BlastSolver

# Optional: Build full verification test suite
cmake -DBUILD_TESTS=ON ..
make -j$(nproc)

# Frontend development server (Vite on http://localhost:5173)
cd ../frontend && npm run dev

# Frontend production compilation (TypeScript type-check + bundle)
cd ../frontend && npm run build
```

---

## 4. Process Architecture — Broker & Worker (IPC & Networking)

The architecture strictly enforces **process isolation**. The Broker and Worker run as independent OS processes communicating over standard OS pipes.

```
Browser Client (ws://localhost:8080)
        │
        │  WebSocket RFC 6455 Frames (Text JSON & Binary Streams)
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Broker (backend/BlastDaemon/Broker.cpp)                     │
│  - C++17 single-file daemon, raw POSIX sockets              │
│  - Self-contained RFC 6455 handshake (built-in SHA-1/Base64)│
│  - Process lifecycle manager keyed by modelId               │
│  - Multi-client thread-safe WebSocket frame multiplexing    │
│  - Host filesystem browser protocol (HOST_FILE_*)           │
└──────────┬──────────────────────────────────────────────────┘
           │  stdin: JSON commands ("{...}\n\n")
           │  stdout: Hybrid stream (JSON lines + BIN_* frames)
           ▼
┌─────────────────────────────────────────────────────────────┐
│  BlastSolver (backend/BlastSolver/main.cpp)                 │
│  - C++20 + CUDA 17 worker engine                            │
│  - Manages concurrent 1D, 2D, and 3D simulation loops       │
│  - Solvers: Eulerian CFD, Lagrangian MPM, Hex8 Solid FEM    │
│  - Couplers: 2D/3D MPM-FSI, 3D FEM-FSI (SAT cut-cell)       │
│  - Telemetry: 30 Hz JSON + high-speed binary frame packets   │
│  - Disk I/O: Async VTK XML (.vtu/.pvd) & XDMF+HDF5          │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 The Broker (`backend/BlastDaemon/Broker.cpp`)

- **Socket Binding & Options:** Binds `0.0.0.0:8080` with `SO_REUSEADDR` and sets `FD_CLOEXEC` on all sockets to prevent handle leakage into spawned worker processes.
- **Signal Handling:** Globally ignores `SIGPIPE` (`signal(SIGPIPE, SIG_IGN)`). Broken client connections yield standard `EPIPE` return codes from `send()` without aborting the daemon.
- **Zero-Dependency RFC 6455 Handshake:** Computes `Sec-WebSocket-Accept` using an in-tree SHA-1 and Base64 implementation without linking OpenSSL.
- **Per-Model Process Isolation:** Manages a map of `std::shared_ptr<Process>` keyed by `modelId`. Re-uses worker instances across multi-stage pipelines (e.g. 1D detonation feeding 2D ground reflection in the same model) while isolating distinct models into separate processes.
- **Host File Browser Protocol:** Handles host filesystem inspection over WebSocket:
  - `HOST_FILE_LIST`: Scans server directories and returns file metadata (size, modification time, file type).
  - `HOST_FILE_READ`: Streams raw text or binary file contents (e.g. LS-DYNA `.k` decks, STL meshes).
  - `LOAD_STL_GEOMETRY`: Parses ASCII/Binary STL surface meshes on the server and returns vertex arrays directly to the client.
- **Hardware Telemetry Relay (Resource Pulse):** Reads CPU utilization (`/proc/stat`), RAM usage (`/proc/self/statm` and `/proc/meminfo`), and queries GPU VRAM, compute utilization, and temperatures via dynamically loaded NVML (`dlopen("libnvidia-ml.so.1")`). Emitted to connected clients at 30 Hz.

### 4.2 Standard I/O Hybrid Protocol

The Worker emits a hybrid stream on `stdout`:
1. **JSON Control Lines:** UTF-8 JSON lines representing solver milestones, step progress, virtual gauge histories, and diagnostics.
2. **Binary Frame Stream:** Formatted with custom binary frame headers followed by raw float arrays:

| Stream Header Marker | Payload Content & Memory Layout |
|---|---|
| `BIN_FRAME <size>\n` | 1D CFD: `uint32 n_cells` + `uint32 n_channels (7)` + `float32[n_cells * 7]` (`p, rho, u, E, alpha1, alpha2, alpha_air`). |
| `BIN2D_FRAME <size>\n` | 2D CFD: `uint32 nr` + `uint32 nz` + `uint32 n_channels` + `float32[nr * nz * n_channels]` (`p, rho, ur, uz, E, alpha1, alpha2`). |
| `BIN_FRAME_3D_SLICES <size>\n` | 3D CFD: Structured binary slice packets (orthogonal XY, YZ, XZ planes and cut-planes) extracted by `extractSlice()`. |
| `BIN_FRAME_MPM <size>\n` | 2D/3D MPM: `uint32 n_particles` + `uint32 stride` + `float32` particle cloud (`x, y, z, vx, vy, vz, mass, volume, stress_tensor, damage, temperature`). |
| `BIN_FRAME_FEM <size>\n` | 3D FEM: `uint32 n_nodes` + `uint32 n_elements` + deformed nodal coordinates + element stress/strain/damage arrays. |

Before transmission to the browser over WebSocket binary frames (Opcode `0x02`), the Broker prepends the `modelId` as a null-terminated UTF-8 string:
```
[modelId string] [0x00 delimiter] [Raw Worker Binary Payload]
```

---

## 5. BlastSolver — Command Dispatch & State Machine (`main.cpp`)

The Worker reads double-newline terminated JSON commands (`"{...}\n\n"`) from `stdin`. The dispatch loop routes commands to the appropriate solver subsystem:

```
                                    +-----------------------+
                                    |  JSON Command Stream  |
                                    +-----------------------+
                                                |
                 +------------------------------+------------------------------+
                 |                              |                              |
                 v                              v                              v
      +--------------------+         +--------------------+         +--------------------+
      | Eulerian CFD (1D)  |         | Eulerian CFD (2D)  |         | Eulerian CFD (3D)  |
      | - INIT / STEP      |         | - INIT_2D / STEP_2D|         | - INIT_3D / STEP_3D|
      | - EXEC_ALL / PAUSE |         | - EXEC_ALL_2D      |         | - EXEC_ALL_3D      |
      +--------------------+         +--------------------+         +--------------------+
                 |                              |                              |
                 +------------------------------+------------------------------+
                 |                              |                              |
                 v                              v                              v
      +--------------------+         +--------------------+         +--------------------+
      | Lagrangian MPM     |         | Hex8 Solid FEM     |         | FSI Couplers       |
      | - INIT_MPM (2D)    |         | - INIT_FEM_3D      |         | - INIT_FSI_2D      |
      | - INIT_MPM_3D (3D) |         | - STEP_FEM_3D      |         | - INIT_FSI_3D (MPM)|
      | - STEP_MPM / EXEC  |         | - EXEC_ALL_FEM_3D  |         | - INIT_FEM_FSI_3D  |
      +--------------------+         +--------------------+         +--------------------+
```

### 5.1 Supported Command Set

- **1D CFD Gas Dynamics:** `INIT`, `STEP`, `EXEC_ALL`, `PAUSE`, `RESUME`, `TERMINATE`.
- **2D CFD Gas Dynamics:** `INIT_2D`, `STEP_2D`, `EXEC_ALL_2D`, `PAUSE_2D`, `RESUME_2D`, `TERMINATE_2D`.
- **3D CFD Gas Dynamics:** `INIT_3D`, `STEP_3D`, `EXEC_ALL_3D`, `PAUSE_3D`, `RESUME_3D`, `TERMINATE_3D`.
- **2D Lagrangian MPM:** `INIT_MPM`, `STEP_MPM`, `EXEC_ALL_MPM`, `PAUSE_MPM`, `RESUME_MPM`, `TERMINATE_MPM`.
- **3D Lagrangian MPM:** `INIT_MPM_3D`, `STEP_MPM_3D`, `EXEC_ALL_MPM_3D`, `PAUSE_MPM_3D`, `RESUME_MPM_3D`, `TERMINATE_MPM_3D`.
- **3D Hexahedral FEM:** `INIT_FEM_3D`, `STEP_FEM_3D`, `EXEC_ALL_FEM_3D`, `PAUSE_FEM_3D`, `RESUME_FEM_3D`, `TERMINATE_FEM_3D`.
- **Fluid-Structure Interaction (FSI):**
  - `INIT_FSI_2D`, `STEP_FSI_2D`, `EXEC_ALL_FSI_2D`, `PAUSE_FSI_2D`, `TERMINATE_FSI_2D` (CFD + 2D MPM).
  - `INIT_FSI_3D`, `STEP_FSI_3D`, `EXEC_ALL_FSI_3D`, `PAUSE_FSI_3D`, `TERMINATE_FSI_3D` (CFD + 3D MPM).
  - `INIT_FEM_FSI_3D`, `STEP_FEM_FSI_3D`, `EXEC_ALL_FEM_FSI_3D`, `PAUSE_FEM_FSI_3D`, `TERMINATE_FEM_FSI_3D` (CFD + 3D FEM).
- **Multi-Stage Remapping:** `REMAP` (1D->2D or 1D->3D), `REMAP_2D` (2D->3D).
- **Configuration & Diagnostics:** `UPDATE_CFL`, `CONTOUR_CONFIG`, `VIEW3D_CONFIG`, `WRITE_VTK`.

### 5.2 Virtual Sensor Gauges

Numerical sensor probes placed at spatial coordinates `(x, y, z)` sample high-frequency time-histories across all 7 physical channels (`p, rho, u, E, alpha1, alpha2, alpha_air`). Gauge histories are accumulated in-memory and streamed in every `TELEMETRY` JSON frame under `gauges_history`, enabling real-time pressure-time and impulse curve rendering in the frontend.

---

## 6. Eulerian CFD Solver Library

### 6.1 State Structs & Structure of Arrays (SoA) Tile Memory

To achieve high memory bandwidth and SIMD/GPU warp memory coalescing, fluid states are organized into Structure of Arrays (SoA) tiles:

```cpp
// 2D Tiles (16x16 = 256 cells per tile)
template<typename RealType>
struct PrimitiveTileT {
    RealType rho[256], ur[256], uz[256], p[256], E[256];
    RealType alpha1[256], alpha2[256], arho1[256], arho2[256];
    int floor_status[256];
};

// 3D Tiles (8x8x8 = 512 cells per tile)
template<typename RealType, bool IsMultiMaterial>
struct PrimitiveTile3D {
    RealType rho[512], ux[512], uy[512], uz[512], p[512], E[512];
    RealType alpha1[512], alpha2[512], arho1[512], arho2[512];
    RealType arrival_time[512];
    int floor_status[512];
};
```

Active tiles are indexed via a fast spatial lookup map. Ambient and unreached tiles are marked inactive and bypassed during flux and time-stepping evaluations.

### 6.2 1D Compressible Euler Solver (`cfd_solver.hpp/.cpp`)

- **Domain:** Spherically symmetric or planar 1D domain `[0, R_max]` with uniform cell width `dr = R_max / n_cells`.
- **Governing Equation:**
  ```
  ∂U/∂t + ∂F(U)/∂r = -α/r · S_geom(U) + S_det(U)
  ```
  where `α = 2` for spherical coordinates and `α = 0` for planar 1D shock tubes.
- **Numerical Fluxes:** Rusanov (Local Lax-Friedrichs) and AUSM+ (Advection Upstream Splitting Method).
- **Spatial Reconstruction:** 1st-order piecewise constant, 2nd-order MUSCL with Minmod / Superbee limiters, and 3rd-order WENO3.
- **Time Integration:** 2nd-order Runge-Kutta (midpoint), 2nd-order ADER-2 space-time predictor, SSP-RK3, and RK4.

### 6.3 2D Axisymmetric & Cartesian CFD Solver (`cfd_solver_2d.hpp/.cpp`, `cfd_solver_2d_cuda.cu`)

- **Domain:** Cylindrical axisymmetric `(r, z)` or Cartesian `(x, y)` grid with `nr × nz` cells.
- **Axisymmetric Geometric Sources:** Cylindrical volume metrics `2πr dr dz` with radial momentum source terms `p/r` integrated analytically at cell centers to preserve radial balance.
- **2D Dynamic Block-Structured AMR (`cfd_solver_2d_amr.hpp`, `cfd_solver_2d_amr_cuda.cu`):** Adaptive mesh refinement using hierarchical block nesting with gradient-based shock sensors, conservative prolongation, and restriction operators.
- **Time-Stepping:** Low-Storage Runge-Kutta 3 (LSRK3) and 2nd-order ADER space-time integration.
- **Boundary Conditions:** Reflective (symmetry wall `u_n = 0`), Transmissive (zero-gradient outflow), and `OUTFLOW_RIEMANN` (characteristic non-reflecting boundary condition).

### 6.4 3D Uniform Cartesian CFD Solver (`cfd_solver_3d.hpp/.cpp`, `cfd_solver_3d_cuda_impl.cuh`)

- **Uniform Domain Architecture:** Executed exclusively on single-block uniform Cartesian grids (`DomainMesh3D`), with all 3D AMR and submesh hierarchy code completely purged per Directive 9.
- **Precision & Material Templates:** Supports 4 compiled variants across CPU OpenMP and CUDA GPU:
  - `CFDSolver3D<float, false>`: FP32 Single-Material Ideal Gas (extreme throughput).
  - `CFDSolver3D<float, true>`: FP32 Multi-Material JWL + Air.
  - `CFDSolver3D<double, false>`: FP64 Single-Material Ideal Gas.
  - `CFDSolver3D<double, true>`: FP64 Multi-Material JWL + Air.
- **Time-Stepping:** Defaults to **2nd-Order ADER-2** (single-stage Cauchy-Kowalevski space-time predictor) or **2nd-Order TVD/SSP-RK2** with slope limiters. ADER-3 is available for 3rd-order spatial-temporal accuracy.
- **6-Face Independent Boundaries:** Each domain boundary (`X_min, X_max, Y_min, Y_max, Z_min, Z_max`) is independently configured as `REFLECTIVE`, `TRANSMISSIVE`, or `OUTFLOW_RIEMANN`.

### 6.5 Immersed Boundary Method & STL Voxelization (`ImmersedBoundary.hpp/.cpp`)

Arbitrary 3D solid CAD obstacles (buildings, blast walls, terrain) are imported via STL files and rasterized onto the Cartesian grid:

1. **Voxelization Algorithm:**
   - Evaluates triangle-box intersections in parallel using OpenMP on CPU and CUDA kernel `voxelize_triangles_kernel` on GPU.
   - Computes perpendicular distance `d_perp = (P - V0) · n_unit` and barycentric coordinates for cell centers within proximity `0.8 · dx`.
   - Accumulates surface normal vectors: `N_accum = sum(T_k.normal)`, normalized to obtain unit boundary normal `n_b = N_accum / ||N_accum||`.
   - Classifies watertight interior solid cells using Möller-Trumbore ray-triangle intersection casting along the X-axis.
2. **Dynamic Slip Wall Ghost-Cell Boundary Condition:**
   - When the CFD stencil encounters a boundary cell (`is_boundary == true`), it samples the nearest exterior fluid neighbor cell in the direction maximizing `n_b · d_fluid`.
   - Thermodynamic variables (`p, rho, E, alpha`) are copied directly from the fluid neighbor.
   - Velocity is reflected across the surface normal `n_b` to enforce zero-through-flow:
     ```
     u_dot_n = u_fluid · n_b
     u_ghost = u_fluid - 2 * u_dot_n * n_b
     ```

### 6.6 Solution Remap Pipelines (`remapper_3d.cpp`)

Allows multi-stage blast workflows to transfer converged shock waves across dimensions:
- **1D Spherical -> 2D Axisymmetric (`Remap1DTo2DNode`):** Sub-cell volume-weighted interpolation mapping 1D radial profiles onto 2D `(r, z)` grids.
- **1D Spherical -> 3D Cartesian (`Remap1DTo3DNode`):** Radial 3D interpolation mapping 1D spherical blast states around an arbitrary charge origin `(x, y, z)`.
- **2D Axisymmetric -> 3D Cartesian (`Remap2DTo3DNode`):** Reconstructs 2D axisymmetric blast fields (including ground Mach reflections) into full 3D Cartesian volumes via vertical axis revolution.

---

## 7. Lagrangian Material Point Method (MPM) Solver Library

The framework includes 2D and 3D Material Point Method (MPM) solvers ([mpm_solver_2d.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_2d.hpp), [mpm_solver_3d.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.hpp), [mpm_solver_3d_cuda.cu](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d_cuda.cu)) designed for extreme solid deformation, fracture, fragmentation, and hyper-velocity penetration without mesh tangling.

```
                          +------------------------------------------+
                          |   1. Particle-to-Grid Transfer (P2G)     |
                          |   Mass, Momentum, Internal Forces (GIMP) |
                          +------------------------------------------+
                                               |
                                               v
                          +------------------------------------------+
                          |   2. Background Grid Nodal Update        |
                          |   Boundary Constraints, Nodal Accel/Vel  |
                          +------------------------------------------+
                                               |
                                               v
                          +------------------------------------------+
                          |   3. Grid-to-Particle Transfer (G2P)     |
                          |   Symplectic Leapfrog Position/Velocity  |
                          +------------------------------------------+
                                               |
                                               v
                          +------------------------------------------+
                          |   4. Constitutive Stress Integration     |
                          |   Hypoelastic / JC / Concrete / CREST    |
                          +------------------------------------------+
```

### 7.1 Transfer Schemes & Interpolation Kernels

- **Supported Transfer Schemes:** Standard PIC/FLIP, APIC (Affine Particle-in-Cell preserving angular momentum), GIMP (Generalized Interpolation Material Point), and Quadratic/Cubic B-Splines.
- **Time Integration:** **2nd-Order Symplectic Staggered Leapfrog / Central Difference** integration:
  ```
  v_p^{n+1/2} = v_p^{n-1/2} + Δt * a_p^n
  x_p^{n+1}   = x_p^n + Δt * v_p^{n+1/2}
  ```
  This preserves Hamiltonian phase space and guarantees second-order trajectory accuracy with single-pass GPU performance.

### 7.2 Granular Debris & Fragment Mechanics

To prevent artificial clustering and numerical surface tension in failed particle debris swarms:
- **Heterogeneous Fragment Size Distribution:** Particles receive masses and radii governed by the Rosin-Rammler / Weibull fragmentation distribution:
  ```
  P(d) = 1 - exp(-(d / d_50)^n)
  ```
- **Stochastic Strain-Energy Ejection Dispersion (Birth Jitter):** Stored elastic strain energy density `U_e = 0.5 * (σ : ε)` is converted into radial kinetic ejection velocity:
  ```
  v_ejection = jitter_factor * sqrt(2.0 * U_e / rho)
  v_p = v_elem_com + v_ejection * n_outward
  ```
- **Sub-Grid Pairwise DEM-Lite Repulsion:** Short-range anti-blobbing contact repulsion prevents particles sharing the same background cell from collapsing into singular points:
  ```
  f_repulsion = k_grain * max(0, r_contact - r) * r_hat - gamma_grain * v_rel
  ```
- **Debris Material Regimes:** Configurable regimes including Cohesionless Dry Gravel (`φ = 38°–48°`, `K_debris = 1–3 GPa`, Reynolds dilatancy), Cohesive Spall Rubble (`c_residual > 0`), Fine Aerodynamic Dust, and Viscous Slurry.

### 7.3 High Explosive Detonation in MPM (CREST Reactive Burn)

MPM supports direct explosive detonation and shock-to-detonation transition (SDT) via the CREST reactive burn model ([constitutive_crest_davis.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/constitutive_crest_davis.hpp)). Connecting a `DetonatorLocation3D` node to `MPMDomain3D` provides point-source hot-spot ignition, seeding initial shock entropy (`s_shock >= 1.5 * s_threshold`), setting full reaction progress (`λ = 1.0`), and releasing chemical detonation energy (`e_int = q_det`).

---

## 8. Lagrangian 3D Hexahedral Finite Element (FEM) Solver Library

The 3D FEM structural solver ([fem_solver_3d.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_solver_3d.hpp), [fem_solver_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_solver_3d.cpp), [fem_solver_3d_cuda.cu](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_solver_3d_cuda.cu)) provides explicit dynamic structural mechanics for reinforced concrete and steel structures under blast impact.

### 8.1 Element Formulations

- **8-Node Hexahedral Solid Elements:** 1-point under-integrated Gauss quadrature with Flanagan-Belytschko stiffness and viscous hourglass stabilization to prevent zero-energy spurious modes.
- **Embedded 1D Rebar Truss/Beam Elements:** 2-node rebar elements embedded inside parent concrete hexahedra with either perfect kinematic bonding or non-linear bond-slip traction laws.
- **Corotational Large-Deformation Kinematics:** Hughes-Liu Jaumann stress rate and Green-Naghdi corotational coordinate frames ensuring objectivity under finite rotations and large strains.

### 8.2 Contact Mechanics & Progressive Erosion

- **Contact Algorithms (`fem_contact_3d.hpp/.cpp`):** Segment-based penalty contact, node-to-segment contact, self-contact, and Coulomb friction sliding.
- **Erosion & Progressive Failure:** Elements fail when equivalent plastic strain, maximum principal tensile strain, or damage exceeds critical thresholds.
- **FEM-to-MPM Debris Conversion:** Failed/eroded FEM elements are automatically converted into Lagrangian MPM debris particles in real-time, preserving exact mass, momentum, and remaining internal energy while transferring kinematics to the MPM solver.

### 8.3 LS-DYNA Keyword Deck Reader (`ls_dyna_reader_3d.hpp/.cpp`)

Directly parses standard LS-DYNA input files (`*.k`, `*.key`, `*.dyn`):
- Supported cards: `*NODE`, `*ELEMENT_SOLID`, `*ELEMENT_BEAM`, `*SECTION_SOLID`, `*SECTION_BEAM`, `*MAT_024` (Piecewise Linear Plasticity), `*MAT_015` (Johnson-Cook), `*MAT_072R3` (K&C Concrete), `*MAT_084` (Winfrith Concrete), `*MAT_159` (CSCM Concrete), `*SET_NODE_LIST`, `*BOUNDARY_SPC_NODE`.
- Includes translation, 3-axis Euler rotation, and uniform scaling transforms.

---

## 9. Fluid-Structure Interaction (FSI) Coupling Architecture

BlastDaemon provides three two-way explicit Fluid-Structure Interaction (FSI) couplers:

```
                            +------------------------------------+
                            | 3D Eulerian CFD Fluid Solver (Gas) |
                            +------------------------------------+
                                       ▲              │
        Moving Boundary Slip Velocity  │              │ Hydrodynamic Pressure & Drag
        (Ghost-Cell Reconstruction)    │              │ (2x2 Gauss Quadrature / SAT)
                                       │              ▼
                            +------------------------------------+
                            | 3D Lagrangian Structural Solver    |
                            | - 3D MPM Particles (FSICoupler3D)  |
                            | - 3D Hex8 Solid FEM (FEMFSICoupler)|
                            +------------------------------------+
```

### 9.1 2D FSI Coupler (`FSICoupler2D`)
Couples 2D Eulerian axisymmetric CFD gas dynamics with 2D Lagrangian MPM particles. Fluid pressures apply external body forces onto solid particles, while moving particle surfaces compress fluid cells.

### 9.2 3D MPM FSI Coupler (`FSICoupler3D`, `fsi_coupler_3d.hpp/.cpp`)
Couples 3D Eulerian finite-volume CFD grids with 3D Lagrangian MPM particles on CPU and CUDA GPU. Implements immersed boundary velocity penalties and conservative momentum transfer.

### 9.3 3D FEM FSI Coupler (`FEMFSICoupler3D`, `fem_fsi_coupler_3d.hpp/.cpp`, `fem_fsi_coupler_3d_cuda.cu`)
High-fidelity conservative two-way coupling between 3D Eulerian CFD and 3D Hexahedral FEM solid meshes:
- **Separating Axis Theorem (SAT) Cut-Cell Aperture Rasterization:** Evaluates geometric polygon clipping between fluid cell boundaries and moving structural element facets.
- **2x2 Gauss Quadrature Pressure Integration:** Hydrodynamic fluid pressures and viscous shear stresses are integrated over structural surface facets and mapped directly to FEM boundary nodes as external nodal forces.
- **Moving Immersed Boundary Velocity Enforcement:** Structural nodal velocities are interpolated back onto fluid boundary ghost cells to enforce zero relative normal velocity (`(u_fluid - u_solid) · n = 0`).
- **Dynamic Cell Uncovering / Filling:** When solid elements move away, newly uncovered fluid cells are initialized using mass-conserving neighborhood state reconstruction.
- **Fracture Erosion Venting:** When structural FEM elements erode and fail, the boundary aperture opens automatically, allowing blast shock waves to vent through ruptured structural walls.

### 9.4 Unified Coupled Timestep Synchronization
Coupled models enforce strict stability synchronization:
```
dt_coupled = min(dt_fluid, dt_solid) * cfl_coupled
```
The FSI coupler node acts as the authoritative single source of truth for the coupled CFL number.

---

## 10. Materials, Constitutive Models & Equations of State

All constitutive updates and Equations of State (EOS) are implemented as `__host__ __device__` inline functions across CPU and CUDA kernels:

### 10.1 Fluid Equations of State (`materials.hpp`)

- **Ideal Gas:** `p = (γ - 1) * rho * e`
- **JWL (Jones-Wilkins-Lee) EOS:**
  ```
  V = rho_0 / rho
  f(V) = A * (1 - ω / (R1 * V)) * exp(-R1 * V) + B * (1 - ω / (R2 * V)) * exp(-R2 * V)
  p = f(V) + ω * rho * e
  ```
- **Baer-Nunziato Multi-Material Mixture Model:**
  ```
  p_mix = (E_internal + sum(alpha_i * S_i * f_i(V_i) / omega_i)) / sum(alpha_i / omega_i)
  ```
  Smooth linear ramps `S_i = min(1.0, alpha_i / 0.01)` prevent discontinuous EOS switching at vacuum and material interfaces. `getMixturePressure()` and `getMixtureEnergy()` are exact analytical inverses.
- **Programmed Burn:** Multi-cell linear burn front over 4 cells based on Chapman-Jouguet detonation velocity `D_CJ` and detonator arrival time.

### 10.2 Solid Constitutive Models

| Constitutive Model | Subsystem | Mathematical Formulation & Capabilities |
|---|---|---|
| **Linear Isotropic Elasticity** | MPM / FEM | Hookean elasticity: `σ = K * tr(ε) * I + 2G * dev(ε)`. |
| **Hypoelastic J2 Plasticity** | MPM / FEM | Jaumann rate-integrated elasticity with von Mises yield surface, isotropic linear/power hardening, and radial return mapping. |
| **Johnson-Cook Viscoplasticity** | MPM / FEM | Strain-rate sensitivity, thermal softening, and progressive damage accumulation coupled with Mie-Grüneisen shock Hugoniot EOS: `σ_y = (A + B * ε_p^n) * (1 + C * ln(ε_dot^*)) * (1 - T^{*m})`. |
| **Drucker-Prager Geomaterial** | MPM | Pressure-dependent frictional shear yield with non-associated dilation for soil, sand, and rock. |
| **RHT Concrete Model** | MPM / FEM | Riedel-Hiermaier-Thoma model: 3-invariant compressive, tensile, and shear yield surfaces with Rubin/Willam-Warnke Lode angle scaling, porous P-alpha compaction EOS, strain-rate enhancement (DIF), and fracture energy regularization (`G_f / char_len`). |
| **HJC Concrete Model** | MPM / FEM | Holmquist-Johnson-Cook model: Tri-linear/polynomial EOS, pressure-dependent shear yield, strain-rate hardening, and damage accumulation. |
| **CSCM Concrete (Mat 159)** | MPM / FEM | Continuous Surface Cap Model: Smooth continuous yield surface with cap hardening, shear dilation, and isotropic damage softening. |
| **Karagozian & Case (K&C / Mat 72R3)** | MPM / FEM | 3-surface concrete plasticity model with independent maximum, yield, and residual failure envelopes. |
| **CREST & Davis Reactive Burn** | MPM | Autonomous shock-to-detonation transition (SDT) for high explosives: Davis solid reactant EOS + Davis product gas EOS with shock entropy jump calculation `s_s = cv * ln(T_H / T0)` and stiff sub-cycled reaction rate kinetics. |

---

## 11. Disk I/O & Post-Processing Export

- **XDMF + HDF5 Writer (`HDF5Writer.hpp/.cpp`, `XDMFWriter.hpp/.cpp`):** Streams heavy volumetric 3D datasets into compressed `.h5` containers accompanied by XML `.xmf` metadata readable by ParaView and VisIt.
- **VTK XML Unstructured Grid Writer (`VTKWriter.hpp/.cpp`, `AsyncVTKWriter.hpp`):**
  - Exports CFD fluid grids, FEM solid meshes, and MPM particle swarms into standard `.vtu` (Unstructured Grid) and `.pvd` (ParaView Collection) XML files.
  - Utilizes `ZLIB` compression for high I/O throughput and reduced disk footprint.
  - Supports Region-of-Interest (ROI) spatial bounding-box cropping and stride decimation.
  - Asynchronous background worker threads prevent I/O blocking during high-speed solver execution.
- **Sensor Gauge History Exporter:** Dumps discrete probe time-histories in CSV, ASCII, and Binary formats.

---

## 12. Frontend Architecture & Subsystems

The frontend is written in **Pure Vanilla TypeScript** with native DOM APIs, custom CSS design tokens, and Web Workers.

```
                              +------------------------------------------+
                              |   Global AppState SSOT (state-manager)   |
                              |   - Models DAG, Workspaces, Undo/Redo    |
                              |   - Mandatory setModelStatus Invalidation|
                              +------------------------------------------+
                                                   │
        +------------------+-----------------------+---------------------+-------------------+
        │                  │                       │                     │                   │
        v                  v                       v                     v                   v
+----------------+ +----------------+    +-------------------+ +-------------------+ +---------------+
| GraphRenderer  | | PropertyEditor |    | Parameter Registry| | Telemetry Viewers | | Host Browser  |
| - SVG/DOM      | | - Dynamic Form |    | - SSOT Docs/Units | | - ViewportWorker  | | - Disk files  |
| - Bezier Wires | | - Popover SSOT |    | - 38 Node Types   | | - ChartWorker     | | - STL / .k    |
| - Mag Snapping | | - Validations  |    | - 250+ Parameters | | - ContourWorker   | | - .blst IO    |
+----------------+ +----------------+    +-------------------+ +-------------------+ +---------------+
```

### 12.1 State Manager (`state-manager.ts`)
- **Single Source of Truth (SSOT):** Manages the global `AppState` containing models, workspaces, connections, layout trees, and undo/redo history stacks.
- **Mandatory State Invalidation:** Every physical parameter edit calls `setModelStatus(modelId, 'UNINITIALIZED')` targeting the specific model, ensuring the solver re-initializes before stepping.
- **Explosive Geometry Synchronization:** Automatically recalculates `charge_radius = (3m / (4πρ))^(1/3)` when mass or density changes.
- **Persistence:** Serializes to `localStorage` under `blast_workspace` on every state mutation.

### 12.2 Visual Node Graph Editor (`graph-renderer.ts`, ~380 KB)
- Infinite 2D panning and zooming canvas using CSS transforms and SVG cubic Bezier paths.
- Magnetic wire snapping (15px radius) with port type color coding (Domain: `#2563eb`, Material: `#64748b`, Explosive: `#dc2626`, Telemetry: `#16a34a`, Solid: `#d97706`).
- Interactive collapsible node cards with embedded dropdowns, orientation toggles, and contextual menus.

### 12.3 Property Inspector (`property-editor.ts`, ~160 KB)
- Dynamically renders parameter input widgets, dropdowns, sliders, and toggle switches.
- Renders rich hover popovers and documentation tooltips fetched directly from `parameter-definitions.ts`.
- Highlights missing or invalid upstream I/O connections with contextual warnings.

### 12.4 Master Parameter & Node Definitions Registry (`parameter-definitions.ts`, ~118 KB)
Single source of truth for UI documentation across all 38 node types and 250+ parameters:
- Complete engineering descriptions, physical units, governing equations, category tags, and tuning guidelines.

### 12.5 Host File Browser (`host-file-browser.ts`)
Modal file browser communicating with the Broker via `HOST_FILE_LIST` and `HOST_FILE_READ` to allow direct host disk selection of STL geometry, LS-DYNA decks, and `.blst` workspace files.

### 12.6 Off-Thread Workers & Visualizers
- **`ViewportWorker.ts` (~314 KB):** Dedicated Web Worker running raw WebGPU and WebGL2 on `OffscreenCanvas`. Renders interactive 3D orthogonal CFD slices, CAD STL obstacles, deformed FEM meshes, and MPM particle clouds with PBR lighting and SSAO.
- **`ChartWorker.ts` (~19 KB):** OffscreenCanvas renderer for live 60 FPS 1D spatial profile plots and gauge time-histories.
- **`ContourWorker.ts` (~43 KB):** OffscreenCanvas renderer for 2D color contour heatmaps.
- **`resource-manager.ts` (~33 KB):** Real-time 30 Hz hardware telemetry bar graphs (CPU, RAM, GPU VRAM, NVML temperature and utilization).

---

## 13. Complete Node Ecosystem (38 Node Types)

| Subsystem Category | Node Types | Purpose & Role |
|---|---|---|
| **1D CFD Gas Dynamics** | `DomainMesh`, `Charge1D`, `ThePainter`, `CFDSolver` | 1D Spherical & planar high-explosive detonation and shock wave propagation. |
| **2D Axisymmetric CFD** | `DomainMesh2D`, `Charge2D`, `DetonatorLocation`, `CFDSolver2D` | 2D Axisymmetric `(r, z)` blast simulation, ground reflection, and Mach stem formation. |
| **3D Multi-Material CFD** | `DomainMesh3D`, `Charge3D`, `CFDSolver3D` | 3D Cartesian uniform multi-material blast dynamics with JWL and Ideal Gas EOS. |
| **Lagrangian Solid MPM** | `MPMDomain2D`, `MPMObject2D`, `MPMDomain3D`, `MPMObject3D`, `MPMMaterialSteel` | 2D/3D Material Point Method for extreme deformation, fracture, and fragmentation. |
| **Lagrangian Solid FEM** | `FEMDomain3D`, `FEMObject3D`, `LSDynaImporter3D` | 3D Hexahedral solid structural dynamics with embedded rebar and LS-DYNA import. |
| **Fluid-Structure Interaction**| `FSICoupler2D`, `FSICoupler3D`, `FEMFSICoupler3D` | Two-way dynamic coupling between Eulerian CFD and Lagrangian MPM / FEM solids. |
| **Material & EOS Models** | `Material` | Universal material node (Elastic, Johnson-Cook, Concrete, CREST, Ideal Gas, JWL). |
| **Boundary & CAD Geometry** | `STLGeometry`, `PrimitiveGeometry3D` | Imports STL surface meshes and analytic CSG primitives for Immersed Boundary CFD. |
| **Point Detonator / Ignition** | `DetonatorLocation3D` | 3D Cartesian initiation point for CFD blast and MPM CREST reactive burn hot-spots. |
| **Remap & State Interpolation**| `RemapNode`, `Remap1DTo2DNode`, `Remap1DTo3DNode`, `Remap2DTo3DNode` | Multi-stage conservative solution transfer across 1D, 2D, and 3D solvers. |
| **Telemetry & Diagnostics** | `TelemetryText`, `TelemetryGraph`, `TelemetryContour`, `Telemetry3DViewport`, `VirtualGauges`, `VirtualGauges3D` | Real-time terminal logs, 1D charts, 2D heatmaps, 3D WebGPU viewports, and sensor probes. |
| **Hardware & Output** | `HardwareConfig`, `VTKOutput` | Compute device/precision selection and VTK XML (`.vtu`/`.pvd`) disk streaming. |

---

## 14. Development Lifecycle & Operational Reference

### 14.1 Network Ports

| Service | Port | Protocol | Description |
|---|---|---|---|
| **Vite Dev Server** | `5173` | HTTP | Frontend development server (HMR enabled) |
| **Broker Daemon** | `8080` | WebSocket (RFC 6455) | Backend WebSocket communication daemon |

### 14.2 Build & Test Verification

```bash
# Build backend
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=ON ..
make -j$(nproc)

# Run verification tests
./test_cuda_solver
./test_crest_davis_mpm
./test_fem_3d_element_math
./test_concrete_parity

# Run frontend typecheck
cd ../frontend && npx tsc --noEmit
```

### 14.3 Known Architectural Invariants & Gotchas

1. **Broker Management:** Never auto-start or kill `./Broker` via automated agents; the user manages the Broker process in their own shell.
2. **Per-Model Process Lifetime:** `INIT`, `INIT_2D`, `INIT_3D`, `INIT_MPM_3D`, and `INIT_FEM_3D` within the same model share a single isolated `BlastSolver` child process. Erasing a process on `TERMINATE` cleans up all associated references.
3. **ArrayBuffer Cloning for Web Workers:** Before passing telemetry `ArrayBuffer` payloads to Web Workers via `postMessage()`, call `data.slice(0)` to prevent neutering when multiple panels view the same data stream.
4. **Exact Inverse Mixture EOS:** `getMixturePressure()` and `getMixtureEnergy()` in `materials.hpp` use identical `S1/S2` linear ramps and `f(V)` terms to prevent artificial energy drift at material interfaces.
5. **No LaTeX in Documentation:** All mathematical formulations must strictly use inline code or standard Unicode characters. Raw LaTeX delimiters (`$`, `$$`, `\frac`) are prohibited repository-wide.
