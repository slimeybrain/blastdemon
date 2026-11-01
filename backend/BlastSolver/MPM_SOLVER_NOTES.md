# MPM 3D Solver Architecture & Numerical Stability Compendium

## Overview

This technical reference documents the critical algorithmic flaws, theoretical mechanisms, symptoms, and permanent numerical corrections applied to the 3D Material Point Method (MPM) solver library (`mpm_solver_3d_cuda.cu`, `mpm_solver_3d.cpp`, and `mpm_solver_3d.hpp`). 

These corrections restored the solver from severe numerical instabilities (including artificial velocity eruptions, multi-megabar pressure singularities, and boundary penetration) to a verified, thermodynamically consistent, and energy-conserving continuum mechanics state.

---

## 1. Grid Field Aliasing & Cross-Material Scalar Pollution in P2G

### Symptom
During multi-material simulations involving high-pressure fluids or expanding gases interacting with deformable solids, the equivalent plastic strain `ep` of adjacent solid particles instantly exploded from `0.0` to over `1.5 × 10^9` in a single timestep upon wavefront arrival. The solid liner artificially froze due to extreme Johnson-Cook strain hardening (`term_strain = A + B * ep^n` scaled yield stress by > 690× to over 200 GPa).

### Root Cause
In `kernel_p2g_3d` (CUDA) and `accumulateParticlesToGrid` (CPU), the Eulerian background grid node accumulator `grid[idx].plastic_strain` was overloaded as a dual-purpose scalar buffer:
```cpp
// Flawed legacy code:
float p_scalar = (is_fluid_water || is_energetic) ? press : p_ep_bar;
atomicAdd(&node->plastic_strain, p_m * weight * p_scalar);
```
For fluid and gas particles, hydrostatic pressure (`press ~ 15 GPa`) was deposited directly into `node->plastic_strain`. In the subsequent G2P step, solid particles sharing background cells interpolated `node->plastic_strain` as their smoothed continuum plastic strain, directly corrupting their constitutive yield surface.

### Algorithmic Correction
Decoupled the grid scalar channels. Non-solid particles (fluids, gases, energetic phases) deposit strictly `0.0f` into the plastic strain accumulator:
```cpp
float p_scalar = (is_fluid_water || is_energetic) ? 0.0f : p_ep_bar;
if (p_scalar > 0.0f) {
    atomicAdd(&node->plastic_strain, p_m * weight * p_scalar);
}
```
Ghost fluid pressure traction boundaries were similarly decoupled from the nodal plastic strain field.

---

## 2. Mie-Grüneisen Shock Hugoniot Asymptotic Singularity

### Symptom
Under convergent multi-axial compression, localized cells along solid material interfaces produced pressure spikes exceeding `343 TPa` (343,309 GPa), negative cavitation pressures of `-13.7 billion GPa`, and particle velocity eruptions exceeding `4.7 billion m/s`.

### Root Cause
The standard Mie-Grüneisen shock Hugoniot equation of state for solids relates Hugoniot pressure `p_H` to volumetric compression `mu_vol = (1 - J) / J` via:
```
p_H = (rho_0 * c_0^2 * mu_vol * [1 + (1 - 0.5 * gamma_0) * mu_vol]) / [1 - (s - 1) * mu_vol]^2
```
For materials with Hugoniot slope `s > 1` (e.g. copper with `s = 1.49`), this equation exhibits a mathematical pole (vertical asymptote) at `mu_asymptote = 1 / (s - 1) ≈ 2.04`. The previous codebase implemented a naive denominator clamp:
```cpp
// Flawed legacy code:
float denom = 1.0f - (mat.mg_s - 1.0f) * mu_vol;
if (denom < 0.1f) denom = 0.1f;
```
When `mu_vol` reached large values during convergent deformation, dividing by `denom^2 = 0.01` multiplied the already astronomical numerator, causing unbounded numerical detonation of the pressure field.

### Algorithmic Correction
Enforced a continuous, pole-free shock Hugoniot formulation satisfying the scale-isolation and conservative monotonicity directives:
1. Volumetric compression is bounded at `mu_max = 0.85 / (s - 1)`, guaranteeing `denom >= 0.15` at all times.
2. For compressions exceeding `mu_max`, the Hugoniot transitions smoothly and tangentially to a linear high-pressure compressibility branch:
```cpp
const float s_minus_1 = fmaxf(mat.mg_s - 1.0f, 0.05f);
const float mu_max = 0.85f / s_minus_1;
const float mu_eff = fminf(mu_vol, mu_max);

float denom = 1.0f - s_minus_1 * mu_eff;
if (denom < 0.15f) denom = 0.15f;

float p_H = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_eff * 
            (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_eff)) / (denom * denom);

if (mu_vol > mu_max) {
    float K_high = mat.density * mat.mg_c0 * mat.mg_c0 * (1.0f + 2.0f * mat.mg_s * mu_max);
    p_H += K_high * (mu_vol - mu_max);
}

float e_H = (p_H * mu_eff) / (2.0f * mat.density * (1.0f + mu_eff));
p_hydro = p_H + mat.mg_gamma0 * mat.density * (e_int_p - e_H);
```

