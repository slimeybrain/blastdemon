# BlastDaemon Framework: Future Work & Architectural Roadmap

This document serves as the master repository for future architectural initiatives, physics improvements, numerical refinements, and experimental features planned for the BlastDaemon framework.

---

## 1. Advanced MPM Debris Modeling & Granular Physics Strategy

### 1.1 Problem Statement & Background
In the current FEM-to-MPM erosion pipeline ([fem_solver_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_solver_3d.cpp#L2475-L2630)), failed hexahedral solid elements are converted into active Material Point Method (MPM) particles. Under certain blast and fragmentation scenarios, the resulting debris field can exhibit non-physical "glue / slime / blob" continuum fluid behavior rather than behaving as discrete, tumbling, dry gravel fragments:

1. **Eulerian Single-Velocity-Field Cohesion:** Standard MPM maps particle momentum onto a shared background Cartesian grid ([mpm_solver_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.cpp#L597-L612)). Overlapping B-Spline or GIMP kernels (support of 2 to 3 grid cells) force closely spaced particles to follow identical continuous velocity streamlines, generating artificial numerical surface tension and preventing sub-grid inter-particle separation.
2. **Kinematic Birth Averaging:** The element conversion pipeline heavily blends spawned particle velocities toward element and multi-element cluster center-of-mass velocities (60% to 90% blending), filtering out the natural micro-velocity variance of shattered fragments.
3. **Overly Compliant Constitutive Model:** The failed particle constitutive update in [mpm_solver_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.cpp#L1023-L1086) and [mpm_solver_3d_cuda.cu](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d_cuda.cu#L709-L770) utilizes an excessively soft bulk modulus (0.005 * K_intact ~ 75 MPa) and low friction slope (M_friction = 0.30, friction angle phi ~ 17 degrees), causing compressed debris to flow like wet mud or slurry.

---

### 1.2 Proposed Solutions & Architecture

```
                                +--------------------------------------------+
                                | Eroded Solid Hex / Shell / Beam Elements   |
                                +--------------------------------------------+
                                                      |
                                                      v
                   +--------------------------------------------------------------------+
                   | 1. Strain-Energy Ejection & Size Distribution                      |
                   |    - Rosin-Rammler size heterogeneity (1mm dust to 40mm gravel)    |
                   |    - Radial elastic release jitter (v_kick ~ sqrt(2 * U_e / rho))  |
                   +--------------------------------------------------------------------+
                                                      |
                                                      v
                   +--------------------------------------------------------------------+
                   | 2. Configurable Debris Material Regimes                            |
                   |    - Gravel (phi = 42 deg, K ~ 2 GPa, Reynolds Dilatancy)         |
                   |    - Cohesive Spall (c_residual > 0, brittle impact shatter)       |
                   |    - Fine Dust (high aerodynamic drag, low inertia)                |
                   +--------------------------------------------------------------------+
                                                      |
                                                      v
                   +--------------------------------------------------------------------+
                   | 3. Sub-Grid DEM-Lite Repulsion & Boundary Mechanics                |
                   |    - Short-range inter-particle anti-blobbing repulsion            |
                   |    - Inelastic boundary restitution & Coulomb floor friction       |
                   +--------------------------------------------------------------------+
```

---

### 1.3 Key Technical Components

#### A. Debris Constitutive Material Regimes
Introduce explicit debris regime selections to govern failed particle stress integration:

* **Cohesionless Dry Gravel & Crushed Aggregate:**
  - **Frictional Shear Strength:** Mohr-Coulomb / Drucker-Prager friction angle phi = 38° to 48° (M_friction = 1.2 to 1.5).
  - **Volumetric Bulk Modulus:** K_debris = 0.05 to 0.15 * K_intact (1.0 to 3.0 GPa), providing stiff, incompressible grain contact resistance under compression.
  - **Tensile Cutoff:** Strict zero-cohesion in dilation (p_comp = 0 when J >= 1.0).
  - **Reynolds Dilatancy:** Non-associated flow rule incorporating a dilation angle (psi = 5° to 15°) to induce shear-jamming and interlocking in confined granular piles.
* **Cohesive Spall Rubble / Damaged Masonry:**
  - **Residual Cohesion:** Retains residual cohesion (c_residual > 0) with progressive impact softening, allowing fractured chunks to stay bonded during ballistic flight until striking solid boundaries.
* **Aerodynamic Fine Dust & Particulate Sand:**
  - **Low Friction Angle:** phi = 25° to 30° with high specific surface area.
  - Coupled directly to blast CFD gas drag in [fem_fsi_coupler_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_fsi_coupler_3d.cpp#L359-L435) for suspension and atmospheric dispersion.
* **Viscous Slurry / Mud (Saturated Geotechnical Soil):**
  - Retains low bulk stiffness and rate-dependent viscosity for fluid-saturated clay or liquefied sand.

---

#### B. Stochastic Strain-Energy Ejection Dispersion (Birth Jitter)
Replace pure center-of-mass velocity smoothing with an energy-conserving explosive fragment scatter:

* When an element fails under high stress, the stored elastic strain energy density U_e = 0.5 * (sigma : epsilon) is converted into radial kinetic ejection:
  ```
  v_ejection = debris_ejection_jitter * sqrt(2.0 * U_e / rho)
  v_p = v_elem_com + v_ejection * unit_normal_outward
  ```
* **Result:** Individual gravel particles disperse radially outward from ruptured element faces in a realistic explosive spray instead of flying as a single clustered blob.

---

#### C. Heterogeneous Fragment Size Distribution (Rosin-Rammler / Weibull)
Instead of uniform particle radii (h_p), allocate masses and radii according to empirical rock fragmentation distributions:

* Cumulative mass fraction passing size d:
  ```
  P(d) = 1 - exp(-(d / d_50)^n)
  ```
  where `d_50` is the characteristic fragment size (governed by element volume and blast intensity) and `n` is the uniformity index (typically 1.2 to 2.2 for blasted rock).
* **Multi-Scale Blast Aerodynamics:** In [fem_fsi_coupler_3d.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/fem_fsi_coupler_3d.cpp), small dust particles (high area-to-mass ratio) get swept up by aerodynamic drag, while heavy gravel boulders follow ballistic parabolas under gravity.

---

#### D. Sub-Grid DEM-Lite Particle Repulsion (Anti-Blobbing)
To prevent particles in the same Eulerian grid cell from merging into a singular point:

* Introduce a short-range pairwise repulsion force active only when inter-particle distance r is less than (r_p1 + r_p2):
  ```
  f_repulsion = k_grain * (r_contact - r) * r_hat - gamma_grain * v_relative
  ```
* Evaluated via a localized cell spatial hash or within the active MPM grid node neighbor list, ensuring zero dynamic allocations in the solver hot loop.
* **Result:** Maintains discrete grain separation and prevents artificial numerical fluid coalescence.

---

#### E. Granular Ground Impact & Boundary Restitution
Enhance the domain boundary handling in [MPMSolver3D::gridToParticle](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.cpp#L963-L991):

* **Coefficient of Restitution (`debris_restitution` = 0.2 to 0.5):** Inelastic velocity reduction upon ground contact to simulate crushed rock energy dissipation.
* **Tangential Coulomb Friction (`debris_ground_friction` = 0.4 to 0.7):** Tangential sliding resistance allowing stones to tumble, slide, and deposit into realistic debris piles.

---

### 1.4 Planned UI & Parameter Integration

The following parameters are designated for integration into `FEMDomain3D` and `MPMDomain3D` node schemas:

| Parameter Key | UI Label | Type / Default | Engineering Purpose |
| :--- | :--- | :--- | :--- |
| `debris_regime` | Debris Material Regime | Enum (`Gravel`, `Cohesive Spall`, `Dust`, `Slurry`) | Sets core constitutive model and yield envelope for failed material points |
| `debris_friction_angle` | Debris Friction Angle (phi) | Number / Float (42.0 deg) | Granular internal friction angle controlling shear resistance and angle of repose |
| `debris_ejection_jitter` | Ejection Dispersion Jitter | Number / Float [0.0, 1.0] (0.35) | Converts stored elastic strain energy into radial particle ejection scatter |
| `debris_size_spread` | Fragment Size Heterogeneity | Number / Float [0.0, 1.0] (0.50) | Controls Rosin-Rammler variance between large gravel boulders and fine dust |
| `debris_subgrid_repulsion` | Subgrid Grain Repulsion | Boolean (true) | Enables DEM-lite contact repulsion to prevent Eulerian grid-cell blobbing |
| `debris_restitution` | Ground Impact Restitution | Number / Float [0.0, 1.0] (0.30) | Inelastic restitution coefficient for debris-boundary collisions |
| `debris_ground_friction` | Ground Coulomb Friction | Number / Float [0.0, 1.0] (0.60) | Friction coefficient against floor/wall boundaries |

---

## 2. Additional Future Architecture & Modeling Initiatives

### 2.1 Adaptive Temporal Sub-Stepping for Multi-Scale FSI
* Dynamic sub-cycling of explicit MPM and FEM solvers within CFD hydrodynamic macro-steps to optimize GPU throughput during high-pressure detonation peaks.

### 2.2 Rebar Debonding & Pull-Out Friction Law
* Advanced slip-friction interface elements between embedded steel rebar trusses/beams and concrete hex elements, replacing ideal tied bonding with nonlinear pull-out force-displacement curves.

### 2.3 Non-Reflecting Perfectly Matched Layers (PML) for 3D Elastic Substrates
* Second-order absorbing boundary conditions for semi-infinite geotechnical soil domains to prevent unphysical acoustic wave reflection during underground blasts.

---

## 3. Large-Scale Model Decomposition & Distributed Architecture Roadmap

### 3.1 Problem Statement & Scaling Objectives
As simulation models grow to high resolutions (e.g. hundreds of millions of Eulerian CFD cells, fine-scale 3D structural FEM shells, and dense MPM debris fields), global model state requirements can exceed the VRAM capacity of a single discrete GPU (16–24 GB consumer, 48–80 GB datacenter). 

To support arbitrarily large blast models while adhering to BlastDemon's **Zero-Dependency Mandate** (pure C++20 standard library, raw POSIX sockets, raw CUDA, and HDF5 C API), the framework must support a multi-tiered scaling strategy.

```
+----------------------------------------------------------------------------------------------------+
|                                 BLASTDEMON SCALING PARADIGMS                                       |
+------------------------------------+-----------------------------------+---------------------------+
| 1. Out-of-Core Host Streaming      | 2. Single-Node Multi-GPU          | 3. Distributed Clusters   |
| (1 GPU, Model in Host RAM)         | (2-8 GPUs, Direct NVLink/P2P)     | (Multi-Node GPU / CPU)    |
| - Brick decomposition              | - Zero-host-bounce P2P halos      | - Raw POSIX network sync  |
| - Double-buffered async streams    | - 1D slab or 3D block partition   | - Interior/halo overlap   |
| - Space-time skewing for PCIe      | - Unified P2P event sync          | - Multi-TB aggregate RAM  |
+------------------------------------+-----------------------------------+---------------------------+
| 4. Heterogeneous Execution: GPU Shock Hydrodynamics + CPU Structural FEM / Non-linear Contact     |
+----------------------------------------------------------------------------------------------------+
```

---

### 3.2 Single-GPU Out-of-Core Execution (Host RAM Streaming)

* **Architecture:** Global simulation domain resides in host system RAM (128 GB to 1+ TB). GPU VRAM is utilized as an active compute cache executing over sub-blocks/tiles.
* **Eulerian CFD Tiling:**
  - Decompose 3D domain into uniform bricks (`Nx × Ny × Nz`) with a ghost cell halo (2 cells for 2nd-order MUSCL/ADER-2, 3 cells for ADER-3).
  - Use dual CUDA streams with double-buffering: Stream 1 executes compute kernels on Tile `K`, while Stream 2 asynchronously transfers updated Tile `K-1` back to host (`D2H`) and streams Tile `K+1` with ghost padding to device (`H2D`).
  - **Space-Time Tiling (Time-Skewing):** To overcome PCIe memory bandwidth bottlenecks (~31.5 GB/s on PCIe 4.0 vs ~1 TB/s VRAM), each tile is advanced by `M` time steps per streaming pass using an expanded ghost halo of width `M × stencil_radius`, amortizing host-device transfer latencies.
* **Lagrangian FEM & MPM:**
  - FEM: Sub-mesh graph partitioning (METIS-style or spatial bounding); element internal forces computed per chunk and accumulated into global host node buffers.
  - MPM: Host-side spatial binning/sorting of material points before streaming sub-grid blocks and local particles to device.

---

### 3.3 Single-Node Multi-GPU Parallelism (NVLink / Direct P2P)

* **Architecture:** Distribute the simulation across 2 to 8 local GPUs within a single workstation or server node.
* **Direct Peer-to-Peer Halo Exchanges:**
  - Eliminate Host RAM bouncing by establishing direct GPU-to-GPU peer transfers via `cudaDeviceEnablePeerAccess` and `cudaMemcpyPeerAsync`.
  - Zero external communications libraries required (no NCCL/MPI dependency), fully compliant with Master Directives.
* **Domain Decomposition Strategy:**
  - **1D Slab (Z-Slicing):** Memory-contiguous slices across GPUs for 2–4 card configurations.
  - **3D Brick Decomposition:** Minimizes surface-to-volume communication ratios for 4–8+ GPU setups.
* **Execution Pipeline per Time Step:**
  1. Launch asynchronous interior domain update kernels on GPU stream 0.
  2. Asynchronously pack and stream halo boundary slices directly to adjacent peer GPUs via stream 1.
  3. Synchronize halo boundaries and compute interface flux reconstructions.
  4. Perform 2nd-order temporal updates (ADER-2 / SSP-RK2 / symplectic leapfrog).

---

### 3.4 Multi-Node Distributed Systems (Multi-GPU & Pure CPU)

* **Multi-Node Multi-GPU Clusters:**
  - Combines on-node multi-GPU P2P streams with inter-node network communications.
  - **Zero-Dependency Inter-Node Messaging:** Uses non-blocking POSIX sockets (`<sys/socket.h>`) with pre-pinned page-locked halo buffers, or an optional isolated MPI backend wrapper.
  - **Communication-Computation Overlap:** Global interior cells (~85–90% of workload) advance concurrently while asynchronous non-blocking network calls exchange subdomain boundary faces.
* **Multi-Node Pure CPU:**
  - Uses C++20 `std::jthread` thread pools and SIMD vectorization (AVX-512 / AVX2) across multi-socket CPU nodes.
  - Enables execution of massive models constrained only by cluster system RAM (terabytes to tens of terabytes) without VRAM limits or PCIe transfer bottlenecks.

---

### 3.5 Heterogeneous Hardware Partitioning (GPU + CPU Co-Processing)

* **Multi-Physics Separation (FSI Coupling):**
  - **GPU:** Dedicated to the high-order Eulerian Cartesian shock hydrodynamics grid and active MPM debris field (maximizing SIMD warp throughput and memory bandwidth).
  - **CPU:** Dedicated to irregular Lagrangian FEM structural elements, non-linear shell contact search trees, failure erosion logic, and rebar debonding.
  - **Coupling Boundary:** Only fluid-structure interface surface loads and immersed boundary velocity points are exchanged across the host-device boundary during FSI sub-cycling.
* **Asynchronous Telemetry & Disk I/O:**
  - CPU worker threads manage telemetry packaging, probe interpolation, and heavy XDMF + HDF5 volumetric disk writes concurrently in the background, preventing GPU pipeline stalls.

---

## 4. Multi-Scale Explosive Detonation & High-Expansion Hydrocode Strategy

### 4.1 Problem Statement & Background
When modeling high-energy explosive detonations (such as TNT, PETN, or RDX governed by the Jones-Wilkins-Lee (JWL) Equation of State), the material undergoes extreme physical state transitions:
1. **Initial High-Density Condensed Phase:** Solid explosive density rho_0 ~ 1500 to 1800 kg/m^3 under Chapman-Jouguet detonation pressures (P_CJ ~ 20 to 40 GPa).
2. **Intermediate Rapid Expansion:** High-pressure gas products expand rapidly, reducing density by 10x to 50x (rho ~ 30 to 150 kg/m^3) while accelerating casing metal or surrounding concrete structures.
3. **Deep Far-Field Gaseous Phase:** Detonation products disperse across multiple orders of magnitude of volume into ambient air (rho < 30 kg/m^3 down to rho_air ~ 1.2 kg/m^3).

In standard Material Point Method (MPM), treating expanding materials with single point-mass particles or fixed-size kernels leads to severe numerical failure modes:
* **Particle Starvation & Grid-Crossing Voids:** As particles move apart, cells become empty, breaking continuum stress gradients and generating artificial numerical cavitation.
* **Stencil Explosion from Over-Sized Domains:** Letting single particle domains stretch across dozens of grid cells degrades spatial resolution and severely degrades GPU neighbor-search performance.
* **Particle Count Explosion:** Splitting particles endlessly into the far-field gas phase causes exponential particle count growth, exhausting GPU VRAM.

---

### 4.2 The Tri-Phase Multi-Scale Architecture

To simulate the entire physical lifecycle accurately and efficiently, the framework adopts a unified tri-phase progression combining **Convected Particle Domain Interpolation (CPDI)**, **Adaptive Octree Particle Splitting**, and **Lagrangian-to-Eulerian Fluid Hand-off**:

```
[ Phase 1: Detonation & Early Expansion ]
- Density: ~1500 down to ~400 kg/m^3 (J = 1.0 to ~4.0)
- Mechanism: CPDI / Deforming Particle Domains
- Action: Track continuous volumetric expansion with deformation gradient F_p.
          Zero grid-crossing noise, continuous domain contact, no artificial cavitation.

                     │  (Particle radius exceeds ~1.2 * cell_size dx_g)
                     ▼

[ Phase 2: Intermediate Expansion & Casing Acceleration ]
- Density: ~400 down to ~30 kg/m^3 (J = ~4.0 to ~50.0)
- Mechanism: Adaptive Octree Particle Splitting
- Action: Parent particle splits into 8 child particles (3D) or 4 child particles (2D).
          Strict conservation of mass, momentum, internal energy, and stress state.
          Maintains 4 to 16 Particles-Per-Cell (PPC) for sharp pressure gradient capture.

                     │  (Density drops below rho_handoff, e.g., < 30 kg/m^3)
                     ▼

[ Phase 3: Far-Field Blast Wave & Atmospheric Dispersion ]
- Density: < 30 kg/m^3 down to ambient air density ~1.2 kg/m^3 (J > 50.0)
- Mechanism: Lagrangian-to-Eulerian Fluid Hand-off
- Action: Conservative deposition of particle mass, momentum, and JWL energy into Eulerian CFD grid.
          Particles are pruned/recycled into pre-allocated memory pools.
          High-order shock-capturing CFD (ADER-2 / TVD) propagates long-range atmospheric blast waves.
```

---

### 4.3 Heterogeneous & Material-Selective Transfer Schemes

To maximize GPU performance and avoid numerical instabilities, transfer schemes are assigned **per-material table / object** rather than globally:

* **Mathematical Validity (Partition of Unity):** Because particle-to-grid (P2G) and grid-to-particle (G2P) mappings are evaluated independently per particle p, any combination of CPDI, GIMP, and B-Spline particles can coexist on the same background grid while guaranteeing exact global conservation of mass, linear momentum, and angular momentum:
  ```
  sum_i N_ip = 1.0  (for all nodes i surrounding particle p)
  ```
* **Targeted Compute Efficiency:** CPDI carries higher arithmetic and memory bandwidth cost (~2.5x to 4x baseline) due to polyhedron vertex convection and gradient volume integrals. Applying CPDI strictly to the expanding explosive (5-15% of total particles) while using ultra-fast B-Splines / GIMP for structural solids (85-95% of particles) yields full anti-cavitation benefits with minimal computational overhead.
* **Elimination of Shear Domain Tangling in Solids:** Under severe plastic shear localization or brittle fracture, CPDI polyhedron corners in solid metals or concrete can distort into needle-like or self-intersecting geometries. Using B-Splines or standard GIMP for solid structures prevents domain tangling while CPDI cleanly handles pure volumetric gas expansion.

#### Material Transfer Scheme Selection Matrix

| Material Type | Primary Deformation Mode | Recommended Transfer Scheme | Engineering Rationale |
| :--- | :--- | :--- | :--- |
| **Explosives (JWL / High-P Gas)** | Extreme Volumetric Expansion | **CPDI** (+ Adaptive Splitting) | Keeps expanding gaseous core continuous; prevents artificial cavitation voids. |
| **Metals (Johnson-Cook / Steel)** | High Shear, Moderate Dilatation | **Quadratic B-Splines** or **GIMP** | High-speed throughput, robust against shear distortion, zero grid-crossing noise. |
| **Concrete / Brittle Rocks (RHT, K&C)** | Shear Failure, Tensile Cracking | **Quadratic B-Splines** | Smooth gradient evaluation for crack-band damage models without mesh bias. |
| **Eroded Debris / Granular Gravel** | Bulk Flow, Sliding, Separation | **Standard APIC / GIMP** | Prevents artificial numerical tensile cohesion between separated gravel grains. |

---

### 4.4 Technical Formulations & Conservation Rules

#### A. CPDI Deforming Polyhedron Kinematics
* In 3D, each particle domain is represented by an 8-node hexahedron whose corner vertices r_c(t) track the continuous continuum deformation:
  ```
  r_c(t) = x_p(t) + F_p * r_c(0)
  ```
* Volume and density evolve consistently:
  ```
  V_p = det(F_p) * V_p0
  rho_p = rho_p0 / det(F_p)
  ```
* Stress divergence forces are integrated over the deforming polyhedron domain before projecting to background grid nodes, guaranteeing smooth C1-like nodal force transitions.

#### B. Octree Particle Splitting & Conservation
* **Trigger Threshold:** Evaluated after the grid-to-particle stage:
  ```
  effective_radius = (V_p)^(1/3) > alpha_split * dx_grid  (typically alpha_split = 1.0 to 1.25)
  ```
* **Octree Child Properties (3D):**
  * Mass & Volume: `m_child = m_parent / 8`, `V0_child = V0_parent / 8`, `lp_child = lp_parent / 2`
  * Spatial Positioning: Children are placed at the 8 sub-octant centroids of the parent deforming domain.
  * Velocity & APIC Tensor: `v_child = v_parent + B_parent * delta_x_child`
  * State History: Children inherit specific internal energy `e_int`, temperature, plastic strain, and deformation gradient `F_p`, preserving total kinetic and internal energy.

#### C. Conservative Eulerian CFD Hand-off
* **Trigger Threshold:**
  ```
  rho_p < rho_handoff_threshold  (e.g., 30.0 kg/m^3)  OR  det(F_p) > J_handoff_threshold (e.g., 50.0)
  ```
* **Deposition Pipeline:**
  * Deposit particle mass, momentum, and JWL total energy into overlapping Eulerian CFD cells using standard shape weights `N_cell(x_p)`.
  * Update multi-material gas volume fractions and fluid conservative variables (`rho`, `rho * u`, `E_total`).
  * Remove converted particles from the active MPM particle buffer and return indices to a pre-allocated GPU free-slot stack, capping peak VRAM consumption.

---

### 4.5 Planned UI & Parameter Integration

The following parameters are designated for integration into the `MPMDomain3D`, `MaterialTable3D`, and `FSICoupler3D` node schemas:

| Parameter Key | UI Label | Type / Default | Engineering Purpose |
| :--- | :--- | :--- | :--- |
| `transfer_scheme` | Particle Transfer Scheme | Enum (`BSpline`, `GIMP`, `CPDI`, `Standard`) | Sets per-material interpolation and domain tracking kernel. |
| `enable_particle_splitting` | Adaptive Particle Splitting | Boolean (`true`) | Enables dynamic octree refinement when particle volume exceeds grid size. |
| `split_size_ratio` | Splitting Size Threshold | Number / Float (`1.20`) | Ratio of particle effective radius to grid cell size `dx` triggering a split. |
| `max_split_generations` | Max Splitting Generations | Integer (`2`) | Caps maximum refinement depth per initial particle to prevent VRAM overflow. |
| `enable_cfd_handoff` | Eulerian CFD Hand-off | Boolean (`true`) | Automatically transitions over-expanded gas particles into Eulerian CFD cells. |
| `handoff_density_cutoff` | Hand-off Density Cutoff | Number / Float (`30.0 kg/m^3`) | Density threshold below which particles are converted to Eulerian fluid. |
| `handoff_j_cutoff` | Hand-off Volume Ratio (J) | Number / Float (`50.0`) | Volumetric expansion ratio triggering immediate transfer to Eulerian CFD. |

---

## 5. Debris & Fragment Aerodynamics in Void / Low-Density Cavities (Anti-Flicker Strategy)

### 5.1 Problem Statement & Numerical Mechanisms
When high-velocity FEM structural fragments and eroded MPM debris fly through low-pressure, low-density, or void/cavity regions (such as post-detonation expansion zones, structural breach voids, or interior vacuum pockets), a severe visual and physical flickering of the surrounding Eulerian pressure field is observed. 

This numerical artifact stems from four interrelated physical and algorithmic mechanisms:

```
+---------------------------------------------------------------------------------------------------------+
|                        Debris & Fragment Flight in Low-Density / Cavity Regions                         |
+---------------------------------------------------------------------------------------------------------+
       |                                |                               |                        |
       v                                v                               v                        v
+------------------+     +-------------------------------+     +--------------------+   +--------------------+
| 1. Voxelization  |     | 2. Rarefaction Wake Clamping  |     | 3. EOS Sensitivity |   | 4. IBM Stencil     |
|    Shocks        |     |    - Severe suction wake      |     |    in Near-Vacuum  |   |    Starvation      |
| - Binary mask    |     |    - p drops below zero       |     | - p = (γ-1)(E-KE)  |   | - Donor clipping   |
|   jumping        |     |    - Floor clamp oscillation  |     | - Δp / p >> 100%   |   |   near walls/voids |
+------------------+     +-------------------------------+     +--------------------+   +--------------------+
```

1. **Binary Staircase Grid-Crossing Transients (Voxelization Shocks):**
   * Solid boundaries are currently rasterized onto the Cartesian finite-volume grid using a binary occupancy mask (`solid_mask = 1` or `0`).
   * As fragments travel across the mesh at velocity `v`, cells transition discontinuously between 100% fluid and 100% solid at the grid-crossing frequency `f_cross = v / Δx`.
   * Covering abruptly blocks Eulerian fluxes; uncovering triggers instantaneous Inverse Distance Weighting (IDW) extrapolation from neighbors. In low-density void regions with minimal acoustic damping, these step discontinuities radiate spurious high-frequency acoustic wavelets.

2. **Extreme Rarefaction Wakes & Pressure Floor Bouncing:**
   * High-speed projectile motion through a cavity induces an extreme expansion/suction fan in the trailing wake.
   * In low-density pockets where ambient pressure `p_ambient` is already near zero, the Eulerian expansion flux attempts to drive cell pressure below zero.
   * The solver clips pressure to the numerical floor (`p_floor = 1e-7 Pa`). In subsequent substeps, numerical diffusion or neighbor IDW extrapolation injects minute amounts of energy, lifting `p` above the floor before the next expansion step drops it back. This limit-cycle alternation manifests as a stroboscopic checkerboard flicker in the wake.

3. **Hyper-Sensitivity of the Conservative Equation of State in Low-Density Media:**
   * Primitive pressure is derived from total conservative energy `E` and momentum `ρ·u`:
     ```text
     p = (γ - 1) · [ E - 0.5 · ρ · (ux² + uy² + uz²) ]
     ```
   * When `ρ → 0`, both `E` and kinetic energy `0.5 · ρ · |u|²` are extremely small numbers.
   * A trivial truncation error (e.g. `10⁻⁵ J/m³`) that is utterly negligible in ambient air produces a relative pressure fluctuation `Δp / p >> 100%` in near-vacuum zones, visually dominating dynamic pressure colormaps.

4. **Immersed Boundary (IBM) Stencil Starvation & Half-Space Switching:**
   * Ghost-cell velocity reflections (`u_refl = vw + u_rel - 2·(u_rel·n)·n`) and pressure reconstructions require sampling fluid donor cells in the outward surface normal direction `n`.
   * In tight cavities, structural breaches, or dense debris swarms, neighboring solid bodies clip donor sample points. As the fragment moves, available donor sets alternate abruptly between 1, 2, or 3 cells, feeding oscillating reflective wall fluxes back into the fluid.

#### Comparison of Mechanisms & Symptoms

| Mechanism | Primary Trigger Condition | Numerical Consequence | Visual & Physical Manifestation |
| :--- | :--- | :--- | :--- |
| **Voxelization Shocks** | Fast fragment crossing grid lines `Δx` | Discontinuous boundary state insertion | High-frequency halo flickering around fragments |
| **Rarefaction Clamping** | Supersonic suction wake in void cavity | Alternation between `p_floor` and neighbor diffusion | Stroboscopic flashing in trailing wake |
| **Conservative EOS Error** | Low fluid density (`ρ < 10⁻³ kg/m³`) | Magnified relative pressure errors (`Δp / p`) | High-contrast noise in near-vacuum zones |
| **Stencil Starvation** | Proximity to structural walls/debris | Jumps in IDW donor cell availability | Asymmetric, erratic pressure bursts on surfaces |

---

### 5.2 Proposed Architecture & Anti-Flicker Pipeline

```
+----------------------------------------------------------------------------------------------------+
|                                    Anti-Flicker FSI Pipeline                                       |
+----------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
| 1. Scale-Aware Entity Classification                                                               |
|    - If Fragment Size < 1.0 Δx  --> Sub-Grid PIC / Drag Source Coupling (Zero Cell Masking)        |
|    - If Fragment Size >= 1.0 Δx --> Continuous Cut-Cell Immersed Boundary (Volume Fraction α_f)    |
+----------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
| 2. Dual-Energy / Internal-Energy Equation in Low-Density Regimes                                   |
|    - If ρ < ρ_vacuum_thresh --> Solve de/dt = -p/ρ (∇·u) directly (Bypasses E - KE subtraction)   |
|    - Guaranteed monotonic, non-oscillatory positive pressure evaluation                            |
+----------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
| 3. Temporal Relaxation on Uncovered Cell Genesis                                                   |
|    - Smooth exponential blend over N_relax substeps: U(t+Δt) = (1-β)·U_extrap + β·U_prev           |
|    - Eliminates impulse pressure shocks during cell uncovering                                     |
+----------------------------------------------------------------------------------------------------+
```

---

### 5.3 Key Technical Components & Formulations

#### A. Continuous Cut-Cell Fluid Volume Fractions (Smooth IBM)
* Replace binary integer masking (`solid_mask ∈ {0, 1}`) with a continuous volume-of-fluid fraction `α_fluid ∈ [0.0, 1.0]`.
* Numerical fluxes at cell interfaces scale proportionally with the open fluid aperture area fraction `A_face`:
  ```text
  Flux_effective = A_face · Flux_fluid + (1 - A_face) · Flux_wall_reflection
  ```
* As a fragment enters or leaves a cell, `α_fluid` evolves smoothly over time, replacing abrupt step discontinuities with continuous C0/C1 flux ramps.

#### B. Sub-Grid Momentum Source Exchange for MPM Debris Particles
* Sub-grid debris particles (effective diameter `< Δx`) should **not** block Eulerian fluid cells or trigger solid wall reflections.
* Instead, couple sub-grid debris via two-way Particle-In-Cell (PIC) momentum/drag source terms:
  ```text
  F_drag = 0.5 · Cd · ρ_fluid · A_proj · |u_fluid - v_particle| · (u_fluid - v_particle)
  ```
* Distribute `-F_drag` to adjacent Eulerian CFD cell momentum buffers and `+F_drag` to the MPM particle velocity. Eulerian cells remain 100% fluid, completely eliminating covering/uncovering transients for small flying fragments.

#### C. Dual-Energy / Internal Energy Formulation in Near-Vacuum Regimes
* To prevent catastrophic loss of significance in low-density cells (`ρ < ρ_dual_thresh`, e.g. `10⁻² kg/m³`), maintain an auxiliary internal energy density `e_int`:
  ```text
  ∂(ρ e_int)/∂t + ∇·(ρ e_int u) = -p (∇·u)
  ```
* In void and expansion cells, compute pressure directly from internal energy:
  ```text
  p = (γ - 1) · ρ · e_int
  ```
  This eliminates total energy subtraction noise (`E - 0.5 ρ |u|²`) and guarantees strictly positive, flicker-free pressure even in deep rarefaction wakes.

#### D. Multi-Step Temporal Hysteresis for Uncovered Cell Genesis
* When a cell transitions from solid to fluid (`α_fluid` increases), initialize the newly exposed fluid state through exponential relaxation over `N_relax` substeps rather than an instantaneous single-step IDW overwrite:
  ```text
  U_cell(t + Δt) = (1 - β) · U_extrapolated + β · U_cell(t)
  ```
  where `β = exp(-Δt / τ_relax)` and `τ_relax ~ 3 · Δt`. This dissipates acoustic initialization spikes and eliminates halo flickering.

---

### 5.4 Planned UI & Parameter Integration

The following parameters are designated for integration into the `CFDSolver3D` and `FSICoupler3D` node configuration schemas:

| Parameter Key | UI Label | Type / Default | Engineering Purpose |
| :--- | :--- | :--- | :--- |
| `fsi_coupling_mode` | FSI Immersed Boundary Mode | Enum (`SmoothCutCell`, `BinaryMask`, `SubGridDragOnly`) | Selects between continuous volume fraction aperture and legacy binary masking. |
| `subgrid_debris_cutoff` | Sub-Grid Debris Size Ratio | Number / Float (`1.0`) | Particles with `diameter < ratio * dx` use point-drag coupling instead of cell masking. |
| `enable_dual_energy` | Vacuum Dual-Energy Formulation | Boolean (`true`) | Activates direct internal energy tracking in low-density zones to prevent EOS noise. |
| `vacuum_density_threshold` | Vacuum Density Threshold | Number / Float (`0.01 kg/m^3`) | Fluid density threshold below which the dual-energy pressure formulation is engaged. |
| `uncovering_relaxation_steps`| Cell Uncovering Relaxation Steps | Integer (`4`) | Number of temporal substeps over which freshly uncovered fluid cells blend to equilibrium. |

---

## 6. Underwater Shock (UNDEX) Hydrodynamics, DAA, Explicit Shells, & Similitude Architecture

### 6.1 Problem Statement & Physics Landscape

Underwater shock (UNDEX) interaction with naval hulls and submerged structures presents a complex, multi-scale physical challenge:
1. **High Impedance & Shock Compressibility:** Water exhibits high acoustic impedance (`ρ_0 · c_0 ≈ 1.5 × 10⁶ kg/(m²·s)`) and non-linear shock compressibility under GPa-level pressures, requiring stiffened liquid equations of state (Modified Tait, Stiffened Gas, Mie-Grüneisen).
2. **Bulk and Hull Cavitation:** Tensile rarefaction waves from free-surface reflections or rapidly accelerating wet hull plates drop fluid pressure to vapor pressure (`p_vapor ≈ 2.3 kPa`), creating cavitation pockets that subsequently collapse and deliver destructive secondary reload water-hammer shocks.
3. **Gas Bubble Dynamics & Jetting:** High-pressure detonation product bubbles undergo multi-cycle expansion and contraction (Rayleigh-Plesset dynamics), migrating under buoyancy and boundaries to generate secondary bubble pulses and high-speed axial water jets.
4. **Thin-Walled Structural Kinematics:** Submarine pressure hulls, surface ship hulls, and internal bulkheads are thin-walled structures requiring 4-node explicit shell elements with through-thickness elastoplasticity and large-rotation co-rotational kinematics.

---

### 6.2 The Dual-Fidelity UNDEX Architecture

BlastDaemon provides a unified dual-fidelity architecture allowing users to run the exact same structural model through either ultra-fast boundary-integral DAA methods or fully coupled 3D multi-material Eulerian CFD:

```
+----------------------------------------------------------------------------------------------------+
|                                  BLASTDAEMON UNDEX PLATFORM                                        |
+-------------------------------------------------+--------------------------------------------------+
|      Fast Boundary-Integral DAA Module          |      High-Fidelity 3D Multi-Material CFD/FSI    |
|           (Zero Fluid Volume Mesh)              |               (3D Eulerian Grid)                 |
+-------------------------------------------------+--------------------------------------------------+
| - Wet surface boundary integrals                | - 3D Navier-Stokes with Stiffened Gas / Tait EOS |
| - DAA1, DAA2, DAA-C, & Local Curved DAA         | - Multi-phase cavitation (HEM / Isobaric Cutoff) |
| - Incident wave from Cole Similitude engine     | - Captures non-spherical bubble jetting & plume  |
| - > 100x speedup for far/medium standoff        | - Captures direct gas-hull contact & impact      |
| - Ideal for rapid DOE / Monte Carlo / Surrogates| - Full wave diffraction and free-surface physics |
+-------------------------------------------------+--------------------------------------------------+
                                                  |
                                                  v
                      +---------------------------------------------------------+
                      |         Unified FEM Structural Shell / Solid Solver     |
                      |            (Belytschko-Lin-Tsay 4-Node Shells)          |
                      |          (Plasticity, Buckling, Tearing, Erosion)       |
                      +---------------------------------------------------------+
```

---

### 6.3 Doubly Asymptotic Approximation (DAA) Hierarchy & Formulations

DAA bridges the high-frequency acoustic radiation damping limit (Plane Wave Approximation) and the low-frequency virtual fluid added-mass limit without discretizing fluid volume meshes.

#### A. DAA1 (First-Order DAA — Geers 1971)
First-order differential equation in time for scattered pressure `p_s`:
```text
M_f · p_dot_s + ρ_0 · c_0 · A_f · p_s = ρ_0 · c_0 · M_f · u_dot_rel
```
* **Early Time (`t → 0`, `ω → ∞`):** Asymptotes to `p_s = ρ_0 · c_0 · u_dot_rel` (Plane Wave Approximation).
* **Late Time (`t → ∞`, `ω → 0`):** Asymptotes to `A_f · p_s = M_f · u_ddot_structure` (Incompressible Added Mass).
* **Characteristics:** Unconditionally stable, 1st-order state variable; slightly overdamps intermediate-frequency bending modes.

#### B. DAA2 (Second-Order DAA — Geers 1978, Felippa & Geers 1980)
Second-order differential equation matching both values and slopes of acoustic impedance:
```text
M_f · p_ddot_s + C_f · p_dot_s + K_f · p_s = ρ_0 · c_0 · (M_f · u_ddot_rel + Ω_f · M_f · u_dot_rel)
```
where `C_f = ρ_0 · c_0 · A_f + Ω_f · M_f` and `K_f = ρ_0 · c_0 · Ω_f · A_f`.
* **DAA2c (Curvature-Matched):** Uses local surface curvature to tune `Ω_f`, incorporating spherical/cylindrical radiation damping.
* **DAA2m (Modal):** Diagonalizes fluid matrices in the structural modal basis for exact low-to-mid frequency mode matching.

#### C. DAA-C (Cavitating Fluid DAA — Geers & DeRuntz 1982 / USA Code)
Extends DAA to account for Taylor hull cavitation at the wet surface:
1. **Cavitation Inception:** If total pressure `p_total = p_inc + p_s < p_cav`, clamp `p_total = p_cav` (vapor pressure).
2. **Gap Tracking:** Integrate cavitation gap kinematics `δ_ddot_cav = a_fluid - a_structure`.
3. **Closure Impact:** When `δ_cav → 0`, deliver a water-hammer reload impulse `p_reload = ρ_0 · c_0 · (v_fluid - v_structure)`.

#### D. Local Curved DAA (Curved Wave Approximation — CWA)
Replaces dense global Boundary Element Method (BEM) matrices `M_f` with local facet curvature:
```text
M_local ≈ ρ_0 / (κ_1 + κ_2)
p_s + (M_local / (ρ_0 · c_0)) · p_dot_s = M_local · u_dot_rel
```
* **Massive Parallelism:** **`O(N)` computational complexity** with zero global linear matrix solves; evaluates directly on GPU threads.

#### DAA Formulations Comparison

| Formulation | ODE Order | Matrix Complexity | Intermediate Frequencies | Cavitation Support | GPU Parallelism |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Plane Wave (PWA)** | `0` (Algebraic) | Diagonal | Poor (Zero added mass) | No | Instantaneous (`O(N)`) |
| **DAA1** | `1st` order | Dense `N × N` (BEM) | Over-damped | No | Moderate (`O(N²)` solve) |
| **DAA2 (DAA2c/m)** | `2nd` order | Dense `N × N` (BEM) | Highly accurate | No | Moderate (`O(N²)` solve) |
| **DAA-C** | `1st` / `2nd` | Dense + Gap array | Accurate + Reload shock | **Yes** (Taylor gap) | Moderate |
| **Local Curved DAA** | `1st` / `2nd` | **Diagonal (`O(N)`)** | Accurate for convex bodies | **Yes** (per-facet gap) | **Massive Parallel (`O(N)`)** |

---

### 6.4 Explicit 4-Node Co-Rotational Shell Elements (Belytschko-Lin-Tsay)

Thin-walled submarine pressure hulls, ship bulkheads, and stiffened panels require computationally efficient 4-node explicit shell elements:
* **Co-Rotational Local Frame:** An element-embedded orthonormal coordinate system rotates with the rigid-body motion, decoupling non-linear rotations from strain calculations.
* **Mindlin-Reissner Plate Kinematics:** Incorporates transverse shear strain deformation for thick and thin shell regimes.
* **6 Degrees of Freedom per Node:** 3 translational `(u, v, w)` and 3 rotational `(θ_x, θ_y, θ_z)` DOFs with drilling stiffness stabilization.
* **Through-Thickness Integration:** 3 to 5 Lobatto integration points across shell thickness for elastoplastic return mapping (von Mises, Johnson-Cook, Cowper-Symonds rate effects).
* **Hourglass Control:** Flanagan-Belytschko / Belytschko-Bindeman shell perturbation hourglass stiffness.
* **Symplectic Time Integration:** Advances translational and rotational accelerations via 2nd-order symplectic central difference (`O(dt²)`).

---

### 6.5 UNDEX Similitude & Empirical Cole Scaling Laws

#### 1. Hopkinson-Cranz Scaling Invariants
For explosive mass `W` (kg TNT) and standoff `R` (m), scaling factor `λ = (W_model / W_prototype)^(1/3)`:
* Geometric Distance: `λ_R = λ`
* Time & Decay Constant: `λ_t = λ`
* Peak Pressure & Material Stress: `λ_P = λ_σ = 1` (Invariant)
* Particle Velocity & Sound Speed: `λ_v = 1` (Invariant)
* Acceleration & Strain Rate: `λ_a = λ_eps_dot = 1 / λ`
* Specific Impulse: `λ_I = λ`

#### 2. Cole Empirical Shock Wave Equations
Incident spherical shock pressure profile:
```text
p_inc(t) = P_max · exp(-(t - t_0) / θ)     for t_0 ≤ t ≤ t_0 + θ
```
* **Peak Pressure:** `P_max = K_p · (W^(1/3) / R)^α_p` (MPa)
* **Decay Constant:** `θ = K_θ · W^(1/3) · (W^(1/3) / R)^α_θ` (ms)
* **Specific Impulse:** `I = K_i · W^(1/3) · (W^(1/3) / R)^α_i` (kPa·s)
* **Energy Flux:** `E_shock = K_e · W^(1/3) · (W^(1/3) / R)^α_e` (kJ/m²)

| Explosive Type | `K_p` (MPa) | `α_p` | `K_θ` (ms) | `α_θ` | `K_i` (kPa·s) | `α_i` | `K_e` (kJ/m²) | `α_e` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TNT** | `52.4` | `1.13` | `0.084` | `-0.23` | `5.75` | `0.89` | `84.4` | `2.04` |
| **Pentolite (50/50)** | `56.1` | `1.14` | `0.084` | `-0.22` | `6.52` | `0.91` | `100.2` | `2.06` |
| **Composition B** | `53.4` | `1.13` | `0.092` | `-0.24` | `6.11` | `0.91` | `95.8` | `2.05` |
| **HBX-1** | `53.5` | `1.14` | `0.106` | `-0.28` | `7.15` | `0.86` | `111.0` | `2.03` |

#### 3. Willis Gas Bubble Scaling Laws
* **Maximum First Bubble Radius (Willis):** `R_max = K_r · (W / (d + 10.3))^(1/3)` (m) *(where `d` is depth in meters; `K_r = 3.36` for TNT)*
* **First Bubble Pulsation Period (Rayleigh-Willis):** `T_bubble = K_t · W^(1/3) / (d + 10.3)^(5/6)` (s) *(where `K_t = 2.11` for TNT)*

---

### 6.6 Verification & Validation (V&V) Benchmarks

1. **Taylor Flat Plate Benchmark (1D Acoustic Shock on Submerged Plate):**
   * Analytical solution: `v_plate(t) = (2 · P_max) / (ρ_0 · c_0) · [exp(-t / θ) - exp(-t / t_c)] / (1 - t_c / θ)`.
   * Validates DAA radiation damping, acoustic impedance matching, and high-fidelity CFD FSI.
2. **Bleich-Sandler Submerged Floating Plate with Cavitation:**
   * Benchmark for cavitation inception, structural decoupling, and cavitation closure reload water-hammer shock.
3. **Huang / Geers Submerged Elastic Spherical Shell (1969/1971):**
   * Closed-form Legendre polynomial modal series solution for submerged spherical shell subjected to an incident step/exponential shock wave.
4. **Kwon & Fox Submerged Cylindrical Shell UNDEX Benchmark (1993):**
   * Air-backed, submerged thin-walled aluminum cylinder (Al 6061-T6, `OD = 0.305 m`, `t = 6.35 mm`, `L = 1.067 m`) under side-on explosive standoff blast.
   * Validates shell element dynamic ovalization modes, circumferential strain histories at 0°, 90°, and 180° generators, and compares DAA boundary loading directly against coupled 3D CFD/FSI.
5. **Ring-Stiffened Submarine Hull Section:**
   * Validates shell-to-beam / shell-to-solid stiffener connections under near-field bubble pulsation and standoff shock loading.

---

### 6.7 Planned UI Nodes & Parameter Integration

| Parameter Key | UI Label | Type / Default | Engineering Purpose |
| :--- | :--- | :--- | :--- |
| `undex_coupling_method` | UNDEX Method | Enum (`LocalCurvedDAA`, `DAA1_BEM`, `DAA2_Modal`, `HighFidelityCFD`) | Selects between fast boundary-integral DAA and coupled 3D Eulerian CFD. |
| `charge_explosive_type` | Explosive Material | Enum (`TNT`, `Pentolite`, `CompB`, `HBX1`, `PETN`) | Selects Cole similitude calibration constants. |
| `charge_mass_kg` | Charge Mass (kg) | Number / Float (`50.0 kg`) | Total TNT-equivalent explosive charge mass. |
| `charge_standoff_m` | Standoff Distance (m) | Number / Float (`5.0 m`) | Distance from charge center to nearest structural facet. |
| `charge_depth_m` | Charge Depth (m) | Number / Float (`10.0 m`) | Hydrostatic depth for Rayleigh-Willis bubble period calculations. |
| `enable_taylor_cavitation` | Hull Cavitation Model | Boolean (`true`) | Activates Taylor hull cavitation decoupling and reload impact pulses in DAA-C. |
| `cavitation_cutoff_pa` | Cavitation Cut-Off Pressure | Number / Float (`2300.0 Pa`) | Vapor pressure threshold for fluid tensile release. |
| `shell_integration_points`| Shell Thickness Points | Integer (`5`) | Number of through-thickness Lobatto integration points for elastoplasticity. |

