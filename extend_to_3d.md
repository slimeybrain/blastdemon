# Architectural Proposal: Extending BlastDaemon to 3D Cartesian CFD

This proposal outlines the implementation plan to extend the entire **BlastDaemon** framework to full 3D Cartesian coordinates ($x, y, z$). It covers state representations, the C++/CUDA solver physics, sparse 3D spatial tiling (voxels), IPC bandwidth mitigation, 1D-to-2D-to-3D remapping, and zero-dependency WebGPU/Canvas volumetric visualization.

---

## User Review Required

> [!IMPORTANT]
> **Performance & Bandwidth Ceiling (WebSocket I/O) & Output Deferral**
> A 3D simulation with $256^3$ cells contains ~16.7 million grid points, representing ~1.34 GB of data per time step. To keep simulation execution fast and respect the WebSocket bandwidth ceiling, **we will not output any full 3D datasets (such as HDF5/XDMF volumetric files) for now**.
> Instead, the solver will slice the 3D grid and output **2D cross-section datasets** for telemetry purposes.
>
> **Dynamic Slice Controls**: The user will configure:
> 1. The location of each slice (axis XY, YZ, or XZ and its normal offset).
> 2. The number of active slices.
> 3. Which simulation quantities (pressure, density, velocities, fractions) are output and plotted for each slice.

> [!WARNING]
> **WebGPU Zero-Dependency Rule**
> The rules in `AGENTS.md` strictly forbid Three.js, Babylon.js, or any external 3D libraries. We will build a **raw WebGL / WebGPU 3D viewport renderer** from scratch in a vanilla HTML5 canvas. This renderer will display the domain bounding box and place the cross-section slices in 3D space, supporting interactive **zoom, pan, and rotate** camera transformations via raw matrix math.

## Key Design Decisions

> [!NOTE]
> **Exclusive 3D Cartesian Domain Layout**
> It has been decided to restrict the 3D simulation solver exclusively to Cartesian coordinates ($x, y, z$). Cylindrical ($r, \theta, z$) or spherical configurations are excluded for simplicity and performance. Boundary conditions (Reflecting, Transmitting, or Outflow) will be independently configured for the six boundaries: $x_{\text{min}}, x_{\text{max}}, y_{\text{min}}, y_{\text{max}}, z_{\text{min}}, z_{\text{max}}$.

---

## Proposed Changes

### Component 1: CFD Physics & State Representation (`backend/BlastSolver/`)

To support three velocity components ($u_x, u_y, u_z$), we must extend state variables and spatial fluxes to three dimensions. To match the 2D model improvements, the 3D solver will utilize **perfectly cubic cells** ($dx = dy = dz = \text{cell\_size}$) derived from a single `cell_size` parameter, three domain dimensions ($L_x, L_y, L_z$), and an origin position ($x_{\text{min}}, y_{\text{min}}, z_{\text{min}}$) placed in 3D space.

##### Grid Discretization & Coordinates:
- **Spatial Positioning**: The domain boundary is defined as $[x_{\text{min}}, x_{\text{min}} + L_x] \times [y_{\text{min}}, y_{\text{min}} + L_y] \times [z_{\text{min}}, z_{\text{min}} + L_z]$. The origin ($x_{\text{min}}, y_{\text{min}}, z_{\text{min}}$) defaults to $(0.0, 0.0, 0.0)$.
- **Cubic Cells**: Grid cell sizes are isotropic:
  $$\Delta x = \Delta y = \Delta z = \text{cell\_size}$$
- **Derived Cell Counts**:
  $$N_x = \text{round}(L_x / \text{cell\_size})$$
  $$N_y = \text{round}(L_y / \text{cell\_size})$$
  $$N_z = \text{round}(z_{\text{max}} / \text{cell\_size})$$
- **Cell Physical Coordinates**: The absolute coordinates for a cell $(i, j, k)$ are calculated relative to the spatial origin:
  $$x_i = x_{\text{min}} + (i + 0.5) \cdot \text{cell\_size}$$
  $$y_j = y_{\text{min}} + (j + 0.5) \cdot \text{cell\_size}$$
  $$z_k = z_{\text{min}} + (k + 0.5) \cdot \text{cell\_size}$$
