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
