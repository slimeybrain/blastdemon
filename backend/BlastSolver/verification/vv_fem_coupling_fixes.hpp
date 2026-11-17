#pragma once

#include "vv_framework.hpp"
#include <vector>

namespace Blast::VV {

// Coupled MPM-FEM contact, Tet4/KosloffFrazier stability, and per-part/material
// parameter isolation verification suite (all executed on genuine production solvers).
std::vector<BenchmarkResult> run_fem_coupling_fixes_benchmarks();

} // namespace Blast::VV
