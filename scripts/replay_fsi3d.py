#!/usr/bin/env python3
"""Headless replay of a captured UI model through the production BlastSolver worker.

Usage:
  scripts/replay_fsi3d.py [payload.json] [--steps N] [--cfl C] [--solver PATH] [--every K] [--tend T]
    --every K : audit every K-th step (sets BLAST_DIAG_EVERY; use for long runs)
    --tend T  : stop when simulated time reaches T seconds (the step budget is then N)

Feeds the captured INIT_FSI_3D payload (written by the worker as
blast_last_INIT_FSI_3D.json) to the real worker over stdin, issues STEP_FSI_3D,
and audits the [DIAG3D] health lines (enabled with BLAST_DIAG=1).

Pass criteria (no caps, no heuristics - pure observation):
  * at least N steps completed
  * n_nonfinite == 0 and n_gt_1e10 == 0 on every step
  * p_max <= 1e11 Pa (physical ceiling for condensed explosive) on every step
  * dt > 0 and finite; no dt collapse (> 1000x drop from running median)
  * no isolated p_max twitch: p_max(n) > 10x both neighbouring steps and > 1e8 Pa
    (a physical detonation onset rises monotonically over several steps, a twitch spikes and collapses)
  * n_spike == 0 and n_dip == 0 on every step (point-wise 6-neighbour audit of the pressure field)
"""
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time

DIAG = re.compile(r"\[DIAG3D\]\s+(.*)")
KV = re.compile(r"(\w+)=(\S+)")


def main() -> int:
    args = sys.argv[1:]
    payload = None
    steps = 1000
    cfl = None
    every = 1
    tend = None
    solver = "/home/chris/antigrav/blastdemon/backend/build/BlastSolver"
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--steps":
            steps = int(args[i + 1]); i += 2
        elif a == "--cfl":
            cfl = float(args[i + 1]); i += 2
        elif a == "--every":
            every = int(args[i + 1]); i += 2
        elif a == "--tend":
            tend = float(args[i + 1]); i += 2
        elif a == "--solver":
            solver = args[i + 1]; i += 2
        else:
            payload = a; i += 1
    if payload is None:
        payload = "/home/chris/antigrav/blastdemon/build/blast_last_INIT_FSI_3D.json"
    with open(payload) as f:
        init_line = f.read().strip()
    init = json.loads(init_line)
    if cfl is None:
        cfl = float(init.get("cfl", 0.6))

    env = dict(os.environ, BLAST_DIAG="1", BLAST_NO_CAPTURE="1", BLAST_DIAG_EVERY=str(every))
    proc = subprocess.Popen([solver], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, env=env, bufsize=0,
                            cwd=os.path.dirname(os.path.abspath(payload)))
    rows = []
    raw = open(os.environ.get("REPLAY_RAW", "/tmp/replay_raw.txt"), "w")
    done = threading.Event()

    def reader():
        buf = b""
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                txt = line.decode("utf-8", "ignore")
                if "[DIAG3D" in txt:
                    raw.write(txt + "\n"); raw.flush()
                m = DIAG.search(txt) if "[DIAG3D_CELL]" not in txt else None
                if m:
                    rows.append({k: float(v) for k, v in KV.findall(m.group(1))})
                    if len(rows) >= max(1, steps // every) or (tend is not None and rows[-1].get("t", 0.0) >= tend):
                        done.set()
        done.set()

    threading.Thread(target=reader, daemon=True).start()
    proc.stdin.write((init_line + "\n").encode())
    proc.stdin.flush()
    time.sleep(2.0)
    step_cmd = {"command": "STEP_FSI_3D", "steps": steps, "cfl": cfl}
    if "modelId" in init:
        step_cmd["modelId"] = init["modelId"]
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode())
    proc.stdin.flush()
    done.wait(timeout=1800)
    try:
        proc.stdin.close()
        proc.terminate()
    except Exception:
        pass

    fails = []
    if tend is None and len(rows) < steps // every:
        fails.append(f"only {len(rows)}/{steps // every} audited steps completed")
    dts = []
    for r in rows:
        s = int(r.get("step", -1))
        if r.get("n_nonfinite", 0) > 0:
            fails.append(f"step {s}: {int(r['n_nonfinite'])} non-finite cells")
        if r.get("n_gt_1e10", 0) > 0:
            fails.append(f"step {s}: {int(r['n_gt_1e10'])} cells > 1e10 Pa")
        if r.get("p_max", 0) > 1e11:
            fails.append(f"step {s}: p_max={r['p_max']:.3e}")
        dt = r.get("dt", 0)
        if not (dt > 0):
            fails.append(f"step {s}: bad dt={dt}")
        else:
            if len(dts) > 20 and dt < statistics.median(dts) / 1000.0:
                fails.append(f"step {s}: dt collapse {dt:.3e}")
            dts.append(dt)
        if r.get("n_spike", 0) > 0:
            fails.append(f"step {s}: {int(r['n_spike'])} isolated pressure spikes")
        if r.get("n_dip", 0) > 0:
            fails.append(f"step {s}: {int(r['n_dip'])} isolated pressure dips")

    for n in range(1, len(rows) - 1):
        pn = rows[n].get("p_max", 0)
        if pn > 1e8 and pn > 10.0 * max(rows[n - 1].get("p_max", 0), rows[n + 1].get("p_max", 0)):
            fails.append(f"step {int(rows[n].get('step', -1))}: isolated p_max twitch {pn:.3e}")

    if rows:
        pmx = max(r.get("p_max", 0) for r in rows)
        pmn = min(r.get("p_min", 0) for r in rows)
        print(f"steps={len(rows)} p_max(peak)={pmx:.4e} p_min(low)={pmn:.4e} "
              f"dt[min,max]=[{min(dts):.3e},{max(dts):.3e}]" if dts else "no dt")
    for f_ in fails[:40]:
        print("FAIL:", f_)
    print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)} issues)")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
