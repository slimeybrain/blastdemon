#!/usr/bin/env python3
"""Run Harbour_1 simulation and track bubble expansion, collapse, and period.

Evaluates against Willis / Cole underwater explosion benchmark:
  W = 5.0 kg TNT, Depth = 295 m (H = 305.3 m)
  Expected Bubble Period T_bubble ~ 30.7 - 32.0 ms
  Expected Maximum Radius R_max ~ 0.85 m
"""

import json
import os
import re
import subprocess
import sys
import time

DIAG_MPM = re.compile(
    r"\[DIAG3D_MPM\]\s+step=(\d+)\s+t=([\d.e+-]+)\s+gas_n=(\d+)\s+gas_m=([\d.e+-]+)\s+gas_V=([\d.e+-]+)\s+gas_rho=([\d.e+-]+)\s+gas_Jmean=([\d.e+-]+)\s+gas_rmax=([\d.e+-]+)\s+gas_ke=([\d.e+-]+)\s+gas_eint=([\d.e+-]+)\s+water_n=(\d+)\s+water_m=([\d.e+-]+)\s+water_V=([\d.e+-]+)\s+water_Jmin=([\d.e+-]+)\s+water_ke=([\d.e+-]+)"
)
DIAG_3D = re.compile(
    r"\[DIAG3D\]\s+step=(\d+)\s+t=([\d.e+-]+)\s+dt=([\d.e+-]+)\s+p_max=([\d.e+-]+)\s+p_min=([\d.e+-]+)\s+n_nonfinite=(\d+)\s+n_gt_1e10=(\d+)\s+n_gt_1e12=(\d+)\s+mpm_active=(\d+)\s+mpm_vmax=([\d.e+-]+)\s+n_spike=(\d+)\s+n_dip=(\d+)"
)


def main():
    payload_path = sys.argv[1] if len(sys.argv) > 1 else "scripts/fixtures/harbour_1_init_fsi_3d.json"
    tend_target = float(sys.argv[2]) if len(sys.argv) > 2 else 0.035  # 35 ms
    every = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    solver_bin = "backend/build/BlastSolver"

    with open(payload_path) as f:
        init_json = json.load(f)
    init_line = json.dumps(init_json)

    env = dict(os.environ, BLAST_DIAG="1", BLAST_NO_CAPTURE="1", BLAST_DIAG_EVERY=str(every), BLAST_DIAG_PROFILE="1", BLAST_DIAG_CELLS=str(every))
    proc = subprocess.Popen(
        [solver_bin],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        bufsize=0,
    )

    # Issue INIT
    proc.stdin.write((init_line + "\n").encode("utf-8"))
    proc.stdin.flush()
    time.sleep(2.0)

    # Issue STEP
    # 35 ms with dt ~ 2.08e-6 is ~17,000 steps
    max_steps = int(tend_target / 2.0e-6) + 2000
    step_cmd = {"command": "STEP_FSI_3D", "steps": max_steps, "cfl": 0.6}
    if "modelId" in init_json:
        step_cmd["modelId"] = init_json["modelId"]
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode("utf-8"))
    proc.stdin.flush()

    trajectory = []
    print(f"{'Step':>7} | {'Time (ms)':>9} | {'R_bubble (m)':>12} | {'V_gas (m^3)':>12} | {'rho_gas':>8} | {'p_max (MPa)':>11} | {'Water Part':>10}")
    print("-" * 85)

    last_pmax = 0.0
    buf = b""
    while True:
        chunk = proc.stdout.read(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            raw_line, buf = buf.split(b"\n", 1)
            line = raw_line.decode("utf-8", "ignore")
            if "[DIAG3D_PROFILE]" in line or "[DIAG3D_CELL]" in line:
                print(f"  {line}")
                sys.stdout.flush()

            m3 = DIAG_3D.search(line)
            if m3:
                last_pmax = float(m3.group(4))

            m = DIAG_MPM.search(line)
            if m:
                step = int(m.group(1))
                t_ms = float(m.group(2)) * 1000.0
                r_max = float(m.group(8))
                v_gas = float(m.group(5))
                rho_gas = float(m.group(6))
                gas_ke = float(m.group(9))
                water_n = int(m.group(11))
                water_v = float(m.group(13))
                water_jmin = float(m.group(14))
                water_ke = float(m.group(15))
                p_max_mpa = last_pmax * 1.0e-6

                r_vol = (3.0 * v_gas / 3.141592653589793) ** (1.0 / 3.0)
                trajectory.append((t_ms, r_vol, v_gas, rho_gas, p_max_mpa, water_n))
                print(f"{step:7d} | {t_ms:9.3f} | {r_vol:8.4f} | {v_gas:10.4e} | {rho_gas:6.2f} | {p_max_mpa:9.2f} | w_ke={water_ke:8.2e} | g_ke={gas_ke:8.2e} | Jmin={water_jmin:.4f}")
                sys.stdout.flush()

                if t_ms >= tend_target * 1000.0:
                    print(f"\nReached target time {t_ms:.2f} ms >= {tend_target * 1000.0:.2f} ms.")
                    break
        if trajectory and trajectory[-1][0] >= tend_target * 1000.0:
            break

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    # Analyze trajectory
    if not trajectory:
        print("ERROR: No trajectory data captured.")
        return 1

    r_vals = [pt[1] for pt in trajectory]
    max_r = max(r_vals)
    max_idx = r_vals.index(max_r)
    t_max_r = trajectory[max_idx][0]

    # Find subsequent minimum after maximum
    post_max = trajectory[max_idx:]
    min_r = min(pt[1] for pt in post_max)
    min_idx = [pt[1] for pt in post_max].index(min_r) + max_idx
    t_min_r = trajectory[min_idx][0]

    print("\n" + "=" * 80)
    print("BUBBLE OSCILLATION ANALYSIS:")
    print(f"  Maximum bubble radius R_max: {max_r:.4f} m at t = {t_max_r:.2f} ms (V_max = {trajectory[max_idx][2]:.4e} m^3)")
    print(f"  Willis benchmark R_max:      0.853 m")
    print(f"  Minimum radius (collapse) R_min: {min_r:.4f} m at t = {t_min_r:.2f} ms (V_min = {trajectory[min_idx][2]:.4e} m^3)")
    print(f"  Observed Bubble Period T_bubble: {t_min_r:.2f} ms")
    print(f"  Willis benchmark Period T_bubble: 30.7 ms (User expected ~32 ms)")
    print("=" * 80)
    return 0


if __name__ == "__main__":
    sys.exit(main())