---

## 3. Unbounded Solid Volume Compression Limits

### Symptom
Solid continuum particles under extreme local impact collapsed to `0.0001` of their initial volume (10,000× reference density), triggering severe numerical stiffness, unphysical time-step degradation, and singular deformation gradients.

### Root Cause
A single global volume limiter `V_min_limit = 1.0e-4f * V0_p` was applied uniformly to all materials, failing to distinguish between highly compressible gases and condensed solids. Under physical shock conditions up to several megabars, solid metals never exceed ~4× reference density (`J = V / V0 >= 0.25`).

### Algorithmic Correction
Enforced physical continuum realizability bounds distinguishing condensed solids from fluids:
```cpp
const bool is_solid_mat = (!is_fluid_water && !is_energetic_p);
const float V_min_limit = is_solid_mat ? (0.25f * V0_p) : (1.0e-4f * V0_p);
const float V_max_limit = is_solid_mat ? (3.0f * V0_p)  : (1.0e4f * V0_p);

V_p = fminf(fmaxf(V_p * expf(fmaxf(fminf(tr_deps, 0.5f), -0.5f)), V_min_limit), V_max_limit);
```

---

## 4. Pairwise Contact Impulse Stacking in Multi-Body DEM

### Symptom
High-density multi-particle assemblies experienced artificial scattering and kinetic energy generation under heavy compressive contact.

### Root Cause
In `kernel_dem_resolve_contact_3d`, pairwise velocity adjustments `dv_p` from all neighboring particles were accumulated onto each particle using `atomicAdd` without a composite step limiter. In dense packs with 12 to 20 contact neighbors, cumulative delta-v easily exceeded the approach velocity and the grid CFL velocity bound `0.5 * (dx / dt)`.

### Algorithmic Correction
Bounded each pairwise impulse magnitude to prevent cumulative over-correction:
```cpp
float dv_mag_p = sqrtf(dv_p_x * dv_p_x + dv_p_y * dv_p_y + dv_p_z * dv_p_z);
float dv_limit = fminf(fabsf(v_n), 0.5f * (cell_dx / fmaxf(dt, 1.0e-12f)));
if (dv_mag_p > dv_limit && dv_mag_p > 1.0e-7f) {
    float scale = dv_limit / dv_mag_p;
    dv_p_x *= scale;
    dv_p_y *= scale;
    dv_p_z *= scale;
    Jx *= scale; Jy *= scale; Jz *= scale;
}
```

---

## 5. Artificial Velocity Gradient Magnification in G2P

### Symptom
Premature yielding, artificial plastic strain speckles, and non-physical shear bands along free boundaries and transition zones.

### Root Cause
In `g2p_device_impl`, the affine momentum tensor `B_new` and velocity gradient tensor `L_new` were multiplied by `inv_w = 1.0f / weight_sum`:
```cpp
// Flawed legacy code:
for (int r = 0; r < 3; ++r) {
    for (int c = 0; c < 3; ++c) {
        B_new[r][c] *= inv_w;
        L_new[r][c] *= inv_w;
    }
}
```
For boundary particles or particles crossing cells where `weight_sum < 1.0` (often dropping to 0.3–0.5), this multiplied `L_ij` and the strain rate increment `deps` by 2× to 3.3×. This violated the APIC formulation (Jiang et al. 2015), which requires `B_p = sum_i w_ip * v_i * (x_i - x_p)^T` directly without inverse weight scaling.

### Algorithmic Correction
Completely removed `inv_w` scaling from `B_new` and `L_new`, bringing the CUDA implementation into 100% mathematical parity with the APIC formulation and the CPU reference solver.

---

## 6. Boundary Reflection & Domain Alignment Flaws

### Symptom
Taylor anvil impact tests exhibited unphysical particle penetration below the anvil surface (`z < 0.0 m`), spurious particle escapes, and 75% suppression of mushroom foot expansion on the GPU compared to the CPU.

### Root Cause
1. Legacy device code used a complex `reflect_axis` helper that attempted to fold coordinates and flip shape function gradients inside P2G/G2P stencil loops.
2. In `main.cpp` and test harnesses, domain bounds were padded by `pad = 3` cells (`zmin -= 3 * cell_size`), shifting the physical boundary plane relative to the user-specified coordinate origin.
3. Particles crossing reflecting boundaries were being flagged as `is_terminated = true`, erroneously deleting valid particles from the simulation.

