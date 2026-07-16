# BlastDaemon Enterprise CFD Framework — Architecture

This document is the primary technical reference for the BlastDaemon codebase. It describes every layer of the system in precise detail: build system, backend processes, solver mathematics, IPC protocol, frontend state graph, panel subsystems, and development lifecycle. It is auto-maintained and should be updated whenever significant changes are made.

---

## 1. Core Mandates (AGENTS.md)

These rules are absolute and enforced at the repository level:

| Rule | Detail |
|---|---|
| **Zero-Dependency Frontend** | Pure Vanilla TypeScript, HTML, CSS. No React, Vue, Webpack, etc. ES6 modules via `tsc`. Vite is permitted strictly as a local dev/bundler tool. |
| **Zero-Dependency Broker** | Pure C++17 standard library. No Boost, no gRPC, no external JSON library linkage. The `nlohmann/json.hpp` header is included directly as a single-file header in `backend/BlastSolver/include/`. |
| **Zero-Dependency Visuals** | Native HTML5 `<canvas>` and raw WebGPU. No Three.js, Babylon.js, or any 3D library. |
| **ONE Exception** | HDF5 (C API) for heavy volumetric disk I/O. Linked **only** to `BlastSolver`. |
| **No Browser Agents** | The `browser_subagent` tool must never be invoked. All verification is via static analysis, code review, or manual inspection. |
| **SSOT Node Graph** | The UI state is an immutable DAG of `Node` and `Connection` objects, synchronized across all panels. |
| **Separation of I/O** | Lightweight telemetry streams over WebSockets. Heavy simulation data is written directly to disk by the Worker using XDMF + HDF5 or VTK. |

---

## 2. Repository Layout

```
blastdemon/
├── backend/
│   ├── BlastDaemon/              # The Broker (WebSocket daemon)
│   │   ├── Broker.cpp            # Single-file Broker implementation (645 lines, C++17)
│   │   └── ProcessManager.hpp    # RAII child-process management
│   └── BlastSolver/              # The Worker (CFD math engine)
│       ├── main.cpp              # Entry point, command dispatch loop (1774 lines)
│       ├── cfd_solver.hpp/cpp    # 1D solver interface & implementation stub
│       ├── cfd_solver_step.cpp   # 1D time-stepping kernel
│       ├── cfd_solver_fluxes.cpp # 1D flux calculations
│       ├── cfd_solver_init.cpp   # 1D initial condition setup
│       ├── cfd_solver_2d.hpp     # 2D CPU solver interface
│       ├── cfd_solver_2d_init.cpp
│       ├── cfd_solver_2d_step.cpp
│       ├── cfd_solver_2d_fluxes.cpp
│       ├── cfd_solver_2d_cuda.hpp/.cu  # 2D GPU CUDA solver
│       ├── cfd_solver_3d.hpp/.cpp      # 3D CPU solver
│       ├── cfd_solver_3d_cuda.hpp/.cu  # 3D GPU CUDA solver
│       ├── remapper_3d.cpp             # 1D→3D state remap
│       ├── cfd_states.hpp       # All primitive/conservative state structs
│       ├── cfd_tile.hpp         # Tile SoA layout definitions
│       ├── materials.hpp        # EOS functions, JWL params, programmed burn
│       ├── HDF5Writer.hpp/.cpp  # HDF5 volumetric output
│       ├── XDMFWriter.hpp/.cpp  # XDMF metadata wrapper
│       └── VTKWriter.hpp/.cpp   # VTK unstructured grid export (ZLIB-compressed)
├── frontend/
│   ├── index.html               # App shell; imports dist/main.js
│   ├── styles.css               # ~38 KB global CSS; all design tokens
│   ├── package.json             # Dev deps: typescript@5, vite@5 only
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts              # Entry point; wires all subsystems (~1041 lines)
│       ├── types.ts             # All TypeScript interfaces: Node, Connection, AppState, etc.
│       ├── state-manager.ts     # Global SSOT store with history/undo/redo (~1540 lines)
│       ├── serialization.ts     # DAG→JSON for solver payloads; binary .blst format
│       ├── NetworkManager.ts    # WebSocket client with reconnect logic
│       ├── layout-manager.ts    # Recursive split-pane renderer (~77 KB)
│       ├── graph-renderer.ts    # Visual node graph canvas (~274 KB)
│       ├── node-viewer.ts       # Per-node detailed panel (~76 KB)
│       ├── property-editor.ts   # Node property inspector (~45 KB)
│       ├── canvas-renderer.ts   # Shared 2D canvas utility
│       ├── resource-manager.ts  # System metrics display (~19 KB)
│       ├── validation.ts        # DAG validation rules (~51 KB)
│       ├── ViewportRenderer.ts  # 3D viewport canvas renderer (~21 KB)
│       ├── ViewportWorker.ts    # Off-thread 3D viewport (~58 KB)
│       ├── ChartWorker.ts       # Off-thread telemetry graph renderer (~13 KB)
│       └── ContourWorker.ts     # Off-thread 2D contour renderer (~18 KB)
├── CMakeLists.txt               # CMake build: Broker (C++17), BlastSolver (C++20+CUDA)
└── AGENTS.md                    # Absolute dev rules (enforced)
```

---

## 3. Build System

### CMake Targets

| Target | Language | C++ Std | Key Deps | Purpose |
|---|---|---|---|---|
| `Broker` | C++17 | 17 (forced) | `nlohmann/json.hpp` (header-only, in `include/`) | WebSocket daemon |
| `BlastSolver` | C++20 + CUDA 17 | 20 | OpenMP, ZLIB, HDF5 (optional), NVML (dlopen) | CFD solver worker |
| `test_cuda_solver` | C++20 + CUDA 17 | 20 | Same as BlastSolver | Standalone GPU solver test harness |

### Compiler Flags

- **C++**: `-Wall -Wextra -O3 -march=native`
- **CUDA**: `--expt-relaxed-constexpr -O3`, `CUDA_SEPARABLE_COMPILATION ON`
- **GPU Architecture**: `CMAKE_CUDA_ARCHITECTURES native` (auto-detects the installed GPU)
- **HDF5**: Conditional — if not found, `NO_HDF5` preprocessor macro is defined and HDF5Writer becomes a no-op stub.

### Build Commands

```bash
# From project root
mkdir build && cd build
cmake ..
make Broker          # Fast (~1s)
make BlastSolver     # Full solver including CUDA compilation
make test_cuda_solver

# Frontend dev server (Vite on :5173)
cd frontend && npm run dev
```

