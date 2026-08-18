export interface MPMMaterialParams {
    density: number;
    youngs_modulus: number;
    poissons_ratio: number;
    yield_stress: number;
    hardening_modulus: number;
    failure_strain: number;
    tensile_failure_stress: number;
    enable_strain_erosion?: boolean;
    erosion_strain?: number;
    enable_stress_erosion?: boolean;
    erosion_stress?: number;
    enable_timestep_erosion?: boolean;
    timestep_erosion_factor?: number;
    jc_A: number;
    jc_B: number;
    jc_n: number;
    jc_C: number;
    jc_m: number;
    T_melt: number;
    T_room: number;
    Cp: number;
    mg_gamma0: number;
    mg_c0: number;
    mg_s: number;
    // Directional Crack Band & Non-Local Damage
    directional_crack_band?: boolean;
    nonlocal_radius?: number;
    // Concrete Core Properties
    fc?: number;
    ft?: number;
    G_f?: number;
    moisture_content?: number;
    dif_cap_compression?: number;
    dif_cap_tension?: number;
    // RHT Concrete
    rht_A?: number;
    rht_N?: number;
    rht_B?: number;
    rht_M?: number;
    rht_Q0?: number;
    rht_BQ?: number;
    rht_D1?: number;
    rht_D2?: number;
    rht_p_crush?: number;
    rht_p_lock?: number;
    rht_alpha0?: number;
    rht_n_comp?: number;
    rht_betac?: number;
    rht_deltat?: number;
    // K&C Concrete
    kc_auto_generate?: boolean;
    kc_a0?: number;
    kc_a1?: number;
    kc_a2?: number;
    kc_a0y?: number;
    kc_a1y?: number;
    kc_a2y?: number;
    kc_a1r?: number;
    kc_a2r?: number;
    kc_b1?: number;
    kc_omega?: number;
    // CSCM Concrete
    cscm_alpha?: number;
    cscm_theta?: number;
    cscm_lambda?: number;
    cscm_beta?: number;
    cscm_R?: number;
    cscm_X0?: number;
    cscm_W?: number;
    cscm_D1?: number;
    cscm_D2?: number;
    // Davis Solid Reactant
    davis_c0?: number;
    davis_s1?: number;
    davis_gamma0?: number;
    davis_cv?: number;
    davis_t0?: number;
    davis_rho0?: number;
    // Davis Product Gas
    davis_a?: number;
    davis_b?: number;
    davis_k?: number;
    davis_vc?: number;
    davis_pc?: number;
    davis_q_det?: number;
    // CREST Reaction Kinetics
    crest_b1?: number;
    crest_c1?: number;
    crest_m1?: number;
    crest_b2?: number;
    crest_c2?: number;
    crest_c3?: number;
    crest_m2?: number;
    crest_s0?: number;
    crest_s_threshold?: number;
    // Ideal Gas CFD
    atm_pressure?: number;
    atm_temperature?: number;
    gamma?: number;
    // JWL CFD
    composition?: string;
    rho?: number;
    detonation_energy?: number;
    det_vel?: number;
    jwl_A?: number;
    jwl_B?: number;
    jwl_R1?: number;
    jwl_R2?: number;
    jwl_omega?: number;
    ideal_gamma?: number;
    ideal_rho_0?: number;
    ideal_e_0?: number;
    reference: string;
    category: string;
}

export interface MPMMaterialParamInfo {
    key: string;
    label: string;
    shortDesc: string;
    unit?: string;
    section: 'model' | 'elasticity' | 'plasticity' | 'failure' | 'erosion' | 'johnson_cook' | 'mie_gruneisen' | 'davis_reactant' | 'davis_product' | 'crest_kinetics' | 'concrete_base' | 'rht' | 'kc' | 'cscm' | 'ideal_gas' | 'jwl';
    tooltip: string;
}

export const MPM_MATERIAL_PARAM_INFO: Record<string, MPMMaterialParamInfo> = {
    'material_model': {
        key: 'material_model',
        label: 'Material Model',
        shortDesc: 'Constitutive formulation',
        section: 'model',
        tooltip: 'Selects the constitutive formulation (Hypoelastic linear hardening vs Johnson-Cook + Mie-Grüneisen shock EOS).'
    },
    'preset': {
        key: 'preset',
        label: 'Material Preset',
        shortDesc: 'Pre-calibrated empirical parameters',
        section: 'model',
        tooltip: 'Loads calibrated material parameters from published shock physics literature.'
    },
    'density': {
        key: 'density',
        label: 'Density',
        shortDesc: 'Solid mass density (ρ₀)',
        unit: 'kg/m³',
        section: 'elasticity',
        tooltip: 'Reference uncompressed solid mass density (rho_0) in kg/m³ for inertia, mass, and shock impedance.'
    },
    'youngs_modulus': {
        key: 'youngs_modulus',
        label: 'Young\'s Modulus (E)',
        shortDesc: 'Elastic tensile stiffness',
        unit: 'Pa',
        section: 'elasticity',
        tooltip: 'Linear elastic tensile modulus E (Pa) - governs elastic stiffness before yielding.'
    },
    'poissons_ratio': {
        key: 'poissons_ratio',
        label: 'Poisson\'s Ratio (ν)',
        shortDesc: 'Lateral contraction ratio',
        unit: 'dim',
        section: 'elasticity',
        tooltip: 'Poisson\'s ratio nu - ratio of transverse contraction to axial extension. Establishes shear modulus G.'
    },
    'yield_stress': {
        key: 'yield_stress',
        label: 'Yield Stress (σ_y0)',
        shortDesc: 'Static initial yield limit',
        unit: 'Pa',
        section: 'plasticity',
        tooltip: 'Static initial yield stress (Pa) where reversible elastic strain ends and plastic flow begins.'
    },
    'hardening_modulus': {
        key: 'hardening_modulus',
        label: 'Hardening Modulus (H)',
        shortDesc: 'Linear plastic tangent slope',
        unit: 'Pa',
        section: 'plasticity',
        tooltip: 'Linear plastic tangent slope H (Pa) for work hardening (Stress = Yield_Stress + H * ep).'
    },
    'failure_strain': {
        key: 'failure_strain',
        label: 'Failure Strain (ε_f)',
        shortDesc: 'Plastic fracture threshold',
        unit: 'dim',
        section: 'failure',
        tooltip: 'Equivalent plastic strain threshold ep_f where ductile fracture occurs and shear resistance is lost.'
    },
    'tensile_failure_stress': {
        key: 'tensile_failure_stress',
        label: 'Tensile Limit / Spall (σ_t)',
        shortDesc: 'Hydrodynamic spallation cutoff',
        unit: 'Pa',
        section: 'failure',
        tooltip: 'Maximum allowable hydrostatic tensile stress (Pa) before cavitation / spall rupture occurs.'
    },
    'enable_strain_erosion': {
        key: 'enable_strain_erosion',
        label: 'Enable Strain Erosion',
        shortDesc: 'Delete element when plastic strain exceeds threshold',
        section: 'erosion',
        tooltip: 'Erode (delete) FEM elements when their accumulated equivalent plastic strain exceeds the erosion strain threshold.'
    },
    'erosion_strain': {
        key: 'erosion_strain',
        label: 'Erosion Strain (ε_ero)',
        shortDesc: 'Plastic strain erosion cutoff',
        unit: 'dim',
        section: 'erosion',
        tooltip: 'Equivalent plastic strain threshold ep_bar at or above which the element is eroded and deleted from the active mesh.'
    },
    'enable_stress_erosion': {
        key: 'enable_stress_erosion',
        label: 'Enable Stress Erosion',
        shortDesc: 'Delete element under hydrostatic tensile rupture',
        section: 'erosion',
        tooltip: 'Erode (delete) FEM elements when mean tensile stress exceeds the tensile erosion threshold.'
    },
    'erosion_stress': {
        key: 'erosion_stress',
        label: 'Erosion Tensile Stress (σ_ero)',
        shortDesc: 'Tensile stress erosion cutoff',
        unit: 'Pa',
        section: 'erosion',
        tooltip: 'Maximum allowable hydrostatic mean tensile stress (Pa) before element is eroded and deleted.'
    },
    'enable_timestep_erosion': {
        key: 'enable_timestep_erosion',
        label: 'Enable Timestep Erosion',
        shortDesc: 'Delete distorted elements choking Courant dt',
        section: 'erosion',
        tooltip: 'Erode highly deformed or inverted elements whose stable Courant time step drops below the fraction threshold of its initial time step.'
    },
    'timestep_erosion_factor': {
        key: 'timestep_erosion_factor',
        label: 'Timestep Erosion Factor (η)',
        shortDesc: 'Courant step erosion ratio dt/dt0',
        unit: 'dim',
        section: 'erosion',
        tooltip: 'Fraction of initial element time step dt0 below which severe distortion triggers element erosion (default 0.10).'
    },
    'jc_A': {
        key: 'jc_A',
        label: 'JC A: Base Yield Stress',
        shortDesc: 'Quasi-static yield strength (A)',
        unit: 'Pa',
        section: 'johnson_cook',
        tooltip: 'Johnson-Cook base yield strength A (Pa) at reference strain rate and room temperature.'
    },
    'jc_B': {
        key: 'jc_B',
        label: 'JC B: Hardening Modulus',
        shortDesc: 'Strain hardening coefficient (B)',
        unit: 'Pa',
        section: 'johnson_cook',
        tooltip: 'Johnson-Cook strain hardening coefficient B (Pa) in the flow stress term (A + B * ep^n).'
    },
    'jc_n': {
        key: 'jc_n',
        label: 'JC n: Hardening Exponent',
        shortDesc: 'Power-law hardening curvature (n)',
        unit: 'dim',
        section: 'johnson_cook',
        tooltip: 'Johnson-Cook work-hardening exponent n (parabolic hardening when n < 1).'
    },
    'jc_C': {
        key: 'jc_C',
        label: 'JC C: Strain Rate Coeff',
        shortDesc: 'Dynamic rate sensitivity (C)',
        unit: 'dim',
        section: 'johnson_cook',
        tooltip: 'Johnson-Cook strain rate sensitivity coefficient C - dynamic strengthening under blast rates.'
    },
    'jc_m': {
        key: 'jc_m',
        label: 'JC m: Thermal Softening',
        shortDesc: 'Softening rate as T → T_melt (m)',
        unit: 'dim',
        section: 'johnson_cook',
        tooltip: 'Johnson-Cook thermal softening exponent m - governs flow stress drop as temperature rises.'
    },
    'T_melt': {
        key: 'T_melt',
        label: 'T Melt: Melting Point',
        shortDesc: 'Zero shear strength temperature',
        unit: 'K',
        section: 'johnson_cook',
        tooltip: 'Melting temperature T_melt (K) - yield stress drops to 0 at or above this temperature.'
    },
    'T_room': {
        key: 'T_room',
        label: 'T Room: Reference Temp',
        shortDesc: 'Ambient temperature baseline',
        unit: 'K',
        section: 'johnson_cook',
        tooltip: 'Reference ambient temperature T_room (K) used to calculate homologous temperature T*.'
    },
    'Cp': {
        key: 'Cp',
        label: 'Cp: Specific Heat',
        shortDesc: 'Plastic work to heat conversion',
        unit: 'J/(kg·K)',
        section: 'johnson_cook',
        tooltip: 'Specific heat capacity Cp (J/kg·K) - converts 90% of plastic work into adiabatic heating.'
    },
    'mg_gamma0': {
        key: 'mg_gamma0',
        label: 'MG Γ₀: Grüneisen Coeff',
        shortDesc: 'Thermal pressure coupling (Γ₀)',
        unit: 'dim',
        section: 'mie_gruneisen',
        tooltip: 'Grüneisen parameter Gamma_0 (dimensionless) - couples thermal internal energy to volumetric shock pressure.'
    },
    'mg_c0': {
        key: 'mg_c0',
        label: 'MG C₀: Bulk Sound Speed',
        shortDesc: 'Zero-pressure shock speed (C₀)',
        unit: 'm/s',
        section: 'mie_gruneisen',
        tooltip: 'Bulk sound speed in uncompressed solid C_0 (m/s) in the shock Hugoniot equation (Us = C_0 + s * Up).'
    },
    'mg_s': {
        key: 'mg_s',
        label: 'MG s: Hugoniot Slope',
        shortDesc: 'Shock velocity vs particle velocity slope (s)',
        unit: 'dim',
        section: 'mie_gruneisen',
        tooltip: 'Dimensionless slope s of the shock velocity vs. particle velocity Hugoniot curve (Us = C_0 + s * Up).'
    },
    // Concrete Core & Fracture Energy
    'fc': {
        key: 'fc',
        label: 'fc: Compressive Strength',
        shortDesc: 'Uniaxial compressive strength',
        unit: 'Pa',
        section: 'concrete_base',
        tooltip: 'Uniaxial quasi-static compressive strength fc (Pa).'
    },
    'ft': {
        key: 'ft',
        label: 'ft: Tensile Strength',
        shortDesc: 'Direct tensile strength',
        unit: 'Pa',
        section: 'concrete_base',
        tooltip: 'Direct tensile cracking strength ft (Pa).'
    },
    'G_f': {
        key: 'G_f',
        label: 'G_f: Fracture Energy',
        shortDesc: 'Tensile crack fracture energy',
        unit: 'N/m',
        section: 'concrete_base',
        tooltip: 'Tensile fracture energy G_f (N/m) for mesh-objective crack regularization (Hillerborg model).'
    },
    'moisture_content': {
        key: 'moisture_content',
        label: 'Moisture Content',
        shortDesc: 'Water saturation mass fraction',
        unit: 'dim',
        section: 'concrete_base',
        tooltip: 'Pore moisture saturation fraction S_w (0 = dry, 1 = fully saturated) for enhanced acoustic shock speed and pore stiffening.'
    },
    'dif_cap_compression': {
        key: 'dif_cap_compression',
        label: 'DIF Cap (Compression)',
        shortDesc: 'Max compressive rate factor',
        unit: 'dim',
        section: 'concrete_base',
        tooltip: 'Maximum allowable Dynamic Increase Factor (DIF) under extreme strain rate compression.'
    },
    'dif_cap_tension': {
        key: 'dif_cap_tension',
        label: 'DIF Cap (Tension)',
        shortDesc: 'Max tensile rate factor',
        unit: 'dim',
        section: 'concrete_base',
        tooltip: 'Maximum allowable Dynamic Increase Factor (DIF) under extreme strain rate tension.'
    },
    // RHT Model
    'rht_A': {
        key: 'rht_A',
        label: 'RHT A: Failure Surface Coeff',
        shortDesc: 'Failure surface multiplier',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT failure surface pre-factor A.'
    },
    'rht_N': {
        key: 'rht_N',
        label: 'RHT N: Pressure Exponent',
        shortDesc: 'Failure surface pressure exponent',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT failure surface pressure hardening exponent N.'
    },
    'rht_B': {
        key: 'rht_B',
        label: 'RHT B: Residual Surface Coeff',
        shortDesc: 'Residual shear multiplier',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT residual friction surface pre-factor B.'
    },
    'rht_M': {
        key: 'rht_M',
        label: 'RHT M: Residual Exponent',
        shortDesc: 'Residual friction exponent',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT residual friction pressure exponent M.'
    },
    'rht_Q0': {
        key: 'rht_Q0',
        label: 'RHT Q₀: Lode Ratio',
        shortDesc: 'Tensile/compressive meridian ratio',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT Lode meridian strength ratio Q0 at zero pressure.'
    },
    'rht_BQ': {
        key: 'rht_BQ',
        label: 'RHT B_Q: Lode Exponent',
        shortDesc: 'Lode angle pressure dependency',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT Lode angle dependence factor BQ.'
    },
    'rht_D1': {
        key: 'rht_D1',
        label: 'RHT D₁: Damage Strain Scaling',
        shortDesc: 'Compressive damage growth factor',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT damage accumulation parameter D1.'
    },
    'rht_D2': {
        key: 'rht_D2',
        label: 'RHT D₂: Damage Pressure Exponent',
        shortDesc: 'Damage pressure confinement factor',
        unit: 'dim',
        section: 'rht',
        tooltip: 'RHT damage confinement exponent D2.'
    },
    'rht_p_crush': {
        key: 'rht_p_crush',
        label: 'RHT p_crush: Pore Crush',
        shortDesc: 'Porous compaction initiation',
        unit: 'Pa',
        section: 'rht',
        tooltip: 'P-alpha EOS pore crush initiation pressure p_crush (Pa).'
    },
    'rht_p_lock': {
        key: 'rht_p_lock',
        label: 'RHT p_lock: Solid Compaction',
        shortDesc: 'Complete pore closure pressure',
        unit: 'Pa',
        section: 'rht',
        tooltip: 'P-alpha EOS solid lock pressure p_lock (Pa) where porosity reaches 0.'
    },
    'rht_alpha0': {
        key: 'rht_alpha0',
        label: 'RHT α₀: Initial Porosity',
        shortDesc: 'Initial porous compaction ratio',
        unit: 'dim',
        section: 'rht',
        tooltip: 'P-alpha EOS initial porous ratio alpha0 = rho_solid / rho_porous.'
    },
    'rht_n_comp': {
        key: 'rht_n_comp',
        label: 'RHT n_comp: Compaction Exponent',
        shortDesc: 'Porous compaction rate',
        unit: 'dim',
        section: 'rht',
        tooltip: 'P-alpha compaction curvature exponent n_comp.'
    },
    'rht_betac': {
        key: 'rht_betac',
        label: 'RHT β_c: Compressive DIF Slope',
        shortDesc: 'DIF compressive rate sensitivity',
        unit: 'dim',
        section: 'rht',
        tooltip: 'Compressive DIF strain rate sensitivity slope beta_c.'
    },
    'rht_deltat': {
        key: 'rht_deltat',
        label: 'RHT δ_t: Tensile DIF Slope',
        shortDesc: 'DIF tensile rate sensitivity',
        unit: 'dim',
        section: 'rht',
        tooltip: 'Tensile DIF strain rate sensitivity slope delta_t.'
    },
    // K&C Model
    'kc_auto_generate': {
        key: 'kc_auto_generate',
        label: 'K&C Auto-Generate Parameters',
        shortDesc: 'Derive surfaces from fc and ft',
        section: 'kc',
        tooltip: 'Automatically computes K&C (MAT_072R3) 3-surface failure envelopes from unconfined compressive strength fc.'
    },
    'kc_a0': {
        key: 'kc_a0',
        label: 'K&C a₀: Max Surface Cohesion',
        shortDesc: 'Maximum failure cohesion',
        unit: 'Pa',
        section: 'kc',
        tooltip: 'K&C maximum yield surface cohesion a0 (Pa).'
    },
    'kc_a1': {
        key: 'kc_a1',
        label: 'K&C a₁: Max Surface Slope',
        shortDesc: 'Maximum friction slope',
        unit: 'dim',
        section: 'kc',
        tooltip: 'K&C maximum yield surface pressure slope a1.'
    },
    'kc_a2': {
        key: 'kc_a2',
        label: 'K&C a₂: Max Surface Curvature',
        shortDesc: 'Maximum pressure curvature',
        unit: '1/Pa',
        section: 'kc',
        tooltip: 'K&C maximum yield surface pressure curvature a2 (1/Pa).'
    },
    'kc_a0y': {
        key: 'kc_a0y',
        label: 'K&C a₀y: Initial Yield Cohesion',
        shortDesc: 'Initial elastic limit cohesion',
        unit: 'Pa',
        section: 'kc',
        tooltip: 'K&C initial yield surface cohesion a0y (Pa).'
    },
    'kc_a1y': {
        key: 'kc_a1y',
        label: 'K&C a₁y: Initial Yield Slope',
        shortDesc: 'Initial elastic limit friction',
        unit: 'dim',
        section: 'kc',
        tooltip: 'K&C initial yield surface pressure slope a1y.'
    },
    'kc_a2y': {
        key: 'kc_a2y',
        label: 'K&C a₂y: Initial Yield Curvature',
        shortDesc: 'Initial yield pressure curvature',
        unit: '1/Pa',
        section: 'kc',
        tooltip: 'K&C initial yield surface pressure curvature a2y (1/Pa).'
    },
    'kc_a1r': {
        key: 'kc_a1r',
        label: 'K&C a₁r: Residual Friction',
        shortDesc: 'Residual friction slope',
        unit: 'dim',
        section: 'kc',
        tooltip: 'K&C residual yield surface pressure slope a1r.'
    },
    'kc_a2r': {
        key: 'kc_a2r',
        label: 'K&C a₂r: Residual Curvature',
        shortDesc: 'Residual pressure curvature',
        unit: '1/Pa',
        section: 'kc',
        tooltip: 'K&C residual yield surface pressure curvature a2r (1/Pa).'
    },
    'kc_b1': {
        key: 'kc_b1',
        label: 'K&C b₁: Damage Softening Rate',
        shortDesc: 'Post-peak softening parameter',
        unit: 'dim',
        section: 'kc',
        tooltip: 'K&C post-peak damage softening evolution parameter b1.'
    },
    'kc_omega': {
        key: 'kc_omega',
        label: 'K&C ω: Dilatancy Factor',
        shortDesc: 'Fractional plastic dilatancy',
        unit: 'dim',
        section: 'kc',
        tooltip: 'K&C fractional dilatancy parameter omega.'
    },
    // CSCM Model
    'cscm_alpha': {
        key: 'cscm_alpha',
        label: 'CSCM α: Triaxial Limit',
        shortDesc: 'Triaxial compression limit',
        unit: 'Pa',
        section: 'cscm',
        tooltip: 'CSCM shear failure surface intercept alpha (Pa).'
    },
    'cscm_theta': {
        key: 'cscm_theta',
        label: 'CSCM θ: Friction Slope',
        shortDesc: 'High-pressure friction slope',
        unit: 'dim',
        section: 'cscm',
        tooltip: 'CSCM linear friction angle parameter theta.'
    },
    'cscm_lambda': {
        key: 'cscm_lambda',
        label: 'CSCM λ: Curvature Strength',
        shortDesc: 'Nonlinear curvature multiplier',
        unit: 'Pa',
        section: 'cscm',
        tooltip: 'CSCM nonlinear shear envelope parameter lambda (Pa).'
    },
    'cscm_beta': {
        key: 'cscm_beta',
        label: 'CSCM β: Curvature Exponent',
        shortDesc: 'Pressure curvature decay',
        unit: '1/Pa',
        section: 'cscm',
        tooltip: 'CSCM exponential curvature decay beta (1/Pa).'
    },
    'cscm_R': {
        key: 'cscm_R',
        label: 'CSCM R: Cap Aspect Ratio',
        shortDesc: 'Elliptical hardening cap ratio',
        unit: 'dim',
        section: 'cscm',
        tooltip: 'CSCM elliptical cap aspect ratio R.'
    },
    'cscm_X0': {
        key: 'cscm_X0',
        label: 'CSCM X₀: Initial Cap Position',
        shortDesc: 'Pore crush cap threshold',
        unit: 'Pa',
        section: 'cscm',
        tooltip: 'CSCM initial cap yield position X0 (Pa).'
    },
    'cscm_W': {
        key: 'cscm_W',
        label: 'CSCM W: Max Plastic Compaction',
        shortDesc: 'Maximum plastic volumetric strain',
        unit: 'dim',
        section: 'cscm',
        tooltip: 'CSCM maximum plastic volume compaction strain W.'
    },
    'cscm_D1': {
        key: 'cscm_D1',
        label: 'CSCM D₁: Brittle Damage Constant',
        shortDesc: 'Tensile brittle damage growth',
        unit: '1/Pa',
        section: 'cscm',
        tooltip: 'CSCM brittle damage growth parameter D1 (1/Pa).'
    },
    'cscm_D2': {
        key: 'cscm_D2',
        label: 'CSCM D₂: Ductile Damage Constant',
        shortDesc: 'Shear ductile damage growth',
        unit: 'dim',
        section: 'cscm',
        tooltip: 'CSCM ductile damage accumulation parameter D2.'
    },
    'directional_crack_band': {
        key: 'directional_crack_band',
        label: 'Directional Crack Band',
        shortDesc: 'Bažant crack angle projection',
        section: 'failure',
        tooltip: 'Scales fracture energy based on principal tensile stress angle, eliminating the 41% energy penalty on 45° diagonal cracks in structured hex meshes.'
    },
    'nonlocal_radius': {
        key: 'nonlocal_radius',
        label: 'Non-Local Damage Radius (Rc)',
        shortDesc: 'Fracture process zone width',
        unit: 'm',
        section: 'failure',
        tooltip: 'Averages damage across elements within physical radius Rc (e.g. 0.05m = 50mm for concrete aggregate, 0.0m for steel). Prevents 1-element grid-aligned razor cuts and enables natural branching cracks.'
    },
    // Davis Solid Reactant
    'davis_c0': {
        key: 'davis_c0',
        label: 'Davis C₀: Reactant Sound Speed',
        shortDesc: 'Solid HE bulk sound speed',
        unit: 'm/s',
        section: 'davis_reactant',
        tooltip: 'Unreacted solid high-explosive bulk acoustic sound speed c0 (m/s).'
    },
    'davis_s1': {
        key: 'davis_s1',
        label: 'Davis s₁: Reactant Hugoniot Slope',
        shortDesc: 'Us-Up linear slope for reactant',
        unit: 'dim',
        section: 'davis_reactant',
        tooltip: 'Hugoniot linear shock-particle velocity slope s1 for the unreacted solid phase.'
    },
    'davis_gamma0': {
        key: 'davis_gamma0',
        label: 'Davis Γ₀: Reactant Grüneisen',
        shortDesc: 'Solid thermal pressure coupling',
        unit: 'dim',
        section: 'davis_reactant',
        tooltip: 'Reference Grüneisen ratio gamma0 for unreacted solid explosive.'
    },
    'davis_cv': {
        key: 'davis_cv',
        label: 'Davis Cv: Specific Heat',
        shortDesc: 'Solid specific heat capacity',
        unit: 'J/(kg·K)',
        section: 'davis_reactant',
        tooltip: 'Specific heat capacity at constant volume for unreacted solid HE (J/(kg·K)).'
    },
    'davis_t0': {
        key: 'davis_t0',
        label: 'Davis T₀: Reference Temp',
        shortDesc: 'Solid initial temperature',
        unit: 'K',
        section: 'davis_reactant',
        tooltip: 'Reference ambient initial temperature T0 (K) for unreacted explosive.'
    },
    'davis_rho0': {
        key: 'davis_rho0',
        label: 'Davis ρ₀: Solid Density',
        shortDesc: 'Unreacted reference density',
        unit: 'kg/m³',
        section: 'davis_reactant',
        tooltip: 'Reference solid explosive mass density rho0 (kg/m³).'
    },
    // Davis Product Gas
    'davis_a': {
        key: 'davis_a',
        label: 'Davis a: Dense Gas Exponent',
        shortDesc: 'High-density isentrope exponent',
        unit: 'dim',
        section: 'davis_product',
        tooltip: 'High-density non-ideal gas isentrope exponent parameter (a).'
    },
    'davis_b': {
        key: 'davis_b',
        label: 'Davis b: Curvature Exponent',
        shortDesc: 'Transition curvature exponent',
        unit: 'dim',
        section: 'davis_product',
        tooltip: 'Transition curvature exponent parameter (b) connecting dense fluid to ideal gas.'
    },
    'davis_k': {
        key: 'davis_k',
        label: 'Davis k: Dilute Adiabatic Exponent',
        shortDesc: 'Low-density adiabatic exponent (k)',
        unit: 'dim',
        section: 'davis_product',
        tooltip: 'Low-density asymptotic adiabatic gas exponent (k = Cp/Cv ≈ 1.30–1.40).'
    },
    'davis_vc': {
        key: 'davis_vc',
        label: 'Davis Vc: Transition Volume',
        shortDesc: 'Characteristic transition relative volume',
        unit: 'dim',
        section: 'davis_product',
        tooltip: 'Characteristic relative volume Vc marking the transition between dense and expanded product states.'
    },
    'davis_pc': {
        key: 'davis_pc',
        label: 'Davis Pc: Transition Pressure',
        shortDesc: 'Characteristic transition pressure',
        unit: 'Pa',
        section: 'davis_product',
        tooltip: 'Characteristic transition pressure Pc (Pa) at volume Vc.'
    },
    'davis_q_det': {
        key: 'davis_q_det',
        label: 'Davis Q: Detonation Energy',
        shortDesc: 'Specific chemical heat of reaction',
        unit: 'J/kg',
        section: 'davis_product',
        tooltip: 'Specific chemical detonation energy release Q (J/kg) converted into product enthalpy.'
    },
    // CREST Reaction Kinetics
    'crest_b1': {
        key: 'crest_b1',
        label: 'CREST b₁: Ignition Rate Coeff',
        shortDesc: 'Hot-spot ignition rate constant',
        unit: '1/s',
        section: 'crest_kinetics',
        tooltip: 'CREST hot-spot ignition rate multiplier b1 (1/s).'
    },
    'crest_c1': {
        key: 'crest_c1',
        label: 'CREST c₁: Ignition Unreacted Power',
        shortDesc: 'Ignition reactant fraction exponent',
        unit: 'dim',
        section: 'crest_kinetics',
        tooltip: 'Exponent c1 on the unreacted solid fraction (1 - λ) in the ignition channel.'
    },
    'crest_m1': {
        key: 'crest_m1',
        label: 'CREST m₁: Ignition Entropy Power',
        shortDesc: 'Ignition shock entropy exponent',
        unit: 'dim',
        section: 'crest_kinetics',
        tooltip: 'Entropy sensitivity exponent m1 for the hot-spot ignition channel.'
    },
    'crest_b2': {
        key: 'crest_b2',
        label: 'CREST b₂: Growth Rate Coeff',
        shortDesc: 'Main grain-burning rate constant',
        unit: '1/s',
        section: 'crest_kinetics',
        tooltip: 'CREST grain-growth burning rate multiplier b2 (1/s).'
    },
    'crest_c2': {
        key: 'crest_c2',
        label: 'CREST c₂: Growth Reacted Power',
        shortDesc: 'Grain-growth product fraction exponent',
        unit: 'dim',
        section: 'crest_kinetics',
        tooltip: 'Exponent c2 on the reacted fraction (λ) representing growing flame surface area.'
    },
    'crest_c3': {
        key: 'crest_c3',
        label: 'CREST c₃: Growth Unreacted Power',
        shortDesc: 'Grain-growth reactant fraction exponent',
        unit: 'dim',
        section: 'crest_kinetics',
        tooltip: 'Exponent c3 on the unreacted fraction (1 - λ) in the growth channel.'
    },
    'crest_m2': {
        key: 'crest_m2',
        label: 'CREST m₂: Growth Entropy Power',
        shortDesc: 'Grain-growth shock entropy exponent',
        unit: 'dim',
        section: 'crest_kinetics',
        tooltip: 'Entropy sensitivity exponent m2 for the grain-growth channel.'
    },
    'crest_s0': {
        key: 'crest_s0',
        label: 'CREST s₀: Entropy Scale',
        shortDesc: 'Reference normalization entropy',
        unit: 'J/(kg·K)',
        section: 'crest_kinetics',
        tooltip: 'Reference shock entropy scale s0 (J/(kg·K)) used to non-dimensionalize effective shock entropy.'
    },
    'crest_s_threshold': {
        key: 'crest_s_threshold',
        label: 'CREST s_th: Ignition Threshold',
        shortDesc: 'Minimum shock entropy to ignite',
        unit: 'J/(kg·K)',
        section: 'crest_kinetics',
        tooltip: 'Minimum shock entropy threshold below which no ignition or reaction progress occurs.'
    },
    // Ideal Gas CFD
    'atm_pressure': {
        key: 'atm_pressure',
        label: 'Ambient Pressure',
        shortDesc: 'Background static pressure',
        unit: 'Pa',
        section: 'ideal_gas',
        tooltip: 'Background atmospheric/fluid static pressure (Pa).'
    },
    'atm_temperature': {
        key: 'atm_temperature',
        label: 'Ambient Temperature',
        shortDesc: 'Background static temperature',
        unit: 'K',
        section: 'ideal_gas',
        tooltip: 'Background ambient temperature (K).'
    },
    'gamma': {
        key: 'gamma',
        label: 'Specific Heat Ratio (γ)',
        shortDesc: 'Ratio of specific heats Cp/Cv',
        unit: 'dim',
        section: 'ideal_gas',
        tooltip: 'Specific heat ratio gamma = Cp / Cv (1.40 for diatomic air, 1.667 for noble gases).'
    },
    // JWL CFD
    'composition': {
        key: 'composition',
        label: 'Explosive Composition',
        shortDesc: 'Chemical composition name',
        section: 'jwl',
        tooltip: 'High explosive chemical formulation identifier.'
    },
    'rho': {
        key: 'rho',
        label: 'Solid Density (ρ)',
        shortDesc: 'Unreacted solid density',
        unit: 'kg/m³',
        section: 'jwl',
        tooltip: 'Unreacted solid explosive density (kg/m³).'
    },
    'detonation_energy': {
        key: 'detonation_energy',
        label: 'Detonation Energy (E₀)',
        shortDesc: 'Specific chemical energy release',
        unit: 'J/kg',
        section: 'jwl',
        tooltip: 'Volumetric chemical detonation energy release E0 (J/kg).'
    },
    'det_vel': {
        key: 'det_vel',
        label: 'Detonation Velocity (D)',
        shortDesc: 'Chapman-Jouguet detonation wave speed',
        unit: 'm/s',
        section: 'jwl',
        tooltip: 'Chapman-Jouguet steady detonation wave speed D (m/s).'
    },
    'jwl_A': {
        key: 'jwl_A',
        label: 'JWL A: High-Pressure Coeff',
        shortDesc: 'JWL high-pressure expansion term',
        unit: 'Pa',
        section: 'jwl',
        tooltip: 'JWL high-pressure expansion coefficient A (Pa).'
    },
    'jwl_B': {
        key: 'jwl_B',
        label: 'JWL B: Mid-Pressure Coeff',
        shortDesc: 'JWL mid-pressure expansion term',
        unit: 'Pa',
        section: 'jwl',
        tooltip: 'JWL mid-pressure expansion coefficient B (Pa).'
    },
    'jwl_R1': {
        key: 'jwl_R1',
        label: 'JWL R₁: High-Pressure Decay',
        shortDesc: 'JWL exponential decay rate 1',
        unit: 'dim',
        section: 'jwl',
        tooltip: 'Non-dimensional high-pressure exponential decay rate R1.'
    },
    'jwl_R2': {
        key: 'jwl_R2',
        label: 'JWL R₂: Mid-Pressure Decay',
        shortDesc: 'JWL exponential decay rate 2',
        unit: 'dim',
        section: 'jwl',
        tooltip: 'Non-dimensional mid-pressure exponential decay rate R2.'
    },
    'jwl_omega': {
        key: 'jwl_omega',
        label: 'JWL ω: Grüneisen Parameter',
        shortDesc: 'JWL fractional Grüneisen ratio',
        unit: 'dim',
        section: 'jwl',
        tooltip: 'Fractional Grüneisen ratio omega = Cp/Cv - 1 for product gas.'
    }
};