- **Physics Impact**:
  - Distance calculations for programmed burn, charge geometries, and remapping are offset by the origin.
  - Cell volumes are constant: $V = \text{cell\_size}^3$.
  - Cell interface areas are constant: $A = \text{cell\_size}^2$.
  - Spatial reconstructions and the CFL timestep calculation ($\Delta t = \text{CFL} \cdot \frac{\text{cell\_size}}{\max(\|u\| + c)}$) are fully optimized.

#### [MODIFY] [cfd_states.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_states.hpp)
- Add `State3D` and `ConservativeState3D` structures containing:
  - Primitives: `rho`, `ux`, `uy`, `uz`, `p`, `E`, `alpha1`, `alpha2`, `arho1`, `arho2`, `floor_status`.
  - Conserved: `rho`, `rhoux`, `rhouy`, `rhouz`, `E`, `alpha1`, `alpha2`, `arho1`, `arho2`.

#### [MODIFY] [cfd_tile.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_tile.hpp)
- Refactor tile structures using C++ templates to compile-time prune unused arrays:
  - **1D Solver**: Uses `cfd_states.hpp` inline structures and does not allocate any multi-dimensional velocity vectors.
  - **2D Solver Tiles**: Template `ConservativeTile2D<bool IsMultiMaterial>` and `PrimitiveTile2D<bool IsMultiMaterial>` using `TILE_SIZE = 16`.
    - If `IsMultiMaterial = false` (Ideal Gas): Contains only `rho`, `ur`, `uz`, `p`, `E`. Wasted arrays for volume fractions and partial densities are omitted.
    - If `IsMultiMaterial = true` (JWL): Allocates the full set: `rho`, `ur`, `uz`, `p`, `E`, `alpha1`, `alpha2`, `arho1`, `arho2`.
  - **3D Solver Tiles**: Template `ConservativeTile3D<bool IsMultiMaterial>` and `PrimitiveTile3D<bool IsMultiMaterial>` using `TILE_SIZE_3D = 8` ($8^3 = 512$ cells).
    - Allocates three velocity arrays (`ux`, `uy`, `uz`).
    - If `IsMultiMaterial = false` (Ideal Gas): Allocates only `rho`, `ux`, `uy`, `uz`, `p`, `E` (6 channels × 512 = 24 KB per tile).
    - If `IsMultiMaterial = true` (JWL): Allocates all 10 channels (10 channels × 512 = 40 KB per tile). Wasted components are never allocated.

```cpp
template <bool IsMultiMaterial>
struct ConservativeTile3D;

template <>
struct ConservativeTile3D<false> {
    Real rho[512];
    Real rhoux[512];
    Real rhouy[512];
    Real rhouz[512];
    Real E[512];
};

template <>
struct ConservativeTile3D<true> {
    Real rho[512];
    Real rhoux[512];
    Real rhouy[512];
    Real rhouz[512];
    Real E[512];
    Real alpha1[512];
    Real alpha2[512];
    Real arho1[512];
    Real arho2[512];
};
```

#### [NEW] `cfd_solver_3d.hpp` / `cfd_solver_3d.cpp` (CPU Solver)
- Implement `CFDSolver3D` using a Pointer-to-Implementation (Pimpl) pattern:
  - `CFDSolver3DImplBase` as base.
  - `CFDSolver3DImpl<bool IsMultiMaterial>` as the templated implementation holding `std::vector<PrimitiveTile3D<IsMultiMaterial>> states_pool` and `std::vector<ConservativeTile3D<IsMultiMaterial>> U_pool`.
  - Instantiates the correct template based on `init_mode` ('JWL' or 'Ideal Gas'), avoiding species fraction array allocations in single-material mode.
