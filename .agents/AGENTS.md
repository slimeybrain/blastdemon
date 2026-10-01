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
- **Rich Markdown Formatting:** Structure all chat responses and documentation using clean, expressive GitHub-Flavored Markdown. Leverage clear headings, organized bulleted/numbered lists, emphasis/bold highlights, structured comparison tables, blockquotes, and fenced code blocks to maximize readability and visual clarity.
- **Strict Prohibition of Raw LaTeX Math:** NEVER emit raw LaTeX delimiters or commands (such as `$`, `$$`, `\(`, `\)`, `\[`, `\]`, `\frac`, `\Delta`, `\mathcal`, `\sum`, `\text`, `\times`, etc.) in chat responses or documentation under any circumstances.
- **Clean Math & Equation Presentation:** Write all mathematical expressions, formulas, physics equations, and variables using:
  - Inline code formatting (e.g. `Nx × Ny × Nz`, `O(dt^2)`, `dt`, `dx`, `M × stencil_radius`, `sigma_y = sigma_0 * (1 + (eps / eps_0)^n)`).
  - Standard Unicode math characters (e.g. `Δt`, `ρ`, `σ`, `γ`, `∇·u`, `√`).
  - Fenced code blocks (`text` or language specific) for multi-line derivations, matrix/tensor equations, or system dynamics.
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

## 13. High Compute Performance and Minimal Memory Footprint (ABSOLUTE RULE)
- **Zero Dynamic Allocations in Hot Paths:** Never allocate memory (e.g. `std::vector`, `new`, `malloc`, string manipulations) inside solver step loops, Gauss point loops, or particle updates. All buffers, temporary arrays, and state tables must be pre-allocated during initialization.
- **Cache Locality & Coalesced Memory Access:** Ensure particle and element data layouts maintain contiguous, cache-friendly, or Structure-of-Arrays (SoA) alignment for full SIMD / GPU warp memory coalescing.
- **Minimal Per-Entity State Variables:** Keep per-element and per-particle state history minimal and strictly packed. Do not store redundant or easily recomputable tensors in persistent memory.
- **Fast Closed-Form Invariant & Return-Mapping Math:** Prefer analytical, branch-minimized, and closed-form implementations for yield evaluations, tensor invariants, and return mapping over costly iterative root-finders where possible.

## 14. Mandatory Minimum 2nd-Order Temporal Accuracy Directive (ABSOLUTE RULE)
- **Prohibition of 1st-Order Defaults:** 1st-order time integration schemes (such as Forward Euler or 1st-order un-staggered steps) are STRICTLY PROHIBITED from being the default anywhere in the framework.
- **Lagrangian & Particle Solvers (FEM and MPM):** Must default to **2nd-Order Symplectic Central Difference / Staggered Leapfrog** integration. This guarantees second-order trajectory accuracy (O(dt^2)) and exact Hamiltonian phase/energy preservation with single-pass GPU performance and zero multi-stage memory overhead.
- **Eulerian Fluid Solvers (CFD):** Must default to **2nd-Order ADER-2** (single-stage Cauchy-Kowalevski space-time predictor) or **2nd-Order TVD/SSP-RK2** with slope limiters. ADER-3 is supported for 3rd-order spatial-temporal accuracy.
- **FSI Coupling Solvers:** Must preserve at least 2nd-order accuracy across fluid-structure coupling substeps.
## 15. Mandatory UI Parameter & Node Type Documentation Directive (ABSOLUTE RULE)
- **Zero Undocumented UI Elements:** Whenever a new node type or new configuration parameter is added, renamed, or modified in the UI or backend:
  - It MUST be registered in `frontend/src/parameter-definitions.ts` with complete engineering documentation (label, physical unit, concise summary, and detailed physics/mathematical formulation/stability implications).
  - New node types MUST have a complete multi-section documentation definition in `frontend/src/parameter-definitions.ts` (including Overview & Role, Governing Physics & Formulations, Inputs & Upstream Connections, Outputs & Telemetry, and Key Parameter Tuning Guide).
  - Parameter popovers, native tooltips, and node info overlays across `property-editor.ts`, `graph-renderer.ts`, and `node-viewer.ts` must stay synchronized with this master single-source-of-truth definitions registry.

