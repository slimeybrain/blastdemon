export interface MPMMaterialParams {
    density: number;
    youngs_modulus: number;
    poissons_ratio: number;
    yield_stress: number;
    hardening_modulus: number;
    failure_strain: number;
    tensile_failure_stress: number;
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
    reference: string;
    category: string;
}

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
        density: 2300.0, youngs_modulus: 30.0e9, poissons_ratio: 0.20, yield_stress: 20.0e6, hardening_modulus: 200.0e6, failure_strain: 0.0035, tensile_failure_stress: 2.2e6,
        jc_A: 20.0e6, jc_B: 150.0e6, jc_n: 0.40, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3000.0, mg_s: 1.20,
        category: 'Concrete & Masonry Strength Grades', reference: 'Eurocode 2 EN 1992-1-1 / Riedel-Hiermaier-Thoma (RHT) Model'
    },
    'Standard Structural Concrete C30/37 (30 MPa)': {
        density: 2350.0, youngs_modulus: 33.0e9, poissons_ratio: 0.20, yield_stress: 30.0e6, hardening_modulus: 250.0e6, failure_strain: 0.0035, tensile_failure_stress: 2.9e6,
        jc_A: 30.0e6, jc_B: 180.0e6, jc_n: 0.40, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3100.0, mg_s: 1.25,
        category: 'Concrete & Masonry Strength Grades', reference: 'Eurocode 2 C30/37 Standard / RHT Benchmark'
    },
    'High-Strength Concrete C50/60 (50 MPa)': {
        density: 2400.0, youngs_modulus: 37.0e9, poissons_ratio: 0.20, yield_stress: 50.0e6, hardening_modulus: 350.0e6, failure_strain: 0.0030, tensile_failure_stress: 4.1e6,
        jc_A: 50.0e6, jc_B: 220.0e6, jc_n: 0.38, jc_C: 0.005, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 900.0, mg_gamma0: 1.00, mg_c0: 3300.0, mg_s: 1.30,
        category: 'Concrete & Masonry Strength Grades', reference: 'Riedel et al., Int. J. Impact Eng. (1999)'
    },
    'Ultra-High Performance Concrete C100/115 (100 MPa)': {
        density: 2500.0, youngs_modulus: 45.0e9, poissons_ratio: 0.20, yield_stress: 100.0e6, hardening_modulus: 500.0e6, failure_strain: 0.0035, tensile_failure_stress: 7.0e6,
        jc_A: 100.0e6, jc_B: 300.0e6, jc_n: 0.35, jc_C: 0.006, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.10, mg_c0: 3600.0, mg_s: 1.35,
        category: 'Concrete & Masonry Strength Grades', reference: 'Forquin et al., Int. J. Impact Eng. (2010)'
    },
    'UHPC / Ductal (150 MPa)': {
        density: 2550.0, youngs_modulus: 55.0e9, poissons_ratio: 0.21, yield_stress: 150.0e6, hardening_modulus: 700.0e6, failure_strain: 0.0050, tensile_failure_stress: 12.0e6,
        jc_A: 150.0e6, jc_B: 400.0e6, jc_n: 0.30, jc_C: 0.007, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 950.0, mg_gamma0: 1.15, mg_c0: 3800.0, mg_s: 1.38,
        category: 'Concrete & Masonry Strength Grades', reference: 'Lafarge Holcim Ductal Technical Manual'
    },
    'Fiber-Reinforced Concrete (FRC 60 MPa)': {
        density: 2450.0, youngs_modulus: 39.0e9, poissons_ratio: 0.20, yield_stress: 60.0e6, hardening_modulus: 450.0e6, failure_strain: 0.0080, tensile_failure_stress: 8.5e6,
        jc_A: 60.0e6, jc_B: 280.0e6, jc_n: 0.35, jc_C: 0.006, jc_m: 1.00, T_melt: 1500.0, T_room: 293.0, Cp: 920.0, mg_gamma0: 1.05, mg_c0: 3400.0, mg_s: 1.32,
        category: 'Concrete & Masonry Strength Grades', reference: 'Nold, ACI Materials Journal (2012)'
    },
    'Clay Brick Masonry': {
        density: 1800.0, youngs_modulus: 10.0e9, poissons_ratio: 0.18, yield_stress: 12.0e6, hardening_modulus: 80.0e6, failure_strain: 0.0020, tensile_failure_stress: 1.2e6,
        jc_A: 12.0e6, jc_B: 50.0e6, jc_n: 0.45, jc_C: 0.003, jc_m: 1.00, T_melt: 1400.0, T_room: 293.0, Cp: 840.0, mg_gamma0: 0.85, mg_c0: 2200.0, mg_s: 1.15,
        category: 'Concrete & Masonry Strength Grades', reference: 'Lourenco, PhD Thesis TU Delft'
    },
    'Aerated Autoclaved Concrete (AAC)': {
        density: 600.0, youngs_modulus: 2.0e9, poissons_ratio: 0.15, yield_stress: 4.0e6, hardening_modulus: 20.0e6, failure_strain: 0.0050, tensile_failure_stress: 0.5e6,
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
    }
};
