#!/usr/bin/env python3
"""
LS-DYNA Keyword Deck Generator: Steel Cylinder with Domed Ends & Lead Fill
==========================================================================
Geometry:
  - Overall Length: 300.0 mm (0.300 m)
  - Outer Diameter: 75.0 mm (0.075 m) -> Outer Radius: 37.5 mm (0.0375 m)
  - Wall Thickness: 6.0 mm (0.006 m)  -> Inner Radius: 31.5 mm (0.0315 m)
  - Domed Ends: Hemispherical caps (Height = 37.5 mm each)
  - Cylindrical Section Length: 225.0 mm (0.225 m)
  - Interior Cavity: Lead-filled capsule (Length = 288.0 mm, Radius = 31.5 mm)

Discretization:
  - Element Type: 100% Conforming 8-node Solid Hexahedra (Hex8 / *ELEMENT_SOLID)
  - Zero Degenerate Wedges / Zero Polar Singularities (Full 3D O-grid / Cubed-Sphere Core)
  - Part 1 (Steel Casing): 3,564 Hex8 elements (2 elements through 6mm wall)
  - Part 2 (Lead Fill): 10,773 Hex8 elements (7-block structured core)
  - Total Elements: 14,337 Hex8 elements
  - Total Nodes: 15,304 nodes (100% conforming shared-node interface)

Materials (Pure SI Units: m, s, kg, N, Pa, J):
  1. Generic Structural Steel (*MAT_024 / MID 1):
     - Density: 7,850 kg/m^3
     - Young's Modulus: 210 GPa (2.10e11 Pa)
     - Poisson's Ratio: 0.30
     - Yield Strength: 350 MPa (3.50e8 Pa)
     - Tangent Modulus: 1.0 GPa (1.00e9 Pa)
     - Failure Plastic Strain: 0.20
  2. Generic Chemical Lead (*MAT_024 / MID 2):
     - Density: 11,340 kg/m^3 (1.134e4 kg/m^3)
     - Young's Modulus: 16.0 GPa (1.60e10 Pa)
     - Poisson's Ratio: 0.42
     - Yield Strength: 15.0 MPa (1.50e7 Pa)
     - Tangent Modulus: 150.0 MPa (1.50e8 Pa)
     - Failure Plastic Strain: 0.50
"""

import math
import numpy as np

def format_card(fields, widths=None):
    """Format a list of fields into fixed-width LS-DYNA card columns."""
    if widths is None:
        widths = [10] * len(fields)
    line = ""
    for f, w in zip(fields, widths):
        if isinstance(f, int):
            line += f"{f:>{w}d}"
        elif isinstance(f, float):
            s = f"{f:.6g}"
            if len(s) > w or ("e" in s.lower() and len(s) > w):
                s = f"{f:{w}.3e}"
            line += f"{s:>{w}}"
        elif f is None:
            line += " " * w
        else:
            line += f"{str(f):>{w}}"
    return line

def shape_func_derivs(xi, eta, zeta):
    xi_nodes   = [-1,  1,  1, -1, -1,  1,  1, -1]
    eta_nodes  = [-1, -1,  1,  1, -1, -1,  1,  1]
    zeta_nodes = [-1, -1, -1, -1,  1,  1,  1,  1]
    
    dN_dxi = np.zeros(8)
    dN_deta = np.zeros(8)
    dN_dzeta = np.zeros(8)
    
    for a in range(8):
        dN_dxi[a]   = 0.125 * xi_nodes[a]   * (1 + eta_nodes[a]*eta)   * (1 + zeta_nodes[a]*zeta)
        dN_deta[a]  = 0.125 * eta_nodes[a]  * (1 + xi_nodes[a]*xi)     * (1 + zeta_nodes[a]*zeta)
        dN_dzeta[a] = 0.125 * zeta_nodes[a] * (1 + xi_nodes[a]*xi)     * (1 + eta_nodes[a]*eta)
        
    return dN_dxi, dN_deta, dN_dzeta

def compute_element_jacobian_det(nodes_coords, xi=0.0, eta=0.0, zeta=0.0):
    dN_dxi, dN_deta, dN_dzeta = shape_func_derivs(xi, eta, zeta)
    J = np.zeros((3, 3))
    J[0, :] = np.sum(dN_dxi[:, None] * nodes_coords, axis=0)
    J[1, :] = np.sum(dN_deta[:, None] * nodes_coords, axis=0)
    J[2, :] = np.sum(dN_dzeta[:, None] * nodes_coords, axis=0)
    return np.linalg.det(J)