- **Dynamic Boundary Conditions**:
  - Store boundary conditions for the 6 faces: `bcXmin`, `bcXmax`, `bcYmin`, `bcYmax`, `bcZmin`, `bcZmax` of type `BCType` (`REFLECTIVE` = 0, `TRANSMISSIVE` = 1, `OUTFLOW_RIEMANN` = 2).
  - Implement `applyBC` helper to flip normal velocity components (`ux` for X, `uy` for Y, `uz` for Z) on `REFLECTIVE` faces, handle copy on `TRANSMISSIVE` faces, and compute Riemann subsonic/supersonic checks on `OUTFLOW_RIEMANN` boundaries.
- **Auto-Termination Check**:
  - Implement `checkTerminationCondition()` checking if the pressure of cells adjacent to any `OUTFLOW_RIEMANN` boundary exceeds `1.05 * ambient_p`, returning `true` to terminate early.
- **Virtual Gauges Sampling**:
  - Support list of 3D virtual gauges: `{ name, x, y, z }`. Sample primitive variables (`rho`, `p`, `ux`, `uy`, `uz`) at the nearest cell index on each step and stream to telemetry.
- **Geometrical Initializations**:
  - Parse charge shape (`Sphere`, `Cylinder`, or `Block`) and center $(x_c, y_c, z_c)$ to compute cell intersections and initialize explosive material fractions and density in absolute coordinates.
- **Active Region Expansion**: Loop over all active tiles in parallel using OpenMP. Check if cell values deviate from ambient. If true, activate all 6 face-adjacent neighbor tiles.
- **Physics Stencil**: Implement Minmod and WENO3 spatial reconstruction in X, Y, and Z directions. Solve Rusanov/AUSM+ fluxes at all cell faces.
- **Equation of State (EOS)**: Evaluate JWL and Ideal Gas mixture models per cell.
- **Programmed Burn**: Detonation arrival time calculated using $t_{arr} = t_{start} + \sqrt{(x - x_d)^2 + (y - y_d)^2 + (z - z_d)^2} / D_{CJ}$.

#### [NEW] `cfd_solver_3d_cuda.cu` / `cfd_solver_3d_cuda.hpp` (GPU Solver)
- Port the 3D tile update physics to CUDA:
  - Grid configuration: launch 1 CUDA block per active tile, with $8 \times 8 \times 8$ threads (512 threads per block).
  - Map active tiles onto a compacted device list of indices: `d_active_tile_tx`, `d_active_tile_ty`, `d_active_tile_tz`.
  - Implement CUDA global memory coalescing by keeping SoA layouts contiguous.
  - Implement `applyBC_device` and `readState_device` with `__device__ __forceinline__` qualifiers to optimize register occupancy and enforce dynamic boundary conditions.
  - Implement CUDA-based `checkTerminationCudaKernel` utilizing global reductions or atomic flags to verify boundary pressure triggers.
  - Support GPU-side gauge coordinate mapping to extract telemetry efficiently.

---

### Component 2: IPC & Serialization (`backend/` & `frontend/src/`)

We must update communication channels to parse and transmit 3D commands, boundary conditions, virtual gauges, charge geometry parameters, slice configurations, and telemetry outputs.

#### [MODIFY] [Broker.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastDaemon/Broker.cpp)
- Add hybrid telemetry relay support for `BIN_FRAME_3D_SLICES <N>` and relay all stdout telemetry frames (such as virtual gauge JSON payloads) directly to the WebSocket client.

#### [MODIFY] [main.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp)
- Parse incoming `INIT_3D` parameters:
  - Domain Mesh origin and dimensions.
  - Boundary conditions: `bc_x_min`, `bc_x_max`, `bc_y_min`, `bc_y_max`, `bc_z_min`, `bc_z_max` mapping to solver BC types.
  - Charge geometry parameters (`charge_shape`, `charge_x`, `charge_y`, `charge_z`, `charge_radius`, `charge_height`, `charge_length_x`, `charge_length_y`, `charge_length_z`).
  - Detonator location parameters (`detonator_x`, `detonator_y`, `detonator_z`, `detonator_radius`).
  - Active slices configuration array:
    `slices: Array<{ axis: 'xy' | 'yz' | 'xz', offset: number, quantities: string[] }>`
  - Virtual gauges:
    `gauges: Array<{ name: string, x: number, y: number, z: number }>`
