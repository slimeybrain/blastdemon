#!/usr/bin/env python3
"""
LS-DYNA Unstructured / Non-Rectilinear Reinforced Concrete Hollow Box Generator
Method: 1D-Constrained Tetrahedral-to-Hexahedral Subdivision (Approach 2)
Reinforcement: Conforming Shared-Node Rebar Mesh (Straight 1D Beams on Hex Edges)
"""

import sys
import os
import math
import random
import numpy as np

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

def compute_hex_min_jacobian(nodes):
    # nodes: 8 x 3 array
    gp = [-1.0 / math.sqrt(3.0), 1.0 / math.sqrt(3.0)]
    min_j = 1e30
    xi_i   = np.array([-1,  1,  1, -1, -1,  1,  1, -1])
    eta_i  = np.array([-1, -1,  1,  1, -1, -1,  1,  1])
    zeta_i = np.array([-1, -1, -1, -1,  1,  1,  1,  1])
    
    for xi in gp:
        for eta in gp:
            for zeta in gp:
                dNdxi   = 0.125 * xi_i   * (1.0 + eta_i * eta)   * (1.0 + zeta_i * zeta)
                dNdeta  = 0.125 * eta_i  * (1.0 + xi_i * xi)     * (1.0 + zeta_i * zeta)
                dNdzeta = 0.125 * zeta_i * (1.0 + xi_i * xi)     * (1.0 + eta_i * eta)
                
                J = np.zeros((3, 3))
                for k in range(8):
                    J[0, 0] += dNdxi[k] * nodes[k, 0]
                    J[0, 1] += dNdeta[k] * nodes[k, 0]
                    J[0, 2] += dNdzeta[k] * nodes[k, 0]
                    
                    J[1, 0] += dNdxi[k] * nodes[k, 1]
                    J[1, 1] += dNdeta[k] * nodes[k, 1]
                    J[1, 2] += dNdzeta[k] * nodes[k, 1]
                    
                    J[2, 0] += dNdxi[k] * nodes[k, 2]
                    J[2, 1] += dNdeta[k] * nodes[k, 2]
                    J[2, 2] += dNdzeta[k] * nodes[k, 2]
                    
                detJ = np.linalg.det(J)
                if detJ < min_j:
                    min_j = detJ
    return min_j

