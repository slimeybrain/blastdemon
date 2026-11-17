#!/usr/bin/env python3
"""
BlastDaemon Living Theory Manual Generator & Freshness Auditor.

Zero-dependency Python 3 (stdlib only) script that:
1. Generates crisp, light-theme-safe vector SVG schematics and constitutive/EOS
   plots in docs/figures/ directly from the implemented mathematical equations.
2. Parses frontend/src/parameter-definitions.ts and frontend/src/state-manager.ts
   to auto-generate Appendix A (Exhaustive Node & Parameter Reference).
3. Parses VERIFICATION_MANUAL.md to sync live V&V pass/fail statistics.
4. Updates the git commit/date stamp in THEORY_MANUAL.md.
5. In --check mode, audits:
   - Zero raw LaTeX delimiters/commands (Directive 7)
   - All inline citations [Key] resolve to the References section
   - All referenced repository file paths and SVG figures exist
   - All node types from parameter-definitions.ts are documented
"""

import argparse
import math
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
THEORY_MANUAL = REPO_ROOT / "THEORY_MANUAL.md"
PARAM_DEFS_TS = REPO_ROOT / "frontend" / "src" / "parameter-definitions.ts"
STATE_MGR_TS = REPO_ROOT / "frontend" / "src" / "state-manager.ts"
VV_MANUAL = REPO_ROOT / "VERIFICATION_MANUAL.md"
FIGURES_DIR = REPO_ROOT / "docs" / "figures"


# ---------------------------------------------------------------------------
# 1. Zero-Dependency SVG Figure Generation
# ---------------------------------------------------------------------------

def svg_header(width: int, height: int, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="{title}">\n'
        f'  <defs>\n'
        f'    <style>\n'
        f'      .bg {{ fill: #f8fafc; stroke: #cbd5e1; stroke-width: 1.5; }}\n'
        f'      .panel {{ fill: #ffffff; stroke: #cbd5e1; stroke-width: 1; }}\n'
        f'      .title {{ font: 700 15px "Segoe UI", system-ui, sans-serif; fill: #0f172a; }}\n'
        f'      .subtitle {{ font: 600 12px "Segoe UI", system-ui, sans-serif; fill: #334155; }}\n'
        f'      .label {{ font: 500 11px "Segoe UI", system-ui, sans-serif; fill: #1e293b; }}\n'
        f'      .small {{ font: 400 10px "Segoe UI", system-ui, sans-serif; fill: #475569; }}\n'
        f'      .mono {{ font: 500 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f172a; }}\n'
        f'      .axis {{ stroke: #334155; stroke-width: 1.2; }}\n'
        f'      .grid {{ stroke: #e2e8f0; stroke-width: 0.8; stroke-dasharray: 3 3; }}\n'
        f'    </style>\n'
        f'    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">\n'
        f'      <path d="M 0 1 L 10 5 L 0 9 z" fill="#1e293b"/>\n'
        f'    </marker>\n'
        f'    <marker id="arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">\n'
        f'      <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb"/>\n'
        f'    </marker>\n'
        f'    <marker id="arrow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">\n'
        f'      <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626"/>\n'
        f'    </marker>\n'
        f'  </defs>\n'
        f'  <rect class="bg" x="1" y="1" width="{width - 2}" height="{height - 2}" rx="8"/>\n'
    )