---

## 4. Process Architecture — Broker & Worker

The application runs as **two separate OS processes** that communicate exclusively through stdin/stdout pipes. No shared memory, no TCP loopback between them.

```
Browser (ws://localhost:8080)
        │
        │  WebSocket frames (RFC 6455)
        ▼
┌────────────────────────────────────────────┐
│  Broker  (Broker.cpp, port 8080)           │
│  C++17, single-file, zero-dependency       │
│  Accepts N clients, each gets its own      │
│  std::thread via std::thread(handle_client)│
└──────────┬─────────────────────────────────┘
           │  stdin (JSON lines "command\n\n")
           │  stdout (hybrid stream: JSON + BIN_FRAME)
           ▼
┌────────────────────────────────────────────┐
│  BlastSolver  (main.cpp)                   │
│  C++20 + CUDA, manages 1D/2D/3D solvers   │
│  Runs simulation loops on detached threads │
└────────────────────────────────────────────┘
```

### 4.1 Broker (`backend/BlastDaemon/Broker.cpp`)

#### Startup & Socket Setup
- Binds `AF_INET SOCK_STREAM` on `0.0.0.0:8080` with `SO_REUSEADDR`.
- Sets `FD_CLOEXEC` on all sockets (Linux).
- Globally ignores `SIGPIPE` (`signal(SIGPIPE, SIG_IGN)`) so dead clients yield `EPIPE` from `send()` rather than killing the daemon.
- Each accepted client socket is dispatched to `std::thread(handle_client, client_fd).detach()`.

#### WebSocket Implementation (Self-Contained)
- Implements the full RFC 6455 handshake: reads the HTTP `Upgrade` request, extracts `Sec-WebSocket-Key`, computes `SHA-1(key + magic_uuid)`, Base64-encodes the result, and sends the `101 Switching Protocols` response.
- SHA-1 and Base64 are implemented from scratch inside `namespace sha1` — no OpenSSL dependency.
- Frame parsing supports all three payload length encodings (7-bit, 16-bit, 64-bit) and correctly unmasks client frames by XOR-ing with the 4-byte masking key.
- Multi-fragment messages are accumulated in `ws_message_accumulator` until the `FIN` bit is set.

#### Per-Client State (`struct ClientConnection`)
- Wraps the socket FD and a `std::mutex send_mutex` to make `send_websocket_frame()` thread-safe (the telemetry relay thread writes on the socket concurrently with the main receive loop).
- `send_websocket_binary()` sends opcode `0x02`; `send_websocket_text()` sends opcode `0x01`.

#### Process Lifecycle Management
- `active_processes` is a `std::map<std::string, std::shared_ptr<Process>>` keyed by **modelId**.
- Each modelId owns exactly one `BlastSolver` child process for its entire lifetime (both 1D and 2D phases share a single process). Cross-model contamination was a known historical bug, now fixed.
- On `INIT` / `INIT_2D` / `INIT_3D`:
  1. If an existing process for the modelId is alive, route the command to it (20 retry attempts × 10ms).
  2. If the process has died, spawn a fresh `BlastSolver` (searched at `./BlastSolver` or `./build/BlastSolver`).
  3. Attach a detached telemetry relay thread.
- On `TERMINATE` / `TERMINATE_2D` / `TERMINATE_3D`: erases **all** map entries pointing to the same `shared_ptr<Process>` (handles the shared 1D/2D process case).
- On client disconnect: calls `terminate()` on all active processes to prevent zombie workers.

#### Telemetry Relay Loop
The relay thread reads from the Worker's stdout into a `std::vector<uint8_t> accumulator` and dispatches:

| Marker prefix | Handling |
|---|---|
| `BIN_FRAME_3D_SLICES <size>\n` | Reads `size` raw bytes, prepends modelId + `\0`, sends as WebSocket binary |
| `BIN2D_FRAME <size>\n` or `BIN_FRAME_2D <size>\n` | Same as above |
| `BIN_FRAME <size>\n` | Same as above (1D telemetry) |
| Any JSON line | Parses with nlohmann, injects `modelId` field, forwards as WebSocket text |
| Unparseable line | Wraps in `{type: "log", modelId, message}` envelope |

The `try/catch` around `std::stoul` prevents crashes on malformed frame headers; the corrupted header is skipped by scanning to the next newline.

### 4.2 ProcessManager (`backend/BlastDaemon/ProcessManager.hpp`)

RAII wrapper around `fork()`+`execv()` / `CreateProcess()` (Windows), exposing:
- `start(path)`: spawns the child, sets up `stdin`/`stdout` pipes.
- `writeStdin(str)`: writes to the child's stdin with error detection.
- `readStdout(buf, len)`: blocking read from the child's stdout.
- `terminate()`: sends `SIGTERM` (Linux) or `TerminateProcess()` (Windows).
- `isRunning()`: checks if the child is still alive (via `waitpid(WNOHANG)` or `GetExitCodeProcess()`).

---

## 5. BlastSolver — Command Dispatch (`main.cpp`)

The Worker reads newline-delimited JSON from stdin (double `\n\n` terminates each message). The main loop uses `poll()` to avoid blocking indefinitely.

### 5.1 Global Atomic State

Three independent simulation contexts run concurrently and are managed by atomic flags:

```cpp
// 1D
std::atomic<bool> sim_running, sim_paused, sim_terminate;
std::atomic<int>  step_progress, global_target_steps;
std::atomic<bool> global_exec_until_end;
std::atomic<double> global_cfl{0.4};

// 2D
std::atomic<bool> sim2d_running, sim2d_paused, sim2d_terminate;
std::atomic<bool> solver2d_initialized;
std::atomic<double> global_cfl_2d{0.35};

// 3D
std::atomic<bool> sim3d_running, sim3d_paused, sim3d_terminate;
std::atomic<double> global_cfl_3d{0.4};
```

### 5.2 Supported Commands