## 16. Mandatory Fully Exhaustive Verification & Validation (V&V) Directive (ABSOLUTE RULE)
- **Zero Unverified Code:** No element formulation, constitutive model, contact law, shock algorithm, or coupling scheme may be committed or merged without an automated, quantitative verification test in `backend/BlastSolver/verification/`.
- **Multi-Scale Verification Pyramid:** Tests must be exhaustive across all physical scales:
  1. *Unit / Single-Element Level:* Rigid body modes (zero strain energy), patch tests, uniaxial tension/compression, simple shear, bending, locking checks, single material-point cyclic load reversal, crack closure, and Hugoniot/JWL isentropes.
  2. *Canonical Mesoscale Level:* Clamped plates, Scordelis-Lo cylindrical roofs, Hertzian elastic contact, Coulomb stick-slip friction, S-rail folding, Sod shock tube, hydrostatic water column, and submerged acoustic added mass.
  3. *Full 3D Multi-Physics System Level:* Full 3D reinforced concrete blast walls under high explosive detonation (Eulerian blast wave reflection, two-way FSI, solid concrete cracking/crushing, rebar plastic yielding, and back-face spall throw to MPM debris), full naval submarine hull sections under close-in/stand-off UNDEX with bubble pulsation, and full automotive frontal crash barrier impact.
- **Strict Quantitative Error Norms (Prohibition of Qualitative Checks):** Qualitative "looks plausible" assertions are strictly prohibited. Every test must evaluate explicit mathematical tolerances:
  - Relative L2 Error Norm (`e_L2 <= tolerance`)
  - Maximum Point-wise Linf Error Norm (`e_Linf <= tolerance`)
  - Hamiltonian Energy Conservation (`e_energy <= 1.0e-3`)
  - Momentum Vector Conservation (`e_momentum <= 1.0e-12`)
  - Asymptotic Convergence Rate (`1.90 <= p_obs <= 2.10` for 2nd-order schemes)
  - Statistical Correlation (`R^2 >= 0.985` for empirical validation data)
- **Autonomous Living Verification Compendium:** The headless test suite (`bin/blast_verify`) must compile and execute continuously, generating zero-dependency vector SVG plots with shaded `± 1.0%` (green) and `± 5.0%` (yellow) error corridors, and automatically compiling `VERIFICATION_MANUAL.md` with live Pass/Fail badges.
- **Strict LaTeX Math Prohibition in V&V:** All formulas in test code, comments, reports, and living manuals MUST strictly use clean Unicode and inline code formatting. Raw LaTeX commands (`$`, `$$`, `\(`, `\)`, `\frac`, etc.) are strictly prohibited per Directive 7.