def gen_riemann_fan_svg() -> str:
    w, h = 820, 320
    out = [svg_header(w, h, "Riemann Wave Fan and AUSM+ Splitting Schematic")]
    out.append('  <text class="title" x="24" y="28">Eulerian Interface Fluxes: Riemann Wave-Fan vs. AUSM+ Mach/Pressure Splitting</text>')

    # Left Panel: Riemann Fan
    out.append('  <rect class="panel" x="20" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="34" y="66">1. Compressible Riemann Wave-Fan (x - t Plane)</text>')
    # Axes
    out.append('  <line class="axis" x1="50" y1="255" x2="380" y2="255" marker-end="url(#arrow)"/>')
    out.append('  <line class="axis" x1="215" y1="255" x2="215" y2="85" marker-end="url(#arrow)"/>')
    out.append('  <text class="label" x="368" y="272">x</text>')
    out.append('  <text class="label" x="223" y="92">t</text>')
    # Waves
    out.append('  <line x1="215" y1="255" x2="85" y2="110" stroke="#2563eb" stroke-width="2.2"/>')
    out.append('  <line x1="215" y1="255" x2="265" y2="105" stroke="#16a34a" stroke-width="2" stroke-dasharray="5 3"/>')
    out.append('  <line x1="215" y1="255" x2="345" y2="115" stroke="#dc2626" stroke-width="2.5"/>')
    # Labels
    out.append('  <text class="label" x="75" y="205">State W_L</text>')
    out.append('  <text class="small" x="68" y="220">(ρ_L, u_L, p_L, α_kL)</text>')
    out.append('  <text class="label" x="305" y="205">State W_R</text>')
    out.append('  <text class="small" x="295" y="220">(ρ_R, u_R, p_R, α_kR)</text>')
    out.append('  <text class="label" x="150" y="135" fill="#2563eb">W_L*</text>')
    out.append('  <text class="label" x="262" y="135" fill="#dc2626">W_R*</text>')
    out.append('  <text class="small" x="62" y="102" fill="#2563eb">S_L = u_L - c_L</text>')
    out.append('  <text class="small" x="235" y="98" fill="#16a34a">S_* (Contact)</text>')
    out.append('  <text class="small" x="315" y="108" fill="#dc2626">S_R = u_R + c_R</text>')
    out.append('  <text class="mono" x="38" y="286">Rusanov: s_max = max(|u_L|+c_L, |u_R|+c_R)</text>')

    # Right Panel: AUSM+ Mach & Pressure Polynomials
    out.append('  <rect class="panel" x="420" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="434" y="66">2. AUSM+ Split Mach M±(M) &amp; Pressure P±(M)</text>')
    # Plot box: x in [465, 775] for M in [-1.5, 1.5], y in [245, 100] for [0, 1.5]
    ox, oy = 620, 245  # M=0, val=0
    sx, sy = 95, 95    # scale
    out.append(f'  <line class="grid" x1="{ox - sx}" y1="95" x2="{ox - sx}" y2="{oy}"/>')
    out.append(f'  <line class="grid" x1="{ox + sx}" y1="95" x2="{ox + sx}" y2="{oy}"/>')
    out.append(f'  <line class="axis" x1="465" y1="{oy}" x2="780" y2="{oy}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{ox}" y1="{oy}" x2="{ox}" y2="90" marker-end="url(#arrow)"/>')
    out.append(f'  <text class="small" x="{ox - sx - 10}" y="{oy + 14}">-1</text>')
    out.append(f'  <text class="small" x="{ox - 3}" y="{oy + 14}">0</text>')
    out.append(f'  <text class="small" x="{ox + sx - 4}" y="{oy + 14}">+1</text>')
    out.append('  <text class="label" x="768" y="260">M</text>')

    # Compute P4+(M) (alpha = 3/16) and M4+(M) (beta = 1/8)
    pts_p, pts_m = [], []
    for k in range(61):
        m = -1.5 + 3.0 * k / 60.0
        if abs(m) >= 1.0:
            p_plus = 0.5 * (1.0 + (1.0 if m > 0 else -1.0))
            m_plus = 0.5 * (m + abs(m))
        else:
            p_plus = 0.25 * (m + 1.0) ** 2 * (2.0 - m) + (3.0 / 16.0) * m * (m * m - 1.0) ** 2
            m_plus = 0.25 * (m + 1.0) ** 2 + (1.0 / 8.0) * (m * m - 1.0) ** 2
        px = ox + m * sx
        pts_p.append(f"{px:.1f},{oy - p_plus * sy:.1f}")
        pts_m.append(f"{px:.1f},{oy - m_plus * sy:.1f}")

    out.append(f'  <polyline fill="none" stroke="#2563eb" stroke-width="2.2" points="{" ".join(pts_p)}"/>')
    out.append(f'  <polyline fill="none" stroke="#dc2626" stroke-width="2.2" points="{" ".join(pts_m)}"/>')
    out.append('  <line x1="440" y1="115" x2="462" y2="115" stroke="#2563eb" stroke-width="2.2"/>')
    out.append('  <text class="small" x="468" y="119">P+(M) (5th-order, α=3/16)</text>')
    out.append('  <line x1="440" y1="133" x2="462" y2="133" stroke="#dc2626" stroke-width="2.2"/>')
    out.append('  <text class="small" x="468" y="137">M+(M) (4th-order, β=1/8)</text>')
    out.append('  <text class="mono" x="436" y="286">Harten Entropy Fix applied if λ_L &lt; 0 &lt; λ_R</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def gen_mpm_cycle_svg() -> str:
    w, h = 820, 320
    out = [svg_header(w, h, "MPM P2G-Grid-G2P Symplectic Cycle and Shape Functions")]
    out.append('  <text class="title" x="24" y="28">Material Point Method (MPM): Symplectic Step &amp; C0/C1/C2 Shape Functions</text>')

    # Left Panel: P2G -> Grid -> G2P Cycle
    out.append('  <rect class="panel" x="20" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="34" y="66">1. Symplectic P2G → Grid → G2P Cycle (APIC / FLIP)</text>')

    boxes = [
        (45, 86, 155, 58, "#eff6ff", "#2563eb", "1. P2G Scatter", "m_i = ∑ N_ip m_p\n(mv)_i = ∑ N_ip m_p (v_p + B_p Δx)"),
        (220, 86, 160, 58, "#fef2f2", "#dc2626", "2. Grid Forces &amp; BCs", "f_i = f_ext - ∑ V_p σ_p ∇N_ip\nBardenhagen Contact"),
        (220, 174, 160, 58, "#f0fdf4", "#16a34a", "3. Grid Leapfrog", "v_i^{n+1/2} = v_i + (f_i/m_i) Δt\nm_i &lt; 1e-8 m_ref Guard"),
        (45, 174, 155, 58, "#faf5ff", "#9333ea", "4. G2P &amp; Stress", "v_p, B_p, F_p^{n+1}, Cayley R\nConstitutive Return Map"),
    ]
    for bx, by, bw, bh, fill, stroke, hdr, body in boxes:
        out.append(f'  <rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        out.append(f'  <text class="subtitle" x="{bx + 10}" y="{by + 18}">{hdr}</text>')
        for idx, line in enumerate(body.split("\n")):
            out.append(f'  <text class="small" x="{bx + 10}" y="{by + 34 + idx * 14}">{line}</text>')

    # Arrows connecting boxes
    out.append('  <line x1="200" y1="115" x2="218" y2="115" stroke="#1e293b" stroke-width="1.6" marker-end="url(#arrow)"/>')
    out.append('  <line x1="300" y1="144" x2="300" y2="172" stroke="#1e293b" stroke-width="1.6" marker-end="url(#arrow)"/>')
    out.append('  <line x1="220" y1="203" x2="202" y2="203" stroke="#1e293b" stroke-width="1.6" marker-end="url(#arrow)"/>')
    out.append('  <line x1="122" y1="174" x2="122" y2="146" stroke="#1e293b" stroke-width="1.6" marker-end="url(#arrow)"/>')
    out.append('  <text class="mono" x="34" y="266">Initial-Contact Tie: v_a + B_a(x_b - x_a) == v_b</text>')
    out.append('  <text class="mono" x="34" y="284">J = max(1e-4, det(F)) | 8×8×8 Sparse Brick Tiles</text>')

    # Right Panel: Shape Function Comparison
    out.append('  <rect class="panel" x="420" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="434" y="66">2. 1D Basis Functions N(ξ) (ξ = (x - x_i)/h)</text>')
    ox, oy = 610, 248
    sx, sy = 78, 145
    out.append(f'  <line class="axis" x1="445" y1="{oy}" x2="778" y2="{oy}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{ox}" y1="{oy}" x2="{ox}" y2="85" marker-end="url(#arrow)"/>')
    for tick in [-2, -1, 0, 1, 2]:
        tx = ox + tick * sx
        out.append(f'  <line class="grid" x1="{tx}" y1="90" x2="{tx}" y2="{oy}"/>')
        out.append(f'  <text class="small" x="{tx - 4}" y="{oy + 14}">{tick}</text>')

    pts_lin, pts_qbs, pts_cbs = [], [], []
    for k in range(121):
        r = -2.0 + 4.0 * k / 120.0
        ar = abs(r)
        n_lin = max(0.0, 1.0 - ar)
        if ar < 0.5:
            n_qbs = 0.75 - ar * ar
        elif ar < 1.5:
            n_qbs = 0.5 * (1.5 - ar) ** 2
        else:
            n_qbs = 0.0
        if ar < 1.0:
            n_cbs = 2.0 / 3.0 - ar * ar + 0.5 * ar ** 3
        elif ar < 2.0:
            n_cbs = (2.0 - ar) ** 3 / 6.0
        else:
            n_cbs = 0.0
        px = ox + r * sx
        pts_lin.append(f"{px:.1f},{oy - n_lin * sy:.1f}")
        pts_qbs.append(f"{px:.1f},{oy - n_qbs * sy:.1f}")
        pts_cbs.append(f"{px:.1f},{oy - n_cbs * sy:.1f}")

    out.append(f'  <polyline fill="none" stroke="#64748b" stroke-width="1.8" stroke-dasharray="4 3" points="{" ".join(pts_lin)}"/>')
    out.append(f'  <polyline fill="none" stroke="#2563eb" stroke-width="2.2" points="{" ".join(pts_qbs)}"/>')
    out.append(f'  <polyline fill="none" stroke="#dc2626" stroke-width="2.2" points="{" ".join(pts_cbs)}"/>')

    out.append('  <line x1="436" y1="96" x2="458" y2="96" stroke="#64748b" stroke-width="1.8" stroke-dasharray="4 3"/>')
    out.append('  <text class="small" x="464" y="100">Linear (C0, support ±1h)</text>')
    out.append('  <line x1="436" y1="113" x2="458" y2="113" stroke="#2563eb" stroke-width="2.2"/>')
    out.append('  <text class="small" x="464" y="117">Quadratic B-Spline (C1, ±1.5h)</text>')
    out.append('  <line x1="436" y1="130" x2="458" y2="130" stroke="#dc2626" stroke-width="2.2"/>')
    out.append('  <text class="small" x="464" y="134">Cubic B-Spline (C2, ±2h)</text>')
    out.append('  <text class="mono" x="434" y="284">Also supported: GIMP (lp[3]) &amp; Radial MLS (Wendland C2)</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def gen_fem_elements_svg() -> str:
    w, h = 820, 300
    out = [svg_header(w, h, "FEM 3D Element Topologies and Integration Formulations")]
    out.append('  <text class="title" x="24" y="28">Lagrangian 3D FEM Element Library &amp; Locking / Hourglass Formulations</text>')

    cards = [
        (20, "Hex8 (SRI / B-bar / FB)", "8 nodes | 1-pt FB/KF or 8-pt SRI", "No volumetric locking (B-bar)"),
        (220, "Tet4-ANP", "4 nodes | Avg Nodal Pressure", "Bonet-Burton smoothed J_nodal"),
        (420, "Wedge6 &amp; Pyramid5", "6 / 5 nodes | Hex-Tet transition", "2-pt Gauss / Dual-Tet split"),
        (620, "Shell4BT &amp; CZM8", "4-node Co-Rotational / 8-node CZM", "Simpson layers + Option C split"),
    ]
    for cx, title, l1, l2 in cards:
        out.append(f'  <rect class="panel" x="{cx}" y="46" width="180" height="234" rx="6"/>')
        out.append(f'  <text class="subtitle" x="{cx + 12}" y="68">{title}</text>')
        out.append(f'  <text class="small" x="{cx + 12}" y="246">{l1}</text>')
        out.append(f'  <text class="small" x="{cx + 12}" y="262">{l2}</text>')

    # Draw Hex8 wireframe (card 1: cx=20)
    out.append('  <polygon points="65,120 135,120 135,190 65,190" fill="#eff6ff" fill-opacity="0.5" stroke="#2563eb" stroke-width="1.6"/>')
    out.append('  <polygon points="90,95 160,95 160,165 90,165" fill="none" stroke="#2563eb" stroke-width="1.2" stroke-dasharray="3 2"/>')
    for x1, y1, x2, y2 in [(65,120,90,95), (135,120,160,95), (135,190,160,165), (65,190,90,165)]:
        out.append(f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#2563eb" stroke-width="1.3"/>')
    out.append('  <circle cx="112" cy="142" r="4.5" fill="#dc2626"/>')
    out.append('  <text class="small" x="120" y="146" fill="#dc2626">GP</text>')

    # Draw Tet4-ANP (card 2: cx=220)
    out.append('  <polygon points="260,195 355,195 310,100" fill="#f0fdf4" fill-opacity="0.6" stroke="#16a34a" stroke-width="1.6"/>')
    out.append('  <line x1="260" y1="195" x2="325" y2="165" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3 2"/>')
    out.append('  <line x1="355" y1="195" x2="325" y2="165" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3 2"/>')
    out.append('  <line x1="310" y1="100" x2="325" y2="165" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3 2"/>')
    for nx, ny in [(260,195), (355,195), (310,100), (325,165)]:
        out.append(f'  <circle cx="{nx}" cy="{ny}" r="4" fill="#16a34a"/>')

    # Draw Wedge6 (card 3: cx=420)
    out.append('  <polygon points="465,195 545,195 505,155" fill="#faf5ff" fill-opacity="0.6" stroke="#9333ea" stroke-width="1.5"/>')
    out.append('  <polygon points="465,125 545,125 505,85" fill="#faf5ff" fill-opacity="0.4" stroke="#9333ea" stroke-width="1.5"/>')
    for x1, y1, x2, y2 in [(465,195,465,125), (545,195,545,125), (505,155,505,85)]:
        out.append(f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#9333ea" stroke-width="1.4"/>')

    # Draw Shell4BT with triad (card 4: cx=620)
    out.append('  <polygon points="650,175 725,185 765,135 690,125" fill="#fff7ed" stroke="#ea580c" stroke-width="1.6"/>')
    out.append('  <line x1="708" y1="155" x2="708" y2="105" stroke="#dc2626" stroke-width="1.8" marker-end="url(#arrow-red)"/>')
    out.append('  <line x1="708" y1="155" x2="748" y2="160" stroke="#2563eb" stroke-width="1.6" marker-end="url(#arrow-blue)"/>')
    out.append('  <text class="small" x="714" y="112" fill="#dc2626">e3 (n)</text>')
    out.append('  <text class="small" x="750" y="164" fill="#2563eb">e1</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def gen_eos_curves_svg() -> str:
    w, h = 820, 320
    out = [svg_header(w, h, "JWL Detonation Isentrope and Tait Water EOS Curves")]
    out.append('  <text class="title" x="24" y="28">Equations of State: JWL Detonation Products &amp; Tait Water Compression</text>')

    # Left: JWL TNT Isentrope (V = rho0/rho from 0.7 to 4.0)
    out.append('  <rect class="panel" x="20" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="34" y="66">1. JWL Product Isentrope (TNT, ρ_0 = 1630 kg/m³)</text>')
    x0, y0, pw, ph = 70, 250, 305, 160
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0 + pw}" y2="{y0}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0}" y2="{y0 - ph}" marker-end="url(#arrow)"/>')
    out.append(f'  <text class="small" x="{x0 + pw - 60}" y="{y0 + 18}">V = ρ_0 / ρ</text>')
    out.append(f'  <text class="small" x="28" y="{y0 - ph + 10}">p (GPa)</text>')

    # TNT JWL params: A=371.2 GPa, B=3.231 GPa, R1=4.15, R2=0.95, w=0.30, E0=7.0 GPa
    A, B, R1, R2, om, E0 = 371.2, 3.231, 4.15, 0.95, 0.30, 7.0
    pts_jwl = []
    for k in range(60):
        V = 0.75 + 3.25 * k / 59.0
        p = A * math.exp(-R1 * V) + B * math.exp(-R2 * V) + (om * E0) / (V ** (1.0 + om))
        p_clamped = min(p, 40.0)
        px = x0 + ((V - 0.75) / 3.25) * (pw - 15)
        py = y0 - (p_clamped / 40.0) * (ph - 10)
        pts_jwl.append(f"{px:.1f},{py:.1f}")
    out.append(f'  <polyline fill="none" stroke="#dc2626" stroke-width="2.4" points="{" ".join(pts_jwl)}"/>')
    out.append(f'  <text class="small" x="155" y="120" fill="#dc2626">p_s(V) = A e^(-R1 V) + B e^(-R2 V) + C V^(-(1+ω))</text>')
    out.append('  <text class="mono" x="34" y="286">V_CJ ≈ 0.73 | P_CJ ≈ 21.0 GPa | D_CJ = 6930 m/s</text>')

    # Right: Tait Water EOS
    out.append('  <rect class="panel" x="420" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="434" y="66">2. Tait Water EOS (ρ_0 = 1000 kg/m³, γ = 7.15)</text>')
    x0, y0, pw, ph = 475, 250, 300, 160
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0 + pw}" y2="{y0}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0}" y2="{y0 - ph}" marker-end="url(#arrow)"/>')
    out.append(f'  <text class="small" x="{x0 + pw - 55}" y="{y0 + 18}">ρ / ρ_0</text>')
    out.append(f'  <text class="small" x="428" y="{y0 - ph + 10}">p (MPa)</text>')

    pts_tait = []
    B_tait, g_tait = 303.9, 7.15  # MPa
    for k in range(60):
        rr = 0.99 + 0.21 * k / 59.0
        p = B_tait * (rr ** g_tait - 1.0) + 0.101325
        p_clamped = max(0.0, min(p, 800.0))
        px = x0 + ((rr - 0.99) / 0.21) * (pw - 15)
        py = y0 - (p_clamped / 800.0) * (ph - 10)
        pts_tait.append(f"{px:.1f},{py:.1f}")
    out.append(f'  <polyline fill="none" stroke="#2563eb" stroke-width="2.4" points="{" ".join(pts_tait)}"/>')
    out.append('  <text class="small" x="490" y="130" fill="#2563eb">p = B ((ρ/ρ_0)^7.15 - 1) + p_0</text>')
    out.append('  <text class="mono" x="434" y="286">Variants: 0=Isentropic, 1=Caloric, 2=Hugoniot</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def gen_constitutive_curves_svg() -> str:
    w, h = 820, 320
    out = [svg_header(w, h, "Johnson-Cook Viscoplasticity and CDP Cyclic Crack Closure")]
    out.append('  <text class="title" x="24" y="28">Solid Constitutive Response: Johnson-Cook Hardening &amp; CDP Unilateral Closure</text>')

    # Left: Johnson-Cook at 3 strain rates (1/s, 1e3/s, 1e5/s)
    out.append('  <rect class="panel" x="20" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="34" y="66">1. Johnson-Cook Rate Hardening (4340 Steel)</text>')
    x0, y0, pw, ph = 70, 250, 305, 160
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0 + pw}" y2="{y0}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{x0}" y1="{y0}" x2="{x0}" y2="{y0 - ph}" marker-end="url(#arrow)"/>')
    out.append(f'  <text class="small" x="{x0 + pw - 75}" y="{y0 + 18}">Plastic Strain ε_p</text>')
    out.append(f'  <text class="small" x="28" y="{y0 - ph + 10}">σ_y (MPa)</text>')

    A_jc, B_jc, n_jc, C_jc = 792.0, 510.0, 0.26, 0.014
    rates = [(1.0, "#64748b", "1 s⁻¹"), (1000.0, "#2563eb", "10³ s⁻¹"), (100000.0, "#dc2626", "10⁵ s⁻¹")]
    for idx, (edot, col, lbl) in enumerate(rates):
        pts = []
        for k in range(50):
            ep = 0.5 * k / 49.0
            sy = (A_jc + B_jc * (ep ** n_jc)) * (1.0 + C_jc * math.log(max(1.0, edot)))
            px = x0 + (ep / 0.5) * (pw - 15)
            py = y0 - (sy / 1500.0) * (ph - 10)
            pts.append(f"{px:.1f},{py:.1f}")
        out.append(f'  <polyline fill="none" stroke="{col}" stroke-width="2.2" points="{" ".join(pts)}"/>')
        out.append(f'  <text class="small" x="315" y="{145 - idx * 18}" fill="{col}">{lbl}</text>')
    out.append('  <text class="mono" x="34" y="286">σ_y = (A + B ε_p^n)(1 + C ln ε̇*)(1 - T*^m)</text>')

    # Right: CDP Uniaxial Cyclic Crack Closure Schematic
    out.append('  <rect class="panel" x="420" y="44" width="380" height="256" rx="6"/>')
    out.append('  <text class="subtitle" x="434" y="66">2. CDP Unilateral Crack Closure (Tension → Compression)</text>')
    ox, oy = 610, 175
    out.append(f'  <line class="axis" x1="450" y1="{oy}" x2="775" y2="{oy}" marker-end="url(#arrow)"/>')
    out.append(f'  <line class="axis" x1="{ox}" y1="260" x2="{ox}" y2="85" marker-end="url(#arrow)"/>')
    out.append('  <text class="small" x="760" y="192">ε</text>')
    out.append('  <text class="small" x="616" y="92">σ</text>')
    # Tension softening + unloading + stiffness recovery in compression
    cdp_pts = f"{ox},{oy} {ox + 35},{oy - 45} {ox + 95},{oy - 14} {ox},{oy} {ox - 75},{oy + 75}"
    out.append(f'  <polyline fill="none" stroke="#16a34a" stroke-width="2.3" points="{cdp_pts}"/>')
    out.append('  <text class="small" x="655" y="118" fill="#16a34a">Tensile cracking (d_t)</text>')
    out.append('  <text class="small" x="455" y="242" fill="#16a34a">Stiffness recovered (1 - D = 1)</text>')
    out.append('  <text class="mono" x="434" y="286">Spectral projection preserves compressive bulk modulus</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def gen_fsi_daa_svg() -> str:
    w, h = 820, 290
    out = [svg_header(w, h, "Two-Way FSI Coupling and UNDEX DAA1 Schematic")]
    out.append('  <text class="title" x="24" y="28">Fluid-Structure Interaction (FSI) &amp; UNDEX Doubly Asymptotic Approximation (DAA)</text>')

    # Left: Two-Way CFD-FEM/MPM FSI
    out.append('  <rect class="panel" x="20" y="44" width="380" height="228" rx="6"/>')
    out.append('  <text class="subtitle" x="34" y="66">1. Two-Way Immersed / Ray-Marched FSI</text>')
    out.append('  <rect x="40" y="88" width="340" height="140" rx="4" fill="#eff6ff" stroke="#93c5fd"/>')
    out.append('  <polygon points="155,110 265,110 265,205 155,205" fill="#e2e8f0" stroke="#334155" stroke-width="1.8"/>')
    out.append('  <text class="label" x="172" y="160">Solid (FEM/MPM)</text>')
    out.append('  <line x1="85" y1="155" x2="150" y2="155" stroke="#dc2626" stroke-width="2" marker-end="url(#arrow-red)"/>')
    out.append('  <text class="small" x="46" y="146" fill="#dc2626">Ray-marched</text>')
    out.append('  <text class="small" x="46" y="159" fill="#dc2626">p_over (2×2 GP)</text>')
    out.append('  <line x1="265" y1="138" x2="320" y2="138" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow-blue)"/>')
    out.append('  <text class="small" x="272" y="128" fill="#2563eb">v_solid mask</text>')
    out.append('  <text class="mono" x="34" y="254">Uncovering: 26-cell IDW + Vacuum Cavity Floor</text>')

    # Right: DAA1 + Geers-Hunter Bubble
    out.append('  <rect class="panel" x="420" y="44" width="380" height="228" rx="6"/>')
    out.append('  <text class="subtitle" x="434" y="66">2. UNDEX DAA1 + 4-DOF Bubble + Cavitation</text>')
    out.append('  <rect x="440" y="88" width="340" height="140" rx="4" fill="#ecfeff" stroke="#67e8f9"/>')
    out.append('  <circle cx="520" cy="172" r="32" fill="#fef3c7" stroke="#d97706" stroke-width="1.8"/>')
    out.append('  <text class="small" x="492" y="176">Bubble R(t)</text>')
    out.append('  <path d="M 556 156 A 48 48 0 0 1 556 188" fill="none" stroke="#dc2626" stroke-width="1.6"/>')
    out.append('  <path d="M 566 146 A 62 62 0 0 1 566 198" fill="none" stroke="#dc2626" stroke-width="1.4" stroke-dasharray="3 2"/>')
    out.append('  <rect x="630" y="110" width="125" height="90" rx="6" fill="#cbd5e1" stroke="#334155" stroke-width="1.8"/>')
    out.append('  <text class="label" x="646" y="158">Wet Hull Facets</text>')
    out.append('  <text class="small" x="638" y="175">(H-Matrix M_added)</text>')
    out.append('  <text class="mono" x="434" y="254">p_total &lt; P_CAV (-100 kPa) ⇒ Bleich-Sandler Cutoff</text>')

    out.append('</svg>\n')
    return "\n".join(out)


def generate_all_figures() -> List[Path]:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    figs = {
        "hllc_ausm_riemann_fan.svg": gen_riemann_fan_svg(),
        "mpm_p2g_g2p_cycle.svg": gen_mpm_cycle_svg(),
        "fem_element_topologies.svg": gen_fem_elements_svg(),
        "eos_jwl_tait_curves.svg": gen_eos_curves_svg(),
        "constitutive_jc_cdp_curves.svg": gen_constitutive_curves_svg(),
        "fsi_daa_coupling_schematic.svg": gen_fsi_daa_svg(),
    }
    written = []
    for name, content in figs.items():
        p = FIGURES_DIR / name
        p.write_text(content, encoding="utf-8")
        written.append(p)
    return written


# ---------------------------------------------------------------------------
# 2. Frontend Schema Extraction (Appendix A)
# ---------------------------------------------------------------------------

def extract_node_schemas() -> str:
    """Parse frontend/src/parameter-definitions.ts and state-manager.ts for Appendix A."""
    if not PARAM_DEFS_TS.exists():
        return "_Error: parameter-definitions.ts not found._"

    text = PARAM_DEFS_TS.read_text(encoding="utf-8")

    # Extract NODE_DEFINITIONS keys, titles, categories, and shortDesc
    node_defs_match = re.search(
        r"export const NODE_DEFINITIONS[^=]*=\s*\{(.*?)\n\};", text, re.S
    )
    node_entries: List[Tuple[str, str, str, str]] = []
    if node_defs_match:
        block = node_defs_match.group(1)
        for m in re.finditer(
            r"^\s{4}'?(\w+)'?:\s*\{(.*?)\n\s{4}\},?", block, re.M | re.S
        ):
            ntype = m.group(1)
            body = m.group(2)
            title_m = re.search(r"title:\s*'([^']*)'", body)
            cat_m = re.search(r"category:\s*'([^']*)'", body)
            desc_m = re.search(r"shortDesc:\s*'([^']*)'", body)
            title = title_m.group(1) if title_m else ntype
            cat = cat_m.group(1) if cat_m else "General"
            desc = desc_m.group(1) if desc_m else ""
            node_entries.append((ntype, title, cat, desc))

    # Extract PARAMETER_DEFINITIONS entries
    param_defs_match = re.search(
        r"export const PARAMETER_DEFINITIONS[^=]*=\s*\{(.*?)\n\};", text, re.S
    )
    param_entries: List[Tuple[str, str, str, str, str, str]] = []
    if param_defs_match:
        pblock = param_defs_match.group(1)
        for m in re.finditer(
            r"^\s{4}'?(\w+)'?:\s*\{(.*?)\n\s{4}\},?", pblock, re.M | re.S
        ):
            pkey = m.group(1)
            pbody = m.group(2)
            lbl_m = re.search(r"label:\s*'([^']*)'", pbody)
            cat_m = re.search(r"category:\s*'([^']*)'", pbody)
            unit_m = re.search(r"unit:\s*'([^']*)'", pbody)
            def_m = re.search(r"defaultVal:\s*([^\n,]+)", pbody)
            sum_m = re.search(r"shortDesc:\s*'([^']*)'", pbody)
            lbl = lbl_m.group(1) if lbl_m else pkey
            pcat = cat_m.group(1) if cat_m else "General"
            unit = unit_m.group(1) if unit_m else "—"
            dval = def_m.group(1).strip() if def_m else "—"
            summary = sum_m.group(1) if sum_m else ""
            param_entries.append((pkey, lbl, pcat, unit, dval, summary))

    # Extract NODE_DEFAULT_PARAMETERS from state-manager.ts
    node_defaults: List[Tuple[str, List[Tuple[str, str]]]] = []
    if STATE_MGR_TS.exists():
        sm_text = STATE_MGR_TS.read_text(encoding="utf-8")
        nd_match = re.search(
            r"export const NODE_DEFAULT_PARAMETERS[^=]*=\s*\{(.*?)\n\};", sm_text, re.S
        )
        if nd_match:
            nd_block = nd_match.group(1)
            for m in re.finditer(
                r"^\s{4}'?(\w+)'?:\s*\{(.*?)\n\s{4}\},?", nd_block, re.M | re.S
            ):
                ntype = m.group(1)
                nbody = m.group(2)
                kv_list: List[Tuple[str, str]] = []
                for km in re.finditer(r"^\s{8}(\w+):\s*([^\n]+)", nbody, re.M):
                    k = km.group(1)
                    v = km.group(2).strip().rstrip(",")
                    kv_list.append((k, v))
                node_defaults.append((ntype, kv_list))

    lines = [
        f"_Auto-synchronized from `frontend/src/parameter-definitions.ts` and `frontend/src/state-manager.ts` "
        f"({len(node_entries)} node types, {len(param_entries)} documented parameters, {len(node_defaults)} default node schemas)._\n",
        "### A.1 Registered UI Node Types\n",
        "| Node Type | Display Title | Functional Category | Summary |",
        "| :--- | :--- | :--- | :--- |",
    ]
    for ntype, title, cat, desc in node_entries:
        safe_desc = desc.replace("|", "\\|")
        lines.append(f"| `{ntype}` | {title} | {cat} | {safe_desc} |")

    lines.append("\n### A.2 Master Parameter Registry\n")
    lines.append("| Parameter Key | Label | Category | Unit | Default | Summary |")
    lines.append("| :--- | :--- | :--- | :---: | :---: | :--- |")
    for pkey, lbl, pcat, unit, dval, summary in param_entries:
        safe_sum = summary.replace("|", "\\|")
        safe_def = dval.replace("|", "\\|")
        lines.append(f"| `{pkey}` | {lbl} | {pcat} | `{unit or '—'}` | `{safe_def}` | {safe_sum} |")

    if node_defaults:
        lines.append("\n### A.3 Per-Node Default Parameter Schemas (`state-manager.ts`)\n")
        lines.append("| Node Type | Default Parameters (`key = default`) |")
        lines.append("| :--- | :--- |")
        for ntype, kv_list in node_defaults:
            formatted = ", ".join(f"`{k} = {v}`" for k, v in kv_list).replace("|", "\\|")
            lines.append(f"| `{ntype}` | {formatted} |")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 3. V&V Summary Sync & Git Stamp
# ---------------------------------------------------------------------------

def extract_vv_summary() -> str:
    if not VV_MANUAL.exists():
        return "_VERIFICATION_MANUAL.md not found._"
    text = VV_MANUAL.read_text(encoding="utf-8")
    m = re.search(
        r"\| Total Benchmarks \|.*?\n\| :---.*?\n\|([^\n]+)\|", text, re.S
    )
    if not m:
        return "_Verification summary table not found in VERIFICATION_MANUAL.md._"
    cols = [c.strip().replace("**", "") for c in m.group(1).split("|")]
    if len(cols) >= 5:
        return (
            f"| Total Benchmarks | Verified & Passed | Pending Integration | Failed | Active Pass Rate |\n"
            f"| :---: | :---: | :---: | :---: | :---: |\n"
            f"| **{cols[0]}** | **{cols[1]}** | **{cols[2]}** | **{cols[3]}** | **{cols[4]}** |"
        )
    return "_Could not parse verification summary._"


def get_git_stamp() -> str:
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True
        ).strip()
        date = subprocess.check_output(
            ["git", "log", "-1", "--format=%cs"], cwd=REPO_ROOT, text=True
        ).strip()
        return f"**Last Verified Against Commit:** `{sha}` ({date})"
    except Exception:
        return "**Last Verified Against Commit:** `unknown`"


def replace_block(doc: str, tag: str, new_body: str) -> str:
    begin = f"<!-- BEGIN_{tag} -->"
    end = f"<!-- END_{tag} -->"
    pattern = re.compile(
        re.escape(begin) + r".*?" + re.escape(end), re.S
    )
    replacement = f"{begin}\n{new_body}\n{end}"
    if pattern.search(doc):
        return pattern.sub(replacement, doc, count=1)
    return doc


# ---------------------------------------------------------------------------
# 4. Freshness, Citation & Directive 7 Auditor (--check)
# ---------------------------------------------------------------------------

def run_checks() -> int:
    errors: List[str] = []
    if not THEORY_MANUAL.exists():
        print("ERROR: THEORY_MANUAL.md does not exist.", file=sys.stderr)
        return 1

    text = THEORY_MANUAL.read_text(encoding="utf-8")

    # 1. Check Directive 7: No raw LaTeX delimiters/commands
    latex_patterns = [
        (r"\$\$", "Raw LaTeX display math '$$'"),
        (r"\\\(", "Raw LaTeX inline '\\('"),
        (r"\\\)", "Raw LaTeX inline '\\)'"),
        (r"\\\[", "Raw LaTeX display '\\['"),
        (r"\\\]", "Raw LaTeX display '\\]'"),
        (r"\\frac\b", "Raw LaTeX '\\frac'"),
        (r"\\mathcal\b", "Raw LaTeX '\\mathcal'"),
    ]
    for pat, desc in latex_patterns:
        if re.search(pat, text):
            errors.append(f"Directive 7 violation: {desc} found in THEORY_MANUAL.md")

    # 2. Check all SVG figures and file:// links exist
    for img_m in re.finditer(r"!\[[^\]]*\]\(([^)]+\.svg)\)", text):
        rel_path = img_m.group(1)
        if not (REPO_ROOT / rel_path).exists():
            errors.append(f"Missing figure file: {rel_path}")

    for file_m in re.finditer(r"file://(/[^)#\s]+)", text):
        fpath = Path(file_m.group(1))
        if not fpath.exists():
            errors.append(f"Broken file:// link in THEORY_MANUAL.md: {fpath}")

    # 3. Check inline citations [Key] resolve to References section
    ref_sec_m = re.search(r"^##\s+.*References", text, re.M)
    if not ref_sec_m:
        errors.append("Missing References section in THEORY_MANUAL.md")
    else:
        body_part = text[:ref_sec_m.start()]
        ref_part = text[ref_sec_m.start():]
        defined_keys = set(re.findall(r"^\s*-\s+\*\*\[([A-Za-z0-9_:-]+)\]\*\*", ref_part, re.M))
        used_keys = set(re.findall(r"\[([A-Z][A-Za-z0-9_:-]{2,})\](?!\()", body_part))
        # Filter out markdown callout tags and status tags
        used_keys -= {"NOTE", "IMPORTANT", "WARNING", "TIP", "CAUTION", "PENDING", "PENDING INTEGRATION"}
        dangling = sorted(used_keys - defined_keys)
        if dangling:
            errors.append(f"Dangling citation keys not in References: {', '.join(dangling)}")

    # 4. Check all node types in parameter-definitions.ts appear in THEORY_MANUAL.md
    if PARAM_DEFS_TS.exists():
        p_text = PARAM_DEFS_TS.read_text(encoding="utf-8")
        m = re.search(r"export const NODE_DEFINITIONS[^=]*=\s*\{(.*?)\n\};", p_text, re.S)
        if m:
            nodes = re.findall(r"^\s{4}'?(\w+)'?:\s*\{", m.group(1), re.M)
            missing_nodes = [n for n in nodes if f"`{n}`" not in text]
            if missing_nodes:
                errors.append(f"Undocumented UI node types: {', '.join(missing_nodes)}")

    if errors:
        print("THEORY MANUAL AUDIT FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print("THEORY MANUAL AUDIT PASSED: 0 errors (citations, figures, file:// links, Directive 7, node coverage verified).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="BlastDaemon Living Theory Manual Tool")
    parser.add_argument("--update", action="store_true", help="Regenerate SVG figures and sync auto-generated sections")
    parser.add_argument("--check", action="store_true", help="Audit citations, figures, Directive 7, and node coverage")
    args = parser.parse_args()

    if not args.update and not args.check:
        args.update = True

    if args.update:
        figs = generate_all_figures()
        print(f"Generated {len(figs)} SVG figures in {FIGURES_DIR.relative_to(REPO_ROOT)}")
        if THEORY_MANUAL.exists():
            doc = THEORY_MANUAL.read_text(encoding="utf-8")
            doc = replace_block(doc, "AUTO_STAMP", get_git_stamp())
            doc = replace_block(doc, "AUTO_VV_SUMMARY", extract_vv_summary())
            doc = replace_block(doc, "AUTO_NODE_REFERENCE", extract_node_schemas())
            THEORY_MANUAL.write_text(doc, encoding="utf-8")
            print(f"Synchronized {THEORY_MANUAL.relative_to(REPO_ROOT)}")

    if args.check:
        return run_checks()

    return 0


if __name__ == "__main__":
    sys.exit(main())