| Command | Scope | Effect |
|---|---|---|
| `INIT` | 1D | Creates `CFDSolverImpl<double, true/false>`. Reads: `n_cells`, `domain_radius`, `gamma`, `explosive_radius`, `rho`, `init_mode`, `composition`, flux/temporal/spatial order, JWL params. |
| `STEP` | 1D | Launches `worker_thread_func()` for N steps |
| `EXEC_ALL` | 1D | Launches `worker_thread_func()` until `is_terminated()` |
| `PAUSE` / `RESUME` | 1D | Sets `sim_paused` atomic |
| `TERMINATE` | 1D | Sets `sim_terminate` atomic |
| `INIT_2D` | 2D | Creates `CFDSolver2DImpl<float>` (CPU) or `CFDSolver2DCudaImpl<float>` (GPU) |
| `REMAP` | 2D/3D | Directly injects 1D state array into the 2D/3D solver via `setInitialConditionFrom1D()` |
| `STEP_2D` / `EXEC_ALL_2D` / `PAUSE_2D` / `RESUME_2D` / `TERMINATE_2D` | 2D | Equivalent 2D thread management |
| `INIT_3D` | 3D | Creates `CFDSolver3DImpl<float, true/false>` (CPU) or `CFDSolver3DCuda<float, true/false>` (GPU) |
| `STEP_3D` / `EXEC_ALL_3D` / `PAUSE_3D` / `RESUME_3D` / `TERMINATE_3D` | 3D | Equivalent 3D thread management |
| `WRITE_VTK` | 1D/2D | Exports current state to `.vtu` file via `VTKWriter` |
| `CONTOUR_CONFIG` | 2D | Sets `global_telemetry_stride` and `global_telemetry_interval_ms` |
| `VIEW3D_CONFIG` | 3D | Updates `global_slices_3d` for next telemetry emission |
| `SET_DEVICE` | 2D/3D | Switches between `cpu` and `cuda` solver backends at runtime |

### 5.3 Worker Thread Functions

Three detached threads, one per simulation dimension:

**`worker_thread_func()` (1D)**
- Loops while `sim_running && !sim_terminate && !sim_paused`.
- Calls `computeStepSize(cfl)` then `step(dt)`.
- Throttles telemetry to 33ms intervals (≈30Hz).
- Tracks wall-clock time in `global_wallclock_1d`.
- Emits a final 100% progress packet on exit.

**`worker_2d_thread_func()` (2D)**
- For CUDA solver: calls `getMaxWaveSpeed()` → computes CFL-limited `dt` manually.
- For CPU solver: calls `computeStepSize(cfl)`.
- Termination condition: `checkTerminationCondition()` (shock reaches outflow boundary).
- Telemetry interval configurable via `CONTOUR_CONFIG`.

**`worker_3d_thread_func()` (3D)**
- Same structure as 2D; uses `global_solver_3d->computeStepSize()`.
- Termination: `global_solver_3d->is_terminated()`.
- Emits slice data via `BIN_FRAME_3D_SLICES` marker.

### 5.4 Telemetry Emission

**1D — `emit_telemetry()`**
```
JSON:  {"type":"TELEMETRY","time":...,"is_terminated":...,"wallclock":...,"gauges_history":{...}}
BINARY: "BIN_FRAME <N>\n" + uint32(n_cells) + uint32(n_channels=7) + float32[n_cells * 7]
```
The 7 channels (indexed) are: `[p, rho, u, E_specific, alpha1, alpha2, alpha_air]`. For Ideal Gas mode, channels 5 and 6 are zeroed.

**2D — `emit_telemetry_2d()`**
```
JSON:   {"type":"TELEMETRY_2D","time":...,"nr":...,"nz":...,"is_terminated":...}
BINARY: "BIN2D_FRAME <N>\n" + uint32(nr) + uint32(nz) + uint32(n_channels) + float32[...]
```
The contour frame channels: `[p, rho, ur, uz, E_int, alpha1, alpha2]` (7 for multi-material, 5 for ideal gas). The downsampled grid is computed by `getTelemetry2D(stride)`.

**3D — `emit_telemetry_3d()`**
```
JSON:   {"type":"TELEMETRY_3D","time":...,"slices":[...]}
BINARY: "BIN_FRAME_3D_SLICES <N>\n" + binary slice payload from extractSlice()
```
Each requested slice (xy/yz/xz plane at offset) is extracted and appended.

### 5.5 Resource Pulse (`emit_resource_pulse()`)

Emitted at 30Hz during simulation runs:
- **CPU**: `CLOCK_PROCESS_CPUTIME_ID` vs `CLOCK_MONOTONIC` delta, normalized by core count.
- **RAM**: `/proc/self/statm` (resident pages × page size) and `/proc/meminfo` (MemTotal, MemAvailable).
- **GPU**: CUDA VRAM via `get_cuda_vram_info()` (CUDA runtime call), and GPU utilization/temperature via NVML loaded dynamically with `dlopen("libnvidia-ml.so.1")`. If NVML is unavailable, mock values are emitted based on whether a simulation is running.

### 5.6 Virtual Gauges

`GaugeDef` structs hold `{id, r, z}` coordinates. During simulation:
- `record_gauges_1d(t)`: samples `getCellValues(i)` at cell `i = clamp(r/dx, 0, n-1)`.
- `record_gauges_2d(t)`: samples `getCellValues(i,j)` at 2D grid position.
- `record_gauges_3d(t)`: samples `sampleGauge({id, x=r, y=0, z=z})` via 3D solver.

All 7 channels are recorded per gauge per timestep. The complete history is emitted in every TELEMETRY JSON frame under `gauges_history`.

---

## 6. CFD Solver Library

### 6.1 Type System & State Structs (`cfd_states.hpp`)

Templates parameterized on `<RealType, IsMultiMaterial>`:

```cpp
// Primitive (1D)
IdealGasStateT<RealType>        { rho, u, p, E, floor_status }
MultiMaterialStateT<RealType>   { rho, u, p, E, alpha1, alpha2, arho1, arho2, floor_status }

// Conservative (1D)
IdealGasConservativeStateT      { rho, rhou, E }
MultiMaterialConservativeStateT { rho, rhou, E, alpha1, alpha2, arho1, arho2 }

// 2D
State2D          { rho, ur, uz, p, E, alpha1, alpha2, arho1, arho2, floor_status }
ConservativeState2D { rho, rhour, rhouz, E, alpha1, alpha2, arho1, arho2 }

// 3D
State3D          { rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2, floor_status }
ConservativeState3D { rho, rhoux, rhouy, rhouz, E, alpha1, alpha2, arho1, arho2 }
```

**Field semantics:**
- `alpha1`: volume fraction of JWL detonation **products** (Material 1)
- `alpha2`: volume fraction of unreacted **explosive** solid (Material 2)
- `alpha0 = 1 - alpha1 - alpha2`: volume fraction of ambient **air** (Material 0)
- `arho1 = alpha1 * rho_mat1`: partial density of products
- `arho2 = alpha2 * rho_mat2`: partial density of unreacted explosive

