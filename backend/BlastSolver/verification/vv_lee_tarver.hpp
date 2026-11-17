#pragma once

#include "vv_framework.hpp"

namespace Blast::VV {

// Lee-Tarver / JWLReactant / mixture-rule verification using the production constitutive headers.
// Grid-level pop-plot and Hugoniot cases are reported as STATUS: PENDING INTEGRATION.
std::vector<BenchmarkResult> run_lee_tarver_benchmarks();

// Diagnostic: dumps the x-t / pmax / lambda trace of one pop-plot case (explosive 0=PBX9501,1=C-4,2=CompB).
void run_lee_tarver_trace(int expl, double P_gpa, double dz_mm, bool reactive = true);

} // namespace Blast::VV
