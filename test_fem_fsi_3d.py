import subprocess
import json
import struct
import time
import sys

def test_fem_fsi(device="cpu", precision="single"):
    print(f"==================================================")
    print(f" Testing 3D FV-FEM Coupler: device={device}, precision={precision}")
    print(f"==================================================")

    init_cmd = {
        "command": "INIT_FEM_FSI_3D",
        "modelId": f"test_fem_{device}_{precision}",
        "nx": 32,
        "ny": 32,
        "nz": 32,
        "cell_size": 0.02,
        "xmin": -0.32,
        "ymin": -0.32,
        "zmin": -0.32,
        "device": device,
        "precision": precision,
        "init_mode": "Multi-Material JWL",
        "charge_shape": "Sphere",
        "charge_x": 0.0,
        "charge_y": 0.0,
        "charge_z": 0.15,
        "charge_radius": 0.05,
        "fem_objects": [
            {
                "shape_type": "Box",
                "nx": 6,
                "ny": 6,
                "nz": 6,
                "size_x": 0.1,
                "size_y": 0.1,
                "size_z": 0.1,
                "pos_x": 0.0,
                "pos_y": 0.0,
                "pos_z": 0.0,
                "density": 7850.0,
                "youngs_modulus": 2.1e11,
                "poissons_ratio": 0.3,
                "yield_stress": 4.0e8,
                "hardening_modulus": 1.0e9
            }
        ]
    }

    step_cmd = {
        "command": "STEP_FEM_FSI_3D",
        "modelId": f"test_fem_{device}_{precision}",
        "steps": 10,
        "cfl": 0.30
    }

    terminate_cmd = {
        "command": "TERMINATE_FEM_FSI_3D"
    }

    proc = subprocess.Popen(
        ["./build/BlastSolver"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        bufsize=0
    )

    cmds = (json.dumps(init_cmd) + "\n" + json.dumps(step_cmd) + "\n" + json.dumps(terminate_cmd) + "\n").encode('utf-8')

    try:
        stdout_bytes, stderr_bytes = proc.communicate(input=cmds, timeout=10)
    except Exception as e:
        proc.kill()
        stdout_bytes, stderr_bytes = proc.communicate()

    stdout = stdout_bytes.decode('utf-8', errors='replace')
    stderr = stderr_bytes.decode('utf-8', errors='replace')

    print(f"Solver exit code: {proc.returncode}")
    has_init = "3D Coupled FV-FEM Solver Initialized" in stdout or "3D Coupled FV-FEM Solver Initialized" in stderr or "INIT_FEM_FSI_3D" in stdout
    has_progress = "STEP_FEM_FSI_3D" in stdout
    has_fem_binary = b"BIN_FEM_3D_MESH" in stdout_bytes
    print(f"Init detected: {has_init}")
    print(f"Progress detected: {has_progress}")
    print(f"BIN_FEM_3D_MESH detected: {has_fem_binary}")
    if stderr:
        print("Stderr snippet:", stderr[:500])
    return proc.returncode == 0 and has_init and has_progress and has_fem_binary

if __name__ == "__main__":
    r_cpu_s = test_fem_fsi("cpu", "single")
    r_cpu_d = test_fem_fsi("cpu", "double")
    r_gpu_s = test_fem_fsi("cuda", "single")
    r_gpu_d = test_fem_fsi("cuda", "double")
    print(f"\nFinal Summary -> CPU Single: {r_cpu_s}, CPU Double: {r_cpu_d}, CUDA Single: {r_gpu_s}, CUDA Double: {r_gpu_d}")
    if not (r_cpu_s and r_cpu_d and r_gpu_s and r_gpu_d):
        sys.exit(1)