### 6.2 Tile Memory Layout (`cfd_tile.hpp`)

Both 2D and 3D solvers use **Structure of Arrays (SoA) tiled layouts** for cache efficiency:

**2D Tiles** (`TILE_SIZE = 16`):
```cpp
template<RealType>
struct PrimitiveTileT {
    RealType rho[256], ur[256], uz[256], p[256], E[256];
    RealType alpha1[256], alpha2[256], arho1[256], arho2[256];
    int floor_status[256];
};
```
Each tile covers a 16×16 block of cells (256 cells total). Active tiles are tracked via a `tile_map` array (`-1` = inactive) and a `states_pool` dynamic vector.

**3D Tiles** (`TILE_SIZE_3D = 8`, `TILE_CELLS_3D = 512`):
```cpp
// Multi-material 3D tile
template<RealType>
struct PrimitiveTile3D<RealType, true> {
    RealType rho[512], ux[512], uy[512], uz[512], p[512], E[512];
    RealType alpha1[512], alpha2[512], arho1[512], arho2[512];
    RealType arrival_time[512];
    int floor_status[512];
};
```
3D tile index: `t_idx = (gx>>3) + (gy>>3)*n_tiles_x + (gz>>3)*n_tiles_x*n_tiles_y`. Cell index within tile: `c_idx = (gx&7) + (gy&7)*8 + (gz&7)*64`.

### 6.3 1D Solver (`CFDSolverImpl<RealType, IsMultiMaterial>`)

**Domain**: 1D spherical/radial `[0, radius]` with `n_cells` cells of size `dr = radius/n_cells`.

**Geometry**: Cell volumes `geom_V[i]` and interface areas `geom_A[i]` are computed once in the constructor for spherical geometry.

**Initial Conditions** (set by `INIT` command):
- `setInitialConditionTNT()`: Multi-material JWL; explosive sphere initialised with `alpha2=1`, `alpha1=0`, at reference density. Cells outside explosive radius: pure air.
- `setInitialConditionIdealGas()`: Single-material; explosive sphere with high pressure from `detonation_energy`. No volume fractions tracked.
- `setInitialConditionRoseTNT()`: Hybrid: programmed-burn with detonator arrival times pre-computed.

**Flux Schemes** (selectable per run):
- **Rusanov** (Lax-Friedrichs): `getFluxRusanov()` — robust, dissipative.
- **AUSM+** (Advection Upstream Splitting Method): `getFluxAUSMPlus()` — sharper, less diffusive.

**Spatial Reconstruction** (`reconstruct()`):
- Order 1: piecewise-constant (no reconstruction)
- Order 2: linear with Minmod limiter
- Order 3: 3rd-order MUSCL with Minmod

**Temporal Integration** (`step(dt)`):
- Order 1: Forward Euler
- Order 2: 2nd-order Runge-Kutta (midpoint)
- Order 3: 3rd-order Runge-Kutta (SSP-RK3)
- Order 4: Classical 4th-order Runge-Kutta

**Active Region**: Tracks `active_r_idx` (the leftmost cell index where physics is essentially ambient). `is_terminated()` returns `active_r_idx >= n_cells`. Steps are computed up to `active_r_idx + buffer`.

**Boundary Conditions**:
- Left (centre): `REFLECTIVE` (symmetry, `u=0` at r=0)
- Right (far field): `TRANSMISSIVE` (extrapolation)

### 6.4 2D CPU Solver (`CFDSolver2DImpl<RealType>`)

**Domain**: 2D axisymmetric (r-z) or Cartesian (x-y). `nr_cells × nz_cells`, cell size `dr × dz`.

**Boundary Conditions** (per-face): `REFLECTIVE`, `TRANSMISSIVE`, `OUTFLOW_RIEMANN`.

**Coordinate System**: Configurable via `setCoordinateSystemCartesian(bool)`.

**Detonator**: Location `(det_x, det_z)` for programmed burn; set by `REMAP` or `INIT_2D` payload.

**Initial Conditions**:
- `setInitialConditionTNT()`: Spherical JWL explosive in 2D.
- `setInitialConditionTNTCylinder()`: Cylindrical charge geometry.
- `setInitialConditionIdealGas()`: Ideal gas high-pressure sphere.
- `setInitialConditionFrom1D()`: Remap from 1D radial solution. Uses K=5 sub-cell averaging; clamps `d_sub <= r_1d.back()` to prevent flat-extrapolation into corners.

**Time Integration**: Low-Storage Runge-Kutta 3 (LSRK3) via `applyLSRK3Step(stage, dt)`.

**Tile Management**: `num_tiles_r × num_tiles_z` tile map. Inactive tiles (pure ambient) are not computed. `updateActiveRegion()` expands the active tile set as the shock propagates.

**Solid Boundaries**: `setSolidVelocities()` and `setSolidMask()` allow embedding solid objects (future feature).

**Termination**: `checkTerminationCondition()` — returns true when the shock reaches within a threshold of the outflow boundary.

### 6.5 2D CUDA Solver (`CFDSolver2DCudaImpl<RealType>`)

**GPU Memory Layout**: All tile pools (`d_states_pool`, `d_U_pool`, `d_dU_pool`) are device pointers to `PrimitiveTileT<RealType>` / `ConservativeTileT<RealType>` arrays.

**Pinned Memory**: Host mirrors (`host_states_pool`, `host_U_pool`) are used during initialization and active-region sync.

**Dynamic Tile Pool Growth**: `growTilePool(new_max_tiles)` — reallocates device arrays via `cudaMalloc` + `cudaFree` when the shock expands beyond the pre-allocated tile count.

**Active Region Update**: `updateActiveRegionHost()` runs every N steps (throttled via `step_count`). Copies active tile flags back to host, expands active region on CPU, pushes updated `d_tile_map` to device.

**Wave Speed Reduction**: `d_wave_speeds` and `d_block_maxes` are used for parallel max-reduction to compute `getMaxWaveSpeed()` without a CPU round-trip per step.

**VRAM Accounting**: `getAllocatedVRAM()` returns the total bytes allocated on device (computed from pool sizes × sizeof(tile)).

**Telemetry**: `getTelemetry2D(stride)` performs a device-to-host copy of the active region at the requested stride, producing a flat `float` array for the BIN2D_FRAME.