def build_cubed_sphere_surface(M=9, N_side=4):
    nodes_3d = []
    node_map = {}
    
    def get_node_id(p):
        key = (round(p[0], 7), round(p[1], 7), round(p[2], 7))
        if key not in node_map:
            nid = len(nodes_3d)
            node_map[key] = nid
            nodes_3d.append(np.array(p, dtype=float))
        return node_map[key]

    top_grid = np.zeros((M+1, M+1), dtype=int)
    for i in range(M+1):
        xi = -1.0 + 2.0 * i / M
        u = math.tan(xi * math.pi / 4.0)
        for j in range(M+1):
            eta = -1.0 + 2.0 * j / M
            v = math.tan(eta * math.pi / 4.0)
            w = 1.0
            norm = math.sqrt(u*u + v*v + w*w)
            top_grid[i, j] = get_node_id((u/norm, v/norm, w/norm))
            
    side_px = np.zeros((M+1, N_side+1), dtype=int)
    for j in range(M+1):
        eta = -1.0 + 2.0 * j / M
        v = math.tan(eta * math.pi / 4.0)
        for k in range(N_side+1):
            w = math.tan((k / N_side) * (math.pi / 4.0))
            u = 1.0
            norm = math.sqrt(u*u + v*v + w*w)
            side_px[j, k] = get_node_id((u/norm, v/norm, w/norm))
            
    side_py = np.zeros((M+1, N_side+1), dtype=int)
    for i in range(M+1):
        xi = 1.0 - 2.0 * i / M
        u = math.tan(xi * math.pi / 4.0)
        for k in range(N_side+1):
            w = math.tan((k / N_side) * (math.pi / 4.0))
            v = 1.0
            norm = math.sqrt(u*u + v*v + w*w)
            side_py[i, k] = get_node_id((u/norm, v/norm, w/norm))

    side_mx = np.zeros((M+1, N_side+1), dtype=int)
    for j in range(M+1):
        eta = 1.0 - 2.0 * j / M
        v = math.tan(eta * math.pi / 4.0)
        for k in range(N_side+1):
            w = math.tan((k / N_side) * (math.pi / 4.0))
            u = -1.0
            norm = math.sqrt(u*u + v*v + w*w)
            side_mx[j, k] = get_node_id((u/norm, v/norm, w/norm))
            
    side_my = np.zeros((M+1, N_side+1), dtype=int)
    for i in range(M+1):
        xi = -1.0 + 2.0 * i / M
        u = math.tan(xi * math.pi / 4.0)
        for k in range(N_side+1):
            w = math.tan((k / N_side) * (math.pi / 4.0))
            v = -1.0
            norm = math.sqrt(u*u + v*v + w*w)
            side_my[i, k] = get_node_id((u/norm, v/norm, w/norm))
            
    quads = []
    for i in range(M):
        for j in range(M):
            quads.append((top_grid[i, j], top_grid[i+1, j], top_grid[i+1, j+1], top_grid[i, j+1]))
    for j in range(M):
        for k in range(N_side):
            quads.append((side_px[j, k], side_px[j+1, k], side_px[j+1, k+1], side_px[j, k+1]))
    for i in range(M):
        for k in range(N_side):
            quads.append((side_py[i, k], side_py[i+1, k], side_py[i+1, k+1], side_py[i, k+1]))
    for j in range(M):
        for k in range(N_side):
            quads.append((side_mx[j, k], side_mx[j+1, k], side_mx[j+1, k+1], side_mx[j, k+1]))
    for i in range(M):
        for k in range(N_side):
            quads.append((side_my[i, k], side_my[i+1, k], side_my[i+1, k+1], side_my[i, k+1]))
            
    equator_nodes = []
    for j in range(M): equator_nodes.append(side_px[j, 0])
    for i in range(M): equator_nodes.append(side_py[i, 0])
    for j in range(M): equator_nodes.append(side_mx[j, 0])
    for i in range(M): equator_nodes.append(side_my[i, 0])
    
    return nodes_3d, quads, equator_nodes, top_grid, side_px, side_py, side_mx, side_my