def generate_unstructured_rc_box(
    filename="unstructured_rc_hollow_box_2m.k",
    Lx=2.0, Ly=2.0, Lz=2.0,
    t_wall=0.20,
    nominal_h=0.10,
    jitter_fraction=0.12,
    random_seed=42,
    rebar_diam=0.012,
    concrete_fpc=30.0e6,
    steel_fy=500.0e6
):
    print("=" * 70)
    print("GENERATING UNSTRUCTURED TET-TO-HEX REINFORCED CONCRETE HOLLOW BOX")
    print(f"Dimensions: {Lx}m x {Ly}m x {Lz}m, Wall Thickness: {t_wall}m")
    print(f"Nominal Macro-Mesh Size: {nominal_h}m, Jitter: {jitter_fraction*100:.1f}%")
    print("=" * 70)
    
    random.seed(random_seed)
    np.random.seed(random_seed)
    
    # 1. Define Macro Grid Stations
    # We ensure exact stations exist for:
    # 0, cover, t_wall - cover, t_wall, ..., Lx - t_wall, Lx - (t_wall - cover), Lx - cover, Lx
    cover = 0.04 # 40mm cover
    
    def build_axis_stations(L, tw, cov, h_nom):
        # Wall 1: [0, cov, tw - cov, tw]
        # Void: [tw ... L - tw] spaced roughly h_nom
        # Wall 2: [L - tw, L - (tw - cov), L - cov, L]
        # In the walls, we place stations at 0, cov, (cov + tw - cov)/2, tw - cov, tw
        w1 = [0.0, cov, 0.5 * (cov + tw - cov), tw - cov, tw]
        w2 = [L - tw, L - (tw - cov), L - 0.5 * (cov + tw - cov), L - cov, L]
        
        # Void intermediate stations
        L_void = L - 2.0 * tw
        n_void = max(2, int(round(L_void / h_nom)))
        void_stations = [tw + i * (L_void / n_void) for i in range(1, n_void)]
        
        stations = sorted(list(set([round(v, 6) for v in w1 + void_stations + w2])))
        return np.array(stations)

    xs = build_axis_stations(Lx, t_wall, cover, nominal_h)
    ys = build_axis_stations(Ly, t_wall, cover, nominal_h)
    zs = build_axis_stations(Lz, t_wall, cover, nominal_h)
    
    Nx = len(xs) - 1
    Ny = len(ys) - 1
    Nz = len(zs) - 1
    
    print(f"Macro Grid Partition: Nx={Nx}, Ny={Ny}, Nz={Nz} ({Nx*Ny*Nz} macro cells)")
    
    # Void bounding box: [t_wall, Lx - t_wall] x [t_wall, Ly - t_wall] x [t_wall, Lz - t_wall]
    eps = 1e-4
    def is_cell_solid(i, j, k):
        cx = 0.5 * (xs[i] + xs[i+1])
        cy = 0.5 * (ys[j] + ys[j+1])
        cz = 0.5 * (zs[k] + zs[k+1])
        in_void = (t_wall - eps <= cx <= Lx - t_wall + eps and
                   t_wall - eps <= cy <= Ly - t_wall + eps and
                   t_wall - eps <= cz <= Lz - t_wall + eps)
        return not in_void

    solid_cells = []
    for k in range(Nz):
        for j in range(Ny):
            for i in range(Nx):
                if is_cell_solid(i, j, k):
                    solid_cells.append((i, j, k))
                    
    print(f"Active Solid Macro Cells (Concrete Walls): {len(solid_cells)}")
    
    # 2. Identify and Generate Macro Vertices
    # A vertex (i, j, k) is needed if it touches any solid macro-cell
    macro_vertex_map = {} # (i, j, k) -> coord [x, y, z]
    for (i, j, k) in solid_cells:
        for di in [0, 1]:
            for dj in [0, 1]:
                for dk in [0, 1]:
                    v_idx = (i + di, j + dj, k + dk)
                    if v_idx not in macro_vertex_map:
                        macro_vertex_map[v_idx] = np.array([xs[v_idx[0]], ys[v_idx[1]], zs[v_idx[2]]])
                        
    print(f"Active Macro Vertices: {len(macro_vertex_map)}")
    
    # Identify Rebar Planes / Lines
    # Rebar is placed on:
    # X in {cover, t_wall - cover, Lx - t_wall + cover, Lx - cover}
    # Y in {cover, t_wall - cover, Ly - t_wall + cover, Ly - cover}
    # Z in {cover, t_wall - cover, Lz - t_wall + cover, Lz - cover}
    rebar_x_vals = {round(cover, 5), round(t_wall - cover, 5), round(Lx - (t_wall - cover), 5), round(Lx - cover, 5)}
    rebar_y_vals = {round(cover, 5), round(t_wall - cover, 5), round(Ly - (t_wall - cover), 5), round(Ly - cover, 5)}
    rebar_z_vals = {round(cover, 5), round(t_wall - cover, 5), round(Lz - (t_wall - cover), 5), round(Lz - cover, 5)}
    
    # Apply Controlled Stochastic Jitter with Pinning Constraints
    # Rules:
    # 1. Boundary nodes on outer faces (X=0, Lx, Y=0, Ly, Z=0, Lz): normal jitter = 0.
    # 2. Boundary nodes on void faces: normal jitter = 0.
    # 3. Base face (Y=0): fixed in all directions for clean SPC.
    # 4. Rebar line nodes: constrained so rebar lines stay perfectly straight.
    # 5. Interior bulk concrete nodes: full 3D stochastic jitter.
    
    perturbed_macro_vertices = {}
    for v_idx, orig_pt in macro_vertex_map.items():
        pt = orig_pt.copy()
        x, y, z = pt[0], pt[1], pt[2]
        
        on_outer_x = (abs(x) < eps or abs(x - Lx) < eps)
        on_outer_y = (abs(y) < eps or abs(y - Ly) < eps)
        on_outer_z = (abs(z) < eps or abs(z - Lz) < eps)
        
        on_void_x = (abs(x - t_wall) < eps or abs(x - (Lx - t_wall)) < eps)
        on_void_y = (abs(y - t_wall) < eps or abs(y - (Ly - t_wall)) < eps)
        on_void_z = (abs(z - t_wall) < eps or abs(z - (Lz - t_wall)) < eps)
        
        on_rebar_x = any(abs(x - rx) < eps for rx in rebar_x_vals)
        on_rebar_y = any(abs(y - ry) < eps for ry in rebar_y_vals)
        on_rebar_z = any(abs(z - rz) < eps for rz in rebar_z_vals)
        
        # Jitter vector
        dx = (random.random() * 2.0 - 1.0) * jitter_fraction * nominal_h
        dy = (random.random() * 2.0 - 1.0) * jitter_fraction * nominal_h
        dz = (random.random() * 2.0 - 1.0) * jitter_fraction * nominal_h
        
        # Clamping
        if abs(y) < eps: # Base SPC plane
            dx, dy, dz = 0.0, 0.0, 0.0
        else:
            if on_outer_x or on_void_x: dx = 0.0
            if on_outer_y or on_void_y: dy = 0.0
            if on_outer_z or on_void_z: dz = 0.0
            
            # If on rebar line along Z (on rebar X and rebar Y), keep X and Y straight!
            if on_rebar_x and on_rebar_y:
                dx = 0.0
                dy = 0.0
            if on_rebar_x and on_rebar_z:
                dx = 0.0
                dz = 0.0
            if on_rebar_y and on_rebar_z:
                dy = 0.0
                dz = 0.0
                
        pt[0] += dx
        pt[1] += dy
        pt[2] += dz
        perturbed_macro_vertices[v_idx] = pt

    # 3. Kuhn 6-Tet Decomposition per Solid Macro Cell
    # For a cube with local corner indices:
    # 0:(0,0,0), 1:(1,0,0), 2:(1,1,0), 3:(0,1,0) [bottom]
    # 4:(0,0,1), 5:(1,0,1), 6:(1,1,1), 7:(0,1,1) [top]
    # Kuhn 6-tets:
    # T0: (0, 1, 2, 6)
    # T1: (0, 1, 5, 6)
    # T2: (0, 3, 2, 6)
    # T3: (0, 3, 7, 6)
    # T4: (0, 4, 5, 6)
    # T5: (0, 4, 7, 6)
    
    tets = [] # list of 4-tuples of v_idx
    for (i, j, k) in solid_cells:
        c0 = (i, j, k)
        c1 = (i + 1, j, k)
        c2 = (i + 1, j + 1, k)
        c3 = (i, j + 1, k)
        c4 = (i, j, k + 1)
        c5 = (i + 1, j, k + 1)
        c6 = (i + 1, j + 1, k + 1)
        c7 = (i, j + 1, k + 1)
        
        # Parity flip to ensure matching diagonal across adjacent cells
        if (i + j + k) % 2 == 0:
            kuhn_tets = [
                (c0, c1, c2, c6),
                (c0, c1, c5, c6),
                (c0, c3, c2, c6),
                (c0, c3, c7, c6),
                (c0, c4, c5, c6),
                (c0, c4, c7, c6)
            ]
        else:
            # Alternating parity for symmetric diagonal alignment
            kuhn_tets = [
                (c7, c6, c5, c1),
                (c7, c6, c2, c1),
                (c7, c4, c5, c1),
                (c7, c4, c0, c1),
                (c7, c3, c2, c1),
                (c7, c3, c0, c1)
            ]
        tets.extend(kuhn_tets)
        
    print(f"Generated {len(tets)} Conforming Tetrahedra")
    
    # 4. 1-to-4 Tetrahedral-to-Hexahedral Subdivision (Approach 2)
    # Global node registry: coord -> nid
    global_nodes = {}
    node_coords = []
    
    def get_node_id(pt):
        key = (round(pt[0], 6), round(pt[1], 6), round(pt[2], 6))
        if key not in global_nodes:
            nid = len(node_coords) + 1
            global_nodes[key] = nid
            node_coords.append(np.array(pt))
            return nid
        return global_nodes[key]

    # Pre-register macro vertices
    macro_nid_map = {}
    for v_idx, pt in perturbed_macro_vertices.items():
        macro_nid_map[v_idx] = get_node_id(pt)
        
    hex_elements = [] # list of 8 nid tuples
    min_overall_j = 1e30
    
    for (v0_idx, v1_idx, v2_idx, v3_idx) in tets:
        V0 = perturbed_macro_vertices[v0_idx]
        V1 = perturbed_macro_vertices[v1_idx]
        V2 = perturbed_macro_vertices[v2_idx]
        V3 = perturbed_macro_vertices[v3_idx]
        
        # Check orientation
        vol6 = np.dot(np.cross(V1 - V0, V2 - V0), V3 - V0)
        if vol6 < 0:
            # Swap V2 and V3 to guarantee positive orientation
            V2, V3 = V3, V2
            v2_idx, v3_idx = v3_idx, v2_idx
            
        M01 = 0.5 * (V0 + V1)
        M02 = 0.5 * (V0 + V2)
        M03 = 0.5 * (V0 + V3)
        M12 = 0.5 * (V1 + V2)
        M13 = 0.5 * (V1 + V3)
        M23 = 0.5 * (V2 + V3)
        
        F012 = (V0 + V1 + V2) / 3.0
        F013 = (V0 + V1 + V3) / 3.0
        F023 = (V0 + V2 + V3) / 3.0
        F123 = (V1 + V2 + V3) / 3.0
        
        C = (V0 + V1 + V2 + V3) / 4.0
        
        # Register nodes
        n_V0 = macro_nid_map[v0_idx]
        n_V1 = macro_nid_map[v1_idx]
        n_V2 = macro_nid_map[v2_idx]
        n_V3 = macro_nid_map[v3_idx]
        
        n_M01 = get_node_id(M01)
        n_M02 = get_node_id(M02)
        n_M03 = get_node_id(M03)
        n_M12 = get_node_id(M12)
        n_M13 = get_node_id(M13)
        n_M23 = get_node_id(M23)
        
        n_F012 = get_node_id(F012)
        n_F013 = get_node_id(F013)
        n_F023 = get_node_id(F023)
        n_F123 = get_node_id(F123)
        
        n_C = get_node_id(C)
        
        # Form 4 Hex8 elements
        h0 = (n_V0, n_M01, n_F012, n_M02, n_M03, n_F013, n_C, n_F023)
        h1 = (n_V1, n_M12, n_F012, n_M01, n_M13, n_F123, n_C, n_F013)
        h2 = (n_V2, n_M02, n_F012, n_M12, n_M23, n_F023, n_C, n_F123)
        h3 = (n_V3, n_M23, n_F123, n_M13, n_M03, n_F023, n_C, n_F013)
        
        for h in [h0, h1, h2, h3]:
            hex_elements.append(h)
            h_coords = np.array([node_coords[nid - 1] for nid in h])
            j_val = compute_hex_min_jacobian(h_coords)
            if j_val < min_overall_j:
                min_overall_j = j_val

    print(f"Subdivided into {len(hex_elements)} Solid Hex8 Elements")
    print(f"Total Unique Nodes: {len(node_coords)}")
    print(f"Minimum Scaled Jacobian: {min_overall_j:.6e} (Strictly Positive: {min_overall_j > 0})")
    assert min_overall_j > 0, "Error: Inverted hex element detected!"

    # 5. Extract Conforming Shared-Node Rebar Cage
    # We trace straight lines through macro-grid stations on rebar planes:
    # 1. Base slab & Roof (Y = rebar_y):
    #    - X-bars at Z in rebar_z_vals
    #    - Z-bars at X in rebar_x_vals
    #    - Y-ties connecting bottom mat to top mat
    # 2. Side Walls (X = rebar_x):
    #    - Y-bars at Z in rebar_z_vals
    #    - Z-bars at Y in rebar_y_vals
    #    - X-ties connecting outer mat to inner mat
    # 3. Front/Back Walls (Z = rebar_z):
    #    - X-bars at Y in rebar_y_vals
    #    - Y-bars at X in rebar_x_vals
    #    - Z-ties connecting outer mat to inner mat
    
    unique_beam_edges = set() # set of (min_nid, max_nid)
    
    def add_rebar_segment(v1_idx, v2_idx):
        if v1_idx in perturbed_macro_vertices and v2_idx in perturbed_macro_vertices:
            pt1 = perturbed_macro_vertices[v1_idx]
            pt2 = perturbed_macro_vertices[v2_idx]
            pt_mid = 0.5 * (pt1 + pt2)
            
            n1 = macro_nid_map[v1_idx]
            n_mid = get_node_id(pt_mid)
            n2 = macro_nid_map[v2_idx]
            
            e1 = (min(n1, n_mid), max(n1, n_mid))
            e2 = (min(n_mid, n2), max(n_mid, n2))
            unique_beam_edges.add(e1)
            unique_beam_edges.add(e2)

    # A. X-direction rebar lines: (i -> i+1, j, k)
    for j_idx, y_val in enumerate(ys):
        if any(abs(y_val - ry) < eps for ry in rebar_y_vals):
            for k_idx, z_val in enumerate(zs):
                if any(abs(z_val - rz) < eps for rz in rebar_z_vals):
                    for i in range(Nx):
                        v1 = (i, j_idx, k_idx)
                        v2 = (i + 1, j_idx, k_idx)
                        if v1 in perturbed_macro_vertices and v2 in perturbed_macro_vertices:
                            add_rebar_segment(v1, v2)
                            
    # B. Y-direction rebar lines: (i, j -> j+1, k)
    for i_idx, x_val in enumerate(xs):
        if any(abs(x_val - rx) < eps for rx in rebar_x_vals):
            for k_idx, z_val in enumerate(zs):
                if any(abs(z_val - rz) < eps for rz in rebar_z_vals):
                    for j in range(Ny):
                        v1 = (i_idx, j, k_idx)
                        v2 = (i_idx, j + 1, k_idx)
                        if v1 in perturbed_macro_vertices and v2 in perturbed_macro_vertices:
                            add_rebar_segment(v1, v2)

    # C. Z-direction rebar lines: (i, j, k -> k+1)
    for i_idx, x_val in enumerate(xs):
        if any(abs(x_val - rx) < eps for rx in rebar_x_vals):
            for j_idx, y_val in enumerate(ys):
                if any(abs(y_val - ry) < eps for ry in rebar_y_vals):
                    for k in range(Nz):
                        v1 = (i_idx, j_idx, k)
                        v2 = (i_idx, j_idx, k + 1)
                        if v1 in perturbed_macro_vertices and v2 in perturbed_macro_vertices:
                            add_rebar_segment(v1, v2)

    rebar_beams = list(unique_beam_edges)
    print(f"Generated {len(rebar_beams)} Conforming Rebar Beam Elements (Shared Nodes)")
    
    # 6. Base Boundary Condition Nodes (Y = 0)
    fixed_base_nodes = []
    for nid, pt in enumerate(node_coords, 1):
        if abs(pt[1]) < eps:
            fixed_base_nodes.append(nid)
            
    print(f"Fixed Base Nodes at Y = 0.0m: {len(fixed_base_nodes)}")

    # 7. Write LS-DYNA Keyword Deck
    print(f"Writing LS-DYNA Keyword Deck to {filename}...")
    
    with open(filename, "w") as f:
        f.write("$" * 80 + "\n")
        f.write("$ LS-DYNA KEYWORD DECK: UNSTRUCTURED REINFORCED CONCRETE HOLLOW BOX (2M)\n")
        f.write("$ Method: 1D-Constrained Tetrahedral-to-Hexahedral Subdivision (Approach 2)\n")
        f.write("$ Concrete: Unstructured Hex8 with Stochastic Jitter & Multi-Valence Nodes\n")
        f.write("$ Rebar: 100% Conforming Shared-Node Beam Cage (Hughes-Liu 3D Beams)\n")
        f.write(f"$ Statistics: {len(node_coords)} Nodes, {len(hex_elements)} Hex Solids, {len(rebar_beams)} Beams\n")
        f.write("$ Unit System: Pure SI [m, kg, s, N, Pa]\n")
        f.write("$" * 80 + "\n")
        f.write("*KEYWORD\n")
        f.write("*TITLE\n")
        f.write(f"Unstructured Tet-to-Hex RC Hollow Box 2m (Jitter={jitter_fraction*100:.1f}%)\n")
        
        # Control Cards
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
        
        f.write("*CONTROL_SOLID\n")
        f.write("$#   esort    fmatrx    nipts    nptss\n")
        f.write(format_card([0, 0, 0, 0]) + "\n")
        
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
        
        # Parts & Sections
        f.write("$" * 80 + "\n")
        f.write("$ PARTS, SECTIONS, AND MATERIALS\n")
        f.write("$" * 80 + "\n")
        f.write("*PART\n")
        f.write("Concrete Structure (Unstructured Hex8 CSCM)\n")
        f.write("$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n")
        f.write(format_card([1, 1, 1, 0, 1, 0, 0, 0]) + "\n")
        
        f.write("*PART\n")
        f.write("Steel Rebar Cage (Shared-Node 12mm Beams)\n")
        f.write("$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n")
        f.write(format_card([2, 2, 2, 0, 0, 0, 0, 0]) + "\n")
        
        f.write("*SECTION_SOLID\n")
        f.write("$#   secid    elform       aet\n")
        f.write(format_card([1, 1, 0]) + "\n")
        
        f.write("*HOURGLASS\n")
        f.write("$#    hgid      ihq        qh        ihq      qm        ibq        q1        q2\n")
        f.write(format_card([1, 5, 0.10, 0, 0.0, 0, 1.5, 0.06]) + "\n")
        
        f.write("*SECTION_BEAM\n")
        f.write("$#   secid    elform      shrf       cst      sarea     norm\n")
        rebar_area = math.pi * (rebar_diam / 2.0) ** 2
        f.write(format_card([2, 1, 1.0, 1, rebar_area, 0]) + "\n")
        f.write("$#     ts1       ts2       tt1       tt2      nsip\n")
        f.write(format_card([rebar_diam, rebar_diam, 0.0, 0.0, 0]) + "\n")
        
        # Concrete Material: MAT_CSCM_CONCRETE (MAT_159)
        f.write("*MAT_CSCM_CONCRETE\n")
        f.write("$#     mid        ro       fpc      dagg     units\n")
        f.write(format_card([1, 2400.0, concrete_fpc, 0.019, 1]) + "\n")
        
        # Steel Rebar Material: MAT_PIECEWISE_LINEAR_PLASTICITY (MAT_024)
        f.write("*MAT_PIECEWISE_LINEAR_PLASTICITY\n")
        f.write("$#     mid        ro         e        pr      sigy      etan      fail      tdel\n")
        f.write(format_card([2, 7850.0, 2.0e11, 0.30, steel_fy, 1.0e9, 0.15, 0.0]) + "\n")
        
        # Boundary Conditions (SPC Set at Y = 0)
        f.write("$" * 80 + "\n")
        f.write("$ BOUNDARY CONDITIONS (FIXED BASE AT Y = 0.0M)\n")
        f.write("$" * 80 + "\n")
        f.write("*SET_NODE_LIST_TITLE\n")
        f.write("Fixed Base Nodes (Y = 0)\n")
        f.write("$#     sid       da1       da2       da3       da4    solver\n")
        f.write(format_card([1, 0.0, 0.0, 0.0, 0.0, "MECH"]) + "\n")
        
        for idx in range(0, len(fixed_base_nodes), 8):
            chunk = fixed_base_nodes[idx:idx+8]
            f.write(format_card(chunk, [10]*len(chunk)) + "\n")
            
        f.write("*BOUNDARY_SPC_SET\n")
        f.write("$#    nsid       cid      dofx      dofy      dofz     dofrx     dofry     dofrz\n")
        f.write(format_card([1, 0, 1, 1, 1, 1, 1, 1]) + "\n")
        
        # Nodes
        f.write("$" * 80 + "\n")
        f.write("$ NODAL COORDINATES (METERS)\n")
        f.write("$" * 80 + "\n")
        f.write("*NODE\n")
        f.write("$#   nid               x               y               z      tc      rc\n")
        for nid, pt in enumerate(node_coords, 1):
            f.write(f"{nid:>8d}{pt[0]:>16.6f}{pt[1]:>16.6f}{pt[2]:>16.6f}{0:>8d}{0:>8d}\n")
            
        # Solid Elements (Concrete)
        f.write("$" * 80 + "\n")
        f.write("$ SOLID ELEMENTS (UNSTRUCTURED HEX8 CONCRETE)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_SOLID\n")
        f.write("$#   eid     pid      n1      n2      n3      n4      n5      n6      n7      n8\n")
        for eid, h in enumerate(hex_elements, 1):
            f.write(format_card([eid, 1, h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]], [8]*10) + "\n")
            
        # Beam Elements (Rebar Cage)
        f.write("$" * 80 + "\n")
        f.write("$ BEAM ELEMENTS (REINFORCING STEEL - CONFORMING SHARED NODES)\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_BEAM\n")
        f.write("$#   eid     pid      n1      n2      n3    rt1     rr1     rt2     rr2   local\n")
        for idx, (n1, n2) in enumerate(rebar_beams, 1):
            beam_eid = 1000000 + idx
            f.write(format_card([beam_eid, 2, n1, n2, 0, 0, 0, 0, 0, 0], [8]*10) + "\n")
            
        f.write("$" * 80 + "\n")
        f.write("*END\n")
        
    print(f"✓ Deck successfully written to {filename}")
    return filename

if __name__ == "__main__":
    generate_unstructured_rc_box("unstructured_rc_hollow_box_2m.k")