### 6.6 3D CPU Solver (`CFDSolver3DImpl<RealType, IsMultiMaterial>`)

**Domain**: Cartesian 3D box `[xmin, xmin+nx*dx] × [ymin...] × [zmin...]`.

**Tile Pool**: `states_pool` (primitive), `U_pool` and `U_prev_pool` (conservative), `active_tiles` (uint8 bitmask per tile).

**Charge Shapes** (`Charge3DParams`):
- `shape_type=0`: Sphere (radius)
- `shape_type=1`: Block (lx, ly, lz dimensions)
- `shape_type=2`: Cylinder (radius, height)

**Boundary Conditions**: Per-face, 6 independent settings: `REFLECTIVE`, `TRANSMISSIVE`, `OUTFLOW_RIEMANN`.

**Ghost Cell Sampling**: `sampleStateInternal(gx, gy, gz)` applies BC logic (reflection for velocity sign) and clamps indices, enabling uniform stencil access at boundaries.

**Gauges**: `sampleGauge(Gauge3D)` trilinearly interpolates from the tile pool at arbitrary (x,y,z).

**Slices**: `extractSlice(Slice3D)` iterates over a 2D plane at a given axis/offset and extracts requested quantities (`p`, `rho`, `u`, `E`, `alpha1`, `alpha2`) at a given stride.

**1D Remap**: `initializeFrom1D()` maps 1D radial states onto the 3D grid using distance from the `(x_expl, y_expl, z_expl)` detonation point, within `R_remap`.

**Programmed Burn**: `applyProgrammedBurn(dt)` calls `MultiMat::computeProgrammedBurn()` per active cell.

**Active Region Update**: `updateActiveRegions()` — scans tiles for non-ambient conditions; marks tiles as active/inactive. Solver steps only compute active tiles.

### 6.7 3D CUDA Solver (`CFDSolver3DCuda<RealType, IsMultiMaterial>`)

GPU version of the 3D solver. Uses:
- `d_states`: device pointer to `PrimitiveTile3D` pool
- `d_U`, `d_U_prev`: device conservative tile pools
- `d_active_tiles`: device active tile bitmask
- `d_max_s_buf`: wave speed reduction buffer
- `d_slice_buf`: temporary slice extraction buffer
- `temp_h_states`, `temp_h_active`: host-side mirrors for the 1D remap phase

---

## 7. Materials & EOS (`materials.hpp`)

All functions are `inline` and tagged `__host__ __device__` for use on both CPU and CUDA kernels.

### 7.1 Built-In Material Presets

| Name | ρ₀ (kg/m³) | D_CJ (m/s) | E_det (J/kg) | Notes |
|---|---|---|---|---|
| `TNT` | 1630 | 6930 | 4.29 × 10⁶ | Default; JWL A=373.77 GPa |
| `PETN` | 1770 | 8300 | 5.80 × 10⁶ | JWL A=613.4 GPa |
| `RDX` | 1806 | 8750 | 5.30 × 10⁶ | JWL A=524.2 GPa |

### 7.2 Equation of State Functions

**Ideal Gas**: `getEnergy_IdealGas(p, rho, gamma)` → `p / ((γ-1)·ρ)`

**JWL** (`getEnergy_JWL(p, rho, jwl)`):
```
V = ρ₀/ρ
f = A(1 - ω/(R₁V))·e^(-R₁V) + B(1 - ω/(R₂V))·e^(-R₂V)
e = (p - f) / (ω·ρ)
```

**Mixture Pressure** (`getMixturePressure`): Baer-Nunziato-type mixing:
```
p = (E_internal + Σ αᵢ·Sᵢ·fᵢ(V)/ωᵢ) / (Σ αᵢ/ωᵢ)
```
- Air (material 0): Ideal gas, `ω₀ = γ-1`
- Products (material 1): Full JWL with density-dependent cold-curve `f₁(V₁)`
- Unreacted solid (material 2): Stiffened-gas approximation, `V₂ = 1.0` (reference volume), `f₂ clamped ≥ 0` to prevent negative interface cell pressures
- Smooth ramp factors `S₁ = min(1, α₁/0.01)` and `S₂ = min(1, α₂/0.01)` prevent discontinuous EOS switching

`getMixtureEnergy()` and `getMixturePressure()` are **exact inverses** — they use identical `S₁/S₂` ramps and `f(V)` terms.

**Mixture Sound Speed** (`getMixtureSoundSpeed`): Volume-fraction–weighted acoustic impedance formula with per-material sound speeds clamped to physical minima.

### 7.3 Programmed Burn (`computeProgrammedBurn`)

Implements a smooth linear burn front over `N_BURN_CELLS = 4` cells:
```
t_arr = det_start_time + r/D_CJ    (arrival time at cell centre)
τ     = 4·dx / D_CJ               (transit time across burn width)
F_pb(t) = clamp((t - t_arr)/τ, 0, 1)
```
The function computes `F_target` and then incrementally updates `alpha1`, `alpha2`, `arho1`, `arho2` by the difference `ΔF = F_target - F_current`, conserving total explosive density `ρ_expl = arho1 + arho2`.

---

## 8. Disk I/O

### HDF5 Writer (`HDF5Writer.hpp/.cpp`)
- Writes volumetric simulation snapshots to `.h5` files using the HDF5 C API.
- Conditionally compiled: `#ifndef NO_HDF5`.
- Used for XDMF+HDF5 pattern (heavy data in HDF5, XML metadata in XDMF).

### XDMF Writer (`XDMFWriter.hpp/.cpp`)
- Generates the XML metadata wrapper referencing the HDF5 datasets.
- Readable by ParaView, VisIt, and similar post-processing tools.

### VTK Writer (`VTKWriter.hpp/.cpp`)
- Exports 1D and 2D solutions to VTU (VTK Unstructured Grid XML) format.
- Uses `ZLIB` for binary data compression (required, hence `find_package(ZLIB REQUIRED)`).
- Exports fields: `rho`, `u` / `(ur, uz)`, `p`, `E`, `alpha1`, `alpha2`.
- Also supports particle VTK export (`export_vtk_particles()`).
- Triggered by the `WRITE_VTK` command.

---

## 9. IPC Protocol Reference

### 9.1 Browser → Broker (WebSocket Text)

Commands are JSON strings. All carry a `modelId` field.

