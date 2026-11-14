#pragma once

#include "vv_framework.hpp"

namespace Blast::VV {

// Lee-Tarver / JWLReactant / mixture-rule verification using the production constitutive headers.
// Grid-level pop-plot and Hugoniot cases are reported as STATUS: PENDING INTEGRATION.
std::vector<BenchmarkResult> run_lee_tarver_benchmarks();

} // namespace Blast::VV
