import subprocess
import json
import sys
import time

def test_temporal_order(device="cuda", precision="double", temporal_order=4):
    init_cmd = {
        "command": "INIT_FEM_FSI_3D",
        "modelId": f"test_order_{temporal_order}_{device}_{precision}",
        "nx": 32,
        "ny": 32,
        "nz": 32,
        "cell_size": 0.02,
        "xmin": -0.32,
        "ymin": -0.32,
        "zmin": -0.32,
        "device": device,
        "precision": precision,
        "temporal_order": temporal_order,
        "spatial_order": 2,
        "init_mode": "Multi-Material JWL",
        "charge_shape": "Sphere",
        "charge_x": 0.0,
        "charge_y": 0.0,
        "charge_z": 0.0,
        "charge_radius": 0.08,
        "fem_objects": []
    }

    step_cmd = {
        "command": "STEP_FEM_FSI_3D",
        "modelId": f"test_order_{temporal_order}_{device}_{precision}",
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
    stdout_bytes, stderr_bytes = proc.communicate(input=cmds, timeout=15)
    stdout = stdout_bytes.decode('utf-8', errors='replace')
    stderr = stderr_bytes.decode('utf-8', errors='replace')

    passed = (proc.returncode == 0) and ("STEP_FEM_FSI_3D" in stdout)
    return passed

if __name__ == "__main__":
    orders = [
        (1, "Euler-1"),
        (2, "RK-2"),
        (3, "RK-3"),
        (4, "MUSCL-Hancock"),
        (5, "ADER-2"),
        (6, "ADER-3")
    ]
    
    all_passed = True
    for dev in ["cpu", "cuda"]:
        for prec in ["single", "double"]:
            for order, name in orders:
                p = test_temporal_order(dev, prec, order)
                print(f"[{dev.upper():4s} | {prec:6s} | Order {order}: {name:13s}] -> {'PASS' if p else 'FAIL'}")
                if not p:
                    all_passed = False

    print(f"\nAll CFD Temporal Order Tests Passed: {all_passed}")
    if not all_passed:
        sys.exit(1)
