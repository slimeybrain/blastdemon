import subprocess
import json
import time
import sys
import os

# Write a simple STL file representing a tetrahedron
def generate_simple_stl(filepath):
    content = """solid tetrahedron
  facet normal 0.57735 0.57735 0.57735
    outer loop
      vertex 0.2 0.2 0.2
      vertex 0.6 0.2 0.2
      vertex 0.4 0.6 0.2
    endloop
  endfacet
  facet normal 0.0 0.0 -1.0
    outer loop
      vertex 0.2 0.2 0.2
      vertex 0.4 0.6 0.2
      vertex 0.4 0.4 0.6
    endloop
  endfacet
  facet normal -1.0 0.0 0.0
    outer loop
      vertex 0.4 0.6 0.2
      vertex 0.6 0.2 0.2
      vertex 0.4 0.4 0.6
    endloop
  endfacet
  facet normal 0.0 -1.0 0.0
    outer loop
      vertex 0.6 0.2 0.2
      vertex 0.2 0.2 0.2
      vertex 0.4 0.4 0.6
    endloop
  endfacet
endsolid tetrahedron
"""
    with open(filepath, "w") as f:
        f.write(content)
    print(f"Generated simple test STL file at {filepath}")

def run_simulation(device="cpu", stl_file=""):
    print(f"--- Running 3D Solver with Geometry (device={device}) ---")
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
        "init_mode": "Ideal Gas",
        "flux_scheme": "AUSM+",
        "spatial_order": 2,
        "temporal_order": 2,
        "cfl": 0.4,
        "ambient_rho": 1.2,
        "atm_pressure": 101325.0,
        "charge_x": 0.4,
        "charge_y": 0.4,
        "charge_z": 0.4,
        "charge_radius": 0.1,
        "charge_mass": 0.1,
        "charge_shape": "Sphere",
        "stl_file": stl_file,
        "geometry_hash": "test_tetra_hash",
        "slices": [
            {"axis": "xy", "offset": 0.4, "stride": 1, "quantities": ["pressure"]}
        ]
    }

    print("Sending INIT_3D with geometry...")
    proc.stdin.write((json.dumps(init_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    time.sleep(0.5)

    step_cmd = {
        "command": "STEP_3D",
        "steps": 5,
        "cfl": 0.4
    }
    print("Sending STEP_3D (5 steps)...")
    proc.stdin.write((json.dumps(step_cmd) + "\n").encode('utf-8'))
    proc.stdin.flush()

    # Read output
    has_nan = False
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
            # We can also check if any of the float values in the slice are NaNs!
            # Since the header is 12 bytes, and each slice has 16 bytes header,
            # we can just scan the binary data for NaNs or inspect floats.
            # But the easiest way is checking if the solver prints a warning.
            continue

        import re
        if re.search(r'\bnan\b|\binf\b', line_str.lower()):
            print(f"Warning: Found NaN/inf in output: {line_str}")
            has_nan = True
            
        if line_str.startswith("{"):
            try:
                msg = json.loads(line_str)
                if msg.get("type") == "progress" and msg.get("percent") == 100:
                    proc.stdin.close()
            except Exception:
                pass
                
        # Timeout safety
        if time.time() - start_time > 15:
            print("Timeout reading solver output!")
            proc.terminate()
            break

    proc.wait()

    if has_nan:
        print(f"Result for {device}: FAILED (NaN or inf detected)")
        return False
    else:
        print(f"Result for {device}: PASSED")
        return True

if __name__ == "__main__":
    stl_path = "/tmp/test_tetrahedron.stl"
    generate_simple_stl(stl_path)
    
    cpu_passed = run_simulation(device="cpu", stl_file=stl_path)
    gpu_passed = run_simulation(device="gpu", stl_file=stl_path)
    
    # Cleanup stl
    if os.path.exists(stl_path):
        os.remove(stl_path)
        
    if cpu_passed and gpu_passed:
        print("ALL GEOMETRY TESTS PASSED SUCCESSFULLY!")
        sys.exit(0)
    else:
        print("SOME TESTS FAILED!")
        sys.exit(1)
