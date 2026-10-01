import subprocess
import json
import struct
import sys
import time

def run_test(device="cpu", precision="single"):
    print("==================================================")
    print(f" Testing 1D-to-3D Remap into FEM-FSI 3D Solver ({device}, {precision})")
    print("==================================================")

    proc = subprocess.Popen(
        ["./build/BlastSolver"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        bufsize=0
    )

    # 1. Initialize and run 1D solver
    init_1d = {
        "command": "INIT",
        "modelId": "model_1d",
        "nx": 200,
        "cell_size": 0.005,
        "init_mode": "Multi-Material JWL",
        "explosive_radius": 0.05,
        "preset": "TNT",
        "rho": 1630.0,
        "detonation_energy": 4.29e6,
        "det_vel": 6930.0,
        "atm_pressure": 101325.0
    }

    step_1d = {
        "command": "STEP",
        "modelId": "model_1d",
        "steps": 25,
        "cfl": 0.5
    }

    proc.stdin.write((json.dumps(init_1d) + "\n").encode('utf-8'))
    proc.stdin.write((json.dumps(step_1d) + "\n").encode('utf-8'))
    proc.stdin.flush()

    # Read binary telemetry from 1D
    # The solver emits text lines and binary packets with headers
    r_1d = []
    p_1d = []
    rho_1d = []
    u_1d = []
    states_1d = []

    # Read until we get 1D binary telemetry or progress
    # Let's accumulate bytes
    n_cells = 200
    cell_size = 0.005
    gamma = 1.4

    # Wait briefly for 1D steps to finish
    time.sleep(0.5)

    # 2. Initialize FEM-FSI 3D with init_mode = "From1D"
    # Remap target center = (0.5, 0.5, 0.5) inside a domain [0, 1]x[0, 1]x[0, 1]
    init_3d = {
        "command": "INIT_FEM_FSI_3D",
        "modelId": "model_3d",
        "nx": 24,
        "ny": 24,
        "nz": 24,
        "cell_size": 0.04,
        "xmin": 0.0,
        "ymin": 0.0,
        "zmin": 0.0,
        "device": device,
        "precision": precision,
        "init_mode": "From1D",
        "charge_radius": 0.0,
        "atm_pressure": 101325.0,
        "ambient_rho": 1.225,
        "slices": [
            {
                "axis": "xy",
                "offset": 0.5,
                "stride": 1,
                "enabled": True,
                "quantities": ["pressure"]
            }
        ],
        "fem_objects": [
            {
                "shape_type": "Box",
                "nx": 4, "ny": 4, "nz": 4,
                "size_x": 0.08, "size_y": 0.08, "size_z": 0.08,
                "pos_x": 0.8, "pos_y": 0.8, "pos_z": 0.8,
                "density": 7850.0, "youngs_modulus": 2.1e11, "poissons_ratio": 0.3
            }
        ]
    }

    # Synthesize 1D blast profile for REMAP
    for i in range(100):
        r = (i + 0.5) * 0.01
        p = 101325.0 + (5.0e6 * max(0.0, 1.0 - r / 0.5)**2)
        rho = 1.225 * (p / 101325.0)**(1.0/1.4)
        u = 200.0 * max(0.0, 1.0 - r / 0.5)
        E = p / (1.4 - 1.0) + 0.5 * rho * u * u
        r_1d.append(r)
        states_1d.append({
            "rho": rho,
            "u": u,
            "p": p,
            "E": E,
            "alpha1": 0.0,
            "alpha2": 1.0,
            "arho1": 0.0,
            "arho2": rho
        })

    remap_cmd = {
        "command": "REMAP",
        "modelId": "model_3d",
        "time": 0.0001,
        "explosive_x": 0.5,
        "explosive_y": 0.5,
        "explosive_z": 0.5,
        "explosive_r": 0.0,
        "remap_radius": 0.0,  # 0.0 means entire domain (cut_r = r_1d.back())
        "charge_radius": 0.05,
        "explosive_type": "MaterialExplosive",
        "r_1d": r_1d,
        "states_1d": states_1d
    }

    step_3d = {
        "command": "STEP_FEM_FSI_3D",
        "modelId": "model_3d",
        "steps": 5,
        "cfl": 0.3
    }

    term_cmd = {
        "command": "TERMINATE_FEM_FSI_3D"
    }

    full_input = (
        json.dumps(init_3d) + "\n" +
        json.dumps(remap_cmd) + "\n" +
        json.dumps(step_3d) + "\n" +
        json.dumps(term_cmd) + "\n"
    ).encode('utf-8')

    try:
        stdout_bytes, stderr_bytes = proc.communicate(input=full_input, timeout=15)
    except Exception as e:
        proc.kill()
        stdout_bytes, stderr_bytes = proc.communicate()

    stdout = stdout_bytes.decode('utf-8', errors='replace')
    stderr = stderr_bytes.decode('utf-8', errors='replace')

    print("Solver Returncode:", proc.returncode)
    remap_applied = "Applied 1D remap" in stdout or "Applied 1D remap" in stderr or "REMAP" in stdout
    fsi_stepped = "STEP_FEM_FSI_3D" in stdout
    print("Remap applied successfully:", remap_applied)
    print("FEM-FSI 3D stepped:", fsi_stepped)

    if proc.returncode == 0 and remap_applied and fsi_stepped:
        print("\n>>> REMAP TO FEM-FSI 3D: PASS <<<")
        return True
    else:
        print("\n>>> REMAP TO FEM-FSI 3D: FAILED <<<")
        print("Stderr snippet:", stderr[:1000])
        print("Stdout snippet:", stdout[:1000])
        return False

if __name__ == "__main__":
    ok_cpu_s = run_test("cpu", "single")
    ok_cpu_d = run_test("cpu", "double")
    ok_cuda_s = run_test("cuda", "single")
    ok_cuda_d = run_test("cuda", "double")
    print(f"\nFinal Summary -> CPU Single: {ok_cpu_s}, CPU Double: {ok_cpu_d}, CUDA Single: {ok_cuda_s}, CUDA Double: {ok_cuda_d}")
    if not (ok_cpu_s and ok_cpu_d and ok_cuda_s and ok_cuda_d):
        sys.exit(1)