- In the simulation loop:
  - Run the 3D solver step and check `checkTerminationCondition()`. If triggered, serialize a termination event to stdout.
  - On telemetry intervals, sample virtual gauge positions in primitive variable arrays and write results as a JSON frame to stdout.
  - Extract and package 2D cross-sections:
    ```
    ASCII: "BIN_FRAME_3D_SLICES <total_bytes>\n"
    Binary: [uint32 n_slices]
            [Slice 0 Header: uint32 id, uint32 width, uint32 height, uint32 n_quantities]
            ...
            [Slice N Header]
            [Slice 0 Data: float32 x width x height x n_quantities]
            ...
            [Slice N Data]
    ```

#### [MODIFY] [serialization.ts](file:///home/chris/antigrav/blastdemon/frontend/src/serialization.ts)
- Add `INIT_3D` serialization support tracing the connections:
  - Trace `DomainMesh3D` to serialize `origin_x/y/z`, `dim_x/y/z`, `cell_size`, and boundary conditions (`bc_x_min/max`, `bc_y_min/max`, `bc_z_min/max`).
  - Trace the `Material` (Air) and `Charge3D` nodes (connected to their respective `Material` nodes) to serialize ambient conditions and charge parameters (`charge_shape`, center coordinate $x_c, y_c, z_c$, and dimensions).
  - Trace `DetonatorLocation` to serialize detonator coordinates.
  - Trace the `Telemetry3DViewport` parameters to serialize the slice array.
  - Trace the `VirtualGauges` node connections to serialize the gauge array.
- Derive grid dimensions dynamically:
  - `nx = Math.round(dim_x / cell_size)`
  - `ny = Math.round(dim_y / cell_size)`
  - `nz = Math.round(dim_z / cell_size)`

#### [MODIFY] [validation.ts](file:///home/chris/antigrav/blastdemon/frontend/src/validation.ts)
- Implement 3D graph validation rules: verify that `CFDSolver3D` receives inputs from a `DomainMesh3D` node, a `Material` node (configured as Air), a `Charge3D` node (optional, but if connected must link to a `Material` node), and a `DetonatorLocation` node.
- Validate that all charge, detonator, and virtual gauge coordinates lie within the physical boundaries $[x_{\text{min}}, x_{\text{min}} + L_x] \times [y_{\text{min}}, y_{\text{min}} + L_y] \times [z_{\text{min}}, z_{\text{min}} + L_z]$.
- Validate that slice offsets lie within the domain bounds, and `cell_size > 0`.

---

### Component 3: 1D-to-2D-to-3D Remapping (`backend/`)

#### [NEW] `remapper_3d.cpp`
This file implements high-fidelity spatial projections to map early-stage high-resolution simulations onto the 3D domain.

##### 1. 1D-to-3D Spherical Projection
Directly project a 1D spherical solver profile (containing shock fronts and early JWL gas expansions) onto the 3D Cartesian solver:
- **Subgrid Averaging ($K \times K \times K$)**: 
  To prevent aliasing and pixelation of the spherical shock front when mapped onto a coarser 3D Cartesian mesh, each cell $(i, j, k)$ centered at $(x_c, y_c, z_c)$ with dimensions $(\Delta x, \Delta y, \Delta z)$ is divided into $K^3$ subcells (default $K=3$, yielding 27 integration points).
  - Subgrid cell coordinates:
    $$x_s = (i - 0.5)\Delta x + \frac{m + 0.5}{K}\Delta x \quad (m = 0 \dots K-1)$$
    $$y_s = (j - 0.5)\Delta y + \frac{n + 0.5}{K}\Delta y \quad (n = 0 \dots K-1)$$
    $$z_s = (k - 0.5)\Delta z + \frac{p + 0.5}{K}\Delta z \quad (p = 0 \dots K-1)$$