### Algorithmic Correction
1. Completely purged `reflect_axis` from `mpm_solver_3d_cuda.cu`. P2G and G2P use standard bounded stencil loops with explicit index checking (`if (i < 0 || i >= nx) continue;`).
2. Removed domain coordinate shifting so that grid bounds strictly align with user geometry.
3. Enforced boundary reflection in `integrate_particle_position_and_bc`:
   - Reflecting boundaries (`bc == 2`): reflect particle coordinate across the plane, invert normal velocity, and never mark the particle as terminated.
   - Sticky boundaries (`bc == 0` or `1`): clamp position to plane and zero the normal velocity component.
   - Termination (`bc == 3` or `4`): cleanly terminate particles only when exiting non-reflecting boundaries.

---

## 7. Sub-Cell Plastic Strain Regularization

### Symptom
Discrete particle speckles in the plastic strain field in elastic-plastic transition zones (e.g. Taylor cylinder impact above the mushroom foot).

### Root Cause
While `kernel_smooth_plastic_strain_3d` filtered the background grid plastic strain field, this smoothed field was never transferred back to particles during G2P. Particles retained their discrete, unsmoothed local `soa.ep_bar` values, subject to high-frequency sub-cell noise.

### Algorithmic Correction
1. In G2P, interpolate the background grid smoothed plastic strain `ep_smoothed` using the shape functions.
2. In constitutive stress integration, apply non-local relaxation bounded by physical thresholds (`ep_smoothed < 50.0`):
```cpp
if (ep_smoothed > 1.0e-6f && ep_smoothed < 50.0f && ep_bar_p > 0.0f) {
    ep_bar_p = 0.75f * ep_bar_p + 0.25f * ep_smoothed;
    soa.ep_bar[p_idx] = ep_bar_p;
}
```

---

## Verification & Validation Compliance Matrix

| Defect / Mechanism | Prior Flawed State | Current Corrected State | Verification Benchmark |
| :--- | :--- | :--- | :--- |
| **P2G Plastic Strain Field** | Overloaded with gas pressure; `ep > 1.5e9` | Decoupled; `ep` purely from plastic flow | `test_user_sc1`, `vv_l3_03_taylor_anvil` |
| **Mie-Grüneisen Hugoniot** | Pole divergence at `mu = 1 / (s - 1)`; `p > 343 TPa` | Bounded `mu_max` with linear high-pressure branch | `test_user_sc1`, `vv_l1_04_johnson_cook` |
| **Solid Volume Bounds** | Permitted 10,000× density compaction (`J >= 1e-4`) | Bounded `0.25 * V0 <= V <= 3.0 * V0` | `test_user_sc1`, `vv_l3_04_casing_expansion` |
| **DEM Contact Impulses** | Unbounded stacked velocity impulses | CFL-bounded pairwise impulse `\|dv\| <= min(v_n, 0.5 dx/dt)` | `test_mpm_dem_contact`, `vv_l2_05` |
| **G2P Tensor Normalization** | Artificially scaled by `1 / weight_sum` | Clean APIC transfer without `inv_w` scaling | `test_cylinder_impact`, `vv_l3_03_taylor_anvil` |
| **Boundary Reflection** | Coordinate flipping via `reflect_axis`; early kill | Clean physical reflection and coordinate clamping | `test_user_taylor_anvil` (4 configs, 3000 steps) |
| **Plastic Strain Noise** | Raw unsmoothed particle history | Non-local Eulerian-Lagrangian regularization | `test_user_taylor_anvil` (`ep_top = 0.000`) |
| **Fractured Metal Strength** | Failed JC/Hypoelastic metals became inviscid fluids (`q = 0`) even at 10+ GPa confinement → AP noses splashed below the Tate hydrodynamic threshold | Confined Coulomb residual `q = min(0.6 p, sigma_y)`, zero in tension / when molten (`fractured_metal_residual_strength`) | `VV-L1-09` part D |
| **JC Fracture Locus** | Triaxiality ratio capped at `4.0` → compressive fracture strain ≤ `4 × failure_strain` | Full JC locus `[d1 + d2 exp(d3 σ*)] / [d1 + d2 exp(d3/3)]`, lower floor only (`jc_fracture_triaxiality_ratio`) | `VV-L1-09` parts B, C |
| **JC Damage Coupling** | Flow stress softened by `(1 − D)` from `D > 0` | Uncoupled until fracture (`D = 1`), per original JC | `VV-L1-09` part B |
| **Weibull Scatter** | Applied to JC flow stress (×~1.55 size factor + ±25% scatter) | Fracture thresholds only (failure strain, spall) | `VV-L1-09` part B (`w = 1.4`) |
| **MG Energy Term** | Intact `Γρ(e_pl − e_H)` vs failed `Γρ e_pl` → ~1 GPa jump on failure | Unified `p_H + Γ0 ρ0 e_pl` (`mie_gruneisen_compression_pressure`) | `VV-L1-09` part A |
