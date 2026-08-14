"""
LS-DYNA Keyword Deck Generator for Buried Concrete Tube (Specimen NSC)
Reference: Park et al. (2024), "Experimental Evaluation on Blast Resistance of Reinforced Concrete Structures under Partially Confined Explosion"
Unit System: Pure SI [m, s, kg, N, Pa]

Geometry:
- Outer: 2.5 m (X) x 2.5 m (Y) x 1.5 m (Z)
- Inner void: 1.5 m (X) x 1.5 m (Y) x 1.5 m (Z)
- Wall/Slab/Roof thickness: 0.5 m (500 mm)
- Concrete: NSC fc' = 26.7 MPa (MAT_072R3 / K&C)
- Rebar: D16 @ ~175 mm double layer grid + D16 shear ties (MAT_024 Hughes-Liu Beams on shared nodes)
- Base boundary: Fixed (Y = 0)
"""

import os
import math

def format_card(fields, widths=None):
    if widths is None:
        widths = [10] * len(fields)
    line = ""
    for f, w in zip(fields, widths):
        if isinstance(f, int):
            line += f"{f:>{w}d}"
        elif isinstance(f, float):
            s = f"{f:.4g}"
            if len(s) > w or ("e" in s.lower() and len(s) > w):
                s = f"{f:{w}.2e}"
            line += f"{s:>{w}}"
        elif f is None:
            line += " " * w
        else:
            line += f"{str(f):>{w}}"
    return line