- **Radial Coordinate Lookup & Interpolation**:
  For each subcell, calculate the spherical radial distance $d_s$ from the explosion center $(x_{\text{expl}}, y_{\text{expl}}, z_{\text{expl}})$:
  $$d_s = \sqrt{(x_s - x_{\text{expl}})^2 + (y_s - y_{\text{expl}})^2 + (z_s - z_{\text{expl}})^2}$$
  - If $d_s \le R_{\text{remap}}$ (the user-defined remap boundary) and $d_s \le r_{1D, \text{max}}$:
    Perform linear interpolation on the 1D solver arrays to determine primitive variables: $\rho_s$, $p_s$, $\alpha_{1,s}$, $\alpha_{2,s}$, $\bar{\rho}_{1,s}$, $\bar{\rho}_{2,s}$, and radial velocity $u_{1D,s}$.
  - Otherwise: Assign ambient atmospheric conditions ($\rho_{\text{amb}}, p_{\text{amb}}$).
- **3D Cartesian Velocity Projection**:
  Project the scalar 1D radial velocity $u_{1D,s}$ along the 3D coordinate directions to compute the Cartesian velocity components:
  $$u_{x,s} = u_{1D,s} \cdot \frac{x_s - x_{\text{expl}}}{d_s}$$
  $$u_{y,s} = u_{1D,s} \cdot \frac{y_s - y_{\text{expl}}}{d_s}$$
  $$u_{z,s} = u_{1D,s} \cdot \frac{z_s - z_{\text{expl}}}{d_s}$$
- **Conservative State Averaging**:
  Convert each subgrid state to conservative variables:
  $$U_s = \left\{ \rho_s, \; \rho_s u_{x,s}, \; \rho_s u_{y,s}, \; \rho_s u_{z,s}, \; E_s, \; \alpha_{1,s}, \; \alpha_{2,s}, \; \bar{\rho}_{1,s}, \; \bar{\rho}_{2,s} \right\}^T$$
  where $E_s = E_{\text{int},s} + 0.5 \rho_s (u_{x,s}^2 + u_{y,s}^2 + u_{z,s}^2)$ is calculated using the Mie-Grüneisen mixture energy.
  Average uniformly over the 3D Cartesian cell volume:
  $$U_{i,j,k} = \frac{1}{K^3} \sum_{s=1}^{K^3} U_s$$
- **Active Tile Allocation**:
  To maintain process efficiency, the remapper will compute the overlap between each sparse $8 \times 8 \times 8$ tile and the sphere of radius $R_{\text{remap}}$. Only tiles intersecting the sphere will be allocated and initialized; all outer tiles remain unallocated (representing default ambient states).

##### 2. 2D Axisymmetric-to-3D Cartesian Projection
Project a 2D cylindrical/axisymmetric simulation ($r$-$z$) onto a 3D Cartesian grid ($x$-$y$-$z$):
- Rotate the 2D profile around the axis of symmetry (default $z$-axis):
  - Cylindrical radius: $r_s = \sqrt{(x_s - x_{\text{axis}})^2 + (y_s - y_{\text{axis}})^2}$
  - Find the 2D axial coordinate: $z_{\text{cyl}} = z_s$
  - Perform bilinear interpolation from the 2D cell grid $(r, z)$ to fetch the state variables.
- Project the cylindrical radial velocity $u_{r,s}$ onto the $x$ and $y$ Cartesian planes:
  $$u_{x,s} = u_{r,s} \cdot \frac{x_s - x_{\text{axis}}}{r_s}, \quad u_{y,s} = u_{r,s} \cdot \frac{y_s - y_{\text{axis}}}{r_s}, \quad u_{z,s} = u_{z,s}^{\text{2D}}$$
- Integrate subgrid samples in conservative space and update active tiles.

---

### Component 4: Zero-Dependency 3D Visualization (`frontend/src/`)

We will build a high-performance, interactive 3D viewport node to render cross-section datasets in 3D Cartesian space.