| Command | Key Fields |
|---|---|
| `INIT` | `n_cells`, `domain_radius`, `gamma`, `explosive_radius`, `rho`, `init_mode`, `composition`, `flux_scheme`, `spatial_order`, `temporal_order`, JWL params |
| `INIT_2D` | `nr`, `nz`, `max_r`, `max_z`, `gamma`, `init_mode`, `device`, `charge_shape`, `charge_r/z/radius/height`, `detonator_r/z`, `remap_radius` |
| `INIT_3D` | `nx`, `ny`, `nz`, `dim_x/y/z`, `xmin/ymin/zmin`, `device`, `init_mode`, `precision`, `slices[]`, `gauges[]` |
| `STEP` | `steps`, `cfl` |
| `EXEC_ALL` | `cfl` |
| `PAUSE` | *(none)* |
| `TERMINATE` | *(none)* |
| `REMAP` | `r_1d[]`, `states_1d[]`, `explosive_x/y/z`, `remap_radius`, `ambient_rho`, `ambient_p`, `is_ideal_gas`, all JWL params |
| `CONTOUR_CONFIG` | `stride`, `refresh_rate` |
| `VIEW3D_CONFIG` | `slices[]`, `refresh_rate` |
| `WRITE_VTK` | `filename` |
| `STOP` | *(none)* — terminates the process for this modelId |

### 9.2 Worker → Broker (stdout Hybrid Stream)

```
JSON line      \n          → forwarded as WS text
BIN_FRAME <N> \n [N bytes] → forwarded as WS binary
BIN2D_FRAME <N> \n [N bytes]
BIN_FRAME_3D_SLICES <N> \n [N bytes]
```

### 9.3 Binary Frame Layout

**1D Binary** (`BIN_FRAME`):
```
[uint32 n_cells] [uint32 n_channels=7] [float32 × n_cells × 7]
```
Channels (column-major): `p, rho, u, E_specific, alpha1, alpha2, alpha_air`

**2D Binary** (`BIN2D_FRAME`):
```
[uint32 nr_ds] [uint32 nz_ds] [uint32 n_channels] [float32 × nr_ds × nz_ds × n_channels]
```

**3D Slices** (`BIN_FRAME_3D_SLICES`): raw binary payload from `extractSlice()`, structured by the slice definitions sent in `VIEW3D_CONFIG`.

### 9.4 Broker → Browser Binary Framing

All binary frames are prefixed with the `modelId` as a null-terminated UTF-8 string before the raw float payload:
```
[modelId bytes][0x00][raw binary payload]
```

---

## 10. Frontend Architecture

### 10.1 TypeScript Type System (`types.ts`)

```typescript
type NodeType = 'DomainMesh' | 'Material' | 'Charge1D' | 'Charge2D' |
    'ThePainter' | 'CFDSolver' | 'TelemetryText' | 'TelemetryGraph' |
    'DomainMesh2D' | 'DetonatorLocation' | 'DetonatorLocation3D' |
    'RemapNode' | 'HardwareConfig' | 'CFDSolver2D' | 'TelemetryContour' |
    'VTKOutput' | 'VirtualGauges' | 'DomainMesh3D' | 'Charge3D' |
    'CFDSolver3D' | 'Telemetry3DViewport' | 'VirtualGauges3D';

interface Node {
    id: string; type: NodeType; x: number; y: number;
    width?: number; height?: number;
    displayMode?: 'compact' | 'normal' | 'expanded' | 'full-panel';
    parameters: Record<string, any>;
    inputs: Port[]; outputs: Port[];
    orientation?: 'HORIZ' | 'VERT';
}

interface Connection { fromNode: string; fromPort: string; toNode: string; toPort: string; }

type SimulationStatus = 'UNINITIALIZED' | 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'TERMINATED';
```

**AppState** (the true global state):
```typescript
interface AppState {
    models: Record<string, Model>;  // All models in the project
    workspaces: Workspace[];        // All open workspaces (tab-like)
    activeWorkspaceId: string;
    workspaceCounter: number;
}
```

**Workspace** → contains a set of `modelIds`, an `activeModelId`, a recursive `LayoutNode` tree, and cross-model `connections[]`.

**Model** → contains `nodes[]` and `connections[]` — a self-contained simulation graph.

**LayoutNode** → union of `SplitNode` (binary split with `ratio` and `direction`) and `PanelNode` (leaf with `panelType`).

**Panel Types**: `MENU_BAR`, `OUTLINER`, `NODE_GRAPH`, `PROPERTIES`, `TELEMETRY_GRAPH`, `TELEMETRY_TEXT`, `NODE_VIEWER`, `EXECUTION_MANAGER`, `RESOURCE_MANAGER`, `TELEMETRY_CONTOUR`, `TELEMETRY_3D`.

### 10.2 State Manager (`state-manager.ts`)

The global SSOT for the entire frontend. Manages:

- **AppState history** with unlimited undo/redo (`pushAppState`, `undo`, `redo`).
- **Model CRUD**: `createModel`, `copyModelToClipboard`, `pasteModelFromClipboard` (deep-copies nodes with remapped IDs).
- **Workspace CRUD**: `createWorkspace`, `deleteWorkspace`, `renameWorkspace`, `duplicateWorkspaceLayout`.
- **Node parameter updates**: `updateNodeParameters` (pushes history) and `updateNodeParametersInPlace` (silent, no history entry).
- **Explosive parameter sync**: `syncExplosiveParameters()` — when `charge_mass` changes, automatically recomputes `charge_radius = (3m/4πρ)^(1/3)`. When `rho` changes, recomputes radii for all connected `Charge1D`/`Charge2D` nodes.
- **Telemetry store**: `Map<string, any>` keyed by `nodeId`. `pushTelemetry(modelId, msg)` routes to the correct `TelemetryText` node.
- **Per-model status**: `Map<string, SimulationStatus>` and `Map<string, number>` for progress.
- **Persistence**: `saveWorkspace()` / `loadWorkspace()` via `localStorage` key `blast_workspace`. Auto-saves on every state mutation.
- **Selection**: `selectedNodeId` with listener callbacks.
- **Layout healing**: `ensureMenuBar(layout)` injects a MENU_BAR panel if the root layout lacks one.

### 10.3 Serialization (`serialization.ts`)

**`serializeForSolver(state, command, modelId)`**: Traces the DAG from the relevant solver node (1D/2D/3D) and compiles a flat JSON payload:

