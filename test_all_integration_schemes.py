import subprocess
import json
import sys

def test_scheme(device, precision, scheme):
    init_cmd = {
        "command": "INIT_FEM_FSI_3D",
        "modelId": f"test_{device}_{precision}_{scheme}",
        "nx": 24,
        "ny": 24,
        "nz": 24,
        "cell_size": 0.02,
        "xmin": -0.24,
        "ymin": -0.24,
        "zmin": -0.24,
        "device": device,
        "precision": precision,
        "integration_scheme": scheme,
        "init_mode": "Multi-Material JWL",
        "charge_shape": "Sphere",
        "charge_x": 0.0,
        "charge_y": 0.0,
        "charge_z": 0.12,
        "charge_radius": 0.04,
        "fem_objects": [
            {
                "shape_type": "Box",
                "nx": 4,
                "ny": 4,
                "nz": 4,
                "size_x": 0.08,
                "size_y": 0.08,
                "size_z": 0.08,
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
        "modelId": f"test_{device}_{precision}_{scheme}",
        "steps": 5,
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
    stdout_bytes, stderr_bytes = proc.communicate(input=cmds, timeout=10)
    stdout = stdout_bytes.decode('utf-8', errors='replace')
    stderr = stderr_bytes.decode('utf-8', errors='replace')

    passed = (proc.returncode == 0) and (b"BIN_FEM_3D_MESH" in stdout_bytes) and ("STEP_FEM_FSI_3D" in stdout)
    print(f"[{device.upper():4s} | {precision:6s} | {scheme:16s}] -> {'PASS' if passed else 'FAIL'}")
    return passed

if __name__ == "__main__":
    schemes = ["OnePointFB", "OnePointKF", "FullGauss8", "SelectiveReduced"]
    configs = [
        ("cpu", "single"),
        ("cpu", "double"),
        ("cuda", "single"),
        ("cuda", "double")
    ]
    all_passed = True
    for dev, prec in configs:
        for sch in schemes:
            if not test_scheme(dev, prec, sch):
                all_passed = False

    print(f"\nAll Schemes Passed: {all_passed}")
    if not all_passed:
        sys.exit(1)