def generate_tube_deck(filename="buried_concrete_tube_nsc.k"):
    # Outer dimensions
    Lx = 2.5   # m (Span)
    Ly = 2.5   # m (Height)
    Lz = 1.5   # m (Tunnel length)
    
    # Wall thickness
    t_wall = 0.5 # m
    
    # Mesh resolution: ~30 mm nominal (0.03125 m)
    # 16 elements through 0.5 m wall -> dx = 0.5 / 16 = 0.03125 m
    # 48 elements through 1.5 m void -> 48 * 0.03125 = 1.5 m
    Nx_wall = 16
    Nx_void = 48
    Nx = Nx_wall + Nx_void + Nx_wall # 80 elements across X
    
    Ny_slab = 16
    Ny_void = 48
    Ny_roof = 16
    Ny = Ny_slab + Ny_void + Ny_roof # 80 elements across Y
    
    Nz = 48 # 48 elements across Z (1.5 m / 0.03125 m)
    
    dx = Lx / Nx # 0.03125 m
    dy = Ly / Ny # 0.03125 m
    dz = Lz / Nz # 0.03125 m
    
    print(f"Mesh Grid: Nx={Nx}, Ny={Ny}, Nz={Nz}")
    print(f"Element size: dx={dx*1000:.2f} mm, dy={dy*1000:.2f} mm, dz={dz*1000:.2f} mm")
    
    # Identify active solid elements and active nodes
    # A cell (i, j, k) is active if it is NOT in the void
    # Void is: Nx_wall <= i < Nx_wall + Nx_void and Ny_slab <= j < Ny_slab + Ny_void
    def is_cell_solid(i, j, k):
        in_void_x = (Nx_wall <= i < Nx_wall + Nx_void)
        in_void_y = (Ny_slab <= j < Ny_slab + Ny_void)
        return not (in_void_x and in_void_y)

    active_cells = []
    for k in range(Nz):
        for j in range(Ny):
            for i in range(Nx):
                if is_cell_solid(i, j, k):
                    active_cells.append((i, j, k))
                    
    num_solids = len(active_cells)
    print(f"Active Solid Elements (Concrete): {num_solids}")
    
    # Active nodes map: (i, j, k) -> nid
    active_nodes = {}
    nid_counter = 1
    
    for k in range(Nz + 1):
        for j in range(Ny + 1):
            for i in range(Nx + 1):
                # Node is needed if any of the 8 adjacent cells is solid
                touches_solid = False
                for di in [-1, 0]:
                    ci = i + di
                    if ci < 0 or ci >= Nx: continue
                    for dj in [-1, 0]:
                        cj = j + dj
                        if cj < 0 or cj >= Ny: continue
                        for dk in [-1, 0]:
                            ck = k + dk
                            if ck < 0 or ck >= Nz: continue
                            if is_cell_solid(ci, cj, ck):
                                touches_solid = True
                                break
                        if touches_solid: break
                    if touches_solid: break
                
                if touches_solid:
                    active_nodes[(i, j, k)] = nid_counter
                    nid_counter += 1
                    
    num_nodes = len(active_nodes)
    print(f"Active Nodes: {num_nodes}")
    
    # Rebar grid layout on shared nodes
    # Cover: 1 element = 31.25 mm cover (nominal 30-35 mm cover)
    cover_idx = 1
    
    # Longitudinal rebar spacing in Z: nominal 175 mm -> 175 / 31.25 = 5.6 -> every 5 or 6 elements (e.g. 5, 11, 16, 22, 27, 33, 38, 43, 48)
    # We select z-indices spaced ~ 175 mm
    z_bar_indices = [0, 6, 11, 17, 23, 29, 35, 41, 47, 48]
    # Transverse / vertical spacing ~ 175 mm (every ~5-6 elements)
    # Along X (0 to 80):
    x_bar_indices = [cover_idx, 6, 11, Nx_wall - cover_idx, 
                     Nx_wall + cover_idx, 21, 27, 32, 38, 43, 48, 54, 59, Nx_wall + Nx_void - cover_idx,
                     Nx_wall + Nx_void + cover_idx, 69, 74, Nx - cover_idx]
    # Along Y (0 to 80):
    y_bar_indices = [cover_idx, 6, 11, Ny_slab - cover_idx,
                     Ny_slab + cover_idx, 21, 27, 32, 38, 43, 48, 54, 59, Ny_slab + Ny_void - cover_idx,
                     Ny_slab + Ny_void + cover_idx, 69, 74, Ny - cover_idx]
    
    # Specific rebar layer locations:
    # 1. Base slab:
    #    Bottom mat: y = cover_idx
    #    Top mat:    y = Ny_slab - cover_idx
    # 2. Roof:
    #    Bottom mat: y = Ny_slab + Ny_void + cover_idx
    #    Top mat:    y = Ny - cover_idx
    # 3. Left wall:
    #    Outer mat:  x = cover_idx
    #    Inner mat:  x = Nx_wall - cover_idx
    # 4. Right wall:
    #    Inner mat:  x = Nx_wall + Nx_void + cover_idx
    #    Outer mat:  x = Nx - cover_idx
    
    beams = [] # list of (n1, n2, bar_type)
    
    def add_beam(p1, p2, btype="main"):
        if p1 in active_nodes and p2 in active_nodes:
            n1 = active_nodes[p1]
            n2 = active_nodes[p2]
            beams.append((n1, n2, btype))

    # --- BASE SLAB REBAR ---
    # Bottom mat: y = cover_idx, x from cover_idx to Nx-cover_idx
    y_b = cover_idx
    # Top mat: y = Ny_slab - cover_idx, x from cover_idx to Nx-cover_idx
    y_t = Ny_slab - cover_idx
    
    for y_cur in [y_b, y_t]:
        # X-direction bars at z_bar_indices
        for k in z_bar_indices:
            for i in range(cover_idx, Nx - cover_idx):
                add_beam((i, y_cur, k), (i + 1, y_cur, k))
        # Z-direction bars at x_bar_indices
        for i in range(cover_idx, Nx - cover_idx + 1):
            if i in x_bar_indices:
                for k in range(Nz):
                    add_beam((i, y_cur, k), (i, y_cur, k + 1))
                    
    # Slab Shear Ties (connecting y_b to y_t at rebar grid intersections)
    for i in x_bar_indices:
        if cover_idx <= i <= Nx - cover_idx:
            for k in z_bar_indices:
                for j in range(y_b, y_t):
                    add_beam((i, j, k), (i, j + 1, k), "tie")

    # --- ROOF REBAR ---
    # Bottom mat: y = Ny_slab + Ny_void + cover_idx
    y_rb = Ny_slab + Ny_void + cover_idx
    # Top mat: y = Ny - cover_idx
    y_rt = Ny - cover_idx
    
    for y_cur in [y_rb, y_rt]:
        # X-direction bars at z_bar_indices
        for k in z_bar_indices:
            for i in range(cover_idx, Nx - cover_idx):
                add_beam((i, y_cur, k), (i + 1, y_cur, k))
        # Z-direction bars at x_bar_indices
        for i in range(cover_idx, Nx - cover_idx + 1):
            if i in x_bar_indices:
                for k in range(Nz):
                    add_beam((i, y_cur, k), (i, y_cur, k + 1))
                    
    # Roof Shear Ties
    for i in x_bar_indices:
        if cover_idx <= i <= Nx - cover_idx:
            for k in z_bar_indices:
                for j in range(y_rb, y_rt):
                    add_beam((i, j, k), (i, j + 1, k), "tie")

    # --- LEFT WALL REBAR ---
    # Outer mat: x = cover_idx
    x_lo = cover_idx
    # Inner mat: x = Nx_wall - cover_idx
    x_li = Nx_wall - cover_idx
    
    for x_cur in [x_lo, x_li]:
        # Y-direction bars at z_bar_indices (from slab bottom mat y_b up to roof top mat y_rt)
        for k in z_bar_indices:
            for j in range(y_b, y_rt):
                add_beam((x_cur, j, k), (x_cur, j + 1, k))
        # Z-direction bars at y_bar_indices in wall region
        for j in range(y_b, y_rt + 1):
            if j in y_bar_indices:
                for k in range(Nz):
                    add_beam((x_cur, j, k), (x_cur, j, k + 1))
                    
    # Left Wall Shear Ties
    for j in y_bar_indices:
        if y_b <= j <= y_rt:
            for k in z_bar_indices:
                for i in range(x_lo, x_li):
                    add_beam((i, j, k), (i + 1, j, k), "tie")

    # --- RIGHT WALL REBAR ---
    # Inner mat: x = Nx_wall + Nx_void + cover_idx
    x_ri = Nx_wall + Nx_void + cover_idx
    # Outer mat: x = Nx - cover_idx
    x_ro = Nx - cover_idx
    
    for x_cur in [x_ri, x_ro]:
        # Y-direction bars at z_bar_indices
        for k in z_bar_indices:
            for j in range(y_b, y_rt):
                add_beam((x_cur, j, k), (x_cur, j + 1, k))
        # Z-direction bars at y_bar_indices in wall region
        for j in range(y_b, y_rt + 1):
            if j in y_bar_indices:
                for k in range(Nz):
                    add_beam((x_cur, j, k), (x_cur, j, k + 1))
                    
    # Right Wall Shear Ties
    for j in y_bar_indices:
        if y_b <= j <= y_rt:
            for k in z_bar_indices:
                for i in range(x_ri, x_ro):
                    add_beam((i, j, k), (i + 1, j, k), "tie")
                    
    # Remove any duplicate beam elements
    unique_beams = []
    seen_beams = set()
    for n1, n2, btype in beams:
        edge = (min(n1, n2), max(n1, n2))
        if edge not in seen_beams:
            seen_beams.add(edge)
            unique_beams.append((n1, n2, btype))
            
    print(f"Total Unique Rebar Beam Elements: {len(unique_beams)}")
    
    # Boundary condition nodes: bottom face of the base slab (j = 0)
    fixed_nodes = []
    for (i, j, k), nid in active_nodes.items():
        if j == 0:
            fixed_nodes.append(nid)
            
    print(f"Fixed Base Nodes (j=0, Y=0.0m): {len(fixed_nodes)}")
    
    # Write LS-DYNA Keyword Deck
    print(f"Writing LS-DYNA deck to {filename}...")
    rebar_diam = 0.016 # 16 mm (0.016 m)
    
    with open(filename, "w") as f:
        # Header
        f.write("$" * 80 + "\n")
        f.write("$ LS-DYNA KEYWORD DECK: BURIED CONCRETE TUBE (SPECIMEN NSC)\n")
        f.write("$ Reference: Park et al. (2024), Int J Concr Struct Mater 18:34\n")
        f.write("$ Geometry: 2.5m x 2.5m x 1.5m outer, 1.5m x 1.5m x 1.5m void, 0.5m thick\n")
        f.write("$ Concrete: fc' = 26.7 MPa (MAT_CONCRETE_DAMAGE_REL3 / MAT_072R3)\n")
        f.write("$ Rebar: D16 @ 175mm c/c double mat + D16 shear ties (MAT_024 Hughes-Liu Beams)\n")
        f.write("$ Base: Fixed SPC at Y = 0.0 m\n")
        f.write("$ Unit System: Pure SI [m, s, kg, N, Pa]\n")
        f.write("$" * 80 + "\n")
        f.write("*KEYWORD\n")
        f.write("*TITLE\n")
        f.write("Buried Concrete Tube NSC - 26.7MPa - D16 Rebar @ 175mm (Pure SI Units)\n")
        
        # Simulation Controls
        f.write("$" * 80 + "\n")
        f.write("$ CONTROL CARDS\n")
        f.write("$" * 80 + "\n")
        f.write("*CONTROL_TERMINATION\n")
        f.write("$#  endtim    endcyc     dtmin    endeng    endmas     nosol\n")
        f.write(format_card([0.050, 0, 0.0, 0.0, 0.0, 0]) + "\n")
        
        f.write("*CONTROL_TIMESTEP\n")
        f.write("$#  dtinit    tssfac      isdo    tslimt     dtms     lctm     erode     ms1st\n")
        f.write(format_card([0.0, 0.67, 0, 0.0, 0.0, 0, 0, 0]) + "\n")
        
        f.write("*CONTROL_ENERGY\n")
        f.write("$#    hgen      rwen    slnten     rylen\n")
        f.write(format_card([2, 2, 2, 2]) + "\n")
        
        f.write("*CONTROL_HOURGLASS\n")
        f.write("$#     ihq        qh\n")
        f.write(format_card([5, 0.10]) + "\n")
        
        # Database Outputs
        f.write("$" * 80 + "\n")
        f.write("$ DATABASE OUTPUT CARDS\n")
        f.write("$" * 80 + "\n")
        f.write("*DATABASE_D3PLOT\n")
        f.write("$#      dt      lcdt      beam      nplt    psetid\n")
        f.write(format_card([0.0005, 0, 0, 0, 0]) + "\n")
        
        f.write("*DATABASE_GLSTAT\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([0.0001, 0, 0, 1]) + "\n")
        
        f.write("*DATABASE_MATSUM\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([0.0001, 0, 0, 1]) + "\n")
        
        # Parts & Sections
        f.write("$" * 80 + "\n")
        f.write("$ PARTS, SECTIONS, AND MATERIALS\n")
        f.write("$" * 80 + "\n")
        f.write("*PART\n")
        f.write("$#                                                                         title\n")
        f.write("Concrete Structure (NSC 26.7 MPa)\n")
        f.write("$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n")
        f.write(format_card([1, 1, 1, 0, 1, 0, 0, 0]) + "\n")
        
        f.write("*PART\n")
        f.write("$#                                                                         title\n")
        f.write("Steel Rebar D16 (459.7 MPa Yield)\n")
        f.write("$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n")
        f.write(format_card([2, 2, 2, 0, 0, 0, 0, 0]) + "\n")
        
        # Section Solid for Concrete
        f.write("*SECTION_SOLID\n")
        f.write("$#   secid    elform       aet\n")
        f.write(format_card([1, 1, 0]) + "\n")  # ELFORM=1: 1-point reduced integration hex
        
        # Hourglass control
        f.write("*HOURGLASS\n")
        f.write("$#    hgid      ihq        qh        ihq      qm        ibq        q1        q2\n")
        f.write(format_card([1, 5, 0.10, 0, 0.0, 0, 1.5, 0.06]) + "\n")
        
        # Section Beam for Rebar
        f.write("*SECTION_BEAM\n")
        f.write("$#   secid    elform      shrf       qr/irid     cst      scoor       nsrf       intg\n")
        f.write(format_card([2, 1, 1.0, 0, 1, 0.0, 0, 0]) + "\n")  # ELFORM=1 (Hughes-Liu), CST=1 (circular)
        f.write("$#     ts1       ts2       tt1       tt2      nsip      rept\n")
        f.write(format_card([rebar_diam, rebar_diam, 0.0, 0.0, 0, 0]) + "\n")
        
        # Concrete Material: MAT_CONCRETE_DAMAGE_REL3 (MAT_072R3)
        # Density: 2304 kg/m3, Poisson: 0.22, A0 = -2.67e7 Pa (-26.7 MPa unconfined compressive strength)
        f.write("*MAT_CONCRETE_DAMAGE_REL3\n")
        f.write("$#     mid        ro        pr\n")
        f.write(format_card([1, 2304.0, 0.22]) + "\n")
        f.write("$#      a0        a1        a2     b1/a2f     b2/a1f     b3/a0f      a0y       a1y\n")
        f.write(format_card([-2.67e7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        f.write("$#     pr0        rtoo       gamma      rsigma      edrop     rup     prf1      prf2\n")
        f.write(format_card([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        f.write("$#      yl        y2        y3        y4        y5        y6        y7        y8\n")
        f.write(format_card([0.0]*8) + "\n")
        f.write("$#      y9       y10       y11       y12       y13\n")
        f.write(format_card([0.0]*5) + "\n")
        f.write("$#      no       eta      lambda      b1        b2        b3\n")
        f.write(format_card([0.0]*6) + "\n")
        f.write("$#    unit     locwid\n")
        f.write(format_card([0, 0.0]) + "\n")
        
        # Steel Rebar Material: MAT_PIECEWISE_LINEAR_PLASTICITY (MAT_024)
        # Pure SI: Density=7850 kg/m3, E=2.0e11 Pa (200 GPa), nu=0.30, SigY=4.597e8 Pa (459.7 MPa), ETAN=2.0e9 Pa (2 GPa)
        f.write("*MAT_PIECEWISE_LINEAR_PLASTICITY\n")
        f.write("$#     mid        ro         e        pr      sigy      etan      fail      tdel\n")
        f.write(format_card([2, 7850.0, 2.0e11, 0.30, 4.597e8, 2.0e9, 0.12, 0.0]) + "\n")
        f.write("$#       c         p      lcss      lcsr        vp\n")
        f.write(format_card([0.0, 0.0, 0, 0, 0.0]) + "\n")
        f.write("$#    eps1      eps2      eps3      eps4      eps5      eps6      eps7      eps8\n")
        f.write(format_card([0.0]*8) + "\n")
        f.write("$#     es1       es2       es3       es4       es5       es6       es7       es8\n")
        f.write(format_card([0.0]*8) + "\n")
        
        # Fixed Boundary Constraints on Base (Y = 0)
        f.write("$" * 80 + "\n")
        f.write("$ BOUNDARY CONDITIONS (FIXED BASE AT Y = 0.0M)\n")
        f.write("$" * 80 + "\n")
        f.write("*SET_NODE_LIST_TITLE\n")
        f.write("Fixed Base Nodes (Y = 0)\n")
        f.write("$#     sid       da1       da2       da3       da4    solver\n")
        f.write(format_card([1, 0.0, 0.0, 0.0, 0.0, "MECH"]) + "\n")
        
        # Write node list in chunks of 8
        for idx in range(0, len(fixed_nodes), 8):
            chunk = fixed_nodes[idx:idx+8]
            f.write(format_card(chunk, [10]*len(chunk)) + "\n")
            
        f.write("*BOUNDARY_SPC_SET\n")
        f.write("$#    nsid       cid      dofx      dofy      dofz     dofrx     dofry     dofrz\n")
        f.write(format_card([1, 0, 1, 1, 1, 1, 1, 1]) + "\n")
        
        # Write Nodes (Coordinates in m)
        f.write("$" * 80 + "\n")
        f.write("$ NODAL COORDINATES (METERS)\n")
        f.write("$" * 80 + "\n")
        f.write("*NODE\n")
        f.write("$#   nid               x               y               z      tc      rc\n")
        
        # Sort nodes by nid
        sorted_nodes = sorted(active_nodes.items(), key=lambda item: item[1])
        for (i, j, k), nid in sorted_nodes:
            xi = i * dx
            yj = j * dy
            zk = k * dz
            f.write(f"{nid:>8d}{xi:>16.6f}{yj:>16.6f}{zk:>16.6f}{0:>8d}{0:>8d}\n")
            
        # Write Solid Elements (Concrete)
        f.write("$" * 80 + "\n")
        f.write("$ SOLID ELEMENTS (CONCRETE TUBE)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_SOLID\n")
        f.write("$#   eid     pid      n1      n2      n3      n4      n5      n6      n7      n8\n")
        
        eid = 1
        for (i, j, k) in active_cells:
            n1 = active_nodes[(i, j, k)]
            n2 = active_nodes[(i + 1, j, k)]
            n3 = active_nodes[(i + 1, j + 1, k)]
            n4 = active_nodes[(i, j + 1, k)]
            n5 = active_nodes[(i, j, k + 1)]
            n6 = active_nodes[(i + 1, j, k + 1)]
            n7 = active_nodes[(i + 1, j + 1, k + 1)]
            n8 = active_nodes[(i, j + 1, k + 1)]
            f.write(format_card([eid, 1, n1, n2, n3, n4, n5, n6, n7, n8], [8]*10) + "\n")
            eid += 1
            
        print(f"Written {eid - 1} Solid Elements to deck.")
        
        # Write Beam Elements (Rebar Mesh)
        f.write("$" * 80 + "\n")
        f.write("$ BEAM ELEMENTS (STEEL REINFORCEMENT - SHARED NODES)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_BEAM\n")
        f.write("$#   eid     pid      n1      n2      n3    rt1     rr1     rt2     rr2   local\n")
        
        beam_eid = 1000001
        for n1, n2, btype in unique_beams:
            f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
            beam_eid += 1
            
        print(f"Written {beam_eid - 1000001} Beam Elements to deck.")
        
        f.write("$" * 80 + "\n")
        f.write("*END\n")

    print(f"Successfully generated {filename}!")

if __name__ == "__main__":
    generate_tube_deck("buried_concrete_tube_nsc.k")