1. For `INIT` (1D): traces `CFDSolver → ThePainter → {DomainMesh, MaterialAir, Charge1D → MaterialExplosive}`. Computes `n_cells = round(radius/dx)`, `explosive_radius` from mass/density, `ambient_rho` from ideal gas law.
2. For `INIT_2D`: traces `CFDSolver2D → {DomainMesh2D, MaterialAir, Charge2D → Material, DetonatorLocation, RemapNode, HardwareConfig}`. Heals missing detonator/charge fields with safe defaults.
3. For `INIT_3D`: traces `CFDSolver3D → {DomainMesh3D, MaterialAir, Charge3D → Material, DetonatorLocation3D, RemapNode, VirtualGauges3D, Telemetry3DViewport}`.

**`serializeToBinary(state)` / `deserializeFromBinary(buffer)`**: Custom `.blst` binary format:
```
Magic: 'BLST' (4 bytes)
Version: 1 (1 byte)
Flags: 0 (1 byte)
JSON Length (4 bytes, big-endian)
JSON payload (variable)
Checksum: sum of JSON bytes mod 2^32 (4 bytes, big-endian)
```

### 10.4 Remap Pipeline Detection (`main.ts`)

`findRemapPipeline(modelId)` scans `ws.connections` (cross-model connections) for:
1. A connection whose destination is a `RemapNode` in the 2D model.
2. Whose source lives in a model containing a `CFDSolver` (1D).

Returns `{model1dId, model2dId, processId: model2dId}` or `null`. The `processId` is always the 2D model ID, ensuring the Broker routes both INIT and INIT_2D to the same BlastSolver process.

`executeModelCommand()` uses the pipeline descriptor to:
- Send `INIT_2D` first (to initialize the 2D solver).
- Then send `REMAP` (parsed from the last 1D binary telemetry stored in `stateManager.telemetryStore`).

### 10.5 WebSocket Client (`NetworkManager.ts`)

- Connects to `ws://localhost:8080`.
- `binaryType = "arraybuffer"` set immediately on socket creation.
- Auto-reconnects after 3s on disconnect.
- `send(message)`: serializes to string if object; logs `[DEBUG] RAW INIT PAYLOAD` for INIT commands.
- Binary frames bypass the JSON parse branch in `onmessage`.

### 10.6 Node Parameter Alignment and Unified Casting

To prevent parameter drift and mismatched data types (such as numbers being mapped as strings) between the user interface properties and backend C++ solver parsing:

1. **Unified Casting Lists**: Any numeric node parameter MUST be registered in the `numericKeys` lists in:
   - `serialization.ts` (so that it gets cast to a number when generating JSON solver payloads)
   - `property-editor.ts` (so that property inputs cast values before updating state parameters)
   - `node-viewer.ts` (so that custom panel overlays parse values correctly)
   - `graph-renderer.ts` (so that inline dropdown handlers cast option selections correctly)
2. **Synchronized Defaults**: Default parameters for any node type must remain identical between `state-manager.ts` (`defaults` map) and `graph-renderer.ts` (`getDefaultParameters` method) to ensure consistency when creating or healing nodes.

---

## 11. UI Panel Components

### 11.1 GraphRenderer (`graph-renderer.ts`, ~274 KB)

The infinite-canvas visual node editor.

**Canvas Layers**:
1. `SVG` layer for Bezier wire paths (cubic, control points at 40% of node distance).
2. `div` layer for node HTML elements (positioned with `transform: translate()`).

**Viewport Transform**: Scale starts at `1.25`. Pan/zoom via mouse wheel + middle-drag. `updateTransform()` applies CSS transform to the canvas-container.

**Port Styling by Data Type**:
- Domain: `#2563eb` (blue)
- Material: `#64748b` (slate)
- Explosive: `#dc2626` (red)
- Telemetry: `#16a34a` (green)

**Wire Snapping**: 15px magnetic snap radius; glowing cyan `#00f0ff` ring on hover.

**Stability**: Wire anchor points recomputed from `.port-bullet` `getBoundingClientRect()` every animation frame. `ResizeObserver` triggers redraws on layout shifts.

**Context Menu**: Right-click → create any node type.

**Layout Direction**: Horizontal or vertical; toggle in panel header. Adjusts cubic Bezier control vectors.

**Auto-Arrange / Fit-to-View**: Available via panel header buttons.

**Node Header Controls**: Orient and collapse buttons positioned at `justify-content: flex-start` with `gap: 8px`.

### 11.2 ChartWorker (`ChartWorker.ts`)

Runs on `OffscreenCanvas` in a dedicated `Worker`.

**Resolution Sync**: Main thread calls `getBoundingClientRect()` and posts `{width, height}` to the worker BEFORE `transferControlToOffscreen()`.

**Plot Channels**: `p`, `rho`, `u`, `E`, `alpha1`, `alpha2` — selected via UI control.

**Plot Stride**: Configurable (1, 2, 5, 10, 20, 50, 100 frames) to throttle redraws.

**Drawing**: 40px padding margin, `#475569` baseline axes, `ctx.beginPath()/stroke()` per channel.

**Auto-Scaling**: `minY`/`maxY` computed from visible data; posted back to main thread via `postMessage({type: 'bounds', minY, maxY})`.

### 11.3 ContourWorker (`ContourWorker.ts`)

Renders the 2D contour field from binary frames on `OffscreenCanvas`.

**Data Decoding**: Parses the BIN2D_FRAME binary layout; maps float values to HSL colormap.

**Stride-Based Subsampling**: Respects `downsample_stride` set via `CONTOUR_CONFIG`.

### 11.4 ViewportWorker / ViewportRenderer (3D)

`ViewportWorker.ts` (~58 KB) runs on a `Worker` with `OffscreenCanvas` for the 3D slice visualiser.

`ViewportRenderer.ts` handles the main-thread `Telemetry3DViewport` node panel, bridging between the node graph and the worker.

### 11.5 NodeViewer (`node-viewer.ts`, ~76 KB)

**Absolute Canvas Trick**: Inner canvas uses `position: absolute; inset: 0` inside a `position: relative` wrapper to decouple from Flexbox layout. Resolution is synced via `setTimeout(..., 0)` microtask.

**Sub-Selector**: Dropdown listing all selectable nodes; clicking switches the displayed node.

**Live Binding**: Native `<input>` fields generated for parameters; mutations call `stateManager.updateNodeParameters()`.

**Dynamic Bounds Display**: `viewer-min-y-${nodeId}` and `viewer-max-y-${nodeId}` header elements receive bounds from the ChartWorker.

