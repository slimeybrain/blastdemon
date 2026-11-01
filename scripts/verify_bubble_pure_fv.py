#!/usr/bin/env python3
"""Run Harbour_1 simulation in Pure_FV mode and track bubble expansion, collapse, and period.

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

DIAG_PROFILE = re.compile(
    r"\[DIAG3D_PROFILE\]\s+step=(\d+)\s+t=([\d.e+-]+)\s+r_bubble_axis=([\d.e+-]+)(.*)"
)
DIAG_3D = re.compile(
    r"\[DIAG3D\]\s+step=(\d+)\s+t=([\d.e+-]+)\s+dt=([\d.e+-]+)\s+p_max=([\d.e+-]+)\s+p_min=([\d.e+-]+)"
)


def main():
    payload_path = sys.argv[1] if len(sys.argv) > 1 else "scripts/fixtures/harbour_1_pure_fv.json"
    tend_target = float(sys.argv[2]) if len(sys.argv) > 2 else 0.035  # 35 ms
    every = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    solver_bin = "build/BlastSolver"

    with open(payload_path) as f:
        init_json = json.load(f)
    init_line = json.dumps(init_json)

    env = dict(
        os.environ,
        BLAST_DIAG="1",
        BLAST_NO_CAPTURE="1",
        BLAST_DIAG_EVERY=str(every),
        BLAST_DIAG_PROFILE="1",
        BLAST_DIAG_ZC="5.0",
        BLAST_DIAG_CELLS="0",
    )
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
    max_steps = int(tend_target / 2.0e-6) + 2000
    step_cmd = {"command": "STEP_FSI_3D", "steps": max_steps, "cfl": 0.6}
    if "modelId" in init_json:
        step_cmd["modelId"] = init_json["modelId"]
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode("utf-8"))
    proc.stdin.flush()

    trajectory = []
    print(f"{'Step':>7} | {'Time (ms)':>9} | {'R_bubble (m)':>12} | {'p_max (MPa)':>11} | Profile")
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

            m3 = DIAG_3D.search(line)
            if m3:
                last_pmax = float(m3.group(4))

            mp = DIAG_PROFILE.search(line)
            if mp:
                step = int(mp.group(1))
                t_ms = float(mp.group(2)) * 1000.0
                r_bub = float(mp.group(3))
                prof_str = mp.group(4).strip()
                p_max_mpa = last_pmax * 1.0e-6
                trajectory.append((t_ms, r_bub, p_max_mpa, step))
                print(f"{step:7d} | {t_ms:9.3f} | {r_bub:12.4f} | {p_max_mpa:11.2f} | {prof_str}")
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

    if not trajectory:
        print("ERROR: No trajectory data captured.")
        return 1

    r_vals = [pt[1] for pt in trajectory]
    max_r = max(r_vals)
    max_idx = r_vals.index(max_r)
    t_max_r = trajectory[max_idx][0]

    post_max = trajectory[max_idx:]
    min_r = min(pt[1] for pt in post_max)
    min_idx = [pt[1] for pt in post_max].index(min_r) + max_idx
    t_min_r = trajectory[min_idx][0]

    print("\n" + "=" * 80)
    print("BUBBLE OSCILLATION ANALYSIS:")
    print(f"  Initial charge radius:       {init_json.get('charge_radius', 0.09):.4f} m")
    print(f"  Maximum bubble radius R_max: {max_r:.4f} m at t = {t_max_r:.2f} ms")
    print(f"  Willis benchmark R_max:      0.853 m")
    print(f"  Minimum radius (collapse) R_min: {min_r:.4f} m at t = {t_min_r:.2f} ms")
    print(f"  Observed Bubble Period T_bubble: {t_min_r:.2f} ms")
    print(f"  Willis benchmark Period T_bubble: 30.7 ms")
    print("=" * 80)
    return 0


if __name__ == "__main__":
    sys.exit(main())
