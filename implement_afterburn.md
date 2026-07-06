# Afterburn Simulation Design & Implementation Plan

This document details the physical chemistry equations, phase representations, scaling behavior, and code modifications required to integrate an objective, scale-independent afterburn (secondary combustion) model into the BlastDaemon 1D and 2D solvers.

---

## 1. Physical Modeling Options

Afterburn (secondary combustion) occurs when fuel-rich, under-oxidized detonation products (containing $\text{CO}$, $\text{H}_2$, soot/carbon) expand and mix with ambient oxygen ($\text{O}_2$) behind the blast shock front. 

Since the chemical reaction rates at shock-heated temperatures are extremely fast compared to turbulent diffusion, this is a mixing-controlled combustion process ($Da \gg 1$).

We have three primary design choices:

### Option A: Miller Energy Relaxation Model (Recommended)
* **Concept:** Tracks reaction progress via a single progress variable $\lambda_{ab} \in [0, 1]$ representing the fraction of detonation products that have undergone secondary combustion.
* **Rate Equation:**
  $$\frac{d\lambda_{ab}}{dt} = \frac{1}{\tau} \min\left( Y_{\text{fuel}}, \frac{Y_{\text{O}_2}}{s} \right) \cdot \Theta(T - T_{\text{ign}})$$
* **Pros:** Extremely robust, stable, requires no stiff ordinary differential equation (ODE) solver, and fits easily into explicit Runge-Kutta time-stepping.

### Option B: Eddy Dissipation Concept (EDC)
* **Concept:** Assumes combustion is strictly determined by the rate at which fuel and oxidizer mix through turbulent eddies. The mixing timescale is computed dynamically from grid scale and local velocity gradients:
  $$\tau_{\text{mix}} = C_{\text{mix}} \frac{\Delta x}{|u| + \epsilon}$$
* **Pros:** More physically accurate for high-shear boundary layers and turbulent mixing zones.

### Option C: Multi-species Finite-Rate Chemical Kinetics
* **Concept:** Solve detailed species transport equations for $\text{CO}$, $\text{H}_2$, $\text{O}_2$, $\text{N}_2$, $\text{CO}_2$, and $\text{H}_2\text{O}$ using Arrhenius reaction rates.
* **Cons:** Highly stiff equations that crash explicit solvers, require tiny time-steps, and require external kinetics libraries (violating the zero-dependency directive).

---

## 2. Phase Representation & Material Fractions

Adding a **4th thermodynamic phase** (e.g., dedicated afterburn products) in the Euler solver is highly discouraged. It requires transporting a new volume fraction $\alpha_3$ and partial density $\alpha_3 \rho_3$, modifying the Rusanov/AUSM+ Riemann solver, and adding complex multi-material pressure-velocity equilibrium iterations. This would severely degrade CUDA performance in the 2D solver.

### Recommended: "Species-in-Phase" Tracer Method
Instead, we maintain the current **3-phase system**:
* **Material 0:** Air (Ideal Gas)
* **Material 1:** Detonation Products (JWL)
* **Material 2:** Unreacted Explosive (JWL)

We carry virtual species concentrations inside the existing phases:
1. **Oxidizer:** Air (Material 0) carries an implicit oxygen mass fraction $Y_{\text{O}_2}$ (starting at $23.3\%$ by mass).
2. **Fuel:** Detonation Products (Material 1) carry a combustible fuel fraction $Y_{\text{fuel}}$ (e.g., $35\%$ for TNT).
3. **Products:** When fuel and oxygen react, they form afterburn products. Since these products are hot gases ($\text{CO}_2$ and $\text{H}_2\text{O}$ vapor), we convert the reacted portion of Detonation Products (Material 1) directly into Air (Material 0).

This keeps the system bounded to 3 phases, preserving CUDA memory bandwidth and solver simplicity.

---

## 3. Scale Objectivity (Hopkinson-Cranz Blast Scaling)

Under standard blast scaling, if the charge mass $W$ scales up by a factor of $10^9$ (from $0.001\text{ kg}$ to $1,000,000\text{ kg}$):
*   The charge radius (length scale) scales as $W^{1/3} = 1,000$.
*   The expansion time of the blast wave also scales as $W^{1/3} = 1,000$.
*   Pressures and velocities remain invariant at matching scaled distances $Z = R / W^{1/3}$.

If we kept a constant physical afterburn timescale (e.g., $\tau = 1\text{ ms}$) across both simulations, the physics would break down. To maintain scale objectivity, the afterburn mixing timescale $\tau$ must be modeled as a combination of a scale-independent chemical kinetic time and a scale-dependent turbulent mixing time:

$$\tau = \tau_{\text{chem}} + \tau_{\text{mixing}}$$

### 1. The Scale-Dependent Mixing Timescale ($\tau_{\text{mixing}}$)
The mixing rate of the expanding gas cloud is governed by the physical dimensions of the charge. We can define this objectively using the initial charge radius $R_{\text{charge}}$:
$$\tau_{\text{mixing}} = C_{\text{mix}} \cdot \frac{R_{\text{charge}}}{D_{\text{CJ}}}$$
*   $R_{\text{charge}}$ is the charge radius (which naturally scales as $W^{1/3}$).
*   $D_{\text{CJ}}$ is the detonation velocity (invariant preset for a given material).
*   **Result:** The mixing timescale scales perfectly as $W^{1/3}$, maintaining Hopkinson-Cranz scaling for large blasts.

### 2. The Scale-Independent Chemical Limit ($\tau_{\text{chem}}$)
The fundamental chemical reaction speed (molecular collisions/arrhenius kinetics) does not scale with charge size. We define a constant lower limit (e.g., $\tau_{\text{chem}} \approx 10\text{ }\mu\text{s}$).

### Behavioral Outcomes:
* **Extreme Small Scale (0.001 kg):** The total timescale is dominated by $\tau_{\text{chem}}$ ($10\text{ }\mu\text{s}$). Because the expansion is extremely rapid, the gas temperature drops below the ignition temperature $T_{\text{ign}}$ before the chemical reaction can complete. The model automatically captures **flame quenching** at small scales.
* **Extreme Large Scale (1,000,000 kg):** $\tau_{\text{mixing}}$ dominates. The reaction rate scales perfectly in proportion to the expansion speed, maintaining correct pressure profiles and shock-front reinforcements at scale.

---

## 4. Dimensional Behavior

To make the afterburn model consistent (meaning a 1D, 2D, or 3D simulation of the same charge releases the same chemical energy over the same timescale), we use a **two-part mixing model**:

*   **1D (Radial/Spherical):** No shear or vorticity exists. We use the global physical expansion timescale ($\tau = \tau_{\text{chem}} + \tau_{\text{mixing}}$) directly.
*   **2D/3D (Axisymmetric/Cartesian):** Large-scale mixing is resolved directly on the grid by the Euler equations. To prevent grid dependency (where mesh refinement speeds up afterburn due to lower numerical diffusion), we compensate the solver reaction timescale:
    $$\tau_{\text{solver}} = \max\left(\tau - \tau_{\text{numerical}}, \tau_{\text{limit}}\right)$$
    where $\tau_{\text{numerical}} \approx C \frac{\Delta x}{|u| + c_s}$.

---

## 5. Solver & Chemistry Mathematics

In the fractional-step source term solver, we calculate:

### 1. Local Mass Densities
* Total cell density: $\rho$
* Local fuel density: $\rho_{\text{fuel}} = f_{\text{fuel}} \cdot (\alpha_1 \rho_1)$
* Local oxygen density: $\rho_{\text{O}_2} = 0.233 \cdot (\alpha_0 \rho_0)$

### 2. Ignition Gating
We check the local temperature $T$ using the specific heat $c_v$ and internal energy:
$$T = \frac{e_{\text{internal}}}{\sum \alpha_k \rho_k c_{v,k}}$$
If $T > T_{\text{ign}}$ (where $T_{\text{ign}} \approx 800 - 1000\text{ K}$), the reaction is active ($\Theta = 1$, otherwise $0$).

### 3. Energy Release and Phase Transition
For a step size $\Delta t$:
$$\Delta \rho_{\text{reacted}} = \min\left(\rho_{\text{fuel}}, \rho \cdot \frac{d\lambda_{ab}}{dt} \Delta t\right)$$
$$\Delta \rho_{\text{O}_2} = s \cdot \Delta \rho_{\text{reacted}}$$

We update the cell conservative state:
* **Thermal Energy:** Add heat release to the total energy $E$:
  $$E \leftarrow E + \Delta \rho_{\text{reacted}} \cdot Q_{ab}$$
* **Mass Exchange:** Move the reacted mass from Material 1 to Material 0:
  $$\alpha_1 \rho_1 \leftarrow \alpha_1 \rho_1 - \Delta \rho_{\text{reacted}}$$
  $$\alpha_0 \rho_0 \leftarrow \alpha_0 \rho_0 + \Delta \rho_{\text{reacted}}$$
* **Renormalization:** Recompute $\alpha_0$ and $\alpha_1$ based on pressure-velocity equilibrium.

---

## 6. Code Architecture Changes

### Component 1: C++ & CUDA Solver Backend