### 11.6 PropertyEditor (`property-editor.ts`, ~45 KB)

**Properties Panel**: Displays the selected node's parameters and I/O connections.

**I/O Connections Sector**: Driven strictly from `state.connections`; highlights missing required connections (CFDSolver, DomainMesh, MaterialAir, explosive) with descriptive validation warnings.

### 11.7 ResourceManager (`resource-manager.ts`)

**Metrics Bars**: GPU UTILIZATION, VRAM ALLOCATION, CORE TEMPERATURE.

**Namespace Safety**: All element IDs prefixed with `panelId` (e.g., `${panelId}-gpu-bar`) to prevent collisions in split-pane layouts.

**Direct DOM Updates**: `updateMetrics()` scopes to the panel's root element and sets bar widths and text directly without `innerHTML` re-renders.

**Fast Path**: `resource_pulse` messages bypass StateManager entirely; they are routed directly from the WS handler via `layoutManager.broadcastResourceData()`.

### 11.8 ExecutionManager

**Controls**: Initialize, Step (N steps), Exec All, Pause, Terminate per model.

**Progress Bar**: Neon-cyan solver progress bar driven by `progress` JSON packets.

**Reset Utility**: 'Reset Workspace' → `window.confirm()` → `localStorage.clear()` → `window.location.reload()`.

### 11.9 LayoutManager (`layout-manager.ts`, ~77 KB)

Recursively renders the `LayoutNode` tree (binary splits) as nested `div` elements with absolute positioning.

**Component Cache**: `components: Map<panelId, {type, instance}>` — preserves component state across layout changes.

**Split Panels**: Draggable dividers update the `ratio` in the state and trigger a full layout re-render.

**Panel Type Header**: Each panel includes a compact header with a panel-type selector dropdown, allowing any panel to be switched to any type at runtime.

### 11.10 Outliner

Renders the DAG as nested `<ul>/<li>` starting from root nodes (nodes with 0 incoming connections). Shows hierarchy via indented tree.

---

## 12. CSS Architecture (`frontend/styles.css`, ~38 KB)

**Nuclear Overrides** for layout stability:
```css
.panel-container { min-width: 0 !important; min-height: 0 !important; }
canvas { max-width: 100% !important; }
```

**Panel Containment**: `.panel-content` uses:
```css
position: relative; flex: 1; overflow: hidden; display: flex; flex-direction: column;
```

**Terminal Text**: `position: absolute; inset: 0; word-break: break-all; white-space: pre-wrap; overflow-y: auto;`

**Design Tokens**: Dark background (`#0f1117`), panel surfaces (`#1a1d27`), accent neon cyan (`#00f0ff`), JWL red (`#dc2626`), solver green (`#16a34a`).

---

## 13. Default Node Graph (Startup State)

On first launch (no `localStorage`), the app initialises with a 1D multi-material JWL pipeline:

```
DomainMesh (1D, radius=1.0m, dx=0.001m)  ──mesh──┐
Material (Air, γ=1.4, p₀=101325 Pa) ──────air───▶ ThePainter ──▶ CFDSolver (AUSM+, RK2, order 2)
Material (JWL TNT, ρ=1630 kg/m³) ──▶ Charge1D ──explosive──┘
```

Connections:
- `node-mesh → node-painter (mesh)`
- `node-air → node-painter (air)`
- `node-material-explosive → node-explosive (material)`
- `node-explosive → node-painter (explosive)`
- `node-painter → node-solver (in)`

---

## 14. Development Lifecycle

### Port Map

| Service | Port | Protocol |
|---|---|---|
| Vite dev server (frontend) | 5173 | HTTP |
| Broker (backend) | 8080 | WebSocket (RFC 6455) |

### Active Runtime (current session)
- `./Broker` running from `build/` (4h46m+)
- `npm run dev` in `frontend/` (62h4m+ and 5h39m+)

### Build Flow

```bash
# Backend
mkdir build && cd build && cmake .. && make -j$(nproc)

# Frontend
cd frontend && npm run dev       # Dev (Vite HMR)
cd frontend && npm run build     # Production (tsc + vite build)
```

### Verification

Integration test: verify Broker on :8080 and frontend on :5173 are responding.

### Source Control Exclusions

`.gitignore` must exclude: `build/`, `*.log`, `node_modules/`, `dist/`, `*.o`, `test_out*.txt`, `my_test_out.txt`.

---

## 15. Known Architectural Details & Gotchas

| Issue | Detail |
|---|---|
| **Per-model process isolation** | INIT and INIT_2D for the same `modelId` share one `BlastSolver` process. The historical "reuse any running process" heuristic caused cross-model parameter contamination and has been removed. |
| **Telemetry binary cloning** | `data.slice(0)` clones the `ArrayBuffer` before passing to a Web Worker `postMessage`, preventing buffer neutering when multiple panels display the same data stream. |
| **Ideal Gas channel count** | The 1D solver emits `is_ideal_gas` in the TELEMETRY JSON; the frontend omits `alpha1`/`alpha2` display for 5-channel frames. The 2D/CUDA solver uses the same 7-channel layout but zeroes the alpha fields. |
| **JWL cold-curve clamping** | For unreacted solid (Material 2), `f2 = max(0, f2)` prevents the negative TNT cold curve from driving interface cells to ~194 MJ/m³ reference energy. |
| **S₁/S₂ ramps** | Smooth linear ramps `min(1, α/0.01)` prevent discontinuous EOS switching near near-vacuum material edges. Must be identical in `getMixturePressure`, `getMixtureEnergy`, and `getMixtureSoundSpeed`. |
| **NVML dynamic loading** | `dlopen("libnvidia-ml.so.1")` is used instead of linking NVML at build time to keep the solver binary runnable on machines without an NVIDIA driver. |
| **`FD_CLOEXEC`** | Set on both server socket and client socket on Linux to prevent inadvertent inheritance by child BlastSolver processes. |
| **`SIGPIPE` suppression** | The Broker globally ignores SIGPIPE. All send errors yield `EPIPE` and are handled gracefully. |
| **2D BC default** | `bcRmax` and `bcZmax` default to `OUTFLOW_RIEMANN` (not `TRANSMISSIVE`) in the 2D solvers for better shock handling at outflow faces. |
| **3D LSRK vs RK** | The 3D solver defaults to `spatialOrder=2, temporalOrder=2` (unlike the 1D solver which defaults to `1,1`). |