def generate_filled_cylinder_mesh(
    L_total=0.300,
    D_out=0.075,
    t_wall=0.006,
    n_thick=2,
    M=9,
    N_rad=4,
    elem_size_nom=0.006
):
    R_out = D_out / 2.0          # 0.0375 m
    R_in = R_out - t_wall        # 0.0315 m
    L_cyl = L_total - 2.0 * R_out # 0.225 m
    
    N_theta = 4 * M # 36
    N_z_cyl = int(round(L_cyl / elem_size_nom)) # 37
    N_side = N_rad # 4
    N_core_z = N_rad # 4
    
    z_cyl_min = -0.5 * L_cyl
    z_cyl_max = 0.5 * L_cyl
    
    dome_nodes, dome_quads, eq_indices, top_grid, side_px, side_py, side_mx, side_my = build_cubed_sphere_surface(M=M, N_side=N_side)
    r_layers_casing = np.linspace(R_in, R_out, n_thick + 1)
    
    global_nodes = []
    global_node_map = {}
    
    def get_global_node(x, y, z):
        key = (round(x, 7), round(y, 7), round(z, 7))
        if key not in global_node_map:
            nid = len(global_nodes) + 1
            global_node_map[key] = nid
            global_nodes.append((nid, x, y, z))
        return global_node_map[key]

    elements = []
    elem_id_counter = 1
    
    # =========================================================================
    # PART 1: STEEL CASING (PID = 1)
    # =========================================================================
    # 1. Top Dome Casing
    top_casing_nodes = np.zeros((n_thick + 1, len(dome_nodes)), dtype=int)
    for l in range(n_thick + 1):
        Rl = r_layers_casing[l]
        for nid, uvec in enumerate(dome_nodes):
            x = Rl * uvec[0]
            y = Rl * uvec[1]
            z = z_cyl_max + Rl * uvec[2]
            top_casing_nodes[l, nid] = get_global_node(x, y, z)
            
    for l in range(n_thick):
        for q in dome_quads:
            n1 = top_casing_nodes[l, q[0]]
            n2 = top_casing_nodes[l, q[1]]
            n3 = top_casing_nodes[l, q[2]]
            n4 = top_casing_nodes[l, q[3]]
            
            n5 = top_casing_nodes[l+1, q[0]]
            n6 = top_casing_nodes[l+1, q[1]]
            n7 = top_casing_nodes[l+1, q[2]]
            n8 = top_casing_nodes[l+1, q[3]]
            
            elements.append((elem_id_counter, 1, n1, n2, n3, n4, n5, n6, n7, n8))
            elem_id_counter += 1

    # 2. Bottom Dome Casing
    bot_casing_nodes = np.zeros((n_thick + 1, len(dome_nodes)), dtype=int)
    for l in range(n_thick + 1):
        Rl = r_layers_casing[l]
        for nid, uvec in enumerate(dome_nodes):
            x = Rl * uvec[0]
            y = Rl * uvec[1]
            z = z_cyl_min - Rl * uvec[2]
            bot_casing_nodes[l, nid] = get_global_node(x, y, z)
            
    for l in range(n_thick):
        for q in dome_quads:
            n1 = bot_casing_nodes[l, q[0]]
            n2 = bot_casing_nodes[l, q[3]]
            n3 = bot_casing_nodes[l, q[2]]
            n4 = bot_casing_nodes[l, q[1]]
            
            n5 = bot_casing_nodes[l+1, q[0]]
            n6 = bot_casing_nodes[l+1, q[3]]
            n7 = bot_casing_nodes[l+1, q[2]]
            n8 = bot_casing_nodes[l+1, q[1]]
            
            elements.append((elem_id_counter, 1, n1, n2, n3, n4, n5, n6, n7, n8))
            elem_id_counter += 1

    # 3. Cylinder Casing
    cyl_casing_nodes = np.zeros((N_z_cyl + 1, n_thick + 1, N_theta), dtype=int)
    for s in range(N_z_cyl + 1):
        zc = z_cyl_min + s * (L_cyl / N_z_cyl)
        for l in range(n_thick + 1):
            Rl = r_layers_casing[l]
            for j in range(N_theta):
                eq_node_idx = eq_indices[j]
                uvec = dome_nodes[eq_node_idx]
                x = Rl * uvec[0]
                y = Rl * uvec[1]
                z = zc
                cyl_casing_nodes[s, l, j] = get_global_node(x, y, z)
                
    for s in range(N_z_cyl):
        for l in range(n_thick):
            for j in range(N_theta):
                j_next = (j + 1) % N_theta
                n1 = cyl_casing_nodes[s, l, j]
                n2 = cyl_casing_nodes[s, l, j_next]
                n3 = cyl_casing_nodes[s+1, l, j_next]
                n4 = cyl_casing_nodes[s+1, l, j]
                
                n5 = cyl_casing_nodes[s, l+1, j]
                n6 = cyl_casing_nodes[s, l+1, j_next]
                n7 = cyl_casing_nodes[s+1, l+1, j_next]
                n8 = cyl_casing_nodes[s+1, l+1, j]
                
                elements.append((elem_id_counter, 1, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # =========================================================================
    # PART 2: LEAD FILL (PID = 2)
    # =========================================================================
    a = 0.45 * R_in # half-width of central core = 14.175 mm
    h_core = 0.45 * R_in # height of dome central core = 14.175 mm
    
    # 1. Top Dome Lead
    top_lead_core = np.zeros((M+1, M+1, N_core_z+1), dtype=int)
    for i in range(M+1):
        x = -a + 2.0 * a * i / M
        for j in range(M+1):
            y = -a + 2.0 * a * j / M
            for k in range(N_core_z+1):
                z = z_cyl_max + h_core * k / N_core_z
                top_lead_core[i, j, k] = get_global_node(x, y, z)
                
    for i in range(M):
        for j in range(M):
            for k in range(N_core_z):
                n1 = top_lead_core[i, j, k]
                n2 = top_lead_core[i+1, j, k]
                n3 = top_lead_core[i+1, j+1, k]
                n4 = top_lead_core[i, j+1, k]
                n5 = top_lead_core[i, j, k+1]
                n6 = top_lead_core[i+1, j, k+1]
                n7 = top_lead_core[i+1, j+1, k+1]
                n8 = top_lead_core[i, j+1, k+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1
                
    top_lead_topblock = np.zeros((M+1, M+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for j in range(M+1):
            top_lead_topblock[i, j, 0] = top_lead_core[i, j, N_core_z]
            top_lead_topblock[i, j, N_rad] = top_casing_nodes[0, top_grid[i, j]]
            p_in = np.array(global_nodes[top_lead_topblock[i, j, 0]-1][1:])
            p_out = np.array(global_nodes[top_lead_topblock[i, j, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                top_lead_topblock[i, j, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for j in range(M):
            for r in range(N_rad):
                n1 = top_lead_topblock[i, j, r]
                n2 = top_lead_topblock[i+1, j, r]
                n3 = top_lead_topblock[i+1, j+1, r]
                n4 = top_lead_topblock[i, j+1, r]
                n5 = top_lead_topblock[i, j, r+1]
                n6 = top_lead_topblock[i+1, j, r+1]
                n7 = top_lead_topblock[i+1, j+1, r+1]
                n8 = top_lead_topblock[i, j+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # 4 side blocks of top dome (+X, +Y, -X, -Y)
    top_lead_px = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for k in range(N_core_z+1):
            top_lead_px[j, k, 0] = top_lead_core[M, j, k]
            top_lead_px[j, k, N_rad] = top_casing_nodes[0, side_px[j, k]]
            p_in = np.array(global_nodes[top_lead_px[j, k, 0]-1][1:])
            p_out = np.array(global_nodes[top_lead_px[j, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                top_lead_px[j, k, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = top_lead_px[j, k, r]
                n2 = top_lead_px[j+1, k, r]
                n3 = top_lead_px[j+1, k+1, r]
                n4 = top_lead_px[j, k+1, r]
                n5 = top_lead_px[j, k, r+1]
                n6 = top_lead_px[j+1, k, r+1]
                n7 = top_lead_px[j+1, k+1, r+1]
                n8 = top_lead_px[j, k+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    top_lead_py = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for k in range(N_core_z+1):
            top_lead_py[i, k, 0] = top_lead_core[M-i, M, k]
            top_lead_py[i, k, N_rad] = top_casing_nodes[0, side_py[i, k]]
            p_in = np.array(global_nodes[top_lead_py[i, k, 0]-1][1:])
            p_out = np.array(global_nodes[top_lead_py[i, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                top_lead_py[i, k, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = top_lead_py[i, k, r]
                n2 = top_lead_py[i+1, k, r]
                n3 = top_lead_py[i+1, k+1, r]
                n4 = top_lead_py[i, k+1, r]
                n5 = top_lead_py[i, k, r+1]
                n6 = top_lead_py[i+1, k, r+1]
                n7 = top_lead_py[i+1, k+1, r+1]
                n8 = top_lead_py[i, k+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    top_lead_mx = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for k in range(N_core_z+1):
            top_lead_mx[j, k, 0] = top_lead_core[0, M-j, k]
            top_lead_mx[j, k, N_rad] = top_casing_nodes[0, side_mx[j, k]]
            p_in = np.array(global_nodes[top_lead_mx[j, k, 0]-1][1:])
            p_out = np.array(global_nodes[top_lead_mx[j, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                top_lead_mx[j, k, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = top_lead_mx[j, k, r]
                n2 = top_lead_mx[j+1, k, r]
                n3 = top_lead_mx[j+1, k+1, r]
                n4 = top_lead_mx[j, k+1, r]
                n5 = top_lead_mx[j, k, r+1]
                n6 = top_lead_mx[j+1, k, r+1]
                n7 = top_lead_mx[j+1, k+1, r+1]
                n8 = top_lead_mx[j, k+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    top_lead_my = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for k in range(N_core_z+1):
            top_lead_my[i, k, 0] = top_lead_core[i, 0, k]
            top_lead_my[i, k, N_rad] = top_casing_nodes[0, side_my[i, k]]
            p_in = np.array(global_nodes[top_lead_my[i, k, 0]-1][1:])
            p_out = np.array(global_nodes[top_lead_my[i, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                top_lead_my[i, k, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = top_lead_my[i, k, r]
                n2 = top_lead_my[i+1, k, r]
                n3 = top_lead_my[i+1, k+1, r]
                n4 = top_lead_my[i, k+1, r]
                n5 = top_lead_my[i, k, r+1]
                n6 = top_lead_my[i+1, k, r+1]
                n7 = top_lead_my[i+1, k+1, r+1]
                n8 = top_lead_my[i, k+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # 2. Cylinder Body Lead
    cyl_lead_core = np.zeros((M+1, M+1, N_z_cyl+1), dtype=int)
    for i in range(M+1):
        for j in range(M+1):
            for s in range(N_z_cyl+1):
                zc = z_cyl_min + s * (L_cyl / N_z_cyl)
                x = -a + 2.0 * a * i / M
                y = -a + 2.0 * a * j / M
                cyl_lead_core[i, j, s] = get_global_node(x, y, zc)
                
    for i in range(M):
        for j in range(M):
            for s in range(N_z_cyl):
                n1 = cyl_lead_core[i, j, s]
                n2 = cyl_lead_core[i+1, j, s]
                n3 = cyl_lead_core[i+1, j+1, s]
                n4 = cyl_lead_core[i, j+1, s]
                n5 = cyl_lead_core[i, j, s+1]
                n6 = cyl_lead_core[i+1, j, s+1]
                n7 = cyl_lead_core[i+1, j+1, s+1]
                n8 = cyl_lead_core[i, j+1, s+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # 4 lateral blocks of cylinder (+X, +Y, -X, -Y)
    cyl_lead_px = np.zeros((M+1, N_z_cyl+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for s in range(N_z_cyl+1):
            cyl_lead_px[j, s, 0] = cyl_lead_core[M, j, s]
            cyl_lead_px[j, s, N_rad] = cyl_casing_nodes[s, 0, j]
            p_in = np.array(global_nodes[cyl_lead_px[j, s, 0]-1][1:])
            p_out = np.array(global_nodes[cyl_lead_px[j, s, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                cyl_lead_px[j, s, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for s in range(N_z_cyl):
            for r in range(N_rad):
                n1 = cyl_lead_px[j, s, r]
                n2 = cyl_lead_px[j+1, s, r]
                n3 = cyl_lead_px[j+1, s+1, r]
                n4 = cyl_lead_px[j, s+1, r]
                n5 = cyl_lead_px[j, s, r+1]
                n6 = cyl_lead_px[j+1, s, r+1]
                n7 = cyl_lead_px[j+1, s+1, r+1]
                n8 = cyl_lead_px[j, s+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    cyl_lead_py = np.zeros((M+1, N_z_cyl+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for s in range(N_z_cyl+1):
            cyl_lead_py[i, s, 0] = cyl_lead_core[M-i, M, s]
            cyl_lead_py[i, s, N_rad] = cyl_casing_nodes[s, 0, M + i]
            p_in = np.array(global_nodes[cyl_lead_py[i, s, 0]-1][1:])
            p_out = np.array(global_nodes[cyl_lead_py[i, s, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                cyl_lead_py[i, s, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for s in range(N_z_cyl):
            for r in range(N_rad):
                n1 = cyl_lead_py[i, s, r]
                n2 = cyl_lead_py[i+1, s, r]
                n3 = cyl_lead_py[i+1, s+1, r]
                n4 = cyl_lead_py[i, s+1, r]
                n5 = cyl_lead_py[i, s, r+1]
                n6 = cyl_lead_py[i+1, s, r+1]
                n7 = cyl_lead_py[i+1, s+1, r+1]
                n8 = cyl_lead_py[i, s+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    cyl_lead_mx = np.zeros((M+1, N_z_cyl+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for s in range(N_z_cyl+1):
            cyl_lead_mx[j, s, 0] = cyl_lead_core[0, M-j, s]
            cyl_lead_mx[j, s, N_rad] = cyl_casing_nodes[s, 0, 2*M + j]
            p_in = np.array(global_nodes[cyl_lead_mx[j, s, 0]-1][1:])
            p_out = np.array(global_nodes[cyl_lead_mx[j, s, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                cyl_lead_mx[j, s, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for s in range(N_z_cyl):
            for r in range(N_rad):
                n1 = cyl_lead_mx[j, s, r]
                n2 = cyl_lead_mx[j+1, s, r]
                n3 = cyl_lead_mx[j+1, s+1, r]
                n4 = cyl_lead_mx[j, s+1, r]
                n5 = cyl_lead_mx[j, s, r+1]
                n6 = cyl_lead_mx[j+1, s, r+1]
                n7 = cyl_lead_mx[j+1, s+1, r+1]
                n8 = cyl_lead_mx[j, s+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    cyl_lead_my = np.zeros((M+1, N_z_cyl+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for s in range(N_z_cyl+1):
            cyl_lead_my[i, s, 0] = cyl_lead_core[i, 0, s]
            cyl_lead_my[i, s, N_rad] = cyl_casing_nodes[s, 0, (3*M + i) % N_theta]
            p_in = np.array(global_nodes[cyl_lead_my[i, s, 0]-1][1:])
            p_out = np.array(global_nodes[cyl_lead_my[i, s, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                cyl_lead_my[i, s, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for s in range(N_z_cyl):
            for r in range(N_rad):
                n1 = cyl_lead_my[i, s, r]
                n2 = cyl_lead_my[i+1, s, r]
                n3 = cyl_lead_my[i+1, s+1, r]
                n4 = cyl_lead_my[i, s+1, r]
                n5 = cyl_lead_my[i, s, r+1]
                n6 = cyl_lead_my[i+1, s, r+1]
                n7 = cyl_lead_my[i+1, s+1, r+1]
                n8 = cyl_lead_my[i, s+1, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # 3. Bottom Dome Lead
    bot_lead_core = np.zeros((M+1, M+1, N_core_z+1), dtype=int)
    for i in range(M+1):
        x = -a + 2.0 * a * i / M
        for j in range(M+1):
            y = -a + 2.0 * a * j / M
            for k in range(N_core_z+1):
                z = z_cyl_min - h_core * k / N_core_z
                bot_lead_core[i, j, k] = get_global_node(x, y, z)
                
    for i in range(M):
        for j in range(M):
            for k in range(N_core_z):
                n1 = bot_lead_core[i, j, k]
                n2 = bot_lead_core[i, j+1, k]
                n3 = bot_lead_core[i+1, j+1, k]
                n4 = bot_lead_core[i+1, j, k]
                n5 = bot_lead_core[i, j, k+1]
                n6 = bot_lead_core[i, j+1, k+1]
                n7 = bot_lead_core[i+1, j+1, k+1]
                n8 = bot_lead_core[i+1, j, k+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    bot_lead_botblock = np.zeros((M+1, M+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for j in range(M+1):
            bot_lead_botblock[i, j, 0] = bot_lead_core[i, j, N_core_z]
            bot_lead_botblock[i, j, N_rad] = bot_casing_nodes[0, top_grid[i, j]]
            p_in = np.array(global_nodes[bot_lead_botblock[i, j, 0]-1][1:])
            p_out = np.array(global_nodes[bot_lead_botblock[i, j, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                bot_lead_botblock[i, j, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for j in range(M):
            for r in range(N_rad):
                n1 = bot_lead_botblock[i, j, r]
                n2 = bot_lead_botblock[i, j+1, r]
                n3 = bot_lead_botblock[i+1, j+1, r]
                n4 = bot_lead_botblock[i+1, j, r]
                n5 = bot_lead_botblock[i, j, r+1]
                n6 = bot_lead_botblock[i, j+1, r+1]
                n7 = bot_lead_botblock[i+1, j+1, r+1]
                n8 = bot_lead_botblock[i+1, j, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    bot_lead_px = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for k in range(N_core_z+1):
            bot_lead_px[j, k, 0] = bot_lead_core[M, j, k]
            bot_lead_px[j, k, N_rad] = bot_casing_nodes[0, side_px[j, k]]
            p_in = np.array(global_nodes[bot_lead_px[j, k, 0]-1][1:])
            p_out = np.array(global_nodes[bot_lead_px[j, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                bot_lead_px[j, k, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = bot_lead_px[j, k, r]
                n2 = bot_lead_px[j, k+1, r]
                n3 = bot_lead_px[j+1, k+1, r]
                n4 = bot_lead_px[j+1, k, r]
                n5 = bot_lead_px[j, k, r+1]
                n6 = bot_lead_px[j, k+1, r+1]
                n7 = bot_lead_px[j+1, k+1, r+1]
                n8 = bot_lead_px[j+1, k, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    bot_lead_py = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for k in range(N_core_z+1):
            bot_lead_py[i, k, 0] = bot_lead_core[M-i, M, k]
            bot_lead_py[i, k, N_rad] = bot_casing_nodes[0, side_py[i, k]]
            p_in = np.array(global_nodes[bot_lead_py[i, k, 0]-1][1:])
            p_out = np.array(global_nodes[bot_lead_py[i, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                bot_lead_py[i, k, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = bot_lead_py[i, k, r]
                n2 = bot_lead_py[i, k+1, r]
                n3 = bot_lead_py[i+1, k+1, r]
                n4 = bot_lead_py[i+1, k, r]
                n5 = bot_lead_py[i, k, r+1]
                n6 = bot_lead_py[i, k+1, r+1]
                n7 = bot_lead_py[i+1, k+1, r+1]
                n8 = bot_lead_py[i+1, k, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    bot_lead_mx = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for j in range(M+1):
        for k in range(N_core_z+1):
            bot_lead_mx[j, k, 0] = bot_lead_core[0, M-j, k]
            bot_lead_mx[j, k, N_rad] = bot_casing_nodes[0, side_mx[j, k]]
            p_in = np.array(global_nodes[bot_lead_mx[j, k, 0]-1][1:])
            p_out = np.array(global_nodes[bot_lead_mx[j, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                bot_lead_mx[j, k, r] = get_global_node(p[0], p[1], p[2])
                
    for j in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = bot_lead_mx[j, k, r]
                n2 = bot_lead_mx[j, k+1, r]
                n3 = bot_lead_mx[j+1, k+1, r]
                n4 = bot_lead_mx[j+1, k, r]
                n5 = bot_lead_mx[j, k, r+1]
                n6 = bot_lead_mx[j, k+1, r+1]
                n7 = bot_lead_mx[j+1, k+1, r+1]
                n8 = bot_lead_mx[j+1, k, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    bot_lead_my = np.zeros((M+1, N_core_z+1, N_rad+1), dtype=int)
    for i in range(M+1):
        for k in range(N_core_z+1):
            bot_lead_my[i, k, 0] = bot_lead_core[i, 0, k]
            bot_lead_my[i, k, N_rad] = bot_casing_nodes[0, side_my[i, k]]
            p_in = np.array(global_nodes[bot_lead_my[i, k, 0]-1][1:])
            p_out = np.array(global_nodes[bot_lead_my[i, k, N_rad]-1][1:])
            for r in range(1, N_rad):
                frac = r / N_rad
                p = (1.0 - frac) * p_in + frac * p_out
                bot_lead_my[i, k, r] = get_global_node(p[0], p[1], p[2])
                
    for i in range(M):
        for k in range(N_core_z):
            for r in range(N_rad):
                n1 = bot_lead_my[i, k, r]
                n2 = bot_lead_my[i, k+1, r]
                n3 = bot_lead_my[i+1, k+1, r]
                n4 = bot_lead_my[i+1, k, r]
                n5 = bot_lead_my[i, k, r+1]
                n6 = bot_lead_my[i, k+1, r+1]
                n7 = bot_lead_my[i+1, k+1, r+1]
                n8 = bot_lead_my[i+1, k, r+1]
                elements.append((elem_id_counter, 2, n1, n2, n3, n4, n5, n6, n7, n8))
                elem_id_counter += 1

    # Validate Jacobians
    node_dict = {nid: np.array([x, y, z]) for (nid, x, y, z) in global_nodes}
    gauss_pts = [-1.0 / math.sqrt(3.0), 1.0 / math.sqrt(3.0)]
    invalid_elems = 0
    for elem in elements:
        eid, pid, n1, n2, n3, n4, n5, n6, n7, n8 = elem
        coords = np.array([node_dict[nid] for nid in [n1, n2, n3, n4, n5, n6, n7, n8]])
        if compute_element_jacobian_det(coords, 0.0, 0.0, 0.0) <= 0.0:
            invalid_elems += 1
        for xi in gauss_pts:
            for eta in gauss_pts:
                for zeta in gauss_pts:
                    if compute_element_jacobian_det(coords, xi, eta, zeta) <= 0.0:
                        invalid_elems += 1
                        
    if invalid_elems > 0:
        raise ValueError(f"Found {invalid_elems} elements with non-positive Jacobian determinant!")
        
    return global_nodes, elements

def write_ls_dyna_deck(filename="steel_cylinder_domed_ends.k"):
    nodes, elements = generate_filled_cylinder_mesh()
    casing_elems = [e for e in elements if e[1] == 1]
    lead_elems = [e for e in elements if e[1] == 2]
    
    with open(filename, "w") as f:
        # Header comments
        f.write("$" * 80 + "\n")
        f.write("$ LS-DYNA KEYWORD DECK: STEEL CYLINDER WITH DOMED ENDS & LEAD CORE FILL\n")
        f.write("$ 100% HIGH-QUALITY CONFORMING HEX8 SOLID MESH (EXPLICIT TRANSIENT FEA)\n")
        f.write("$" * 80 + "\n")
        f.write("$ Geometry Specifications:\n")
        f.write("$   - Overall Length: 300.0 mm (0.300 m)\n")
        f.write("$   - Outer Diameter: 75.0 mm (0.075 m) -> Outer Radius = 37.5 mm\n")
        f.write("$   - Wall Thickness: 6.0 mm (0.006 m)  -> Inner Radius = 31.5 mm\n")
        f.write("$   - Domed Ends: Cubed-Sphere Hex8 Hemispherical Caps (R_out = 37.5 mm)\n")
        f.write("$   - Cylindrical Section Length: 225.0 mm (0.225 m)\n")
        f.write("$   - Interior Cavity: Lead-Filled Capsule (R_in = 31.5 mm, L_inner = 288.0 mm)\n")
        f.write("$\n")
        f.write("$ Mesh Quality & Discretization:\n")
        f.write("$   - Element Type: 100% Conforming 8-node Solid Hexahedra (*ELEMENT_SOLID)\n")
        f.write("$   - Zero Degenerate Wedges / Zero Polar Singularities\n")
        f.write("$   - Interface: 100% Conforming Shared-Node Coupling between Steel & Lead\n")
        f.write(f"$   - Steel Casing Elements (Part 1): {len(casing_elems):d} Hex8\n")
        f.write(f"$   - Lead Fill Elements (Part 2): {len(lead_elems):d} Hex8\n")
        f.write(f"$   - Total Hex8 Elements: {len(elements):d}\n")
        f.write(f"$   - Total Global Nodes: {len(nodes):d}\n")
        f.write("$\n")
        f.write("$ Material Models (Pure SI Units: m, s, kg, N, Pa, J):\n")
        f.write("$   1. Steel Casing (MAT_PIECEWISE_LINEAR_PLASTICITY / MAT_024):\n")
        f.write("$      - Density (RO): 7850.0 kg/m^3\n")
        f.write("$      - Young's Modulus (E): 2.10e11 Pa (210 GPa)\n")
        f.write("$      - Poisson's Ratio (PR): 0.30\n")
        f.write("$      - Yield Stress (SIGY): 3.50e8 Pa (350 MPa)\n")
        f.write("$      - Tangent Modulus (ETAN): 1.00e9 Pa (1 GPa)\n")
        f.write("$      - Failure Plastic Strain (FAIL): 0.20\n")
        f.write("$\n")
        f.write("$   2. Lead Core Fill (MAT_PIECEWISE_LINEAR_PLASTICITY / MAT_024):\n")
        f.write("$      - Density (RO): 11340.0 kg/m^3 (1.134e4 kg/m^3)\n")
        f.write("$      - Young's Modulus (E): 1.60e10 Pa (16 GPa)\n")
        f.write("$      - Poisson's Ratio (PR): 0.42\n")
        f.write("$      - Yield Stress (SIGY): 1.50e7 Pa (15 MPa)\n")
        f.write("$      - Tangent Modulus (ETAN): 1.50e8 Pa (150 MPa)\n")
        f.write("$      - Failure Plastic Strain (FAIL): 0.50\n")
        f.write("$" * 80 + "\n")
        f.write("*KEYWORD\n")
        f.write("*TITLE\n")
        f.write("Steel Cylinder with Domed Ends and Lead Core Fill (100% Hex8)\n")
        
        # Simulation Controls
        f.write("$" * 80 + "\n")
        f.write("$ SIMULATION CONTROL CARDS\n")
        f.write("$" * 80 + "\n")
        f.write("*CONTROL_TERMINATION\n")
        f.write("$#  endtim    endcyc     dtmin    endeng    endmas     nosol\n")
        f.write(format_card([0.0020, 0, 0.0, 0.0, 0.0, 0]) + "\n")
        
        f.write("*CONTROL_TIMESTEP\n")
        f.write("$#  dtinit    tssfac      isdo    tslimt     dtms     lctm     erode     ms1st\n")
        f.write(format_card([0.0, 0.90, 0, 0.0, 0.0, 0, 0, 0]) + "\n")
        
        f.write("*CONTROL_ENERGY\n")
        f.write("$#    hgen      rwen    slnten     rylen\n")
        f.write(format_card([2, 2, 2, 2]) + "\n")
        
        f.write("*CONTROL_HOURGLASS\n")
        f.write("$#     ihq        qh\n")
        f.write(format_card([5, 0.10]) + "\n")
        
        f.write("*CONTROL_SOLID\n")
        f.write("$#   esort   fmatrx    nipts     nsub\n")
        f.write(format_card([1, 1, 0, 0]) + "\n")
        
        # Database Outputs
        f.write("$" * 80 + "\n")
        f.write("$ DATABASE OUTPUT CONTROLS\n")
        f.write("$" * 80 + "\n")
        f.write("*DATABASE_BINARY_D3PLOT\n")
        f.write("$#      dt      lcdt      beam     npltc    psetid\n")
        f.write(format_card([2.0e-5, 0, 0, 0, 0]) + "\n")
        
        f.write("*DATABASE_EXTENT_BINARY\n")
        f.write("$#   neiph     neips    maxint    strflg    sigflg    epsflg    rltflg    engflg\n")
        f.write(format_card([8, 8, 3, 1, 1, 1, 1, 1]) + "\n")
        
        f.write("*DATABASE_GLSTAT\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([5.0e-6, 0, 0, 1]) + "\n")
        
        f.write("*DATABASE_MATSUM\n")
        f.write("$#      dt    binary      lcur     ioopt\n")
        f.write(format_card([5.0e-6, 0, 0, 1]) + "\n")
        
        # Part & Section Definitions
        f.write("$" * 80 + "\n")
        f.write("$ PART & SECTION DEFINITIONS\n")
        f.write("$" * 80 + "\n")
        f.write("*SECTION_SOLID\n")
        f.write("$#   secid    elform       aet\n")
        f.write(format_card([1, 1, 0]) + "\n")
        
        # Part 1: Steel Casing
        f.write("*PART\n")
        f.write("$#                                                                 title\n")
        f.write("Steel_Cylinder_Casing\n")
        f.write("$#     pid      secid       mid     eosid      hgid       grav      adpopt      tmid\n")
        f.write(format_card([1, 1, 1, 0, 0, 0, 0, 0]) + "\n")
        
        # Part 2: Lead Core Fill
        f.write("*PART\n")
        f.write("$#                                                                 title\n")
        f.write("Lead_Core_Fill\n")
        f.write("$#     pid      secid       mid     eosid      hgid       grav      adpopt      tmid\n")
        f.write(format_card([2, 1, 2, 0, 0, 0, 0, 0]) + "\n")
        
        # Material Definitions
        f.write("$" * 80 + "\n")
        f.write("$ MATERIAL 1: GENERIC STRUCTURAL STEEL (SI UNITS: m, kg, s, Pa)\n")
        f.write("$" * 80 + "\n")
        f.write("*MAT_PIECEWISE_LINEAR_PLASTICITY\n")
        f.write("$#     mid        ro         e        pr      sigy      etan      fail      tdel\n")
        f.write(format_card([1, 7850.0, 2.10e11, 0.30, 3.50e8, 1.0e9, 0.20, 0.0]) + "\n")
        f.write("$#       c         p      lcss      lcsr        vp\n")
        f.write(format_card([0.0, 0.0, 0, 0, 0.0]) + "\n")
        f.write("$#    eps1      eps2      eps3      eps4      eps5      eps6      eps7      eps8\n")
        f.write(format_card([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        f.write("$#     es1       es2       es3       es4       es5       es6       es7       es8\n")
        f.write(format_card([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        
        f.write("$" * 80 + "\n")
        f.write("$ MATERIAL 2: GENERIC CHEMICAL LEAD (SI UNITS: m, kg, s, Pa)\n")
        f.write("$" * 80 + "\n")
        f.write("*MAT_PIECEWISE_LINEAR_PLASTICITY\n")
        f.write("$#     mid        ro         e        pr      sigy      etan      fail      tdel\n")
        f.write(format_card([2, 11340.0, 1.60e10, 0.42, 1.50e7, 1.50e8, 0.50, 0.0]) + "\n")
        f.write("$#       c         p      lcss      lcsr        vp\n")
        f.write(format_card([0.0, 0.0, 0, 0, 0.0]) + "\n")
        f.write("$#    eps1      eps2      eps3      eps4      eps5      eps6      eps7      eps8\n")
        f.write(format_card([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        f.write("$#     es1       es2       es3       es4       es5       es6       es7       es8\n")
        f.write(format_card([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]) + "\n")
        
        # Node Definitions
        f.write("$" * 80 + "\n")
        f.write(f"$ NODE DEFINITIONS ({len(nodes):d} Nodes)\n")
        f.write("$" * 80 + "\n")
        f.write("*NODE\n")
        f.write("$#   nid               x               y               z      tc      rc\n")
        for nid, x, y, z in nodes:
            f.write(format_card([nid, x, y, z, 0, 0], widths=[8, 16, 16, 16, 8, 8]) + "\n")
            
        # Element Definitions
        f.write("$" * 80 + "\n")
        f.write(f"$ SOLID ELEMENT DEFINITIONS ({len(elements):d} Hex8 Elements)\n")
        f.write(f"$ Part 1 (Steel Casing): {len(casing_elems):d} Elements | Part 2 (Lead Fill): {len(lead_elems):d} Elements\n")
        f.write("$" * 80 + "\n")
        f.write("*ELEMENT_SOLID\n")
        f.write("$#   eid     pid      n1      n2      n3      n4      n5      n6      n7      n8\n")
        for eid, pid, n1, n2, n3, n4, n5, n6, n7, n8 in elements:
            f.write(format_card([eid, pid, n1, n2, n3, n4, n5, n6, n7, n8], widths=[8, 8, 8, 8, 8, 8, 8, 8, 8, 8]) + "\n")
            
        f.write("*END\n")
        
    print(f"[SUCCESS] Wrote lead-filled LS-DYNA keyword file: {filename}")
    print(f"  Nodes: {len(nodes):d}")
    print(f"  Steel Casing Hex8 Elements: {len(casing_elems):d}")
    print(f"  Lead Fill Hex8 Elements: {len(lead_elems):d}")
    print(f"  Total Hex8 Elements: {len(elements):d}")
    print(f"  Mesh Quality: 100% Positive Jacobians at all Gauss integration points.")

if __name__ == "__main__":
    write_ls_dyna_deck("steel_cylinder_domed_ends.k")