export interface MPMCategoryGroup {
    category: string;
    presets: string[];
}

export const MPM_MATERIAL_CATEGORIES: MPMCategoryGroup[] = [
    {
        category: 'Structural & Military Steels',
        presets: [
            'Structural Steel (A36)',
            'Steel S275',
            'Steel S355',
            'Steel S460',
            'Steel 1006',
            'Steel 1020',
            'Steel 4340',
            'Q1N (HY-80 Naval Steel)',
            'HY-100 Steel',
            'RHA (Rolled Homogeneous Armor)',
            'Armox 500T',
            'Armox 600T',
            'Weldox 700E',
            'Weldox 900E',
            'Stainless Steel 304',
            'Stainless Steel 316L',
            'Tool Steel D2'
        ]
    },
    {
        category: 'Light Alloys & Refractory Metals',
        presets: [
            'Aluminum 6061-T6',
            'Aluminum 7075-T6',
            'Aluminum 2024-T3',
            'Aluminum 1100-O',
            'Aluminum 5083-H116',
            'Copper (OFHC)',
            'Copper (C11000)',
            'Brass 260 (Cartridge Brass)',
            'Bronze (C93200)',
            'Titanium Ti-6Al-4V',
            'Titanium CP (Grade 2)',
            'Tantalum (Pure)',
            'Tungsten (Pure)',
            'Tungsten Heavy Alloy (W-Ni-Fe)',
            'Depleted Uranium (DU-0.75Ti)',
            'Lead (Chemical Pure)',
            'Nickel 200',
            'Inconel 718',
            'Beryllium (S-200F)'
        ]
    },
    {
        category: 'Concrete & Masonry Strength Grades',
        presets: [
            'Normal-Strength Concrete C20/25 (20 MPa)',
            'Standard Structural Concrete C30/37 (30 MPa)',
            'High-Strength Concrete C50/60 (50 MPa)',
            'Ultra-High Performance Concrete C100/115 (100 MPa)',
            'UHPC / Ductal (150 MPa)',
            'Fiber-Reinforced Concrete (FRC 60 MPa)',
            'Clay Brick Masonry',
            'Aerated Autoclaved Concrete (AAC)'
        ]
    },
    {
        category: 'Soils, Rocks & Geomaterial Strengths',
        presets: [
            'Soft Marine Clay (Cu = 25 kPa)',
            'Stiff Silty Clay (Cu = 100 kPa)',
            'Loose Dry Sand (Dr = 30%)',
            'Dense Compacted Sand (Dr = 85%)',
            'Compacted Gravel Subgrade',
            'Westerly Granite',
            'Berea Sandstone',
            'Limestone (Solnhofen)',
            'Ice / Permafrost (-5°C)'
        ]
    },
    {
        category: 'Energetic Solids & Unreacted Explosives',
        presets: [
            'Aluminized ANFO (Unreacted)',
            'Ammonal (Unreacted)',
            'ANFO (Unreacted)',
            'Baratol (Unreacted)',
            'C-4 (Unreacted)',
            'Composition A-3 (Unreacted)',
            'Composition B (Unreacted)',
            'Composition C-3 (Unreacted)',
            'Cyclotol (Unreacted)',
            'Heavy ANFO (Unreacted)',
            'HMX (Unreacted)',
            'LX-04 (Unreacted)',
            'LX-07 (Unreacted)',
            'LX-10 (Unreacted)',
            'LX-14 (Unreacted)',
            'LX-17 (Unreacted)',
            'Mining Emulsion (Unreacted)',
            'Octol (Unreacted)',
            'PBX 9404 (Unreacted)',
            'PBX 9501 (Unreacted)',
            'PBX 9502 (Unreacted)',
            'PE-10 (Unreacted)',
            'PE-12 (Unreacted)',
            'PE-4 (Unreacted)',
            'PE-8 (Unreacted)',
            'Pentolite (Unreacted)',
            'PETN (Unreacted)',
            'RDX (Unreacted)',
            'TATB (Unreacted)',
            'Tetryl (Unreacted)',
            'TNT (Unreacted)',
            'Water Gel (Unreacted)'
        ]
    },
    {
        category: 'Polymers & High-Performance Thermoplastics',
        presets: [
            'Polycarbonate (Lexan)',
            'UHMWPE',
            'PMMA (Acrylic / Plexiglas)',
            'Nylon 6-6',
            'PTFE (Teflon)',
            'PEEK',
            'Kevlar-Epoxy Composite'
        ]
    },
    {
        category: 'Technical Ceramics & Armor Glasses',
        presets: [
            'Boron Carbide (B4C)',
            'Silicon Carbide (SiC)',
            'Alumina (Al2O3 - 99.5%)',
            'Soda-Lime Glass',
            'Fused Silica Glass',
            'Titanium Diboride (TiB2)'
        ]
    },
    {
        category: 'Soft Materials, Bio-Surrogates & Composites',
        presets: [
            'Ballistic Gelatin (10% 4°C)',
            'Ballistic Gelatin (20% 4°C)',
            'Water (Hydrodynamic Shock)',
            'Al-PTFE Reactive Material',
            'Al-Al2O3 MMC'
        ]
    },
    {
        category: 'Ideal Gas Presets (Eulerian CFD)',
        presets: [
            'Air (Standard STP, gamma=1.4)',
            'Air (Dry Sea-Level STP)',
            'Air (Stratosphere 20km)',
            'Air (High-Temperature Shock 1000K)',
            'Nitrogen (N2, gamma=1.40)',
            'Oxygen (O2, gamma=1.40)',
            'Helium (Noble, gamma=1.667)',
            'Argon (Noble, gamma=1.667)',
            'Neon (Noble, gamma=1.667)',
            'Krypton (Noble, gamma=1.667)',
            'Xenon (Noble, gamma=1.667)',
            'Hydrogen (H2, gamma=1.41)',
            'Methane (CH4, gamma=1.32)',
            'Propane (C3H8, gamma=1.13)',
            'Ethylene (C2H4, gamma=1.24)',
            'Acetylene (C2H2, gamma=1.23)',
            'Carbon Monoxide (CO, gamma=1.40)',
            'Carbon Dioxide (CO2, gamma=1.30)',
            'Sulfur Hexafluoride (SF6, gamma=1.09)',
            'Ammonia (NH3, gamma=1.31)',
            'Nitrous Oxide (N2O, gamma=1.30)',
            'Water Vapor / Steam (H2O, gamma=1.33)',
            'Chlorine (Cl2, gamma=1.34)'
        ]
    },
    {
        category: 'JWL Detonation Gas Presets (Eulerian CFD)',
        presets: [
            'TNT (Trinitrotoluene)',
            'C-4 (Composition 4)',
            'Composition B (Comp B)',
            'PETN (Pentaerythritol Tetranitrate)',
            'HMX (Octogen / EDC37)',
            'RDX (Hexogen / Cyclonite)',
            'PBX 9501',
            'PBX 9502',
            'LX-04',
            'LX-07',
            'LX-10',
            'LX-14',
            'LX-17',
            'ANFO (Ammonium Nitrate / Fuel Oil)',
            'Aluminized ANFO',
            'Heavy ANFO',
            'Ammonal',
            'Tritonal (80% TNT / 20% Al)',
            'Pentolite 50/50',
            'Semtex 1A',
            'Tetryl',
            'Mining Emulsion',
            'Water Gel'
        ]
    },
    {
        category: 'Custom Settings',
        presets: [
            'Custom'
        ]
    }
];

