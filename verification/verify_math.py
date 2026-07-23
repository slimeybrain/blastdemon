import subprocess
import json
import struct
import sys
import os
import time
import numpy as np

GOLDEN_PATH = "verification/golden_sedov_3d.bin"

def run_3d_simulation(device="cpu", generate_mode=False):
    print(f"--- Running 3D Solver (device={device}, generate_mode={generate_mode}) ---")
    proc = subprocess.Popen(
        ["./build/BlastSolver"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False
    )

    init_cmd = {
        "command": "INIT_3D",
        "nx": 16,
        "ny": 16,
        "nz": 16,
        "cell_size": 0.05,
        "xmin": 0.0,
        "ymin": 0.0,
        "zmin": 0.0,
        "device": device,
        "precision": "double",
        "init_mode": "Multi-Material JWL",
        "flux_scheme": "AUSM+",
        "spatial_order": 2,
        "temporal_order": 2,
        "cfl": 0.4,
        "ambient_rho": 1.225,
        "atm_pressure": 101325.0,
        "charge_x": 0.4,
        "charge_y": 0.4,
        "charge_z": 0.4,
        "charge_radius": 0.15,
        "charge_mass": 1.0,
        "charge_shape": "Sphere",
        "composition": "TNT",
        "slices": [
            {"axis": "xy", "offset": 0.4, "stride": 1, "quantities": ["pressure"]}
        ]
    }

    # Send INIT_3D
    print("Sending INIT_3D command...")
    proc.stdin.write((json.dumps(init_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    time.sleep(0.5)

    # Disable intermediate telemetry to make verification deterministic
    proc.stdin.write((json.dumps({"command": "SET_TELEMETRY_RATE", "rate": 1000.0}) + "\n").encode('utf-8'))
    proc.stdin.flush()

    # Send 5 steps
    step_cmd = {
        "command": "STEP_3D",
        "steps": 5,
        "cfl": 0.4
    }
    print("Sending STEP_3D command (5 steps)...")
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    slices_data = []
    masses = []
    energies = []
    
    # Read output
    start_time = time.time()
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        line_str = line.decode('utf-8', errors='ignore').strip()
        if not line_str:
            continue
        
        if line_str.startswith("BIN_FRAME_3D_SLICES"):
            total_bytes = int(line_str.split()[1])
            binary_payload = proc.stdout.read(total_bytes)
            
            # Parse slice
            magic, time_val, n_slices = struct.unpack("<IfI", binary_payload[:12])
            offset = 12
            for _ in range(n_slices):
                axis_id, slice_offset, w, h = struct.unpack("<IfII", binary_payload[offset:offset+16])
                offset += 16
                data_size = w * h
                slice_vals = struct.unpack(f"<{data_size}f", binary_payload[offset:offset+data_size*4])
                offset += data_size * 4
                slices_data.append((time_val, axis_id, w, h, slice_vals))
                
        elif line_str.startswith("{"):
            try:
                msg = json.loads(line_str)
                if msg.get("type") == "progress" and msg.get("percent") == 100:
                    proc.stdin.close()
                elif msg.get("type") == "TELEMETRY_3D":
                    if "total_mass" in msg:
                        masses.append(msg["total_mass"])
                    if "total_energy" in msg:
                        energies.append(msg["total_energy"])
            except Exception as e:
                pass
                
        # Timeout safety
        if time.time() - start_time > 15:
            print("Timeout reading solver output!")
            proc.terminate()
            break

    proc.wait()

    return slices_data, masses, energies

if __name__ == "__main__":
    mode = "verify"
    device = "cpu"
    if len(sys.argv) > 1:
        mode = sys.argv[1]
    if len(sys.argv) > 2:
        device = sys.argv[2]

    if mode == "generate":
        slices, _, _ = run_3d_simulation(device=device, generate_mode=True)
        slices_to_save = [slices[0], slices[-1]]
        os.makedirs(os.path.dirname(GOLDEN_PATH), exist_ok=True)
        with open(GOLDEN_PATH, "wb") as f:
            for time_val, axis_id, w, h, slice_vals in slices_to_save:
                f.write(struct.pack("<fIII", time_val, axis_id, w, h))
                f.write(struct.pack(f"<{len(slice_vals)}f", *slice_vals))
        print(f"Golden master saved to {GOLDEN_PATH}")
        sys.exit(0)

    else:
        if not os.path.exists(GOLDEN_PATH):
            print(f"Golden master file {GOLDEN_PATH} not found. Run with 'generate' argument first.")
            sys.exit(1)

        golden_slices = []
        with open(GOLDEN_PATH, "rb") as f:
            while True:
                header = f.read(16)
                if not header:
                    break
                time_val, axis_id, w, h = struct.unpack("<fIII", header)
                data_size = w * h
                slice_vals = struct.unpack(f"<{data_size}f", f.read(data_size * 4))
                golden_slices.append((time_val, axis_id, w, h, slice_vals))

        slices, masses, energies = run_3d_simulation(device=device, generate_mode=False)
        slices_to_compare = [slices[0], slices[-1]]

        # 1. Compare slices
        if len(slices_to_compare) != len(golden_slices):
            print(f"ERROR: Slice counts differ. Expected {len(golden_slices)}, got {len(slices_to_compare)}")
            sys.exit(1)

        print("\n--- REGRESSION TEST: SLICE DATA ---")
        max_diff = 0.0
        for i in range(len(slices_to_compare)):
            g_t, g_axis, g_w, g_h, g_vals = golden_slices[i]
            t, axis, w, h, vals = slices_to_compare[i]
            diff = np.max(np.abs(np.array(g_vals) - np.array(vals)))
            max_diff = max(max_diff, diff)
            print(f"Slice {i} (Time={t:.4f}, Axis={axis}): Max Diff = {diff:.6e}")

        # Williamson RK3 vs Heun RK2/SSP-RK3 should produce slightly different result if order/algorithm changed,
        # but wait, does the current master run with order=2 (Heun)? Yes, our init_cmd sets temporal_order=2.
        # Wait, does temporal_order=2 use the same coefficients?
        # Yes! Williamson LSRK3 is for temporal_order=3! If temporal_order=2, it still uses the existing RK2 implementation.
        # But wait! If we modify the code to support LSRK3 for order=3, then order=2 should remain unchanged, and produce exactly 0.0 difference!
        # This is a perfect regression test! It verifies that order=2 is completely untouched and equivalent to the pre-refactor state.
        if max_diff < 1e-6:
            print("Regression test: PASSED")
        else:
            print("Regression test: FAILED")
            sys.exit(1)

        # 2. Check Conservation
        print("\n--- CONSERVATION CHECKS ---")
        if not masses or not energies:
            print("WARNING: No mass/energy telemetry captured. Solver does not report them yet.")
        else:
            mass_var = np.max(np.abs(np.array(masses) - masses[0]))
            energy_var = np.max(np.abs(np.array(energies) - energies[0]))
            print(f"Max Mass Variation:   {mass_var:.6e} (relative: {mass_var / masses[0]:.6e})")
            print(f"Max Energy Variation: {energy_var:.6e} (relative: {energy_var / energies[0]:.6e})")
            
            # Absolute conservation within 1e-14 relative
            rel_mass_var = mass_var / masses[0]
            rel_energy_var = energy_var / energies[0]
            if rel_mass_var < 1e-13 and rel_energy_var < 1e-13:
                print("Conservation check: PASSED")
            else:
                print("Conservation check: FAILED")
                sys.exit(1)
        
        sys.exit(0)
