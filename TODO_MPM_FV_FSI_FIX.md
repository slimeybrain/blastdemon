# 3D MPM-FV FSI Recovery Plan & Forensic Diagnosis (Next Week Action File)

**Created:** 2026-11-17  
**Branch:** `feature/mpm-fv-fsi-3d`  
**Reference Test Case:** `/home/chris/blastdemon_tests/m6276mm/v8/m62.json`  
**Captured Init Payload:** [`blast_last_INIT_FSI_3D.json`](file:///home/chris/antigrav/blastdemon/build/blast_last_INIT_FSI_3D.json)  
**Captured VTK Output:** `/home/chris/blastdemon_tests/m6276mm/v10/` (`steps 0..1800`, `vx = 750 m/s`, `ω_x = 2000 rad/s`, `dx = 6 mm`, `time_delay = 500 µs`)

---

## 1. Forensic Root Causes (Verified Against `v10` VTU Output)

### Root Cause 1: Unreacted Energetic Charge (`Charge.stl`) Has `m_solid = 0` -> Fake Sealed Air Cavity
- **Location:** [`mpm_solver_3d_cuda.cu`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d_cuda.cu#L843-L846) (and CPU counterpart in [`mpm_solver_3d.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.cpp))
  ```cpp
  const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                             mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                             mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
  const bool is_solid_mat = !is_fluid_water && !is_energetic && (mat.material_model != MPMMaterialModel::DruckerPragerSoil);
  ```
- **Failure Mechanism:** `Charge.stl` (`obj 2`, `x_0 ∈ [-0.1105, -0.0360] m`, `y, z ∈ [-0.0199, +0.0199] m`) uses `JWL Programmed Burn` with `time_delay = 500 µs`. Prior to `500 µs` (`lambda = 0`), it is a solid unreacted explosive billet (`ρ = 1800 kg/m³`), yet `is_solid_mat == false` leaves `m_solid == 0` everywhere inside `Charge.stl`. The FV CFD solver therefore treats the explosive filler inside `MainBody.stl` as a **sealed pocket of ambient air**.

### Root Cause 2: Non-Conservative Velocity & Pressure Overwrite Pump (`×2.93` per 200 Steps -> `144 GPa` Blowup)
- **Location:** [`kernel_fsi_apply_penalty_active_gpu`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L9538-L9648) & [`kernel_fsi_apply_penalty_gpu`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L9447-L9535), invoked **twice per step** (in [`coupleFSIWithMPMGPU`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L10264) and at the end of [`CFDSolver3DCuda::step`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L6246)).
- **Failure Mechanism:**
  - [`kernel_fsi_couple_active_gpu`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L9180) only marks `d_geom.is_boundary = true` where `m_solid > 1.0e-8` **AND** `n_solid_neighbors >= 4`.
  - However, `kernel_fsi_apply_penalty_active_gpu` overwrites `u_cfd = v_mpm` (`+750 m/s`) and copies neighbor pressure `p_target` into `d_U` on **all** cells with `m_solid > 1.0e-8` — including open fluid cells (`1 <= n_solid_neighbors <= 3`, `is_boundary == false`) lining the inner cavity wall (`x_0 = -0.047 m`).
  - Those `is_boundary == false` cells continually ram mass at `750 m/s` into the `is_boundary == true` front cavity wall (`flx_mass = 0`) and mirror the resulting higher pressure back into themselves every step:

| Step | Physical `x` | Body-Fixed `x_0` | Cavity `ρ_max` (`kg/m³`) | Cavity `P_max` | Reacted `α_1` | MPM `|v|_max` (`m/s`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `0` | `-0.047 m` | `-0.047 m` | `1.225` | `0.101 MPa` | `0.000` | `754.2` |
| `200` | `-0.041 m` | `-0.056 m` | `2.99` | `0.371 MPa` | `0.000` | `754.6` |
| `400` | `-0.017 m` | `-0.047 m` | `8.76` | `0.988 MPa` | `0.000` | `754.2` |
| `800` | `+0.013 m` | `-0.047 m` | `94.0` | `8.19 MPa` | `0.000` | `754.0` |
| `1200` | `+0.043 m` | `-0.047 m` | `1,102` | `70.4 MPa` | `0.000` | `754.2` |
| `1600` | `+0.073 m` | `-0.047 m` | `15,210` | `637.5 MPa` | `0.000` | `1,077.4` |
| `1800` | `+0.091 m` | `-0.044 m` | blowout | **`144,100 MPa` (`144 GPa`)** | `0.000` | **`43,301.3`** (`25,000 × √3` clamp) |

### Root Cause 3: B-Spline Fringe Piston, Thin-Shell Windscreen Leakage, & Stairstep Wall Flux
1. **B-Spline Fringe Piston (`20–26 mm` ahead of tip):** `m_solid > 1.0e-8` triggers on outer B-spline tails (`1.0–1.5 dx` outside the physical surface), clamping ambient air `1–2` cells ahead of the supersonic tip to `750 m/s`.
2. **Thin-Shell Leakage (`Nose.stl`):** `Nose.stl` (`obj 6`, `x_0 ∈ [0.052, 0.201] m`) is a `1.5–2 mm` hollow windscreen (`< dx = 6 mm`). Its nodes have `< 4` solid face neighbors, so `is_boundary` is `false` (air leaks into the nose cone) while the penalty kernel forces `ux = 750 m/s` on those cells.
3. **Uncommitted Stairstep Piston Edit in `get_face_flux_gpu`:** Uncommitted edits in [`cfd_solver_3d_cuda_impl.cuh`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L1771-L1803) replaced smooth-normal (`n_hat`) wall reflection with a 1D Cartesian stairstep shock piston (`vn_wall = 750 m/s` on every `x`-step of a `15°` cone instead of `v_w · n_hat = 750 × sin(15°) = 194 m/s`).

### Root Cause 4: Multi-Material JWL `products.rho0 = 1.225 kg/m³` Poisoning When Charge Is in MPM
- **Location:** [`parseMaterialSet`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp#L6294-L6301)
- **Failure Mechanism:** When the explosive is an `MPMObject3D` (`explosive_charge == ""`), top-level `msg` has `"density": 1.225` (ambient air) and no top-level `jwl_*` or `afterburn_*`. `parseMaterialSet` sets `matSet.products.rho0 = 1.225`! When `Charge.stl` detonates at `t = 500 µs` and erodes into Multi-Material FV (`ρ < 9 kg/m³`), FV computes `v_rel = 1.225 / 9.0 = 0.136` (`7.3×` solid compression -> `> 400 GPa` instant explosion).

### Root Cause 5: `space_time_scheme` Serialization Collision & `.pvd` Desynchronization
- **Locations:** [`serialization.ts`](file:///home/chris/antigrav/blastdemon/frontend/src/serialization.ts), [`main.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp#L8637), [`VTKService.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/services/VTKService.cpp)
- `MPMDomain3D`'s `"space_time_scheme": "Leapfrog"` overwrites `CFDSolver3D`'s `"space_time_scheme"` (`"ADER-2"` / `"MUSCL-Hancock"`).
- Re-initializing wrote `timestep="0"` into `vtk_output_mpm.pvd` while leaving `steps 200..1800` `.vtu` slice files in `v10/`, making the `t = 160 µs` bow shock (`x = 0.325 m`) appear `12.5 cm` ahead of the frozen `t = 0` projectile (`x = 0.200 m`) in ParaView.

---

## 2. Single-Material Ideal Gas vs. Multi-Material CFD Notes

- **Single-Material Ideal Gas (`CFDSolver3DCuda<RealType, false>`, `init_mode = "Ideal Gas"`):**
  - `~2×` faster and `~45%` less VRAM (`5` conserved fields vs. `9`).
  - Exact for supersonic aerodynamics, shock reflections, and real cavity air sloshing.
  - Works cleanly with low-density MPM explosive particle erosion (`V / V0 > 20`, where JWL `A, B` exponentials are `< 10^-10 Pa`), with minor `γ = 1.4` vs. `1 + ω = 1.30` approximation and no O₂ afterburn.
- **Multi-Material JWL + Air (`CFDSolver3DCuda<RealType, true>`):**
  - Required when `afterburn_enabled: true` (turbulent O₂ combustion of fuel-rich detonation products), separate `ω = 0.30` product EOS vs. `γ = 1.40` air EOS, early high-density handoff (`V / V0 < 10`), or UNDEX (`TaitWater`).
  - Works seamlessly once `parseMaterialSet` inherits `products` + `afterburn` from energetic `mpm_objects`.

---

## 3. Step-by-Step Implementation Checklist for Next Week

### Phase 1: Condensed-Phase Volume Fraction `α_s` & Unreacted HE Occupancy
- [ ] In [`mpm_solver_3d.hpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.hpp), [`mpm_solver_3d_cuda.cu`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d_cuda.cu), and [`mpm_solver_3d.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/mpm_solver_3d.cpp), accumulate condensed-phase solid volume `v_solid` onto `MPMGridNode3D` during P2G:
  - Intact structural solids (`!has_failed && damage < 0.99`): scatter `w_{ip} * V_p` to `v_solid` and `w_{ip} * m_p` to `m_solid`.
  - Energetic materials (`JWLProgrammedBurn`, `CRESTReactiveBurn`, `LeeTarverIgnitionGrowth`): scatter `(1.0f - lambda_p) * w_{ip} * V_p` to `v_solid` and `(1.0f - lambda_p) * w_{ip} * m_p` to `m_solid`.
  - Separate failed/spall debris (`has_failed || damage >= 0.99`) so sub-grid drag is never applied to intact thin shells (`Nose.stl`).

### Phase 2: Volume-Fraction Ghost-Fluid Coupling (Both Ideal Gas & Multi-Material CFD)
- [ ] **Purge Fluid-Cell State Overwrites (Directive 19):** Remove `kernel_fsi_apply_penalty_active_gpu` / `kernel_fsi_apply_penalty_gpu` overwrites on fluid cells in [`cfd_solver_3d_cuda_impl.cuh`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L6239-L6278) and [`coupleFSIWithMPMGPU`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L10264-L10329). Let real enclosed air gaps (inside `Nose.stl`) slosh naturally and conservatively without any velocity initialization shims.
- [ ] **Volume-Fraction Wall Mask & `3×3×3` Smooth Normals:**
  - Set `d_geom.is_boundary = true` where intact `α_s = v_solid / V_cell >= 0.25` (seals `Nose.stl` thin shells, rejects `10^-6` B-spline outer tails ahead of the tip, and drops `n_solid_neighbors >= 4`).
  - Compute smooth outward unit normal `n_hat = -∇α_s / |∇α_s|` over a `3×3×3` stencil.
- [ ] **Oblique Slip-Wall Riemann Flux (`get_face_flux_gpu`):**
  - Revert the uncommitted 1D stairstep piston edit in [`cfd_solver_3d_cuda_impl.cuh`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L1771-L1803) (keep uncommitted frontend UI files intact).
  - Project wall and fluid velocities onto `n_hat` (`v_rel_n = (v_wall - u_fluid) · n_hat`) to build the moving slip-wall ghost state and wall pressure `p_wall`, with `flx_mass = 0` and normal work flux `p_wall * (v_wall · n_hat) * (n_hat · n_face)`.
- [ ] **Clean Uncovering & Discrete Traction:**
  - In [`kernel_extrapolate_uncovered_cells_3d`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_3d_cuda_impl.cuh#L8428-L8545), extrapolate freshly uncovered cells strictly from neighbors with `!prev_is_solid && !curr_is_solid` (ambient fallback if isolated).
  - Compute `Fluid -> MPM` force via `-V_cell * p_fluid_interface * ∇α_s` (and apply sub-grid drag only to detached failed debris with `α_s < 0.25`).

### Phase 3: `parseMaterialSet` MPM-Charge Inheritance, Serialization Precedence & `.pvd` Sync
- [ ] In [`parseMaterialSet`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp#L6262-L6325), when no Eulerian `explosive_charge` is wired and `msg["mpm_objects"]` contains an energetic object, inherit `products` (`rho0`, `A, B, R1, R2, omega`), `det_vel`, `detonation_energy`, and `afterburn_*` from that `MPMObject3D` instead of reading ambient air `"density": 1.225`.
- [ ] In [`serialization.ts`](file:///home/chris/antigrav/blastdemon/frontend/src/serialization.ts) and [`main.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp#L8637), serialize MPM time integration as `mpm_space_time_scheme` and re-apply `CFDSolver3D` keys (`space_time_scheme`, `flux_scheme`, `spatial_order`, `device`, `precision`) last (Directives 11 & 12).
- [ ] In [`VTKService.cpp`](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/services/VTKService.cpp), clean stale matching `.vtu` frame files when resetting `.pvd` at `step = 0` and flush `AsyncVTKWriter` on stop/pause.

### Phase 4: Verification (`bin/blast_verify` + M62 Headless Audit)
- [ ] Add **`VV-FSI-SUP-01`** (`Mach 2.2`, `15°` half-angle MPM cone in both Single-Material Ideal Gas and Multi-Material CFD):
  - Assert undisturbed upstream air `>= 2 dx` ahead of the physical cone tip (`|p - p_atm| / p_atm < 1.0e-4`, `|u| < 0.05 m/s`).
  - Assert attached oblique shock surface pressure matches exact Taylor-Maccoll theory (`p_cone / p_atm ≈ 1.82`, `e_L2 <= 0.10`).
- [ ] Run [`blast_last_INIT_FSI_3D.json`](file:///home/chris/antigrav/blastdemon/build/blast_last_INIT_FSI_3D.json) headlessly in both Single-Material Ideal Gas and Multi-Material JWL+Afterburn modes past `step 2500` and across detonation (`t >= 500 µs`), confirming zero internal pressure runaway and clean Mach cone contours.