## 17. Absolute Prohibition of Synthetic, Mocked, or Potemkin Verification Tests (PRIME DIRECTIVE)
- **Zero Synthetic or Scaled Simulation Curves (ABSOLUTE PROHIBITION):** It is strictly forbidden to manufacture "numerical" or "simulation" data by scaling, multiplying, offsetting, or adding arbitrary noise to analytical or experimental solutions (e.g. `num = exact * 0.99x`, hardcoded displacements, synthetic sine waves, or mocked curve fits). Any test or verification suite that fabricates numerical curves without executing actual solver code is considered a critical engineering integrity breach.
- **Mandatory Genuine Solver Pipeline Execution:** Every verification test asserting physical validity MUST instantiate the actual production solver, element, or constitutive classes (e.g., `CFDSolver3D`, `MPMSolver3DCUDA`, `FEMSolver3D`, `FEMShell4BTElement`, `Materials::...`), allocate concrete spatial computational grids or particle clouds, advance physical time through true numerical integration loops, and extract data directly from genuine solver state memory buffers.
- **Explicit Mesh & Discretization Provenance:** Every benchmark report, SVG plot, and manual entry MUST document the actual spatial and temporal discretization used to produce the numerical dataset: grid dimensions (`Nx × Ny × Nz`), element count, particle count (`Np`), spatial cell size (`dx`, `dy`, `dz`), and integration timestep (`dt`). Benchmarks lacking physical spatial-temporal discretization cannot be presented as solved numerical simulations.
- **Honest Failure & Transparent Status Reporting:** If a solver capability or coupled multi-physics pipeline is not yet fully integrated, computationally prohibitive for headless CI, or fails convergence tolerances, the test MUST fail loudly with an honest error norm or be explicitly marked as `STATUS: PENDING INTEGRATION` or `STATUS: UNVERIFIED`. AI assistants and developers are strictly prohibited from faking a `PASS` badge or fabricating synthetic plots to satisfy directives.
- **Real Physics over Canned Smoothness:** Numerical verification plots must display the authentic physical and numerical behavior of the solver—including genuine spatial gradients, numerical dispersion, grid shock resolution, or contact chatter. If a test must run rapidly in headless verification (`bin/blast_verify`), execute a reduced-mesh or 1D/2D slice that genuinely runs rather than an analytical equation multiplied by a fudge factor.

## 18. Pipeline Browser as the Primary Model-Building & Configuration Hub (PRIME DIRECTIVE)
- **Primary Model-Building Environment:** The Pipeline Browser is the primary, indispensable workflow environment for building, configuring, inspecting, wiring, and executing multi-physics models in BlastDaemon. It must NEVER be treated as a passive or secondary tree outliner.
- **Exhaustive Feature & Configuration Exposure (Zero Hidden Features):** Every feature, entity, physical connection, material assignment, background mesh, charge geometry, detonator location, boundary condition, slice plane, virtual gauge probe, and coupling stage MUST be fully presented and accessible within the Pipeline Browser where appropriate.
- **Strict Prohibition of Orphaned UI Features:** It is strictly forbidden to introduce solver features, connection capabilities, or configuration parameters that can only be accessed or wired via the Canvas Graph view or secondary Property Grids. If a capability exists in BlastDaemon, it MUST be first-class, visible, and fully operable in the Pipeline Browser.
- **Logical, Sensible, and User-Friendly Presentation:**
  - Entities must be structured with clear visual hierarchy, intuitive domain grouping, color-coded badges, and human-readable state indicators.
  - Multi-chip status rows (`.pipeline-conn-chip-group`) must break down distinct logical dependencies (e.g., Mesh, Air Material, Charge, Detonator, Coupler) individually so users see the exact state of all logical ports rather than a single opaque, collapsed warning.
- **Instant 1-Click Inline Workflows (Zero Friction):**
  - Primary model construction, entity assignment, rewiring, and disconnection MUST be achievable via instant, single-click inline popups (`showQuickAssignPopup`) directly on the tree row without forcing the user through multi-step modal dialogs or awkward canvas drag-wiring.
  - Modals and deep property sheets remain available for comprehensive multi-physics inspection, but daily model-building workflows must be instantaneous and direct.
- **Hierarchical Child-Entity Nesting:** Sub-features belonging to domains (orthogonal slices, virtual gauge probes, structural object parts, element sets) must appear as interactive, expandable sub-rows directly beneath their parent domain in the tree.
- **Mandatory Bidirectional State & Parameter Synchronization:** Every wiring action or parameter assignment executed in the Pipeline Browser must simultaneously update the global DAG connection topology (`state.connections`) and the local node parameter dictionary (`parameters`), strictly enforcing model status invalidation (`this.stateManager.setModelStatus(modelId, 'UNINITIALIZED')`) per Directive 12.