#### [NEW] `Telemetry3DViewport` / `ViewportWorker.ts` (Raw WebGL/WebGPU 3D Viewport)
- **3D Bounding Box**: Render a wireframe outline representing the physical boundaries of the Cartesian domain ($[x_{\text{min}}, x_{\text{min}} + L_x] \times [y_{\text{min}}, y_{\text{min}} + L_y] \times [z_{\text{min}}, z_{\text{min}} + L_z]$) positioned correctly in 3D space.
- **Textured Cut-Planes**: Render each active cross-section as a textured 3D quad, positioned at its exact spatial coordinate.
  - Upstream data (Float32Array) is uploaded to textures on the GPU.
  - Shaders will map local scalar values to colors using selected colormaps (plasma, viridis, coolwarm, etc.) dynamically.
- **Geometrical Markers**:
  - Draw the explosive charge geometry as a transparent colored wireframe shape (sphere, cylinder, or box) inside the domain outline.
  - Draw the detonator coordinate as a small red point or star.
  - Draw active virtual gauge coordinates as small spheres with name tooltips on mouse hover.
- **Interactive Camera Controls & Matrix Math**: Implement standard camera transformation matrices from scratch (without external math libraries):
  - **Orbit Rotation**: Orbit around target center using Mouse Left-Drag (modifies Yaw $\theta$ and Pitch $\phi$).
  - **Zooming**: Scroll Mouse Wheel (modifies distance $R$ in perspective, or viewport scale in orthographic).
  - **Panning**: Mouse Right-Drag or Shift+Drag (modifies target offset vector $\mathbf{T} = [T_x, T_y, T_z]^T$).
- **Projection Toggles (Dual Matrix Pipelines)**:
  - **Perspective Mode**: Computes standard perspective projection matrix utilizing field-of-view (FOV = 45°) and near/far clipping planes. Best for spatial depth.
  - **Orthographic Mode**: Computes a parallel projection matrix using current zoom scale, ensuring grid lines stay parallel. Perfect for isometric alignment and dimension evaluation.
- **Overlay HUD Toolbar (Default Views & Reset)**:
  An overlay control toolbar will be drawn on top of the canvas, offering:
  - **ISO Preset**: Isometric view showing three sides of the domain (Yaw = 45°, Pitch = 35.26°).
  - **6 Orthogonal Presets**:
    - **Top (XY Plane)**: Yaw = 0°, Pitch = 90° (views down +Z axis)
    - **Bottom (XY Plane)**: Yaw = 0°, Pitch = -90° (views up -Z axis)
    - **Front (XZ Plane)**: Yaw = 0°, Pitch = 0° (views down +Y axis)
    - **Back (XZ Plane)**: Yaw = 180°, Pitch = 0° (views up -Y axis)
    - **Left (YZ Plane)**: Yaw = -90°, Pitch = 0° (views down +X axis)
    - **Right (YZ Plane)**: Yaw = 90°, Pitch = 0° (views up -X axis)
  - **Projection Switcher**: Toggle button between Perspective and Orthographic.
  - **Reset Button**: Immediate transition resetting camera parameters back to default (Perspective, ISO angles, target centered on domain midpoint, zoom reset).
- **Coordinate Orientation Gizmo**:
  A small coordinate axis gizmo (X=Red, Y=Green, Z=Blue arrows) is drawn in the bottom-left corner of the viewport, rotating in real-time to match the camera's current viewing matrix.
- **Properties Sidebar**: Add inputs in the node property panel to:
  - Add/remove slice planes.
  - Set orientation (XY, YZ, XZ) and offset value.
  - Choose plotted variables (pressure, density, velocity, fractions) for each slice.

---

## Verification Plan

### Automated Tests
- **Rhs3DUnitTests**: Build a C++ test framework validating 3D Minmod/WENO3 stencils against analytically calculated gradients.
- **ConservationTests3D**: Run simple 3D shock tube simulations (Sod problem) on CPU and GPU, ensuring total mass and energy are conserved to $10^{-6}$ precision.

### Manual Verification
- Verify that adding, editing, and deleting slice planes in the Telemetry3DViewport updates the active slice configuration sent to the solver.
- Interact with the 3D canvas viewport using mouse drag, scroll, and right-click to confirm smooth camera rotate, zoom, and pan operations.
- Cross-verify 3D center slice values against 2D axisymmetric solver telemetry at identical timestamps to confirm mathematical equivalence.
