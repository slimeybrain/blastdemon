import subprocess
import json
import sys

def test_uncovering_precision(device="cuda", precision="double"):
    # Step 1: Initial setup with moving box causing uncovering
    init_cmd = {
        "command": "INIT_FEM_FSI_3D",
        "modelId": f"test_uncover_{device}_{precision}",
        "nx": 32,
        "ny": 32,
        "nz": 32,
        "cell_size": 0.02,
        "xmin": -0.32,
        "ymin": -0.32,
        "zmin": -0.32,
        "device": device,
        "precision": precision,
        "integration_scheme": "OnePointFB",
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
                "vel_z": 200.0,  # Fast moving solid creating uncovering in wake
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
        "modelId": f"test_uncover_{device}_{precision}",
        "steps": 20,
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
    print(f"Uncovering test [{device.upper():4s} | {precision:6s}] -> {'PASS' if passed else 'FAIL'}")
    return passed

if __name__ == "__main__":
    p_cpu_s = test_uncovering_precision("cpu", "single")
    p_cpu_d = test_uncovering_precision("cpu", "double")
    p_gpu_s = test_uncovering_precision("cuda", "single")
    p_gpu_d = test_uncovering_precision("cuda", "double")
    all_p = p_cpu_s and p_cpu_d and p_gpu_s and p_gpu_d
    print(f"All Uncovering Tests Passed: {all_p}")
    if not all_p:
        sys.exit(1)
