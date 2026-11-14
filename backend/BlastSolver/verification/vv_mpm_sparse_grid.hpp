#pragma once

#include "vv_framework.hpp"

namespace Blast::VV {

// Block-sparse background grid vs dense grid parity across 2D CPU MPM, 3D CPU MPM, and 3D CUDA GPU MPM.
// Each benchmark instantiates genuine production solvers (MPMSolver2D, MPMSolver3D, MPMSolver3DCUDA)
// in lockstep (Dense vs Sparse, plus a second Dense run on GPU to measure the float-atomic ordering
// noise floor), verifying particle kinematic/stress parity, interface profile continuity across +/-5
// cells, momentum/energy conservation, and substantial grid RAM/VRAM savings.
std::vector<BenchmarkResult> run_mpm_sparse_grid_benchmarks();

} // namespace Blast::VV
