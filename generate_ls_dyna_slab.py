"""
LS-DYNA Keyword Deck Generator for Reinforced Concrete Slab Test Case
Pure SI Units: [m, s, kg, N, Pa]
Geometry: 3.0 m x 3.0 m x 0.2 m
Concrete: 40 MPa (4.0e7 Pa) Compressive Strength (MAT_CONCRETE_DAMAGE_REL3)
Reinforcement: 0.016 m diameter bars @ 0.150 m spacing top & bottom (0.030 m cover)
Elements: Hex8 for concrete, 2-node Beams for rebar (shared-node full coupling)
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

def generate_ls_dyna_deck_si(filename="concrete_slab_3x3m_40mpa.k"):
    # Slab Dimensions in meters [m]
    Lx = 3.0
    Ly = 3.0
    Lz = 0.2
    
    # Mesh discretization
    dx_nom = 0.030
    dy_nom = 0.030
    
    Nx = int(round(Lx / dx_nom))  # 100 elements
    Ny = int(round(Ly / dy_nom))  # 100 elements
    
    # Z-layer node coordinates in meters [m]
    # Cover = 0.030 m (30 mm) top and bottom.
    z_nodes = [0.0, 0.030, 0.065, 0.100, 0.135, 0.170, 0.200]
    Nz = len(z_nodes) - 1  # 6 layers of hex elements
    
    bot_rebar_k = 1  # z = 0.030 m
    top_rebar_k = 5  # z = 0.170 m
    
    rebar_spacing = 0.150  # m
    rebar_step_i = int(round(rebar_spacing / (Lx / Nx)))  # 5 elements
    rebar_step_j = int(round(rebar_spacing / (Ly / Ny)))  # 5 elements
    
    rebar_diam = 0.016  # m (16 mm)
    
    print(f"Generating SI mesh: Nx={Nx}, Ny={Ny}, Nz={Nz}")
    print(f"Total Solid Elements: {Nx * Ny * Nz}")
    print(f"Total Nodes: {(Nx + 1) * (Ny + 1) * (Nz + 1)}")
    
    def node_id(i, j, k):
        return 1 + i + j * (Nx + 1) + k * (Nx + 1) * (Ny + 1)
    
    with open(filename, "w") as f:
        # Header
        f.write("$" * 80 + "\n")
        f.write("$ LS-DYNA INPUT DECK: REINFORCED CONCRETE SLAB TEST CASE\n")
        f.write(f"$ Dimensions: {Lx} x {Ly} x {Lz} m\n")
        f.write(f"$ Concrete: fc' = 40 MPa = 4.0e7 Pa (MAT_CONCRETE_DAMAGE_REL3)\n")
        f.write(f"$ Rebar: D={rebar_diam}m @ {rebar_spacing}m c/c, Cover=0.03m (MAT_024)\n")
        f.write("$ Pure SI Unit System: [m, s, kg, N, Pa]\n")
        f.write("$" * 80 + "\n")
        f.write("*KEYWORD\n")
        f.write("*TITLE\n")
        f.write("Concrete Slab 3x3m - 40MPa - 16mm Rebar @ 150mm Mesh (Pure SI Units)\n")
        
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
        f.write(format_card([0.001, 0, 0, 0, 0]) + "\n")
        
        f.write("*DATABASE_GLSTAT\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([0.0001, 0, 0, 1]) + "\n")
        
        f.write("*DATABASE_MATSUM\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([0.0001, 0, 0, 1]) + "\n")
        
        f.write("*DATABASE_RCFORC\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([0.0001, 0, 0, 1]) + "\n")
        
        # Parts & Sections
        f.write("$" * 80 + "\n")
        f.write("$ PARTS, SECTIONS, AND MATERIALS\n")
        f.write("$" * 80 + "\n")
        f.write("*PART\n")
        f.write("$#                                                                         title\n")
        f.write("Concrete Slab (40 MPa)\n")
        f.write("$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n")
        f.write(format_card([1, 1, 1, 0, 1, 0, 0, 0]) + "\n")
        
        f.write("*PART\n")
        f.write("$#                                                                         title\n")
        f.write("Steel Rebar Mesh (16mm Bar)\n")
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
        
        # Section Beam for Rebar (Dimensions in m)
        f.write("*SECTION_BEAM\n")
        f.write("$#   secid    elform      shrf       qr/irid     cst      scoor       nsrf       intg\n")
        f.write(format_card([2, 1, 1.0, 0, 1, 0.0, 0, 0]) + "\n")  # ELFORM=1 (Hughes-Liu), CST=1 (circular)
        f.write("$#     ts1       ts2       tt1       tt2      nsip      rept\n")
        f.write(format_card([rebar_diam, rebar_diam, 0.0, 0.0, 0, 0]) + "\n")
        
        # Concrete Material: MAT_CONCRETE_DAMAGE_REL3 (MAT_072R3)
        # Density: 2400 kg/m3, Poisson: 0.18, A0 = -4.0e7 Pa (-40 MPa unconfined compressive strength)
        f.write("*MAT_CONCRETE_DAMAGE_REL3\n")
        f.write("$#     mid        ro        pr\n")
        f.write(format_card([1, 2400.0, 0.18]) + "\n")
        f.write("$#      a0        a1        a2     b1/a2f     b2/a1f     b3/a0f      a0y       a1y\n")
        f.write(format_card([-4.0e7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
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
        # Pure SI: Density=7850 kg/m3, E=2.0e11 Pa (200 GPa), nu=0.30, SigY=5.0e8 Pa (500 MPa), ETAN=2.0e9 Pa (2 GPa)
        f.write("*MAT_PIECEWISE_LINEAR_PLASTICITY\n")
        f.write("$#     mid        ro         e        pr      sigy      etan      fail      tdel\n")
        f.write(format_card([2, 7850.0, 2.0e11, 0.30, 5.0e8, 2.0e9, 0.12, 0.0]) + "\n")
        f.write("$#       c         p      lcss      lcsr        vp\n")
        f.write(format_card([0.0, 0.0, 0, 0, 0.0]) + "\n")
        f.write("$#    eps1      eps2      eps3      eps4      eps5      eps6      eps7      eps8\n")
        f.write(format_card([0.0]*8) + "\n")
        f.write("$#     es1       es2       es3       es4       es5       es6       es7       es8\n")
        f.write(format_card([0.0]*8) + "\n")
        
        # Write Nodes (Coordinates in m)
        f.write("$" * 80 + "\n")
        f.write("$ NODAL COORDINATES (METERS)\n")
        f.write("$" * 80 + "\n")
        f.write("*NODE\n")
        f.write("$#   nid               x               y               z      tc      rc\n")
        
        for k in range(Nz + 1):
            zk = z_nodes[k]
            for j in range(Ny + 1):
                yj = j * (Ly / Ny)
                for i in range(Nx + 1):
                    xi = i * (Lx / Nx)
                    nid = node_id(i, j, k)
                    f.write(f"{nid:>8d}{xi:>16.6f}{yj:>16.6f}{zk:>16.6f}{0:>8d}{0:>8d}\n")
        
        # Write Solid Elements (Concrete)
        f.write("$" * 80 + "\n")
        f.write("$ SOLID ELEMENTS (CONCRETE SLAB)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_SOLID\n")
        f.write("$#   eid     pid      n1      n2      n3      n4      n5      n6      n7      n8\n")
        
        eid = 1
        for k in range(Nz):
            for j in range(Ny):
                for i in range(Nx):
                    n1 = node_id(i, j, k)
                    n2 = node_id(i+1, j, k)
                    n3 = node_id(i+1, j+1, k)
                    n4 = node_id(i, j+1, k)
                    n5 = node_id(i, j, k+1)
                    n6 = node_id(i+1, j, k+1)
                    n7 = node_id(i+1, j+1, k+1)
                    n8 = node_id(i, j+1, k+1)
                    f.write(format_card([eid, 1, n1, n2, n3, n4, n5, n6, n7, n8], [8]*10) + "\n")
                    eid += 1
        
        num_solid = eid - 1
        print(f"Written {num_solid} Solid Elements.")
        
        # Write Beam Elements (Rebar Mesh)
        f.write("$" * 80 + "\n")
        f.write("$ BEAM ELEMENTS (STEEL REINFORCEMENT - FULLY CONNECTED SHARED NODES)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_BEAM\n")
        f.write("$#   eid     pid      n1      n2      n3    rt1     rr1     rt2     rr2   local\n")
        
        beam_eid = 1000001
        
        # Bottom Layer (k = bot_rebar_k, z = 0.030 m)
        # X-direction bars
        for j in range(0, Ny + 1, rebar_step_j):
            for i in range(Nx):
                n1 = node_id(i, j, bot_rebar_k)
                n2 = node_id(i+1, j, bot_rebar_k)
                f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
                beam_eid += 1
                
        # Y-direction bars
        for i in range(0, Nx + 1, rebar_step_i):
            for j in range(Ny):
                n1 = node_id(i, j, bot_rebar_k)
                n2 = node_id(i, j+1, bot_rebar_k)
                f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
                beam_eid += 1
                
        # Top Layer (k = top_rebar_k, z = 0.170 m)
        # X-direction bars
        for j in range(0, Ny + 1, rebar_step_j):
            for i in range(Nx):
                n1 = node_id(i, j, top_rebar_k)
                n2 = node_id(i+1, j, top_rebar_k)
                f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
                beam_eid += 1
                
        # Y-direction bars
        for i in range(0, Nx + 1, rebar_step_i):
            for j in range(Ny):
                n1 = node_id(i, j, top_rebar_k)
                n2 = node_id(i, j+1, top_rebar_k)
                f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
                beam_eid += 1
                
        num_beam = beam_eid - 1000001
        print(f"Written {num_beam} Beam Elements.")
        
        f.write("*END\n")
        
    print(f"Successfully generated {filename} ({os.path.getsize(filename) / (1024*1024):.2f} MB)")

if __name__ == "__main__":
    generate_ls_dyna_deck_si("concrete_slab_3x3m_40mpa.k")