export const MPM_MATERIAL_PRESET_NAMES = MPM_MATERIAL_CATEGORIES.flatMap(cat => cat.presets);
export type MPMMaterialPresetName = string;

export const MPM_MATERIAL_PRESETS: Record<string, MPMMaterialParams> = {
    // ---------------------------------------------------------
    // 1. Structural & Military Steels
    // ---------------------------------------------------------
    'Structural Steel (A36)': {
        density: 7850.0, youngs_modulus: 200.0e9, poissons_ratio: 0.26, yield_stress: 250.0e6, hardening_modulus: 1.0e9, failure_strain: 0.20, tensile_failure_stress: 400.0e6,
        jc_A: 250.0e6, jc_B: 510.0e6, jc_n: 0.26, jc_C: 0.014, jc_m: 1.03, T_melt: 1793.0, T_room: 293.0, Cp: 486.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'ASTM A36 Standard / LLNL Explosives Handbook'
    },
    'Steel S275': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 275.0e6, hardening_modulus: 900.0e6, failure_strain: 0.23, tensile_failure_stress: 430.0e6,
        jc_A: 275.0e6, jc_B: 450.0e6, jc_n: 0.28, jc_C: 0.014, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 475.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'BS EN 10025-2 Standard Structural Steel'
    },
    'Steel S355': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 355.0e6, hardening_modulus: 1.0e9, failure_strain: 0.22, tensile_failure_stress: 510.0e6,
        jc_A: 355.0e6, jc_B: 480.0e6, jc_n: 0.27, jc_C: 0.014, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 475.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'EN 10025-2 European Standard Structural Steel'
    },
    'Steel S460': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 460.0e6, hardening_modulus: 1.1e9, failure_strain: 0.19, tensile_failure_stress: 600.0e6,
        jc_A: 460.0e6, jc_B: 520.0e6, jc_n: 0.26, jc_C: 0.014, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 475.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'EN 10025-3 High Yield Structural Steel'
    },
    'Steel 1006': {
        density: 7890.0, youngs_modulus: 205.0e9, poissons_ratio: 0.29, yield_stress: 350.0e6, hardening_modulus: 800.0e6, failure_strain: 0.30, tensile_failure_stress: 450.0e6,
        jc_A: 350.0e6, jc_B: 275.0e6, jc_n: 0.36, jc_C: 0.022, jc_m: 1.00, T_melt: 1811.0, T_room: 293.0, Cp: 452.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Bane & Johnson, J. Appl. Mech. (1985)'
    },
    'Steel 1020': {
        density: 7870.0, youngs_modulus: 200.0e9, poissons_ratio: 0.29, yield_stress: 330.0e6, hardening_modulus: 900.0e6, failure_strain: 0.28, tensile_failure_stress: 420.0e6,
        jc_A: 330.0e6, jc_B: 410.0e6, jc_n: 0.32, jc_C: 0.019, jc_m: 1.00, T_melt: 1790.0, T_room: 293.0, Cp: 486.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'ASM Metals Handbook Vol. 1'
    },
    'Steel 4340': {
        density: 7830.0, youngs_modulus: 207.0e9, poissons_ratio: 0.29, yield_stress: 792.0e6, hardening_modulus: 1.2e9, failure_strain: 0.25, tensile_failure_stress: 1000.0e6,
        jc_A: 792.0e6, jc_B: 510.0e6, jc_n: 0.26, jc_C: 0.014, jc_m: 1.03, T_melt: 1793.0, T_room: 293.0, Cp: 477.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Johnson & Cook (1983) 7th Int. Symp. Ballistics'
    },
    'Q1N (HY-80 Naval Steel)': {
        density: 7850.0, youngs_modulus: 205.0e9, poissons_ratio: 0.29, yield_stress: 550.0e6, hardening_modulus: 1.1e9, failure_strain: 0.22, tensile_failure_stress: 700.0e6,
        jc_A: 550.0e6, jc_B: 600.0e6, jc_n: 0.30, jc_C: 0.015, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'MIL-S-16216 Naval Submarine Armor Steel'
    },
    'HY-100 Steel': {
        density: 7850.0, youngs_modulus: 205.0e9, poissons_ratio: 0.29, yield_stress: 690.0e6, hardening_modulus: 1.2e9, failure_strain: 0.20, tensile_failure_stress: 820.0e6,
        jc_A: 690.0e6, jc_B: 650.0e6, jc_n: 0.28, jc_C: 0.015, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'MIL-S-16216 Submarine Pressure Hull Armor'
    },
    'RHA (Rolled Homogeneous Armor)': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 950.0e6, hardening_modulus: 1.3e9, failure_strain: 0.18, tensile_failure_stress: 1100.0e6,
        jc_A: 950.0e6, jc_B: 720.0e6, jc_n: 0.25, jc_C: 0.012, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'MIL-A-12560 Armor Plate Benchmark'
    },
    'Armox 500T': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 1250.0e6, hardening_modulus: 1.5e9, failure_strain: 0.15, tensile_failure_stress: 1600.0e6,
        jc_A: 1250.0e6, jc_B: 840.0e6, jc_n: 0.26, jc_C: 0.005, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Borvik et al., Int. J. Impact Eng. (2009)'
    },
    'Armox 600T': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 1650.0e6, hardening_modulus: 1.8e9, failure_strain: 0.10, tensile_failure_stress: 2000.0e6,
        jc_A: 1650.0e6, jc_B: 950.0e6, jc_n: 0.20, jc_C: 0.005, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'SSAB Armox Ultra-High Hardness Armor'
    },
    'Weldox 700E': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 700.0e6, hardening_modulus: 1.2e9, failure_strain: 0.16, tensile_failure_stress: 800.0e6,
        jc_A: 700.0e6, jc_B: 560.0e6, jc_n: 0.26, jc_C: 0.014, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Borvik et al., Eur. J. Mech. A (2001)'
    },
    'Weldox 900E': {
        density: 7850.0, youngs_modulus: 210.0e9, poissons_ratio: 0.30, yield_stress: 900.0e6, hardening_modulus: 1.4e9, failure_strain: 0.14, tensile_failure_stress: 1000.0e6,
        jc_A: 900.0e6, jc_B: 620.0e6, jc_n: 0.24, jc_C: 0.012, jc_m: 1.00, T_melt: 1773.0, T_room: 293.0, Cp: 470.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Dey et al., Int. J. Solids Struct. (2004)'
    },
    'Stainless Steel 304': {
        density: 7900.0, youngs_modulus: 193.0e9, poissons_ratio: 0.29, yield_stress: 310.0e6, hardening_modulus: 1.0e9, failure_strain: 0.40, tensile_failure_stress: 620.0e6,
        jc_A: 310.0e6, jc_B: 1000.0e6, jc_n: 0.65, jc_C: 0.070, jc_m: 1.00, T_melt: 1673.0, T_room: 293.0, Cp: 500.0, mg_gamma0: 1.93, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Lee et al., J. Mater. Process. Technol. (2002)'
    },
    'Stainless Steel 316L': {
        density: 7980.0, youngs_modulus: 193.0e9, poissons_ratio: 0.30, yield_stress: 290.0e6, hardening_modulus: 950.0e6, failure_strain: 0.45, tensile_failure_stress: 580.0e6,
        jc_A: 290.0e6, jc_B: 940.0e6, jc_n: 0.61, jc_C: 0.065, jc_m: 1.00, T_melt: 1650.0, T_room: 293.0, Cp: 500.0, mg_gamma0: 1.93, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'Follansbee & Kocks, Acta Metall. (1988)'
    },
    'Tool Steel D2': {
        density: 7700.0, youngs_modulus: 210.0e9, poissons_ratio: 0.28, yield_stress: 1600.0e6, hardening_modulus: 2.0e9, failure_strain: 0.10, tensile_failure_stress: 1900.0e6,
        jc_A: 1600.0e6, jc_B: 900.0e6, jc_n: 0.20, jc_C: 0.010, jc_m: 1.00, T_melt: 1690.0, T_room: 293.0, Cp: 460.0, mg_gamma0: 1.81, mg_c0: 4570.0, mg_s: 1.49,
        category: 'Structural & Military Steels', reference: 'ASM Specialty Handbook: Tool Materials'
    },

    // ---------------------------------------------------------
    // 2. Light Alloys & Refractory Metals
    // ---------------------------------------------------------
    'Aluminum 6061-T6': {
        density: 2700.0, youngs_modulus: 68.9e9, poissons_ratio: 0.33, yield_stress: 324.0e6, hardening_modulus: 400.0e6, failure_strain: 0.17, tensile_failure_stress: 310.0e6,
        jc_A: 324.0e6, jc_B: 114.0e6, jc_n: 0.42, jc_C: 0.002, jc_m: 1.34, T_melt: 925.0, T_room: 293.0, Cp: 896.0, mg_gamma0: 1.97, mg_c0: 5240.0, mg_s: 1.40,
        category: 'Light Alloys & Refractory Metals', reference: 'Lesuer, LLNL Report UCRL-ID-138054 (2000)'
    },
    'Aluminum 7075-T6': {
        density: 2810.0, youngs_modulus: 71.7e9, poissons_ratio: 0.33, yield_stress: 520.0e6, hardening_modulus: 600.0e6, failure_strain: 0.11, tensile_failure_stress: 570.0e6,
        jc_A: 520.0e6, jc_B: 477.0e6, jc_n: 0.52, jc_C: 0.001, jc_m: 1.61, T_melt: 893.0, T_room: 293.0, Cp: 960.0, mg_gamma0: 2.00, mg_c0: 5200.0, mg_s: 1.39,
        category: 'Light Alloys & Refractory Metals', reference: 'Nicholas, Exp. Mech. (1981)'
    },
    'Aluminum 2024-T3': {
        density: 2780.0, youngs_modulus: 73.1e9, poissons_ratio: 0.33, yield_stress: 369.0e6, hardening_modulus: 550.0e6, failure_strain: 0.18, tensile_failure_stress: 485.0e6,
        jc_A: 369.0e6, jc_B: 684.0e6, jc_n: 0.73, jc_C: 0.0083, jc_m: 1.70, T_melt: 775.0, T_room: 293.0, Cp: 875.0, mg_gamma0: 2.00, mg_c0: 5320.0, mg_s: 1.34,
        category: 'Light Alloys & Refractory Metals', reference: 'Buyuk et al., Int. J. Impact Eng. (2009)'
    },
    'Aluminum 1100-O': {
        density: 2710.0, youngs_modulus: 69.0e9, poissons_ratio: 0.33, yield_stress: 34.0e6, hardening_modulus: 200.0e6, failure_strain: 0.35, tensile_failure_stress: 90.0e6,
        jc_A: 34.0e6, jc_B: 250.0e6, jc_n: 0.35, jc_C: 0.001, jc_m: 1.00, T_melt: 933.0, T_room: 293.0, Cp: 904.0, mg_gamma0: 1.97, mg_c0: 5240.0, mg_s: 1.40,
        category: 'Light Alloys & Refractory Metals', reference: 'Steinberg, LLNL Report UCRL-MA-106439 (1996)'
    },
    'Aluminum 5083-H116': {
        density: 2660.0, youngs_modulus: 70.3e9, poissons_ratio: 0.33, yield_stress: 215.0e6, hardening_modulus: 350.0e6, failure_strain: 0.16, tensile_failure_stress: 315.0e6,
        jc_A: 215.0e6, jc_B: 390.0e6, jc_n: 0.45, jc_C: 0.005, jc_m: 1.20, T_melt: 864.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.97, mg_c0: 5240.0, mg_s: 1.40,
        category: 'Light Alloys & Refractory Metals', reference: 'Clausen et al., Int. J. Impact Eng. (2004)'
    },
    'Copper (OFHC)': {
        density: 8960.0, youngs_modulus: 124.0e9, poissons_ratio: 0.34, yield_stress: 90.0e6, hardening_modulus: 292.0e6, failure_strain: 0.54, tensile_failure_stress: 230.0e6,
        jc_A: 90.0e6, jc_B: 292.0e6, jc_n: 0.31, jc_C: 0.025, jc_m: 1.09, T_melt: 1356.0, T_room: 293.0, Cp: 383.0, mg_gamma0: 2.02, mg_c0: 3940.0, mg_s: 1.49,
        category: 'Light Alloys & Refractory Metals', reference: 'Johnson & Cook (1983) 7th Int. Symp. Ballistics'
    },
    'Copper (C11000)': {
        density: 8890.0, youngs_modulus: 117.0e9, poissons_ratio: 0.34, yield_stress: 70.0e6, hardening_modulus: 280.0e6, failure_strain: 0.45, tensile_failure_stress: 220.0e6,
        jc_A: 70.0e6, jc_B: 280.0e6, jc_n: 0.30, jc_C: 0.020, jc_m: 1.00, T_melt: 1356.0, T_room: 293.0, Cp: 385.0, mg_gamma0: 2.02, mg_c0: 3940.0, mg_s: 1.49,
        category: 'Light Alloys & Refractory Metals', reference: 'Copper Development Association (CDA) Data Sheet'
    },
    'Brass 260 (Cartridge Brass)': {
        density: 8530.0, youngs_modulus: 110.0e9, poissons_ratio: 0.37, yield_stress: 112.0e6, hardening_modulus: 500.0e6, failure_strain: 0.50, tensile_failure_stress: 315.0e6,
        jc_A: 112.0e6, jc_B: 505.0e6, jc_n: 0.42, jc_C: 0.009, jc_m: 1.68, T_melt: 1189.0, T_room: 293.0, Cp: 377.0, mg_gamma0: 2.04, mg_c0: 3830.0, mg_s: 1.43,
        category: 'Light Alloys & Refractory Metals', reference: 'Johnson & Cook (1983) Ballistics Benchmark'
    },
    'Bronze (C93200)': {
        density: 8930.0, youngs_modulus: 100.0e9, poissons_ratio: 0.34, yield_stress: 140.0e6, hardening_modulus: 400.0e6, failure_strain: 0.20, tensile_failure_stress: 240.0e6,
        jc_A: 140.0e6, jc_B: 400.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 1273.0, T_room: 293.0, Cp: 377.0, mg_gamma0: 2.00, mg_c0: 3800.0, mg_s: 1.45,
        category: 'Light Alloys & Refractory Metals', reference: 'ASM Metals Handbook Vol. 2'
    },
    'Titanium Ti-6Al-4V': {
        density: 4430.0, youngs_modulus: 113.8e9, poissons_ratio: 0.342, yield_stress: 1098.0e6, hardening_modulus: 1092.0e6, failure_strain: 0.14, tensile_failure_stress: 1170.0e6,
        jc_A: 1098.0e6, jc_B: 1092.0e6, jc_n: 0.93, jc_C: 0.014, jc_m: 1.10, T_melt: 1878.0, T_room: 293.0, Cp: 526.0, mg_gamma0: 1.23, mg_c0: 5130.0, mg_s: 1.028,
        category: 'Light Alloys & Refractory Metals', reference: 'Kay, LLNL Report UCRL-ID-146715 (2002)'
    },
    'Titanium CP (Grade 2)': {
        density: 4510.0, youngs_modulus: 105.0e9, poissons_ratio: 0.34, yield_stress: 275.0e6, hardening_modulus: 500.0e6, failure_strain: 0.20, tensile_failure_stress: 345.0e6,
        jc_A: 275.0e6, jc_B: 450.0e6, jc_n: 0.40, jc_C: 0.012, jc_m: 1.00, T_melt: 1933.0, T_room: 293.0, Cp: 523.0, mg_gamma0: 1.23, mg_c0: 5130.0, mg_s: 1.028,
        category: 'Light Alloys & Refractory Metals', reference: 'TIMET Titanium Technical Data Sheet'
    },
    'Tantalum (Pure)': {
        density: 16650.0, youngs_modulus: 186.0e9, poissons_ratio: 0.34, yield_stress: 175.0e6, hardening_modulus: 540.0e6, failure_strain: 0.40, tensile_failure_stress: 205.0e6,
        jc_A: 175.0e6, jc_B: 540.0e6, jc_n: 0.32, jc_C: 0.045, jc_m: 0.50, T_melt: 3290.0, T_room: 293.0, Cp: 140.0, mg_gamma0: 1.60, mg_c0: 3410.0, mg_s: 1.20,
        category: 'Light Alloys & Refractory Metals', reference: 'Meyers et al., Metall. Mater. Trans. A (1995)'
    },
    'Tungsten (Pure)': {
        density: 19300.0, youngs_modulus: 411.0e9, poissons_ratio: 0.28, yield_stress: 1500.0e6, hardening_modulus: 800.0e6, failure_strain: 0.05, tensile_failure_stress: 1700.0e6,
        jc_A: 1500.0e6, jc_B: 500.0e6, jc_n: 0.25, jc_C: 0.016, jc_m: 1.00, T_melt: 3695.0, T_room: 293.0, Cp: 134.0, mg_gamma0: 1.67, mg_c0: 4030.0, mg_s: 1.237,
        category: 'Light Alloys & Refractory Metals', reference: 'Marsh, LASL Shock Hugoniot Data (1980)'
    },
    'Tungsten Heavy Alloy (W-Ni-Fe)': {
        density: 17600.0, youngs_modulus: 360.0e9, poissons_ratio: 0.29, yield_stress: 670.0e6, hardening_modulus: 700.0e6, failure_strain: 0.15, tensile_failure_stress: 960.0e6,
        jc_A: 670.0e6, jc_B: 650.0e6, jc_n: 0.30, jc_C: 0.016, jc_m: 1.00, T_melt: 1750.0, T_room: 293.0, Cp: 150.0, mg_gamma0: 1.67, mg_c0: 3900.0, mg_s: 1.25,
        category: 'Light Alloys & Refractory Metals', reference: 'Coates & Ramesh, Mater. Sci. Eng. A (1998)'
    },
    'Depleted Uranium (DU-0.75Ti)': {
        density: 18600.0, youngs_modulus: 172.0e9, poissons_ratio: 0.23, yield_stress: 850.0e6, hardening_modulus: 600.0e6, failure_strain: 0.22, tensile_failure_stress: 1300.0e6,
        jc_A: 850.0e6, jc_B: 550.0e6, jc_n: 0.25, jc_C: 0.030, jc_m: 1.00, T_melt: 1405.0, T_room: 293.0, Cp: 116.0, mg_gamma0: 2.32, mg_c0: 2490.0, mg_s: 1.54,
        category: 'Light Alloys & Refractory Metals', reference: 'Armstrong et al., J. Phys. IV (1997)'
    },
    'Lead (Chemical Pure)': {
        density: 11340.0, youngs_modulus: 16.0e9, poissons_ratio: 0.44, yield_stress: 12.0e6, hardening_modulus: 50.0e6, failure_strain: 0.50, tensile_failure_stress: 18.0e6,
        jc_A: 12.0e6, jc_B: 45.0e6, jc_n: 0.50, jc_C: 0.010, jc_m: 1.00, T_melt: 600.6, T_room: 293.0, Cp: 129.0, mg_gamma0: 2.74, mg_c0: 2050.0, mg_s: 1.46,
        category: 'Light Alloys & Refractory Metals', reference: 'Steinberg, LLNL Report UCRL-MA-106439 (1996)'
    },
    'Nickel 200': {
        density: 8890.0, youngs_modulus: 207.0e9, poissons_ratio: 0.31, yield_stress: 148.0e6, hardening_modulus: 600.0e6, failure_strain: 0.40, tensile_failure_stress: 462.0e6,
        jc_A: 148.0e6, jc_B: 580.0e6, jc_n: 0.38, jc_C: 0.010, jc_m: 1.00, T_melt: 1726.0, T_room: 293.0, Cp: 456.0, mg_gamma0: 1.93, mg_c0: 4600.0, mg_s: 1.44,
        category: 'Light Alloys & Refractory Metals', reference: 'Special Metals Nickel Alloys Handbook'
    },
    'Inconel 718': {
        density: 8190.0, youngs_modulus: 205.0e9, poissons_ratio: 0.29, yield_stress: 1180.0e6, hardening_modulus: 1200.0e6, failure_strain: 0.15, tensile_failure_stress: 1375.0e6,
        jc_A: 1180.0e6, jc_B: 1300.0e6, jc_n: 0.65, jc_C: 0.013, jc_m: 1.30, T_melt: 1609.0, T_room: 293.0, Cp: 435.0, mg_gamma0: 1.90, mg_c0: 4500.0, mg_s: 1.40,
        category: 'Light Alloys & Refractory Metals', reference: 'Pereira et al., Mater. Des. (2014)'
    },
    'Beryllium (S-200F)': {
        density: 1850.0, youngs_modulus: 287.0e9, poissons_ratio: 0.07, yield_stress: 345.0e6, hardening_modulus: 400.0e6, failure_strain: 0.03, tensile_failure_stress: 470.0e6,
        jc_A: 345.0e6, jc_B: 200.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 1560.0, T_room: 293.0, Cp: 1825.0, mg_gamma0: 1.18, mg_c0: 7990.0, mg_s: 1.124,
        category: 'Light Alloys & Refractory Metals', reference: 'Steinberg, LLNL Report UCRL-MA-106439 (1996)'
    },

    // ---------------------------------------------------------
    // 3. Concrete & Masonry Strength Grades
    // ---------------------------------------------------------
    'Normal-Strength Concrete C20/25 (20 MPa)': {
        density: 2300.0, youngs_modulus: 30.0e9, poissons_ratio: 0.20, yield_stress: 20.0e6, hardening_modulus: 200.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 2.2e6,
        fc: 20.0e6, ft: 2.2e6, G_f: 75.0, moisture_content: 0.04, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.60, rht_N: 0.61, rht_B: 0.70, rht_M: 0.80, rht_Q0: 0.68, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0, rht_p_crush: 6.67e6, rht_p_lock: 6.0e9, rht_alpha0: 1.28, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        kc_auto_generate: true, kc_a0: 6.67e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 5.33e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.60, kc_omega: 0.50,
        cscm_alpha: 7.0e6, cscm_theta: 0.38, cscm_lambda: 5.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 60.0e6, cscm_W: 0.05, cscm_D1: 2.5e-9, cscm_D2: 1.0,
        jc_A: 20.0e6, jc_B: 150.0e6, jc_n: 0.40, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3000.0, mg_s: 1.20,
        category: 'Concrete & Masonry Strength Grades', reference: 'Eurocode 2 EN 1992-1-1 / Riedel-Hiermaier-Thoma (RHT) Model'
    },
    'Standard Structural Concrete C30/37 (30 MPa)': {
        density: 2350.0, youngs_modulus: 33.0e9, poissons_ratio: 0.20, yield_stress: 30.0e6, hardening_modulus: 250.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 2.9e6,
        fc: 30.0e6, ft: 2.9e6, G_f: 90.0, moisture_content: 0.04, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.60, rht_N: 0.61, rht_B: 0.70, rht_M: 0.80, rht_Q0: 0.68, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0, rht_p_crush: 10.0e6, rht_p_lock: 6.0e9, rht_alpha0: 1.25, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        kc_auto_generate: true, kc_a0: 10.0e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 8.0e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.60, kc_omega: 0.50,
        cscm_alpha: 10.5e6, cscm_theta: 0.40, cscm_lambda: 7.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 85.0e6, cscm_W: 0.05, cscm_D1: 2.5e-9, cscm_D2: 1.0,
        jc_A: 30.0e6, jc_B: 180.0e6, jc_n: 0.40, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3100.0, mg_s: 1.25,
        category: 'Concrete & Masonry Strength Grades', reference: 'Eurocode 2 C30/37 Standard / RHT Benchmark'
    },
    'High-Strength Concrete C50/60 (50 MPa)': {
        density: 2400.0, youngs_modulus: 37.0e9, poissons_ratio: 0.20, yield_stress: 50.0e6, hardening_modulus: 350.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 4.1e6,
        fc: 50.0e6, ft: 4.1e6, G_f: 120.0, moisture_content: 0.04, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.60, rht_N: 0.61, rht_B: 0.70, rht_M: 0.80, rht_Q0: 0.68, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0, rht_p_crush: 16.67e6, rht_p_lock: 6.0e9, rht_alpha0: 1.20, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        kc_auto_generate: true, kc_a0: 16.67e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 13.33e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.60, kc_omega: 0.50,
        cscm_alpha: 17.5e6, cscm_theta: 0.42, cscm_lambda: 12.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 140.0e6, cscm_W: 0.05, cscm_D1: 2.5e-9, cscm_D2: 1.0,
        jc_A: 50.0e6, jc_B: 220.0e6, jc_n: 0.38, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3300.0, mg_s: 1.30,
        category: 'Concrete & Masonry Strength Grades', reference: 'Riedel et al., Int. J. Impact Eng. (1999)'
    },
    'Ultra-High Performance Concrete C100/115 (100 MPa)': {
        density: 2500.0, youngs_modulus: 45.0e9, poissons_ratio: 0.20, yield_stress: 100.0e6, hardening_modulus: 500.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 7.0e6,
        fc: 100.0e6, ft: 7.0e6, G_f: 180.0, moisture_content: 0.02, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.65, rht_N: 0.60, rht_B: 0.75, rht_M: 0.80, rht_Q0: 0.70, rht_BQ: 0.0105, rht_D1: 0.035, rht_D2: 1.0, rht_p_crush: 33.33e6, rht_p_lock: 7.0e9, rht_alpha0: 1.12, rht_n_comp: 3.0, rht_betac: 0.030, rht_deltat: 0.034,
        kc_auto_generate: true, kc_a0: 33.33e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 26.67e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.60, kc_omega: 0.50,
        cscm_alpha: 35.0e6, cscm_theta: 0.45, cscm_lambda: 24.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 280.0e6, cscm_W: 0.04, cscm_D1: 2.5e-9, cscm_D2: 1.0,
        jc_A: 100.0e6, jc_B: 300.0e6, jc_n: 0.35, jc_C: 0.006, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.10, mg_c0: 3600.0, mg_s: 1.35,
        category: 'Concrete & Masonry Strength Grades', reference: 'Forquin et al., Int. J. Impact Eng. (2010)'
    },
    'UHPC / Ductal (150 MPa)': {
        density: 2550.0, youngs_modulus: 55.0e9, poissons_ratio: 0.21, yield_stress: 150.0e6, hardening_modulus: 700.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 12.0e6,
        fc: 150.0e6, ft: 12.0e6, G_f: 300.0, moisture_content: 0.01, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.70, rht_N: 0.58, rht_B: 0.80, rht_M: 0.80, rht_Q0: 0.72, rht_BQ: 0.0105, rht_D1: 0.030, rht_D2: 1.0, rht_p_crush: 50.0e6, rht_p_lock: 8.0e9, rht_alpha0: 1.08, rht_n_comp: 3.0, rht_betac: 0.028, rht_deltat: 0.032,
        kc_auto_generate: true, kc_a0: 50.0e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 40.0e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.60, kc_omega: 0.50,
        cscm_alpha: 52.5e6, cscm_theta: 0.48, cscm_lambda: 36.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 420.0e6, cscm_W: 0.03, cscm_D1: 2.5e-9, cscm_D2: 1.0,
        jc_A: 150.0e6, jc_B: 400.0e6, jc_n: 0.30, jc_C: 0.007, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.15, mg_c0: 3800.0, mg_s: 1.38,
        category: 'Concrete & Masonry Strength Grades', reference: 'Lafarge Holcim Ductal Technical Manual'
    },
    'Fiber-Reinforced Concrete (FRC 60 MPa)': {
        density: 2450.0, youngs_modulus: 39.0e9, poissons_ratio: 0.20, yield_stress: 60.0e6, hardening_modulus: 450.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 8.5e6,
        fc: 60.0e6, ft: 8.5e6, G_f: 500.0, moisture_content: 0.03, dif_cap_compression: 2.5, dif_cap_tension: 5.0,
        rht_A: 1.62, rht_N: 0.61, rht_B: 0.72, rht_M: 0.80, rht_Q0: 0.68, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0, rht_p_crush: 20.0e6, rht_p_lock: 6.0e9, rht_alpha0: 1.18, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        kc_auto_generate: true, kc_a0: 20.0e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 16.0e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.40, kc_omega: 0.50,
        cscm_alpha: 21.0e6, cscm_theta: 0.43, cscm_lambda: 14.5e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 170.0e6, cscm_W: 0.05, cscm_D1: 2.0e-9, cscm_D2: 1.0,
        jc_A: 60.0e6, jc_B: 280.0e6, jc_n: 0.35, jc_C: 0.006, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 920.0, mg_gamma0: 1.05, mg_c0: 3400.0, mg_s: 1.32,
        category: 'Concrete & Masonry Strength Grades', reference: 'Nold, ACI Materials Journal (2012)'
    },
    'Clay Brick Masonry': {
        density: 1800.0, youngs_modulus: 10.0e9, poissons_ratio: 0.18, yield_stress: 12.0e6, hardening_modulus: 80.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 1.2e6,
        fc: 12.0e6, ft: 1.2e6, G_f: 40.0, moisture_content: 0.05, dif_cap_compression: 2.0, dif_cap_tension: 4.0,
        rht_A: 1.50, rht_N: 0.65, rht_B: 0.65, rht_M: 0.80, rht_Q0: 0.65, rht_BQ: 0.0105, rht_D1: 0.05, rht_D2: 1.0, rht_p_crush: 4.0e6, rht_p_lock: 4.0e9, rht_alpha0: 1.35, rht_n_comp: 3.0, rht_betac: 0.035, rht_deltat: 0.040,
        kc_auto_generate: true, kc_a0: 4.0e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 3.2e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 1.80, kc_omega: 0.50,
        cscm_alpha: 4.2e6, cscm_theta: 0.35, cscm_lambda: 3.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 35.0e6, cscm_W: 0.06, cscm_D1: 3.0e-9, cscm_D2: 1.0,
        jc_A: 12.0e6, jc_B: 50.0e6, jc_n: 0.45, jc_C: 0.003, jc_m: 1.00, T_melt: 1400.0, T_room: 293.0, Cp: 840.0, mg_gamma0: 0.85, mg_c0: 2200.0, mg_s: 1.15,
        category: 'Concrete & Masonry Strength Grades', reference: 'Lourenco, PhD Thesis TU Delft'
    },
    'Aerated Autoclaved Concrete (AAC)': {
        density: 600.0, youngs_modulus: 2.0e9, poissons_ratio: 0.15, yield_stress: 4.0e6, hardening_modulus: 20.0e6, failure_strain: 0.85, erosion_strain: 0.85, tensile_failure_stress: 0.5e6,
        fc: 4.0e6, ft: 0.5e6, G_f: 15.0, moisture_content: 0.06, dif_cap_compression: 2.0, dif_cap_tension: 4.0,
        rht_A: 1.40, rht_N: 0.70, rht_B: 0.60, rht_M: 0.80, rht_Q0: 0.60, rht_BQ: 0.0105, rht_D1: 0.06, rht_D2: 1.0, rht_p_crush: 1.33e6, rht_p_lock: 2.0e9, rht_alpha0: 1.50, rht_n_comp: 3.0, rht_betac: 0.040, rht_deltat: 0.045,
        kc_auto_generate: true, kc_a0: 1.33e6, kc_a1: 0.44, kc_a2: 0.77e-9, kc_a0y: 1.07e6, kc_a1y: 0.35, kc_a2y: 0.62e-9, kc_a1r: 0.25, kc_a2r: 0.50e-9, kc_b1: 2.00, kc_omega: 0.50,
        cscm_alpha: 1.4e6, cscm_theta: 0.30, cscm_lambda: 1.0e6, cscm_beta: 1.5e-8, cscm_R: 4.0, cscm_X0: 12.0e6, cscm_W: 0.08, cscm_D1: 4.0e-9, cscm_D2: 1.0,
        jc_A: 4.0e6, jc_B: 15.0e6, jc_n: 0.50, jc_C: 0.002, jc_m: 1.00, T_melt: 1400.0, T_room: 293.0, Cp: 1000.0, mg_gamma0: 0.50, mg_c0: 1200.0, mg_s: 1.10,
        category: 'Concrete & Masonry Strength Grades', reference: 'Autoclaved Aerated Concrete Handbook'
    },

    // ---------------------------------------------------------
    // 4. Soils, Rocks & Geomaterial Strengths
    // ---------------------------------------------------------
    'Soft Marine Clay (Cu = 25 kPa)': {
        density: 1600.0, youngs_modulus: 15.0e6, poissons_ratio: 0.45, yield_stress: 0.025e6, hardening_modulus: 0.1e6, failure_strain: 0.20, tensile_failure_stress: 0.005e6,
        jc_A: 0.025e6, jc_B: 0.10e6, jc_n: 0.50, jc_C: 0.050, jc_m: 1.00, T_melt: 1400.0, T_room: 293.0, Cp: 1200.0, mg_gamma0: 0.50, mg_c0: 1500.0, mg_s: 1.40,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Wood, Soil Behaviour & Critical State Mechanics'
    },
    'Stiff Silty Clay (Cu = 100 kPa)': {
        density: 1850.0, youngs_modulus: 50.0e6, poissons_ratio: 0.40, yield_stress: 0.10e6, hardening_modulus: 0.5e6, failure_strain: 0.15, tensile_failure_stress: 0.02e6,
        jc_A: 0.10e6, jc_B: 0.30e6, jc_n: 0.45, jc_C: 0.030, jc_m: 1.00, T_melt: 1400.0, T_room: 293.0, Cp: 1100.0, mg_gamma0: 0.65, mg_c0: 1600.0, mg_s: 1.45,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Terzaghi & Peck Soil Mechanics'
    },
    'Loose Dry Sand (Dr = 30%)': {
        density: 1550.0, youngs_modulus: 30.0e6, poissons_ratio: 0.30, yield_stress: 0.05e6, hardening_modulus: 0.2e6, failure_strain: 0.15, tensile_failure_stress: 0.001e6,
        jc_A: 0.05e6, jc_B: 0.20e6, jc_n: 0.50, jc_C: 0.010, jc_m: 1.00, T_melt: 1700.0, T_room: 293.0, Cp: 800.0, mg_gamma0: 0.45, mg_c0: 1450.0, mg_s: 1.35,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Lade & Duncan Granular Soil Benchmark'
    },
    'Dense Compacted Sand (Dr = 85%)': {
        density: 1800.0, youngs_modulus: 100.0e6, poissons_ratio: 0.30, yield_stress: 0.25e6, hardening_modulus: 1.0e6, failure_strain: 0.10, tensile_failure_stress: 0.005e6,
        jc_A: 0.25e6, jc_B: 0.80e6, jc_n: 0.40, jc_C: 0.015, jc_m: 1.00, T_melt: 1700.0, T_room: 293.0, Cp: 800.0, mg_gamma0: 0.60, mg_c0: 1650.0, mg_s: 1.40,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Lade & Nelson Granular Media Model'
    },
    'Compacted Gravel Subgrade': {
        density: 2100.0, youngs_modulus: 200.0e6, poissons_ratio: 0.28, yield_stress: 0.50e6, hardening_modulus: 2.0e6, failure_strain: 0.08, tensile_failure_stress: 0.01e6,
        jc_A: 0.50e6, jc_B: 1.50e6, jc_n: 0.35, jc_C: 0.015, jc_m: 1.00, T_melt: 1700.0, T_room: 293.0, Cp: 850.0, mg_gamma0: 0.75, mg_c0: 1850.0, mg_s: 1.42,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'AASHTO Pavement Design Subgrade Manual'
    },
    'Westerly Granite': {
        density: 2640.0, youngs_modulus: 60.0e9, poissons_ratio: 0.25, yield_stress: 200.0e6, hardening_modulus: 5.0e9, failure_strain: 0.015, tensile_failure_stress: 15.0e6,
        jc_A: 200.0e6, jc_B: 800.0e6, jc_n: 0.30, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 790.0, mg_gamma0: 1.50, mg_c0: 3950.0, mg_s: 1.40,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Marsh, LASL Shock Hugoniot Data (1980)'
    },
    'Berea Sandstone': {
        density: 2150.0, youngs_modulus: 18.0e9, poissons_ratio: 0.20, yield_stress: 50.0e6, hardening_modulus: 1.5e9, failure_strain: 0.020, tensile_failure_stress: 4.0e6,
        jc_A: 50.0e6, jc_B: 250.0e6, jc_n: 0.35, jc_C: 0.005, jc_m: 1.00, T_melt: 1600.0, T_room: 293.0, Cp: 850.0, mg_gamma0: 1.10, mg_c0: 2800.0, mg_s: 1.30,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Zhang et al., Int. J. Rock Mech. Min. Sci. (2000)'
    },
    'Limestone (Solnhofen)': {
        density: 2600.0, youngs_modulus: 50.0e9, poissons_ratio: 0.28, yield_stress: 120.0e6, hardening_modulus: 3.5e9, failure_strain: 0.015, tensile_failure_stress: 8.0e6,
        jc_A: 120.0e6, jc_B: 500.0e6, jc_n: 0.32, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 820.0, mg_gamma0: 1.40, mg_c0: 3700.0, mg_s: 1.38,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Ahrens & Gregson, J. Geophys. Res. (1964)'
    },
    'Ice / Permafrost (-5°C)': {
        density: 917.0, youngs_modulus: 9.0e9, poissons_ratio: 0.33, yield_stress: 5.0e6, hardening_modulus: 100.0e6, failure_strain: 0.050, tensile_failure_stress: 1.5e6,
        jc_A: 5.0e6, jc_B: 20.0e6, jc_n: 0.50, jc_C: 0.020, jc_m: 1.00, T_melt: 273.15, T_room: 268.15, Cp: 2050.0, mg_gamma0: 1.00, mg_c0: 2950.0, mg_s: 1.30,
        category: 'Soils, Rocks & Geomaterial Strengths', reference: 'Schulson, JOM (1999) Physics of Ice'
    },

    // ---------------------------------------------------------
    // 5. Energetic Solids & Unreacted Explosives (All 32 Compositions)
    // ---------------------------------------------------------
    'Aluminized ANFO (Unreacted)': {
        density: 1150.0, youngs_modulus: 2.5e9, poissons_ratio: 0.35, yield_stress: 8.0e6, hardening_modulus: 50.0e6, failure_strain: 0.10, tensile_failure_stress: 2.0e6,
        jc_A: 8.0e6, jc_B: 30.0e6, jc_n: 0.40, jc_C: 0.010, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1380.0, mg_gamma0: 0.75, mg_c0: 2100.0, mg_s: 1.50,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Ammonal (Unreacted)': {
        density: 1550.0, youngs_modulus: 4.0e9, poissons_ratio: 0.35, yield_stress: 12.0e6, hardening_modulus: 80.0e6, failure_strain: 0.08, tensile_failure_stress: 3.0e6,
        jc_A: 12.0e6, jc_B: 40.0e6, jc_n: 0.40, jc_C: 0.010, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1250.0, mg_gamma0: 0.85, mg_c0: 2300.0, mg_s: 1.55,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'ANFO (Unreacted)': {
        density: 930.0, youngs_modulus: 1.8e9, poissons_ratio: 0.35, yield_stress: 5.0e6, hardening_modulus: 30.0e6, failure_strain: 0.12, tensile_failure_stress: 1.2e6,
        jc_A: 5.0e6, jc_B: 20.0e6, jc_n: 0.45, jc_C: 0.010, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1420.0, mg_gamma0: 0.65, mg_c0: 1950.0, mg_s: 1.45,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Baratol (Unreacted)': {
        density: 2550.0, youngs_modulus: 12.0e9, poissons_ratio: 0.30, yield_stress: 25.0e6, hardening_modulus: 150.0e6, failure_strain: 0.05, tensile_failure_stress: 5.0e6,
        jc_A: 25.0e6, jc_B: 80.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 820.0, mg_gamma0: 1.20, mg_c0: 2600.0, mg_s: 1.60,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'C-4 (Unreacted)': {
        density: 1630.0, youngs_modulus: 4.5e9, poissons_ratio: 0.38, yield_stress: 15.0e6, hardening_modulus: 100.0e6, failure_strain: 0.15, tensile_failure_stress: 4.0e6,
        jc_A: 15.0e6, jc_B: 50.0e6, jc_n: 0.40, jc_C: 0.015, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1200.0, mg_gamma0: 0.90, mg_c0: 2450.0, mg_s: 1.58,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook / Dobratz'
    },
    'Composition A-3 (Unreacted)': {
        density: 1650.0, youngs_modulus: 7.0e9, poissons_ratio: 0.34, yield_stress: 22.0e6, hardening_modulus: 140.0e6, failure_strain: 0.06, tensile_failure_stress: 6.0e6,
        jc_A: 22.0e6, jc_B: 70.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1180.0, mg_gamma0: 0.95, mg_c0: 2500.0, mg_s: 1.60,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'Composition B (Unreacted)': {
        density: 1717.0, youngs_modulus: 9.0e9, poissons_ratio: 0.32, yield_stress: 28.0e6, hardening_modulus: 180.0e6, failure_strain: 0.05, tensile_failure_stress: 7.0e6,
        jc_A: 28.0e6, jc_B: 90.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1150.0, mg_gamma0: 1.00, mg_c0: 2710.0, mg_s: 1.62,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Composition C-3 (Unreacted)': {
        density: 1600.0, youngs_modulus: 3.5e9, poissons_ratio: 0.38, yield_stress: 10.0e6, hardening_modulus: 70.0e6, failure_strain: 0.18, tensile_failure_stress: 3.0e6,
        jc_A: 10.0e6, jc_B: 40.0e6, jc_n: 0.40, jc_C: 0.015, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1220.0, mg_gamma0: 0.88, mg_c0: 2400.0, mg_s: 1.55,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'Cyclotol (Unreacted)': {
        density: 1750.0, youngs_modulus: 10.0e9, poissons_ratio: 0.32, yield_stress: 32.0e6, hardening_modulus: 200.0e6, failure_strain: 0.04, tensile_failure_stress: 8.0e6,
        jc_A: 32.0e6, jc_B: 100.0e6, jc_n: 0.33, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1120.0, mg_gamma0: 1.05, mg_c0: 2750.0, mg_s: 1.64,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Heavy ANFO (Unreacted)': {
        density: 1250.0, youngs_modulus: 3.0e9, poissons_ratio: 0.36, yield_stress: 9.0e6, hardening_modulus: 60.0e6, failure_strain: 0.11, tensile_failure_stress: 2.2e6,
        jc_A: 9.0e6, jc_B: 35.0e6, jc_n: 0.40, jc_C: 0.010, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1350.0, mg_gamma0: 0.78, mg_c0: 2150.0, mg_s: 1.52,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Commercial Mining Explosives Data'
    },
    'HMX (Unreacted)': {
        density: 1900.0, youngs_modulus: 18.0e9, poissons_ratio: 0.28, yield_stress: 50.0e6, hardening_modulus: 350.0e6, failure_strain: 0.03, tensile_failure_stress: 12.0e6,
        jc_A: 50.0e6, jc_B: 150.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1050.0, mg_gamma0: 1.15, mg_c0: 2900.0, mg_s: 1.70,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Dobratz & Crawford LLNL Handbook'
    },
    'LX-04 (Unreacted)': {
        density: 1860.0, youngs_modulus: 12.0e9, poissons_ratio: 0.30, yield_stress: 35.0e6, hardening_modulus: 220.0e6, failure_strain: 0.04, tensile_failure_stress: 9.0e6,
        jc_A: 35.0e6, jc_B: 110.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1100.0, mg_gamma0: 1.10, mg_c0: 2850.0, mg_s: 1.68,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'LX-07 (Unreacted)': {
        density: 1865.0, youngs_modulus: 13.0e9, poissons_ratio: 0.30, yield_stress: 38.0e6, hardening_modulus: 240.0e6, failure_strain: 0.04, tensile_failure_stress: 9.5e6,
        jc_A: 38.0e6, jc_B: 120.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1090.0, mg_gamma0: 1.11, mg_c0: 2860.0, mg_s: 1.68,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'LX-10 (Unreacted)': {
        density: 1860.0, youngs_modulus: 14.0e9, poissons_ratio: 0.30, yield_stress: 40.0e6, hardening_modulus: 250.0e6, failure_strain: 0.04, tensile_failure_stress: 10.0e6,
        jc_A: 40.0e6, jc_B: 130.0e6, jc_n: 0.31, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1080.0, mg_gamma0: 1.12, mg_c0: 2870.0, mg_s: 1.69,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'LX-14 (Unreacted)': {
        density: 1835.0, youngs_modulus: 11.5e9, poissons_ratio: 0.31, yield_stress: 32.0e6, hardening_modulus: 200.0e6, failure_strain: 0.05, tensile_failure_stress: 8.5e6,
        jc_A: 32.0e6, jc_B: 105.0e6, jc_n: 0.33, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1120.0, mg_gamma0: 1.08, mg_c0: 2820.0, mg_s: 1.66,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'LX-17 (Unreacted)': {
        density: 1900.0, youngs_modulus: 15.0e9, poissons_ratio: 0.28, yield_stress: 45.0e6, hardening_modulus: 300.0e6, failure_strain: 0.03, tensile_failure_stress: 11.0e6,
        jc_A: 45.0e6, jc_B: 140.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 1000.0, mg_gamma0: 1.16, mg_c0: 2920.0, mg_s: 1.71,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Tarver et al., LLNL Insensitive PBX Data'
    },
    'Mining Emulsion (Unreacted)': {
        density: 1200.0, youngs_modulus: 1.5e9, poissons_ratio: 0.40, yield_stress: 3.0e6, hardening_modulus: 15.0e6, failure_strain: 0.25, tensile_failure_stress: 0.5e6,
        jc_A: 3.0e6, jc_B: 10.0e6, jc_n: 0.50, jc_C: 0.020, jc_m: 1.00, T_melt: 360.0, T_room: 293.0, Cp: 1500.0, mg_gamma0: 0.60, mg_c0: 1800.0, mg_s: 1.40,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Orica Mining Explosives Data Sheet'
    },
    'Octol (Unreacted)': {
        density: 1810.0, youngs_modulus: 11.0e9, poissons_ratio: 0.31, yield_stress: 30.0e6, hardening_modulus: 190.0e6, failure_strain: 0.04, tensile_failure_stress: 8.0e6,
        jc_A: 30.0e6, jc_B: 100.0e6, jc_n: 0.33, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1130.0, mg_gamma0: 1.06, mg_c0: 2800.0, mg_s: 1.65,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'PBX 9404 (Unreacted)': {
        density: 1840.0, youngs_modulus: 12.5e9, poissons_ratio: 0.30, yield_stress: 36.0e6, hardening_modulus: 230.0e6, failure_strain: 0.04, tensile_failure_stress: 9.0e6,
        jc_A: 36.0e6, jc_B: 115.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1100.0, mg_gamma0: 1.09, mg_c0: 2840.0, mg_s: 1.67,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Dobratz LLNL Handbook UCRL-52997'
    },
    'PBX 9501 (Unreacted)': {
        density: 1840.0, youngs_modulus: 13.0e9, poissons_ratio: 0.30, yield_stress: 38.0e6, hardening_modulus: 240.0e6, failure_strain: 0.04, tensile_failure_stress: 9.5e6,
        jc_A: 38.0e6, jc_B: 120.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1090.0, mg_gamma0: 1.10, mg_c0: 2850.0, mg_s: 1.68,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Gibbs & Popolato LASL Data'
    },
    'PBX 9502 (Unreacted)': {
        density: 1895.0, youngs_modulus: 14.5e9, poissons_ratio: 0.28, yield_stress: 42.0e6, hardening_modulus: 280.0e6, failure_strain: 0.03, tensile_failure_stress: 10.5e6,
        jc_A: 42.0e6, jc_B: 135.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 1010.0, mg_gamma0: 1.15, mg_c0: 2910.0, mg_s: 1.70,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Tarver et al. Insensitive Explosives'
    },
    'PE-10 (Unreacted)': {
        density: 1580.0, youngs_modulus: 4.0e9, poissons_ratio: 0.37, yield_stress: 12.0e6, hardening_modulus: 80.0e6, failure_strain: 0.12, tensile_failure_stress: 3.5e6,
        jc_A: 12.0e6, jc_B: 45.0e6, jc_n: 0.40, jc_C: 0.012, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1230.0, mg_gamma0: 0.86, mg_c0: 2380.0, mg_s: 1.54,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'UK MOD Plastic Explosive Specification'
    },
    'PE-12 (Unreacted)': {
        density: 1600.0, youngs_modulus: 4.2e9, poissons_ratio: 0.37, yield_stress: 13.0e6, hardening_modulus: 85.0e6, failure_strain: 0.12, tensile_failure_stress: 3.8e6,
        jc_A: 13.0e6, jc_B: 48.0e6, jc_n: 0.40, jc_C: 0.012, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1220.0, mg_gamma0: 0.88, mg_c0: 2400.0, mg_s: 1.55,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'UK MOD Plastic Explosive Specification'
    },
    'PE-4 (Unreacted)': {
        density: 1600.0, youngs_modulus: 4.0e9, poissons_ratio: 0.38, yield_stress: 14.0e6, hardening_modulus: 90.0e6, failure_strain: 0.14, tensile_failure_stress: 3.6e6,
        jc_A: 14.0e6, jc_B: 46.0e6, jc_n: 0.40, jc_C: 0.014, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1210.0, mg_gamma0: 0.88, mg_c0: 2410.0, mg_s: 1.56,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'UK MOD PE-4 Ordnance Data Sheet'
    },
    'PE-8 (Unreacted)': {
        density: 1620.0, youngs_modulus: 4.4e9, poissons_ratio: 0.37, yield_stress: 14.5e6, hardening_modulus: 95.0e6, failure_strain: 0.13, tensile_failure_stress: 3.9e6,
        jc_A: 14.5e6, jc_B: 49.0e6, jc_n: 0.40, jc_C: 0.013, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1200.0, mg_gamma0: 0.89, mg_c0: 2430.0, mg_s: 1.57,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'UK MOD PE-8 Ordnance Specification'
    },
    'Pentolite (Unreacted)': {
        density: 1700.0, youngs_modulus: 8.5e9, poissons_ratio: 0.33, yield_stress: 26.0e6, hardening_modulus: 170.0e6, failure_strain: 0.06, tensile_failure_stress: 6.5e6,
        jc_A: 26.0e6, jc_B: 85.0e6, jc_n: 0.36, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1160.0, mg_gamma0: 0.98, mg_c0: 2680.0, mg_s: 1.61,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Dobratz LLNL Explosives Data'
    },
    'PETN (Unreacted)': {
        density: 1770.0, youngs_modulus: 14.0e9, poissons_ratio: 0.29, yield_stress: 40.0e6, hardening_modulus: 250.0e6, failure_strain: 0.03, tensile_failure_stress: 10.0e6,
        jc_A: 40.0e6, jc_B: 125.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 414.0, T_room: 293.0, Cp: 1090.0, mg_gamma0: 1.08, mg_c0: 2810.0, mg_s: 1.66,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Dobratz LLNL Explosives Handbook'
    },
    'RDX (Unreacted)': {
        density: 1800.0, youngs_modulus: 15.0e9, poissons_ratio: 0.29, yield_stress: 42.0e6, hardening_modulus: 270.0e6, failure_strain: 0.03, tensile_failure_stress: 10.5e6,
        jc_A: 42.0e6, jc_B: 130.0e6, jc_n: 0.31, jc_C: 0.010, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1070.0, mg_gamma0: 1.10, mg_c0: 2840.0, mg_s: 1.67,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Dobratz LLNL Explosives Handbook'
    },
    'TATB (Unreacted)': {
        density: 1930.0, youngs_modulus: 16.0e9, poissons_ratio: 0.27, yield_stress: 48.0e6, hardening_modulus: 320.0e6, failure_strain: 0.03, tensile_failure_stress: 11.5e6,
        jc_A: 48.0e6, jc_B: 145.0e6, jc_n: 0.29, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 990.0, mg_gamma0: 1.18, mg_c0: 2950.0, mg_s: 1.72,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Tarver et al., LLNL Insensitive Explosives'
    },
    'Tetryl (Unreacted)': {
        density: 1730.0, youngs_modulus: 9.5e9, poissons_ratio: 0.32, yield_stress: 30.0e6, hardening_modulus: 190.0e6, failure_strain: 0.05, tensile_failure_stress: 7.5e6,
        jc_A: 30.0e6, jc_B: 95.0e6, jc_n: 0.34, jc_C: 0.010, jc_m: 1.00, T_melt: 402.0, T_room: 293.0, Cp: 1140.0, mg_gamma0: 1.02, mg_c0: 2730.0, mg_s: 1.63,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LASL Explosive Property Data'
    },
    'TNT (Unreacted)': {
        density: 1630.0, youngs_modulus: 6.0e9, poissons_ratio: 0.35, yield_stress: 20.0e6, hardening_modulus: 120.0e6, failure_strain: 0.07, tensile_failure_stress: 5.0e6,
        jc_A: 20.0e6, jc_B: 60.0e6, jc_n: 0.38, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1260.0, mg_gamma0: 0.92, mg_c0: 2470.0, mg_s: 1.59,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Water Gel (Unreacted)': {
        density: 1300.0, youngs_modulus: 2.0e9, poissons_ratio: 0.40, yield_stress: 4.0e6, hardening_modulus: 20.0e6, failure_strain: 0.20, tensile_failure_stress: 0.8e6,
        jc_A: 4.0e6, jc_B: 15.0e6, jc_n: 0.45, jc_C: 0.020, jc_m: 1.00, T_melt: 373.0, T_room: 293.0, Cp: 1450.0, mg_gamma0: 0.65, mg_c0: 1900.0, mg_s: 1.42,
        category: 'Energetic Solids & Unreacted Explosives', reference: 'Commercial Slurry Explosives Technical Data'
    },

    // ---------------------------------------------------------
    // 6. Polymers & High-Performance Thermoplastics
    // ---------------------------------------------------------
    'Polycarbonate (Lexan)': {
        density: 1200.0, youngs_modulus: 2.38e9, poissons_ratio: 0.38, yield_stress: 75.0e6, hardening_modulus: 400.0e6, failure_strain: 0.60, tensile_failure_stress: 90.0e6,
        jc_A: 75.0e6, jc_B: 120.0e6, jc_n: 0.45, jc_C: 0.080, jc_m: 1.20, T_melt: 533.0, T_room: 293.0, Cp: 1250.0, mg_gamma0: 0.61, mg_c0: 2470.0, mg_s: 1.55,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'Dorogoy et al., Int. J. Impact Eng. (2011)'
    },
    'UHMWPE': {
        density: 970.0, youngs_modulus: 3.0e9, poissons_ratio: 0.42, yield_stress: 30.0e6, hardening_modulus: 250.0e6, failure_strain: 0.80, tensile_failure_stress: 120.0e6,
        jc_A: 30.0e6, jc_B: 80.0e6, jc_n: 0.50, jc_C: 0.090, jc_m: 1.10, T_melt: 408.0, T_room: 293.0, Cp: 1850.0, mg_gamma0: 0.70, mg_c0: 2800.0, mg_s: 1.60,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'Russell et al., Int. J. Impact Eng. (2013)'
    },
    'PMMA (Acrylic / Plexiglas)': {
        density: 1190.0, youngs_modulus: 3.3e9, poissons_ratio: 0.35, yield_stress: 110.0e6, hardening_modulus: 300.0e6, failure_strain: 0.05, tensile_failure_stress: 70.0e6,
        jc_A: 110.0e6, jc_B: 150.0e6, jc_n: 0.40, jc_C: 0.050, jc_m: 1.00, T_melt: 433.0, T_room: 293.0, Cp: 1470.0, mg_gamma0: 0.75, mg_c0: 2590.0, mg_s: 1.52,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'Richeton et al., Int. J. Solids Struct. (2006)'
    },
    'Nylon 6-6': {
        density: 1140.0, youngs_modulus: 2.8e9, poissons_ratio: 0.39, yield_stress: 85.0e6, hardening_modulus: 350.0e6, failure_strain: 0.40, tensile_failure_stress: 95.0e6,
        jc_A: 85.0e6, jc_B: 130.0e6, jc_n: 0.42, jc_C: 0.065, jc_m: 1.15, T_melt: 533.0, T_room: 293.0, Cp: 1670.0, mg_gamma0: 0.75, mg_c0: 2600.0, mg_s: 1.55,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'ASM Engineered Materials Handbook Vol. 2'
    },
    'PTFE (Teflon)': {
        density: 2160.0, youngs_modulus: 0.5e9, poissons_ratio: 0.46, yield_stress: 25.0e6, hardening_modulus: 100.0e6, failure_strain: 0.50, tensile_failure_stress: 35.0e6,
        jc_A: 25.0e6, jc_B: 60.0e6, jc_n: 0.50, jc_C: 0.100, jc_m: 1.00, T_melt: 600.0, T_room: 293.0, Cp: 970.0, mg_gamma0: 0.59, mg_c0: 1680.0, mg_s: 1.83,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'Rae et al., Polymer (2004) High Strain Rate Data'
    },
    'PEEK': {
        density: 1320.0, youngs_modulus: 4.0e9, poissons_ratio: 0.38, yield_stress: 100.0e6, hardening_modulus: 500.0e6, failure_strain: 0.30, tensile_failure_stress: 110.0e6,
        jc_A: 100.0e6, jc_B: 180.0e6, jc_n: 0.40, jc_C: 0.050, jc_m: 1.10, T_melt: 616.0, T_room: 293.0, Cp: 1340.0, mg_gamma0: 0.80, mg_c0: 2700.0, mg_s: 1.50,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'Rae et al., Polymer (2007) PEEK High Rate'
    },
    'Kevlar-Epoxy Composite': {
        density: 1400.0, youngs_modulus: 30.0e9, poissons_ratio: 0.25, yield_stress: 400.0e6, hardening_modulus: 1.0e9, failure_strain: 0.03, tensile_failure_stress: 600.0e6,
        jc_A: 400.0e6, jc_B: 300.0e6, jc_n: 0.30, jc_C: 0.020, jc_m: 1.00, T_melt: 773.0, T_room: 293.0, Cp: 1400.0, mg_gamma0: 0.90, mg_c0: 3200.0, mg_s: 1.45,
        category: 'Polymers & High-Performance Thermoplastics', reference: 'DuPont Kevlar Ballistic Property Manual'
    },

    // ---------------------------------------------------------
    // 7. Technical Ceramics & Armor Glasses
    // ---------------------------------------------------------
    'Boron Carbide (B4C)': {
        density: 2510.0, youngs_modulus: 460.0e9, poissons_ratio: 0.17, yield_stress: 15.0e9, hardening_modulus: 10.0e9, failure_strain: 0.008, tensile_failure_stress: 400.0e6,
        jc_A: 15.0e9, jc_B: 5.0e9, jc_n: 0.20, jc_C: 0.005, jc_m: 1.00, T_melt: 3036.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.50, mg_c0: 9710.0, mg_s: 1.15,
        category: 'Technical Ceramics & Armor Glasses', reference: 'Holmquist & Johnson, J. Appl. Phys. (2006)'
    },
    'Silicon Carbide (SiC)': {
        density: 3210.0, youngs_modulus: 410.0e9, poissons_ratio: 0.16, yield_stress: 11.7e9, hardening_modulus: 8.0e9, failure_strain: 0.010, tensile_failure_stress: 370.0e6,
        jc_A: 11.7e9, jc_B: 4.0e9, jc_n: 0.20, jc_C: 0.005, jc_m: 1.00, T_melt: 3000.0, T_room: 293.0, Cp: 670.0, mg_gamma0: 1.40, mg_c0: 8190.0, mg_s: 1.17,
        category: 'Technical Ceramics & Armor Glasses', reference: 'JH-1 Ceramic Model / Holmquist et al. (1999)'
    },
    'Alumina (Al2O3 - 99.5%)': {
        density: 3890.0, youngs_modulus: 370.0e9, poissons_ratio: 0.22, yield_stress: 3.5e9, hardening_modulus: 5.0e9, failure_strain: 0.012, tensile_failure_stress: 260.0e6,
        jc_A: 3.5e9, jc_B: 2.0e9, jc_n: 0.25, jc_C: 0.005, jc_m: 1.00, T_melt: 2345.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 1.33, mg_c0: 7820.0, mg_s: 1.27,
        category: 'Technical Ceramics & Armor Glasses', reference: 'Johnson & Holmquist, J. Appl. Phys. (1990)'
    },
    'Soda-Lime Glass': {
        density: 2500.0, youngs_modulus: 70.0e9, poissons_ratio: 0.23, yield_stress: 2.0e9, hardening_modulus: 1.0e9, failure_strain: 0.005, tensile_failure_stress: 80.0e6,
        jc_A: 2.0e9, jc_B: 1.0e9, jc_n: 0.30, jc_C: 0.005, jc_m: 1.00, T_melt: 1473.0, T_room: 293.0, Cp: 840.0, mg_gamma0: 0.40, mg_c0: 3860.0, mg_s: 1.40,
        category: 'Technical Ceramics & Armor Glasses', reference: 'Holmquist et al., 15th Int. Symp. Ballistics'
    },
    'Fused Silica Glass': {
        density: 2200.0, youngs_modulus: 72.0e9, poissons_ratio: 0.17, yield_stress: 3.0e9, hardening_modulus: 1.5e9, failure_strain: 0.006, tensile_failure_stress: 110.0e6,
        jc_A: 3.0e9, jc_B: 1.2e9, jc_n: 0.30, jc_C: 0.005, jc_m: 1.00, T_melt: 1983.0, T_room: 293.0, Cp: 740.0, mg_gamma0: 0.30, mg_c0: 5970.0, mg_s: 0.40,
        category: 'Technical Ceramics & Armor Glasses', reference: 'Marsh LASL Shock Data / Corning Glass Tech'
    },
    'Titanium Diboride (TiB2)': {
        density: 4520.0, youngs_modulus: 560.0e9, poissons_ratio: 0.11, yield_stress: 14.0e9, hardening_modulus: 9.0e9, failure_strain: 0.008, tensile_failure_stress: 450.0e6,
        jc_A: 14.0e9, jc_B: 5.0e9, jc_n: 0.20, jc_C: 0.005, jc_m: 1.00, T_melt: 3498.0, T_room: 293.0, Cp: 620.0, mg_gamma0: 1.60, mg_c0: 8900.0, mg_s: 1.15,
        category: 'Technical Ceramics & Armor Glasses', reference: 'Grady, Mech. Mater. (1998) Shock Wave Physics'
    },

    // ---------------------------------------------------------
    // 8. Soft Materials, Bio-Surrogates & Composites
    // ---------------------------------------------------------
    'Ballistic Gelatin (10% 4°C)': {
        density: 1060.0, youngs_modulus: 0.05e6, poissons_ratio: 0.499, yield_stress: 0.015e6, hardening_modulus: 0.05e6, failure_strain: 1.50, tensile_failure_stress: 0.15e6,
        jc_A: 0.015e6, jc_B: 0.05e6, jc_n: 0.50, jc_C: 0.100, jc_m: 1.00, T_melt: 310.0, T_room: 277.15, Cp: 4180.0, mg_gamma0: 0.10, mg_c0: 1480.0, mg_s: 1.92,
        category: 'Soft Materials, Bio-Surrogates & Composites', reference: 'Fackler NATO Ballistic Gelatin Standard'
    },
    'Ballistic Gelatin (20% 4°C)': {
        density: 1100.0, youngs_modulus: 0.15e6, poissons_ratio: 0.499, yield_stress: 0.035e6, hardening_modulus: 0.10e6, failure_strain: 1.20, tensile_failure_stress: 0.35e6,
        jc_A: 0.035e6, jc_B: 0.10e6, jc_n: 0.50, jc_C: 0.100, jc_m: 1.00, T_melt: 315.0, T_room: 277.15, Cp: 4100.0, mg_gamma0: 0.12, mg_c0: 1520.0, mg_s: 1.90,
        category: 'Soft Materials, Bio-Surrogates & Composites', reference: 'Jussila, Forensic Sci. Int. (2004)'
    },
    'Water (Hydrodynamic Shock)': {
        density: 1000.0, youngs_modulus: 2.2e9, poissons_ratio: 0.499, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 5.00, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 273.15, T_room: 293.0, Cp: 4184.0, mg_gamma0: 0.10, mg_c0: 1480.0, mg_s: 1.92,
        category: 'Soft Materials, Bio-Surrogates & Composites', reference: 'Rice & Walsh, J. Chem. Phys. (1957) Water EOS'
    },
    'Al-PTFE Reactive Material': {
        density: 2270.0, youngs_modulus: 1.2e9, poissons_ratio: 0.40, yield_stress: 35.0e6, hardening_modulus: 120.0e6, failure_strain: 0.30, tensile_failure_stress: 45.0e6,
        jc_A: 35.0e6, jc_B: 80.0e6, jc_n: 0.45, jc_C: 0.050, jc_m: 1.00, T_melt: 600.0, T_room: 293.0, Cp: 940.0, mg_gamma0: 0.80, mg_c0: 2300.0, mg_s: 1.65,
        category: 'Soft Materials, Bio-Surrogates & Composites', reference: 'Cai et al., Appl. Phys. Lett. (2008) Reactive Materials'
    },
    'Al-Al2O3 MMC': {
        density: 3000.0, youngs_modulus: 110.0e9, poissons_ratio: 0.30, yield_stress: 450.0e6, hardening_modulus: 800.0e6, failure_strain: 0.08, tensile_failure_stress: 520.0e6,
        jc_A: 450.0e6, jc_B: 500.0e6, jc_n: 0.35, jc_C: 0.005, jc_m: 1.20, T_melt: 925.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 1.60, mg_c0: 5600.0, mg_s: 1.35,
        category: 'Soft Materials, Bio-Surrogates & Composites', reference: 'Lloyd, Int. Mater. Rev. (1994) Metal Matrix Composites'
    },

    // ---------------------------------------------------------
    // 9. Linear Elastic Presets
    // ---------------------------------------------------------
    'Aluminum 6061-T6 (Elastic)': {
        density: 2700.0, youngs_modulus: 68.9e9, poissons_ratio: 0.33, yield_stress: 276.0e6, hardening_modulus: 500.0e6, failure_strain: 0.12, tensile_failure_stress: 310.0e6,
        jc_A: 276.0e6, jc_B: 500.0e6, jc_n: 0.30, jc_C: 0.002, jc_m: 1.00, T_melt: 925.0, T_room: 293.0, Cp: 896.0, mg_gamma0: 1.97, mg_c0: 5240.0, mg_s: 1.40,
        category: 'Linear Elastic Presets', reference: 'MIL-HDBK-5J Metallic Materials Data'
    },
    'Titanium Ti-6Al-4V (Elastic)': {
        density: 4430.0, youngs_modulus: 113.8e9, poissons_ratio: 0.342, yield_stress: 880.0e6, hardening_modulus: 1.0e9, failure_strain: 0.14, tensile_failure_stress: 950.0e6,
        jc_A: 880.0e6, jc_B: 700.0e6, jc_n: 0.40, jc_C: 0.014, jc_m: 0.90, T_melt: 1878.0, T_room: 293.0, Cp: 526.0, mg_gamma0: 1.23, mg_c0: 5020.0, mg_s: 1.03,
        category: 'Linear Elastic Presets', reference: 'Aerospace Structural Metals Handbook'
    },
    'Structural Concrete C30 (Elastic)': {
        density: 2400.0, youngs_modulus: 32.0e9, poissons_ratio: 0.18, yield_stress: 30.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 3.0e6,
        jc_A: 30.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2500.0, mg_s: 1.25,
        category: 'Linear Elastic Presets', reference: 'Eurocode 2: Design of Concrete Structures'
    },
    'Tempered Glass (Elastic)': {
        density: 2500.0, youngs_modulus: 70.0e9, poissons_ratio: 0.22, yield_stress: 2.0e9, hardening_modulus: 0.0, failure_strain: 0.005, tensile_failure_stress: 80.0e6,
        jc_A: 2.0e9, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1473.0, T_room: 293.0, Cp: 840.0, mg_gamma0: 0.40, mg_c0: 3860.0, mg_s: 1.40,
        category: 'Linear Elastic Presets', reference: 'Pilkington Technical Glass Data'
    },

    // ---------------------------------------------------------
    // 10. CREST Reactive Burn Presets (Davis Reactant + Product EOS)
    // ---------------------------------------------------------
    'PBX 9502 (TATB/Kel-F 95/5) - CREST Davis': {
        density: 1895.0, youngs_modulus: 10.0e9, poissons_ratio: 0.35, yield_stress: 50.0e6, hardening_modulus: 100.0e6, failure_strain: 0.10, tensile_failure_stress: 60.0e6,
        jc_A: 50.0e6, jc_B: 100.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 1000.0, mg_gamma0: 0.65, mg_c0: 2050.0, mg_s: 2.12,
        davis_c0: 2050.0, davis_s1: 2.12, davis_gamma0: 0.65, davis_cv: 1000.0, davis_t0: 293.0, davis_rho0: 1895.0,
        davis_a: 2.85, davis_b: 1.10, davis_k: 1.35, davis_vc: 0.65, davis_pc: 12.5e9, davis_q_det: 3.90e6,
        crest_b1: 1.2e7, crest_c1: 0.67, crest_m1: 2.5, crest_b2: 3.5e6, crest_c2: 0.50, crest_c3: 0.67, crest_m2: 1.5, crest_s0: 15.0, crest_s_threshold: 2.0,
        category: 'CREST Reactive Burn Presets', reference: 'Handley, C. A. (2007) CREST reactive burn model for PBX 9502; Davis (1998)'
    },
    'EDC37 (HMX/NC/K10 91/1/8) - CREST Davis': {
        density: 1841.0, youngs_modulus: 8.5e9, poissons_ratio: 0.36, yield_stress: 40.0e6, hardening_modulus: 80.0e6, failure_strain: 0.12, tensile_failure_stress: 50.0e6,
        jc_A: 40.0e6, jc_B: 80.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1100.0, mg_gamma0: 0.70, mg_c0: 2750.0, mg_s: 1.85,
        davis_c0: 2750.0, davis_s1: 1.85, davis_gamma0: 0.70, davis_cv: 1100.0, davis_t0: 293.0, davis_rho0: 1841.0,
        davis_a: 3.10, davis_b: 1.25, davis_k: 1.30, davis_vc: 0.60, davis_pc: 14.2e9, davis_q_det: 5.20e6,
        crest_b1: 2.5e7, crest_c1: 0.67, crest_m1: 2.0, crest_b2: 6.8e6, crest_c2: 0.50, crest_c3: 0.67, crest_m2: 1.2, crest_s0: 14.0, crest_s_threshold: 1.5,
        category: 'CREST Reactive Burn Presets', reference: 'Whitworth, N. J. (2008) CREST modeling of EDC37 shock initiation'
    },
    'PBX 9501 (HMX/Estane 95/5) - CREST Davis': {
        density: 1830.0, youngs_modulus: 9.0e9, poissons_ratio: 0.35, yield_stress: 45.0e6, hardening_modulus: 90.0e6, failure_strain: 0.10, tensile_failure_stress: 55.0e6,
        jc_A: 45.0e6, jc_B: 90.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1080.0, mg_gamma0: 0.68, mg_c0: 2600.0, mg_s: 1.90,
        davis_c0: 2600.0, davis_s1: 1.90, davis_gamma0: 0.68, davis_cv: 1080.0, davis_t0: 293.0, davis_rho0: 1830.0,
        davis_a: 3.00, davis_b: 1.20, davis_k: 1.32, davis_vc: 0.62, davis_pc: 13.8e9, davis_q_det: 5.00e6,
        crest_b1: 2.0e7, crest_c1: 0.67, crest_m1: 2.2, crest_b2: 5.5e6, crest_c2: 0.50, crest_c3: 0.67, crest_m2: 1.3, crest_s0: 14.0, crest_s_threshold: 2.0,
        category: 'CREST Reactive Burn Presets', reference: 'Gibbs & Popolato (1980) LASL Explosive Property Data / Davis EOS'
    },
    'Composition B (RDX/TNT 60/40) - CREST Davis': {
        density: 1717.0, youngs_modulus: 7.2e9, poissons_ratio: 0.34, yield_stress: 35.0e6, hardening_modulus: 70.0e6, failure_strain: 0.15, tensile_failure_stress: 40.0e6,
        jc_A: 35.0e6, jc_B: 70.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1050.0, mg_gamma0: 0.72, mg_c0: 2450.0, mg_s: 1.95,
        davis_c0: 2450.0, davis_s1: 1.95, davis_gamma0: 0.72, davis_cv: 1050.0, davis_t0: 293.0, davis_rho0: 1717.0,
        davis_a: 2.70, davis_b: 1.15, davis_k: 1.36, davis_vc: 0.66, davis_pc: 11.8e9, davis_q_det: 4.60e6,
        crest_b1: 1.8e7, crest_c1: 0.67, crest_m1: 2.3, crest_b2: 4.5e6, crest_c2: 0.50, crest_c3: 0.67, crest_m2: 1.4, crest_s0: 15.0, crest_s_threshold: 1.5,
        category: 'CREST Reactive Burn Presets', reference: 'Urtiew et al. (1998) Shock initiation of Comp B / Davis EOS parameters'
    },
    'LX-17 (TATB/Kel-F 92.5/7.5) - CREST Davis': {
        density: 1905.0, youngs_modulus: 10.5e9, poissons_ratio: 0.35, yield_stress: 52.0e6, hardening_modulus: 105.0e6, failure_strain: 0.10, tensile_failure_stress: 62.0e6,
        jc_A: 52.0e6, jc_B: 105.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 990.0, mg_gamma0: 0.64, mg_c0: 2020.0, mg_s: 2.15,
        davis_c0: 2020.0, davis_s1: 2.15, davis_gamma0: 0.64, davis_cv: 990.0, davis_t0: 293.0, davis_rho0: 1905.0,
        davis_a: 2.80, davis_b: 1.08, davis_k: 1.35, davis_vc: 0.65, davis_pc: 12.2e9, davis_q_det: 3.80e6,
        crest_b1: 1.1e7, crest_c1: 0.67, crest_m1: 2.5, crest_b2: 3.2e6, crest_c2: 0.50, crest_c3: 0.67, crest_m2: 1.5, crest_s0: 15.0, crest_s_threshold: 3.0,
        category: 'CREST Reactive Burn Presets', reference: 'LLNL Explosives Handbook / CREST Parameters for Insensitive HE'
    },

    // ---------------------------------------------------------
    // 11. Concrete Damage Models (RHT, K&C, CSCM)
    // ---------------------------------------------------------
    'Normal-Strength Concrete C35/45 (RHT Default)': {
        density: 2400.0, youngs_modulus: 34.0e9, poissons_ratio: 0.18, yield_stress: 35.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 3.2e6,
        jc_A: 35.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2500.0, mg_s: 1.25,
        fc: 35.0e6, ft: 3.2e6, G_f: 150.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.60, rht_N: 0.61, rht_B: 0.70, rht_M: 0.80, rht_Q0: 0.680, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0,
        rht_p_crush: 17.0e6, rht_p_lock: 600.0e6, rht_alpha0: 1.22, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        category: 'Concrete & Geomaterial Formulations', reference: 'Riedel, Hiermaier, Thoma (1999) Int. J. Impact Eng.'
    },
    'Standard Structural Concrete C30/37 (RHT)': {
        density: 2380.0, youngs_modulus: 32.0e9, poissons_ratio: 0.18, yield_stress: 30.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 2.8e6,
        jc_A: 30.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2450.0, mg_s: 1.25,
        fc: 30.0e6, ft: 2.8e6, G_f: 140.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.60, rht_N: 0.61, rht_B: 0.70, rht_M: 0.80, rht_Q0: 0.680, rht_BQ: 0.0105, rht_D1: 0.04, rht_D2: 1.0,
        rht_p_crush: 15.0e6, rht_p_lock: 550.0e6, rht_alpha0: 1.25, rht_n_comp: 3.0, rht_betac: 0.032, rht_deltat: 0.036,
        category: 'Concrete & Geomaterial Formulations', reference: 'Riedel (2000) Shock Wave Physics in Concrete'
    },
    'High-Strength Concrete C60/75 (RHT)': {
        density: 2450.0, youngs_modulus: 39.0e9, poissons_ratio: 0.19, yield_stress: 60.0e6, hardening_modulus: 0.0, failure_strain: 0.0030, tensile_failure_stress: 4.4e6,
        jc_A: 60.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 0.90, mg_c0: 2600.0, mg_s: 1.28,
        fc: 60.0e6, ft: 4.4e6, G_f: 180.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.55, rht_N: 0.63, rht_B: 0.72, rht_M: 0.78, rht_Q0: 0.700, rht_BQ: 0.0100, rht_D1: 0.035, rht_D2: 1.0,
        rht_p_crush: 30.0e6, rht_p_lock: 800.0e6, rht_alpha0: 1.18, rht_n_comp: 3.0, rht_betac: 0.030, rht_deltat: 0.034,
        category: 'Concrete & Geomaterial Formulations', reference: 'Riedel et al. (2009) High-Strength Armor Concrete'
    },
    'High-Performance Concrete C80/95 (RHT)': {
        density: 2500.0, youngs_modulus: 44.0e9, poissons_ratio: 0.20, yield_stress: 80.0e6, hardening_modulus: 0.0, failure_strain: 0.0028, tensile_failure_stress: 5.2e6,
        jc_A: 80.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 920.0, mg_gamma0: 0.95, mg_c0: 2700.0, mg_s: 1.30,
        fc: 80.0e6, ft: 5.2e6, G_f: 210.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.50, rht_N: 0.65, rht_B: 0.75, rht_M: 0.75, rht_Q0: 0.720, rht_BQ: 0.0095, rht_D1: 0.030, rht_D2: 1.0,
        rht_p_crush: 40.0e6, rht_p_lock: 1000.0e6, rht_alpha0: 1.15, rht_n_comp: 3.0, rht_betac: 0.028, rht_deltat: 0.032,
        category: 'Concrete & Geomaterial Formulations', reference: 'Tu & Lu (2010) High Performance Concrete'
    },
    'Ultra-High Performance Concrete UHPC 140 (RHT)': {
        density: 2550.0, youngs_modulus: 52.0e9, poissons_ratio: 0.21, yield_stress: 140.0e6, hardening_modulus: 0.0, failure_strain: 0.0040, tensile_failure_stress: 9.5e6,
        jc_A: 140.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.00, mg_c0: 2850.0, mg_s: 1.32,
        fc: 140.0e6, ft: 9.5e6, G_f: 350.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.45, rht_N: 0.68, rht_B: 0.80, rht_M: 0.72, rht_Q0: 0.750, rht_BQ: 0.0090, rht_D1: 0.020, rht_D2: 1.0,
        rht_p_crush: 70.0e6, rht_p_lock: 1500.0e6, rht_alpha0: 1.10, rht_n_comp: 3.0, rht_betac: 0.025, rht_deltat: 0.028,
        category: 'Concrete & Geomaterial Formulations', reference: 'Ductal UHPC Penetration Studies'
    },
    'Low-Strength Blast Berm Concrete C20/25 (RHT)': {
        density: 2300.0, youngs_modulus: 28.0e9, poissons_ratio: 0.17, yield_stress: 20.0e6, hardening_modulus: 0.0, failure_strain: 0.0040, tensile_failure_stress: 2.0e6,
        jc_A: 20.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 850.0, mg_gamma0: 0.80, mg_c0: 2350.0, mg_s: 1.22,
        fc: 20.0e6, ft: 2.0e6, G_f: 120.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        rht_A: 1.65, rht_N: 0.60, rht_B: 0.68, rht_M: 0.82, rht_Q0: 0.660, rht_BQ: 0.0110, rht_D1: 0.05, rht_D2: 1.0,
        rht_p_crush: 10.0e6, rht_p_lock: 450.0e6, rht_alpha0: 1.30, rht_n_comp: 3.0, rht_betac: 0.035, rht_deltat: 0.040,
        category: 'Concrete & Geomaterial Formulations', reference: 'Low-Strength Concrete Blast Berm Calibration'
    },

    // K&C Concrete Models
    'Normal-Strength Concrete C35/45 (K&C Auto MAT_072R3)': {
        density: 2400.0, youngs_modulus: 34.0e9, poissons_ratio: 0.18, yield_stress: 35.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 3.2e6,
        jc_A: 35.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2500.0, mg_s: 1.25,
        fc: 35.0e6, ft: 3.2e6, G_f: 150.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        kc_auto_generate: true, kc_a0: 11.6e6, kc_a1: 0.45, kc_a2: 4.28e-9, kc_a0y: 5.2e6, kc_a1y: 0.45, kc_a2y: 4.28e-9, kc_a1r: 0.75, kc_a2r: 5.71e-9, kc_b1: 1.60, kc_omega: 0.50,
        category: 'Concrete & Geomaterial Formulations', reference: 'Malvar et al., Karagozian & Case Concrete Model (MAT_072R3)'
    },
    'Standard Structural Concrete C30/37 (K&C Auto)': {
        density: 2380.0, youngs_modulus: 32.0e9, poissons_ratio: 0.18, yield_stress: 30.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 2.8e6,
        jc_A: 30.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2450.0, mg_s: 1.25,
        fc: 30.0e6, ft: 2.8e6, G_f: 140.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        kc_auto_generate: true, kc_a0: 10.0e6, kc_a1: 0.45, kc_a2: 4.28e-9, kc_a0y: 4.5e6, kc_a1y: 0.45, kc_a2y: 4.28e-9, kc_a1r: 0.75, kc_a2r: 5.71e-9, kc_b1: 1.60, kc_omega: 0.50,
        category: 'Concrete & Geomaterial Formulations', reference: 'K&C MAT_072R3 Standard Concrete'
    },
    'High-Strength Concrete C60/75 (K&C Auto)': {
        density: 2450.0, youngs_modulus: 39.0e9, poissons_ratio: 0.19, yield_stress: 60.0e6, hardening_modulus: 0.0, failure_strain: 0.0030, tensile_failure_stress: 4.4e6,
        jc_A: 60.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 0.90, mg_c0: 2600.0, mg_s: 1.28,
        fc: 60.0e6, ft: 4.4e6, G_f: 180.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        kc_auto_generate: true, kc_a0: 20.0e6, kc_a1: 0.43, kc_a2: 4.00e-9, kc_a0y: 9.0e6, kc_a1y: 0.43, kc_a2y: 4.00e-9, kc_a1r: 0.72, kc_a2r: 5.50e-9, kc_b1: 1.55, kc_omega: 0.50,
        category: 'Concrete & Geomaterial Formulations', reference: 'K&C MAT_072R3 High Strength Concrete'
    },
    'High-Performance Concrete C80/95 (K&C Auto)': {
        density: 2500.0, youngs_modulus: 44.0e9, poissons_ratio: 0.20, yield_stress: 80.0e6, hardening_modulus: 0.0, failure_strain: 0.0028, tensile_failure_stress: 5.2e6,
        jc_A: 80.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 920.0, mg_gamma0: 0.95, mg_c0: 2700.0, mg_s: 1.30,
        fc: 80.0e6, ft: 5.2e6, G_f: 210.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        kc_auto_generate: true, kc_a0: 26.5e6, kc_a1: 0.42, kc_a2: 3.80e-9, kc_a0y: 12.0e6, kc_a1y: 0.42, kc_a2y: 3.80e-9, kc_a1r: 0.70, kc_a2r: 5.20e-9, kc_b1: 1.50, kc_omega: 0.50,
        category: 'Concrete & Geomaterial Formulations', reference: 'K&C MAT_072R3 High Performance Concrete'
    },
    'Ultra-High Performance Concrete UHPC 140 (K&C Auto)': {
        density: 2550.0, youngs_modulus: 52.0e9, poissons_ratio: 0.21, yield_stress: 140.0e6, hardening_modulus: 0.0, failure_strain: 0.0040, tensile_failure_stress: 9.5e6,
        jc_A: 140.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.00, mg_c0: 2850.0, mg_s: 1.32,
        fc: 140.0e6, ft: 9.5e6, G_f: 350.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        kc_auto_generate: true, kc_a0: 46.0e6, kc_a1: 0.40, kc_a2: 3.50e-9, kc_a0y: 21.0e6, kc_a1y: 0.40, kc_a2y: 3.50e-9, kc_a1r: 0.68, kc_a2r: 4.80e-9, kc_b1: 1.40, kc_omega: 0.50,
        category: 'Concrete & Geomaterial Formulations', reference: 'K&C MAT_072R3 UHPC Calibration'
    },

    // CSCM Concrete Models
    'Normal-Strength Concrete C35/45 (CSCM MAT_159 Standard)': {
        density: 2400.0, youngs_modulus: 34.0e9, poissons_ratio: 0.18, yield_stress: 35.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 3.2e6,
        jc_A: 35.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2500.0, mg_s: 1.25,
        fc: 35.0e6, ft: 3.2e6, G_f: 150.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        cscm_alpha: 14.0e6, cscm_theta: 0.15, cscm_lambda: 10.5e6, cscm_beta: 2.85e-9, cscm_R: 5.0, cscm_X0: 87.5e6, cscm_W: 0.05, cscm_D1: 2.5e-9, cscm_D2: 3.0e-17,
        category: 'Concrete & Geomaterial Formulations', reference: 'Murray, Y. D. (2007) Users Manual for LS-DYNA Concrete Model MAT_159'
    },
    'Standard Structural Concrete C30/37 (CSCM)': {
        density: 2380.0, youngs_modulus: 32.0e9, poissons_ratio: 0.18, yield_stress: 30.0e6, hardening_modulus: 0.0, failure_strain: 0.0035, tensile_failure_stress: 2.8e6,
        jc_A: 30.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 880.0, mg_gamma0: 0.85, mg_c0: 2450.0, mg_s: 1.25,
        fc: 30.0e6, ft: 2.8e6, G_f: 140.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        cscm_alpha: 12.0e6, cscm_theta: 0.15, cscm_lambda: 9.0e6, cscm_beta: 2.85e-9, cscm_R: 5.0, cscm_X0: 75.0e6, cscm_W: 0.05, cscm_D1: 2.5e-9, cscm_D2: 3.0e-17,
        category: 'Concrete & Geomaterial Formulations', reference: 'FHWA-HRT-05-062 CSCM Concrete Calibration'
    },
    'High-Strength Concrete C60/75 (CSCM)': {
        density: 2450.0, youngs_modulus: 39.0e9, poissons_ratio: 0.19, yield_stress: 60.0e6, hardening_modulus: 0.0, failure_strain: 0.0030, tensile_failure_stress: 4.4e6,
        jc_A: 60.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 0.90, mg_c0: 2600.0, mg_s: 1.28,
        fc: 60.0e6, ft: 4.4e6, G_f: 180.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        cscm_alpha: 24.0e6, cscm_theta: 0.14, cscm_lambda: 18.0e6, cscm_beta: 2.70e-9, cscm_R: 5.0, cscm_X0: 150.0e6, cscm_W: 0.045, cscm_D1: 2.2e-9, cscm_D2: 3.0e-17,
        category: 'Concrete & Geomaterial Formulations', reference: 'CSCM High-Strength Concrete Testing'
    },
    'High-Performance Concrete C80/95 (CSCM)': {
        density: 2500.0, youngs_modulus: 44.0e9, poissons_ratio: 0.20, yield_stress: 80.0e6, hardening_modulus: 0.0, failure_strain: 0.0028, tensile_failure_stress: 5.2e6,
        jc_A: 80.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 920.0, mg_gamma0: 0.95, mg_c0: 2700.0, mg_s: 1.30,
        fc: 80.0e6, ft: 5.2e6, G_f: 210.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        cscm_alpha: 32.0e6, cscm_theta: 0.13, cscm_lambda: 24.0e6, cscm_beta: 2.60e-9, cscm_R: 5.0, cscm_X0: 200.0e6, cscm_W: 0.040, cscm_D1: 2.0e-9, cscm_D2: 3.0e-17,
        category: 'Concrete & Geomaterial Formulations', reference: 'CSCM High Performance Concrete Parameters'
    },
    'Ultra-High Performance Concrete UHPC 140 (CSCM)': {
        density: 2550.0, youngs_modulus: 52.0e9, poissons_ratio: 0.21, yield_stress: 140.0e6, hardening_modulus: 0.0, failure_strain: 0.0040, tensile_failure_stress: 9.5e6,
        jc_A: 140.0e6, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 1800.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.00, mg_c0: 2850.0, mg_s: 1.32,
        fc: 140.0e6, ft: 9.5e6, G_f: 350.0, moisture_content: 0.0, dif_cap_compression: 2.5, dif_cap_tension: 8.0,
        cscm_alpha: 56.0e6, cscm_theta: 0.12, cscm_lambda: 42.0e6, cscm_beta: 2.50e-9, cscm_R: 5.0, cscm_X0: 350.0e6, cscm_W: 0.035, cscm_D1: 1.8e-9, cscm_D2: 3.0e-17,
        category: 'Concrete & Geomaterial Formulations', reference: 'CSCM UHPC Calibration'
    },

    // ---------------------------------------------------------
    // 12. Ideal Gas Presets (Eulerian CFD)
    // ---------------------------------------------------------
    'Air (Standard STP, gamma=1.4)': {
        density: 1.225, youngs_modulus: 1.42e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 1005.0, mg_gamma0: 0.40, mg_c0: 340.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'Standard Atmosphere (ISO 2533 / NASA)'
    },
    'Air (Dry Sea-Level STP)': {
        density: 1.204, youngs_modulus: 1.42e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1006.0, mg_gamma0: 0.40, mg_c0: 343.2, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'ISO Standard Atmosphere Sea-Level 20°C'
    },
    'Air (Stratosphere 20km)': {
        density: 0.0889, youngs_modulus: 7.74e3, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 216.65, Cp: 1005.0, mg_gamma0: 0.40, mg_c0: 295.0, mg_s: 1.00,
        atm_pressure: 5529.0, atm_temperature: 216.65, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'US Standard Atmosphere 1976 (20 km altitude)'
    },
    'Air (High-Temperature Shock 1000K)': {
        density: 0.352, youngs_modulus: 1.37e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.0, Cp: 1142.0, mg_gamma0: 0.35, mg_c0: 624.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 1000.0, gamma: 1.35,
        category: 'Ideal Gas Presets', reference: 'NIST High-Temperature Air Tables (1000 K)'
    },
    'Nitrogen (N2, gamma=1.40)': {
        density: 1.165, youngs_modulus: 1.42e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1040.0, mg_gamma0: 0.40, mg_c0: 349.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Nitrogen Gas)'
    },
    'Oxygen (O2, gamma=1.40)': {
        density: 1.331, youngs_modulus: 1.42e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 918.0, mg_gamma0: 0.40, mg_c0: 326.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Oxygen Gas)'
    },
    'Helium (Noble, gamma=1.667)': {
        density: 0.1786, youngs_modulus: 1.69e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 5193.0, mg_gamma0: 0.667, mg_c0: 1007.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.667,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Helium Thermophysical Properties)'
    },
    'Argon (Noble, gamma=1.667)': {
        density: 1.784, youngs_modulus: 1.69e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 520.0, mg_gamma0: 0.667, mg_c0: 319.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.667,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Argon Thermophysical Properties)'
    },
    'Neon (Noble, gamma=1.667)': {
        density: 0.838, youngs_modulus: 1.69e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1030.0, mg_gamma0: 0.667, mg_c0: 449.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.667,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Neon Gas)'
    },
    'Krypton (Noble, gamma=1.667)': {
        density: 3.486, youngs_modulus: 1.69e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 248.0, mg_gamma0: 0.667, mg_c0: 221.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.667,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Krypton Gas)'
    },
    'Xenon (Noble, gamma=1.667)': {
        density: 5.464, youngs_modulus: 1.69e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 158.0, mg_gamma0: 0.667, mg_c0: 176.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.667,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Xenon Gas)'
    },
    'Hydrogen (H2, gamma=1.41)': {
        density: 0.0899, youngs_modulus: 1.43e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 14300.0, mg_gamma0: 0.41, mg_c0: 1290.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.41,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Hydrogen Properties)'
    },
    'Methane (CH4, gamma=1.32)': {
        density: 0.717, youngs_modulus: 1.34e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 2220.0, mg_gamma0: 0.32, mg_c0: 430.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.32,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Methane Properties)'
    },
    'Propane (C3H8, gamma=1.13)': {
        density: 1.868, youngs_modulus: 1.14e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1670.0, mg_gamma0: 0.13, mg_c0: 247.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.13,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Propane Gas)'
    },
    'Ethylene (C2H4, gamma=1.24)': {
        density: 1.178, youngs_modulus: 1.26e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1540.0, mg_gamma0: 0.24, mg_c0: 327.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.24,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Ethylene Gas)'
    },
    'Acetylene (C2H2, gamma=1.23)': {
        density: 1.097, youngs_modulus: 1.25e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1690.0, mg_gamma0: 0.23, mg_c0: 340.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.23,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Acetylene Gas)'
    },
    'Carbon Monoxide (CO, gamma=1.40)': {
        density: 1.165, youngs_modulus: 1.42e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 1040.0, mg_gamma0: 0.40, mg_c0: 349.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.40,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Carbon Monoxide)'
    },
    'Carbon Dioxide (CO2, gamma=1.30)': {
        density: 1.977, youngs_modulus: 1.32e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 288.15, Cp: 844.0, mg_gamma0: 0.30, mg_c0: 258.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 288.15, gamma: 1.30,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Carbon Dioxide Properties)'
    },
    'Sulfur Hexafluoride (SF6, gamma=1.09)': {
        density: 6.130, youngs_modulus: 1.10e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 665.0, mg_gamma0: 0.09, mg_c0: 152.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.09,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Sulfur Hexafluoride)'
    },
    'Ammonia (NH3, gamma=1.31)': {
        density: 0.730, youngs_modulus: 1.33e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 2170.0, mg_gamma0: 0.31, mg_c0: 430.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.31,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Ammonia Gas)'
    },
    'Nitrous Oxide (N2O, gamma=1.30)': {
        density: 1.870, youngs_modulus: 1.32e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 880.0, mg_gamma0: 0.30, mg_c0: 263.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.30,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Nitrous Oxide)'
    },
    'Water Vapor / Steam (H2O, gamma=1.33)': {
        density: 0.598, youngs_modulus: 1.35e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 373.15, Cp: 2080.0, mg_gamma0: 0.33, mg_c0: 478.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 373.15, gamma: 1.33,
        category: 'Ideal Gas Presets', reference: 'IAPWS-IF97 Steam Tables (100°C saturated vapor)'
    },
    'Chlorine (Cl2, gamma=1.34)': {
        density: 2.980, youngs_modulus: 1.36e5, poissons_ratio: 0.0, yield_stress: 0.0, hardening_modulus: 0.0, failure_strain: 100.0, tensile_failure_stress: 0.0,
        jc_A: 0.0, jc_B: 0.0, jc_n: 1.00, jc_C: 0.0, jc_m: 1.00, T_melt: 10000.0, T_room: 293.15, Cp: 480.0, mg_gamma0: 0.34, mg_c0: 215.0, mg_s: 1.00,
        atm_pressure: 101325.0, atm_temperature: 293.15, gamma: 1.34,
        category: 'Ideal Gas Presets', reference: 'NIST Chemistry WebBook (Chlorine Gas)'
    },

    // ---------------------------------------------------------
    // 13. JWL Detonation Gas Presets (Eulerian CFD)
    // ---------------------------------------------------------
    'TNT (Trinitrotoluene)': {
        density: 1630.0, youngs_modulus: 6.0e9, poissons_ratio: 0.35, yield_stress: 20.0e6, hardening_modulus: 120.0e6, failure_strain: 0.07, tensile_failure_stress: 5.0e6,
        jc_A: 20.0e6, jc_B: 60.0e6, jc_n: 0.38, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1260.0, mg_gamma0: 0.92, mg_c0: 2470.0, mg_s: 1.59,
        composition: 'TNT', rho: 1630.0, detonation_energy: 4.29e6, det_vel: 6930.0, jwl_A: 373.77e9, jwl_B: 3.747e9, jwl_R1: 4.15, jwl_R2: 0.90, jwl_omega: 0.35,
        ideal_gamma: 1.40, ideal_rho_0: 1630.0, ideal_e_0: 4.29e6,
        category: 'JWL Detonation Gas Presets', reference: 'Dobratz, B. M. LLNL Explosives Handbook UCRL-52997'
    },
    'C-4 (Composition 4)': {
        density: 1601.0, youngs_modulus: 5.5e9, poissons_ratio: 0.36, yield_stress: 15.0e6, hardening_modulus: 80.0e6, failure_strain: 0.10, tensile_failure_stress: 4.0e6,
        jc_A: 15.0e6, jc_B: 50.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 450.0, T_room: 293.0, Cp: 1300.0, mg_gamma0: 0.90, mg_c0: 2500.0, mg_s: 1.60,
        composition: 'C-4', rho: 1601.0, detonation_energy: 5.60e6, det_vel: 8193.0, jwl_A: 596.22e9, jwl_B: 13.75e9, jwl_R1: 4.50, jwl_R2: 1.50, jwl_omega: 0.32,
        ideal_gamma: 1.40, ideal_rho_0: 1601.0, ideal_e_0: 5.60e6,
        category: 'JWL Detonation Gas Presets', reference: 'Lee et al., JWL Equation of State Parameters for High Explosives'
    },
    'Composition B (Comp B)': {
        density: 1717.0, youngs_modulus: 7.2e9, poissons_ratio: 0.34, yield_stress: 35.0e6, hardening_modulus: 70.0e6, failure_strain: 0.15, tensile_failure_stress: 40.0e6,
        jc_A: 35.0e6, jc_B: 70.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1050.0, mg_gamma0: 0.72, mg_c0: 2450.0, mg_s: 1.95,
        composition: 'Comp B', rho: 1717.0, detonation_energy: 5.19e6, det_vel: 7980.0, jwl_A: 524.23e9, jwl_B: 7.678e9, jwl_R1: 4.20, jwl_R2: 1.10, jwl_omega: 0.34,
        ideal_gamma: 1.40, ideal_rho_0: 1717.0, ideal_e_0: 5.19e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'PETN (Pentaerythritol Tetranitrate)': {
        density: 1770.0, youngs_modulus: 13.5e9, poissons_ratio: 0.30, yield_stress: 38.0e6, hardening_modulus: 240.0e6, failure_strain: 0.04, tensile_failure_stress: 9.0e6,
        jc_A: 38.0e6, jc_B: 110.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 414.0, T_room: 293.0, Cp: 1120.0, mg_gamma0: 1.05, mg_c0: 2800.0, mg_s: 1.65,
        composition: 'PETN', rho: 1770.0, detonation_energy: 6.00e6, det_vel: 8300.0, jwl_A: 625.3e9, jwl_B: 23.29e9, jwl_R1: 5.25, jwl_R2: 1.60, jwl_omega: 0.28,
        ideal_gamma: 1.40, ideal_rho_0: 1770.0, ideal_e_0: 6.00e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'HMX (Octogen / EDC37)': {
        density: 1890.0, youngs_modulus: 18.0e9, poissons_ratio: 0.28, yield_stress: 55.0e6, hardening_modulus: 380.0e6, failure_strain: 0.03, tensile_failure_stress: 14.0e6,
        jc_A: 55.0e6, jc_B: 160.0e6, jc_n: 0.28, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1020.0, mg_gamma0: 1.15, mg_c0: 3000.0, mg_s: 1.70,
        composition: 'HMX', rho: 1890.0, detonation_energy: 6.20e6, det_vel: 9110.0, jwl_A: 778.3e9, jwl_B: 7.071e9, jwl_R1: 4.20, jwl_R2: 1.00, jwl_omega: 0.30,
        ideal_gamma: 1.40, ideal_rho_0: 1890.0, ideal_e_0: 6.20e6,
        category: 'JWL Detonation Gas Presets', reference: 'LASL Explosive Property Data'
    },
    'RDX (Hexogen / Cyclonite)': {
        density: 1800.0, youngs_modulus: 15.0e9, poissons_ratio: 0.29, yield_stress: 42.0e6, hardening_modulus: 270.0e6, failure_strain: 0.03, tensile_failure_stress: 10.5e6,
        jc_A: 42.0e6, jc_B: 130.0e6, jc_n: 0.31, jc_C: 0.010, jc_m: 1.00, T_melt: 477.0, T_room: 293.0, Cp: 1070.0, mg_gamma0: 1.10, mg_c0: 2840.0, mg_s: 1.67,
        composition: 'RDX', rho: 1800.0, detonation_energy: 5.80e6, det_vel: 8750.0, jwl_A: 611.3e9, jwl_B: 10.65e9, jwl_R1: 4.40, jwl_R2: 1.20, jwl_omega: 0.32,
        ideal_gamma: 1.40, ideal_rho_0: 1800.0, ideal_e_0: 5.80e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'PBX 9501': {
        density: 1830.0, youngs_modulus: 9.0e9, poissons_ratio: 0.35, yield_stress: 45.0e6, hardening_modulus: 90.0e6, failure_strain: 0.10, tensile_failure_stress: 55.0e6,
        jc_A: 45.0e6, jc_B: 90.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1080.0, mg_gamma0: 0.68, mg_c0: 2600.0, mg_s: 1.90,
        composition: 'PBX 9501', rho: 1830.0, detonation_energy: 5.50e6, det_vel: 8800.0, jwl_A: 852.4e9, jwl_B: 18.02e9, jwl_R1: 4.55, jwl_R2: 1.30, jwl_omega: 0.38,
        ideal_gamma: 1.40, ideal_rho_0: 1830.0, ideal_e_0: 5.50e6,
        category: 'JWL Detonation Gas Presets', reference: 'LASL Explosive Property Data'
    },
    'PBX 9502': {
        density: 1895.0, youngs_modulus: 10.0e9, poissons_ratio: 0.35, yield_stress: 50.0e6, hardening_modulus: 100.0e6, failure_strain: 0.10, tensile_failure_stress: 60.0e6,
        jc_A: 50.0e6, jc_B: 100.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 1000.0, mg_gamma0: 0.65, mg_c0: 2050.0, mg_s: 2.12,
        composition: 'PBX 9502', rho: 1895.0, detonation_energy: 4.20e6, det_vel: 7720.0, jwl_A: 559.0e9, jwl_B: 8.44e9, jwl_R1: 4.40, jwl_R2: 1.20, jwl_omega: 0.30,
        ideal_gamma: 1.40, ideal_rho_0: 1895.0, ideal_e_0: 4.20e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'LX-04': {
        density: 1860.0, youngs_modulus: 8.5e9, poissons_ratio: 0.35, yield_stress: 40.0e6, hardening_modulus: 85.0e6, failure_strain: 0.10, tensile_failure_stress: 48.0e6,
        jc_A: 40.0e6, jc_B: 85.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1060.0, mg_gamma0: 0.70, mg_c0: 2580.0, mg_s: 1.88,
        composition: 'LX-04', rho: 1860.0, detonation_energy: 5.30e6, det_vel: 8400.0, jwl_A: 742.0e9, jwl_B: 11.20e9, jwl_R1: 4.40, jwl_R2: 1.20, jwl_omega: 0.30,
        ideal_gamma: 1.40, ideal_rho_0: 1860.0, ideal_e_0: 5.30e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook'
    },
    'LX-07': {
        density: 1860.0, youngs_modulus: 8.6e9, poissons_ratio: 0.35, yield_stress: 42.0e6, hardening_modulus: 86.0e6, failure_strain: 0.10, tensile_failure_stress: 50.0e6,
        jc_A: 42.0e6, jc_B: 86.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1060.0, mg_gamma0: 0.70, mg_c0: 2600.0, mg_s: 1.88,
        composition: 'LX-07', rho: 1860.0, detonation_energy: 5.50e6, det_vel: 8600.0, jwl_A: 785.0e9, jwl_B: 12.50e9, jwl_R1: 4.45, jwl_R2: 1.15, jwl_omega: 0.32,
        ideal_gamma: 1.40, ideal_rho_0: 1860.0, ideal_e_0: 5.50e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook'
    },
    'LX-10': {
        density: 1860.0, youngs_modulus: 8.8e9, poissons_ratio: 0.35, yield_stress: 43.0e6, hardening_modulus: 88.0e6, failure_strain: 0.10, tensile_failure_stress: 51.0e6,
        jc_A: 43.0e6, jc_B: 88.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1060.0, mg_gamma0: 0.70, mg_c0: 2610.0, mg_s: 1.88,
        composition: 'LX-10', rho: 1860.0, detonation_energy: 5.80e6, det_vel: 8820.0, jwl_A: 830.0e9, jwl_B: 15.00e9, jwl_R1: 4.50, jwl_R2: 1.10, jwl_omega: 0.38,
        ideal_gamma: 1.40, ideal_rho_0: 1860.0, ideal_e_0: 5.80e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook'
    },
    'LX-14': {
        density: 1830.0, youngs_modulus: 8.8e9, poissons_ratio: 0.35, yield_stress: 44.0e6, hardening_modulus: 88.0e6, failure_strain: 0.10, tensile_failure_stress: 52.0e6,
        jc_A: 44.0e6, jc_B: 88.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 550.0, T_room: 293.0, Cp: 1060.0, mg_gamma0: 0.70, mg_c0: 2620.0, mg_s: 1.88,
        composition: 'LX-14', rho: 1830.0, detonation_energy: 5.95e6, det_vel: 8830.0, jwl_A: 826.1e9, jwl_B: 17.24e9, jwl_R1: 4.55, jwl_R2: 1.32, jwl_omega: 0.38,
        ideal_gamma: 1.40, ideal_rho_0: 1830.0, ideal_e_0: 5.95e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook'
    },
    'LX-17': {
        density: 1905.0, youngs_modulus: 10.5e9, poissons_ratio: 0.35, yield_stress: 52.0e6, hardening_modulus: 105.0e6, failure_strain: 0.10, tensile_failure_stress: 62.0e6,
        jc_A: 52.0e6, jc_B: 105.0e6, jc_n: 0.30, jc_C: 0.010, jc_m: 1.00, T_melt: 623.0, T_room: 293.0, Cp: 990.0, mg_gamma0: 0.64, mg_c0: 2020.0, mg_s: 2.15,
        composition: 'LX-17', rho: 1905.0, detonation_energy: 4.10e6, det_vel: 7630.0, jwl_A: 535.0e9, jwl_B: 8.00e9, jwl_R1: 4.40, jwl_R2: 1.20, jwl_omega: 0.30,
        ideal_gamma: 1.40, ideal_rho_0: 1905.0, ideal_e_0: 4.10e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook'
    },
    'ANFO (Ammonium Nitrate / Fuel Oil)': {
        density: 880.0, youngs_modulus: 1.5e9, poissons_ratio: 0.40, yield_stress: 2.0e6, hardening_modulus: 10.0e6, failure_strain: 0.25, tensile_failure_stress: 0.5e6,
        jc_A: 2.0e6, jc_B: 8.0e6, jc_n: 0.45, jc_C: 0.020, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1600.0, mg_gamma0: 0.50, mg_c0: 1500.0, mg_s: 1.40,
        composition: 'ANFO', rho: 880.0, detonation_energy: 3.70e6, det_vel: 4560.0, jwl_A: 49.46e9, jwl_B: 1.891e9, jwl_R1: 3.90, jwl_R2: 1.10, jwl_omega: 0.33,
        ideal_gamma: 1.40, ideal_rho_0: 880.0, ideal_e_0: 3.70e6,
        category: 'JWL Detonation Gas Presets', reference: 'Commercial Mining Explosives Data'
    },
    'Aluminized ANFO': {
        density: 1050.0, youngs_modulus: 2.0e9, poissons_ratio: 0.38, yield_stress: 3.0e6, hardening_modulus: 15.0e6, failure_strain: 0.20, tensile_failure_stress: 1.0e6,
        jc_A: 3.0e6, jc_B: 10.0e6, jc_n: 0.40, jc_C: 0.020, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1550.0, mg_gamma0: 0.55, mg_c0: 1650.0, mg_s: 1.45,
        composition: 'Aluminized ANFO', rho: 1050.0, detonation_energy: 4.10e6, det_vel: 4900.0, jwl_A: 76.5e9, jwl_B: 1.85e9, jwl_R1: 4.15, jwl_R2: 1.15, jwl_omega: 0.30,
        ideal_gamma: 1.40, ideal_rho_0: 1050.0, ideal_e_0: 4.10e6,
        category: 'JWL Detonation Gas Presets', reference: 'Commercial Mining Explosives Data'
    },
    'Heavy ANFO': {
        density: 1250.0, youngs_modulus: 2.5e9, poissons_ratio: 0.38, yield_stress: 4.0e6, hardening_modulus: 20.0e6, failure_strain: 0.18, tensile_failure_stress: 1.5e6,
        jc_A: 4.0e6, jc_B: 12.0e6, jc_n: 0.40, jc_C: 0.020, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1500.0, mg_gamma0: 0.52, mg_c0: 1700.0, mg_s: 1.45,
        composition: 'Heavy ANFO', rho: 1250.0, detonation_energy: 3.50e6, det_vel: 5000.0, jwl_A: 198.0e9, jwl_B: 1.45e9, jwl_R1: 4.30, jwl_R2: 1.00, jwl_omega: 0.20,
        ideal_gamma: 1.40, ideal_rho_0: 1250.0, ideal_e_0: 3.50e6,
        category: 'JWL Detonation Gas Presets', reference: 'Commercial Mining Explosives Data'
    },
    'Ammonal': {
        density: 1600.0, youngs_modulus: 4.0e9, poissons_ratio: 0.36, yield_stress: 10.0e6, hardening_modulus: 40.0e6, failure_strain: 0.15, tensile_failure_stress: 3.0e6,
        jc_A: 10.0e6, jc_B: 30.0e6, jc_n: 0.35, jc_C: 0.015, jc_m: 1.00, T_melt: 442.0, T_room: 293.0, Cp: 1400.0, mg_gamma0: 0.60, mg_c0: 2000.0, mg_s: 1.50,
        composition: 'Ammonal', rho: 1600.0, detonation_energy: 4.40e6, det_vel: 5400.0, jwl_A: 125.0e9, jwl_B: 2.50e9, jwl_R1: 4.00, jwl_R2: 1.00, jwl_omega: 0.25,
        ideal_gamma: 1.40, ideal_rho_0: 1600.0, ideal_e_0: 4.40e6,
        category: 'JWL Detonation Gas Presets', reference: 'Demolition Range Reference'
    },
    'Tritonal (80% TNT / 20% Al)': {
        density: 1720.0, youngs_modulus: 8.0e9, poissons_ratio: 0.33, yield_stress: 25.0e6, hardening_modulus: 150.0e6, failure_strain: 0.08, tensile_failure_stress: 6.0e6,
        jc_A: 25.0e6, jc_B: 80.0e6, jc_n: 0.35, jc_C: 0.010, jc_m: 1.00, T_melt: 354.0, T_room: 293.0, Cp: 1180.0, mg_gamma0: 0.95, mg_c0: 2550.0, mg_s: 1.62,
        composition: 'Tritonal', rho: 1720.0, detonation_energy: 5.40e6, det_vel: 6700.0, jwl_A: 400.0e9, jwl_B: 4.50e9, jwl_R1: 4.10, jwl_R2: 0.95, jwl_omega: 0.32,
        ideal_gamma: 1.40, ideal_rho_0: 1720.0, ideal_e_0: 5.40e6,
        category: 'JWL Detonation Gas Presets', reference: 'Air Force Armament Laboratory Tritonal Data'
    },
    'Pentolite 50/50': {
        density: 1650.0, youngs_modulus: 9.0e9, poissons_ratio: 0.32, yield_stress: 28.0e6, hardening_modulus: 160.0e6, failure_strain: 0.06, tensile_failure_stress: 7.0e6,
        jc_A: 28.0e6, jc_B: 85.0e6, jc_n: 0.33, jc_C: 0.010, jc_m: 1.00, T_melt: 373.0, T_room: 293.0, Cp: 1200.0, mg_gamma0: 0.98, mg_c0: 2600.0, mg_s: 1.60,
        composition: 'Pentolite 50/50', rho: 1650.0, detonation_energy: 5.10e6, det_vel: 7470.0, jwl_A: 540.0e9, jwl_B: 9.20e9, jwl_R1: 4.50, jwl_R2: 1.40, jwl_omega: 0.35,
        ideal_gamma: 1.40, ideal_rho_0: 1650.0, ideal_e_0: 5.10e6,
        category: 'JWL Detonation Gas Presets', reference: 'LASL Explosive Property Data'
    },
    'Semtex 1A': {
        density: 1540.0, youngs_modulus: 4.5e9, poissons_ratio: 0.38, yield_stress: 12.0e6, hardening_modulus: 60.0e6, failure_strain: 0.12, tensile_failure_stress: 3.5e6,
        jc_A: 12.0e6, jc_B: 40.0e6, jc_n: 0.36, jc_C: 0.015, jc_m: 1.00, T_melt: 414.0, T_room: 293.0, Cp: 1350.0, mg_gamma0: 0.88, mg_c0: 2380.0, mg_s: 1.64,
        composition: 'Semtex 1A', rho: 1540.0, detonation_energy: 5.40e6, det_vel: 7900.0, jwl_A: 510.0e9, jwl_B: 11.50e9, jwl_R1: 4.40, jwl_R2: 1.30, jwl_omega: 0.32,
        ideal_gamma: 1.40, ideal_rho_0: 1540.0, ideal_e_0: 5.40e6,
        category: 'JWL Detonation Gas Presets', reference: 'Explosia a.s. Technical Data'
    },
    'Tetryl': {
        density: 1730.0, youngs_modulus: 11.0e9, poissons_ratio: 0.31, yield_stress: 32.0e6, hardening_modulus: 180.0e6, failure_strain: 0.05, tensile_failure_stress: 8.0e6,
        jc_A: 32.0e6, jc_B: 95.0e6, jc_n: 0.32, jc_C: 0.010, jc_m: 1.00, T_melt: 402.0, T_room: 293.0, Cp: 1150.0, mg_gamma0: 0.95, mg_c0: 2700.0, mg_s: 1.65,
        composition: 'Tetryl', rho: 1730.0, detonation_energy: 4.23e6, det_vel: 7570.0, jwl_A: 510.9e9, jwl_B: 8.44e9, jwl_R1: 4.50, jwl_R2: 1.40, jwl_omega: 0.25,
        ideal_gamma: 1.40, ideal_rho_0: 1730.0, ideal_e_0: 4.23e6,
        category: 'JWL Detonation Gas Presets', reference: 'LLNL Explosives Handbook UCRL-52997'
    },
    'Mining Emulsion': {
        density: 1150.0, youngs_modulus: 2.2e9, poissons_ratio: 0.38, yield_stress: 3.5e6, hardening_modulus: 18.0e6, failure_strain: 0.20, tensile_failure_stress: 1.2e6,
        jc_A: 3.5e6, jc_B: 11.0e6, jc_n: 0.40, jc_C: 0.020, jc_m: 1.00, T_melt: 360.0, T_room: 293.0, Cp: 1550.0, mg_gamma0: 0.54, mg_c0: 1600.0, mg_s: 1.45,
        composition: 'Mining Emulsion', rho: 1150.0, detonation_energy: 3.20e6, det_vel: 5300.0, jwl_A: 215.0e9, jwl_B: 1.76e9, jwl_R1: 4.45, jwl_R2: 1.05, jwl_omega: 0.15,
        ideal_gamma: 1.40, ideal_rho_0: 1150.0, ideal_e_0: 3.20e6,
        category: 'JWL Detonation Gas Presets', reference: 'Commercial Mining Explosives Data'
    },
    'Water Gel': {
        density: 1200.0, youngs_modulus: 2.4e9, poissons_ratio: 0.38, yield_stress: 3.8e6, hardening_modulus: 19.0e6, failure_strain: 0.19, tensile_failure_stress: 1.4e6,
        jc_A: 3.8e6, jc_B: 11.5e6, jc_n: 0.40, jc_C: 0.020, jc_m: 1.00, T_melt: 360.0, T_room: 293.0, Cp: 1580.0, mg_gamma0: 0.53, mg_c0: 1650.0, mg_s: 1.45,
        composition: 'Water Gel', rho: 1200.0, detonation_energy: 3.40e6, det_vel: 4800.0, jwl_A: 154.0e9, jwl_B: 2.15e9, jwl_R1: 4.30, jwl_R2: 1.10, jwl_omega: 0.25,
        ideal_gamma: 1.40, ideal_rho_0: 1200.0, ideal_e_0: 3.40e6,
        category: 'JWL Detonation Gas Presets', reference: 'Commercial Mining Explosives Data'
    }
};

export function getConstitutiveModels(): string[] {
    return [
        'Linear Elastic',
        'Hypoelastic',
        'Johnson-Cook + Mie-Grüneisen',
        'CREST Reactive Burn',
        'RHT Concrete',
        'Karagozian & Case (K&C)',
        'CSCM Concrete',
        'Ideal Gas',
        'JWL Detonation Gas'
    ];
}

export function getPresetsForConstitutiveModel(modelName: string): string[] {
    switch (modelName) {
        case 'Linear Elastic':
            return [
                'Structural Steel (A36)',
                'Steel S275',
                'Steel S355',
                'Aluminum 6061-T6 (Elastic)',
                'Titanium Ti-6Al-4V (Elastic)',
                'Structural Concrete C30 (Elastic)',
                'Tempered Glass (Elastic)',
                'Soda-Lime Glass',
                'Fused Silica Glass',
                'Polycarbonate (Lexan)',
                'Nylon 6-6',
                'Custom'
            ];
        case 'Hypoelastic':
            return [
                'Structural Steel (A36)',
                'Steel S275',
                'Steel S355',
                'Steel S460',
                'Steel 1006',
                'Steel 1020',
                'Steel 4340',
                'Q1N (HY-80 Naval Steel)',
                'HY-100 Steel',
                'RHA (Rolled Homogeneous Armor)',
                'Armox 500T',
                'Armox 600T',
                'Weldox 700E',
                'Weldox 900E',
                'Stainless Steel 304',
                'Stainless Steel 316L',
                'Aluminum 6061-T6',
                'Aluminum 7075-T6',
                'Aluminum 2024-T3',
                'Copper (OFHC)',
                'Brass 260 (Cartridge Brass)',
                'Titanium Ti-6Al-4V',
                'Lead (Pure)',
                'Custom'
            ];
        case 'Johnson-Cook + Mie-Grüneisen':
            return [
                'High-Strength Armor Steel (4340)',
                'Steel 4340',
                'Steel 1006',
                'Steel 1020',
                'Armox 500T',
                'Armox 600T',
                'Weldox 700E',
                'Weldox 900E',
                'Stainless Steel 304',
                'Stainless Steel 316L',
                'Tool Steel D2',
                'Aluminum 6061-T6',
                'Aluminum 7075-T6',
                'Aluminum 2024-T3',
                'Aluminum 1100-O',
                'Aluminum 5083-H116',
                'Copper (OFHC)',
                'Copper (C11000)',
                'Brass 260 (Cartridge Brass)',
                'Titanium Ti-6Al-4V',
                'Titanium CP (Grade 2)',
                'Tungsten Heavy Alloy (W-90NiFe)',
                'Tantalum (Pure)',
                'Nickel 200',
                'Inconel 718',
                'Magnesium AZ31B',
                'Custom'
            ];
        case 'CREST Reactive Burn':
            return [
                'PBX 9502 (TATB/Kel-F 95/5) - CREST Davis',
                'EDC37 (HMX/NC/K10 91/1/8) - CREST Davis',
                'PBX 9501 (HMX/Estane 95/5) - CREST Davis',
                'Composition B (RDX/TNT 60/40) - CREST Davis',
                'LX-17 (TATB/Kel-F 92.5/7.5) - CREST Davis',
                'HMX (Unreacted)',
                'RDX (Unreacted)',
                'PETN (Unreacted)',
                'TNT (Unreacted)',
                'Custom'
            ];
        case 'RHT Concrete':
            return [
                'Standard Structural Concrete C30/37 (RHT)',
                'Normal-Strength Concrete C35/45 (RHT Default)',
                'High-Strength Concrete C60/75 (RHT)',
                'High-Performance Concrete C80/95 (RHT)',
                'Ultra-High Performance Concrete UHPC 140 (RHT)',
                'Low-Strength Blast Berm Concrete C20/25 (RHT)',
                'Custom'
            ];
        case 'Karagozian & Case (K&C)':
            return [
                'Standard Structural Concrete C30/37 (K&C Auto)',
                'Normal-Strength Concrete C35/45 (K&C Auto MAT_072R3)',
                'High-Strength Concrete C60/75 (K&C Auto)',
                'High-Performance Concrete C80/95 (K&C Auto)',
                'Ultra-High Performance Concrete UHPC 140 (K&C Auto)',
                'Custom'
            ];
        case 'CSCM Concrete':
            return [
                'Standard Structural Concrete C30/37 (CSCM)',
                'Normal-Strength Concrete C35/45 (CSCM MAT_159 Standard)',
                'High-Strength Concrete C60/75 (CSCM)',
                'High-Performance Concrete C80/95 (CSCM)',
                'Ultra-High Performance Concrete UHPC 140 (CSCM)',
                'Custom'
            ];
        case 'Ideal Gas':
            return [
                'Air (Standard STP, gamma=1.4)',
                'Air (Dry Sea-Level STP)',
                'Air (Stratosphere 20km)',
                'Air (High-Temperature Shock 1000K)',
                'Nitrogen (N2, gamma=1.40)',
                'Oxygen (O2, gamma=1.40)',
                'Helium (Noble, gamma=1.667)',
                'Argon (Noble, gamma=1.667)',
                'Neon (Noble, gamma=1.667)',
                'Krypton (Noble, gamma=1.667)',
                'Xenon (Noble, gamma=1.667)',
                'Hydrogen (H2, gamma=1.41)',
                'Methane (CH4, gamma=1.32)',
                'Propane (C3H8, gamma=1.13)',
                'Ethylene (C2H4, gamma=1.24)',
                'Acetylene (C2H2, gamma=1.23)',
                'Carbon Monoxide (CO, gamma=1.40)',
                'Carbon Dioxide (CO2, gamma=1.30)',
                'Sulfur Hexafluoride (SF6, gamma=1.09)',
                'Ammonia (NH3, gamma=1.31)',
                'Nitrous Oxide (N2O, gamma=1.30)',
                'Water Vapor / Steam (H2O, gamma=1.33)',
                'Chlorine (Cl2, gamma=1.34)',
                'Custom'
            ];
        case 'JWL Detonation Gas':
            return [
                'TNT (Trinitrotoluene)',
                'C-4 (Composition 4)',
                'Composition B (Comp B)',
                'PETN (Pentaerythritol Tetranitrate)',
                'HMX (Octogen / EDC37)',
                'RDX (Hexogen / Cyclonite)',
                'PBX 9501',
                'PBX 9502',
                'LX-04',
                'LX-07',
                'LX-10',
                'LX-14',
                'LX-17',
                'ANFO (Ammonium Nitrate / Fuel Oil)',
                'Aluminized ANFO',
                'Heavy ANFO',
                'Ammonal',
                'Tritonal (80% TNT / 20% Al)',
                'Pentolite 50/50',
                'Semtex 1A',
                'Tetryl',
                'Mining Emulsion',
                'Water Gel',
                'Custom'
            ];
        default:
            return ['Custom'];
    }
}

export function getDefaultPresetForModel(modelName: string): string {
    const list = getPresetsForConstitutiveModel(modelName);
    return list.length > 0 ? list[0] : 'Custom';
}
