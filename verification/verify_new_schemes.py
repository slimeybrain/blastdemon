import subprocess
import json
import struct
import sys
import os
import time
import numpy as np

def run_simulation(device="cpu", flux_scheme="AUSM+", spatial_order=2, temporal_order=2):
    print(f"Running: device={device}, flux={flux_scheme}, spatial={spatial_order}, temporal={temporal_order}")
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
        "flux_scheme": flux_scheme,
        "spatial_order": spatial_order,
        "temporal_order": temporal_order,
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
        "slices": []
    }

    # Send INIT_3D
    proc.stdin.write((json.dumps(init_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    time.sleep(0.1)

    # Disable intermediate telemetry
    proc.stdin.write((json.dumps({"command": "SET_TELEMETRY_RATE", "rate": 1000.0}) + "\n").encode('utf-8'))
    proc.stdin.flush()

    # Send 5 steps
    step_cmd = {
        "command": "STEP_3D",
        "steps": 5,
        "cfl": 0.4
    }
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    masses = []
    energies = []
    
    start_time = time.time()
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        line_str = line.decode('utf-8', errors='ignore').strip()
        if not line_str:
            continue
        
        if line_str.startswith("{"):
            try:
                msg = json.loads(line_str)
                if msg.get("type") == "progress" and msg.get("percent") == 100:
                    proc.stdin.close()
                elif msg.get("type") == "TELEMETRY_3D":
                    if "total_mass" in msg:
                        masses.append(msg["total_mass"])
                    if "total_energy" in msg:
                        energies.append(msg["total_energy"])
            except Exception:
                pass
                
        # Timeout safety
        if time.time() - start_time > 15:
            print("  Timeout reading solver output!")
            proc.terminate()
            break

    proc.wait()
    return masses, energies

if __name__ == "__main__":
    # Test combinations
    combinations = [
        # (device, flux, spatial_order, temporal_order)
        # 1. MUSCL-Hancock
        ("cpu", "AUSM+", 2, 4),
        ("cpu", "Rusanov", 2, 4),
        ("gpu", "AUSM+", 2, 4),
        ("gpu", "Rusanov", 2, 4),
        # 2. ADER-2
        ("cpu", "AUSM+", 2, 5),
        ("cpu", "Rusanov", 2, 5),
        ("gpu", "AUSM+", 2, 5),
        ("gpu", "Rusanov", 2, 5),
        # 3. ADER-3
        ("cpu", "AUSM+", 3, 6),
        ("cpu", "Rusanov", 3, 6),
        ("gpu", "AUSM+", 3, 6),
        ("gpu", "Rusanov", 3, 6),
    ]

    failed = False
    for device, flux, so, to in combinations:
        try:
            masses, energies = run_simulation(device, flux, so, to)
            if not masses or not energies:
                print("  FAILED: No telemetry captured")
                failed = True
                continue
            
            mass_var = np.max(np.abs(np.array(masses) - masses[0]))
            energy_var = np.max(np.abs(np.array(energies) - energies[0]))
            rel_mass_var = mass_var / masses[0]
            rel_energy_var = energy_var / energies[0] if energies[0] != 0 else 0.0
            
            print(f"  Max Mass Variation:   {mass_var:.6e} (relative: {rel_mass_var:.6e})")
            print(f"  Max Energy Variation: {energy_var:.6e} (relative: {rel_energy_var:.6e})")
            
            # Allow slightly higher tolerance for ADER/MUSCL-Hancock due to predictor updates
            if rel_mass_var < 1e-11 and rel_energy_var < 1e-11:
                print("  PASSED")
            else:
                print("  FAILED: Conservation check exceeded tolerance")
                failed = True
        except Exception as e:
            print(f"  FAILED with exception: {e}")
            failed = True

    if failed:
        sys.exit(1)
    else:
        print("ALL NEW TEMPORAL SCHEMES PASSED VERIFICATION!")
        sys.exit(0)