#### [materials.hpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/materials.hpp)
* **Extend the preset database:** Update the `MaterialSet` struct and presets (`TNT`, `PETN`, `RDX`, etc.) to include physical afterburn parameters:
  ```cpp
  struct AfterburnParams {
      Real Q_ab;      // Afterburn heat of reaction (J/kg of fuel)
      Real f_fuel;    // Combustible fraction of detonation products (0.0 to 1.0)
      Real s_ratio;   // Stoichiometric oxygen/fuel ratio
      Real T_ign;     // Ignition temperature (Kelvin)
      Real tau_chem;  // Fundamental chemical reaction speed (seconds, default ~10 microseconds)
      Real C_mix;     // Mixing constant scaling factor (dimensionless)
  };
  ```
* **Add helper function to compute mixture temperature:**
  ```cpp
  #ifdef __CUDACC__
  __host__ __device__
  #endif
  inline Real getMixtureTemperature(Real e_internal, Real rho, Real alpha1, Real alpha2, Real arho1, Real arho2, const JWLParams& products, const JWLParams& unreacted) {
      // Calculates mixture temperature T based on internal energy and specific heat coefficients.
  }
  ```

#### [cfd_solver_step.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_step.cpp)
* **Update the source terms:** Integrate the afterburn energy release and mass exchange in the `applySourceTerms` lambda:
  * Extract $R_{\text{charge}}$ (cached during initialization).
  * Compute scale-dependent mixing timescale: $\tau = \tau_{\text{chem}} + C_{\text{mix}} \frac{R_{\text{charge}}}{D_{\text{CJ}}}$.
  * Check ignition condition: $T_{\text{cell}} > T_{\text{ign}}$.
  * Calculate reacted fuel mass fraction change: $\Delta \rho_{\text{reacted}}$.
  * Apply heat release to conservative energy: $U[i].E \leftarrow U[i].E + \Delta \rho_{\text{reacted}} \cdot Q_{ab}$.
  * Perform phase conversion: subtract $\Delta \rho_{\text{reacted}}$ from $\alpha_1 \rho_1$ and add it to $\alpha_0 \rho_0$.

#### [cfd_solver_2d_step.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_2d_step.cpp)
* Replicate the source term math for the 2D CPU solver.

#### [cfd_solver_2d_cuda.cu](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/cfd_solver_2d_cuda.cu)
* Update the GPU source term kernel (`applySourceTermsKernel`) to execute the afterburn chemistry in parallel.

#### [main.cpp](file:///home/chris/antigrav/blastdemon/backend/BlastSolver/main.cpp)
* Update the `INIT` and `INIT_2D` command handlers to accept custom afterburn parameters when the material is `Custom`. Cache the initial charge dimension $R_{\text{charge}}$ inside the solver class instances.

---

### Component 2: TypeScript Frontend

#### [types.ts](file:///home/chris/antigrav/blastdemon/frontend/src/types.ts)
* Add properties to the `Material` parameters definition:
  * `afterburn_enabled`: boolean
  * `afterburn_energy`: number
  * `afterburn_ignition_temp`: number
  * `afterburn_mixing_time`: number
  * `afterburn_stoich_ratio`: number

#### [property-editor.ts](file:///home/chris/antigrav/blastdemon/frontend/src/property-editor.ts)
* **Preset Handling:** Lock/disable inputs when a preset explosive is selected (e.g., `TNT`). Unlock fields only when composition is set to `Custom`.
* Include the new afterburn properties in the dropdown presets mapping (TNT, RDX, etc.) in `updateParameter()`.

#### [serialization.ts](file:///home/chris/antigrav/blastdemon/frontend/src/serialization.ts)
* Include afterburn parameters in the serialized JSON config sent to the backend during solver initialization.

---

## 7. Verification Plan

### Automated Tests
1. **Dimension Invariance:** Verify that a 1D, 2D, and 3D simulation of a TNT charge yields matching peak temperatures and energy release curves.
2. **Hopkinson-Cranz Scaling Verification:**
   * Run a simulation with a $0.1\text{ kg}$ charge.
   * Run a second simulation with a $1000\text{ kg}$ charge.
   * Verify that the peak pressure at scaled distances is identical, confirming that the dual-timescale model preserves blast scaling.
3. **Quenching Verification:** Verify that charges below a critical size threshold (e.g., $10^{-4}\text{ kg}$) drop below the ignition temperature too quickly to undergo significant afterburn.

### Manual Verification
* Inspect the **TelemetryContour** (2D plotter) and verify the physical shape of the afterburn flame front as it mixes along the shear layers of the expanding blast bubble.
