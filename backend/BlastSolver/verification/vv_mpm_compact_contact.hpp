#pragma once

#include "vv_framework.hpp"

namespace Blast::VV {

// Compact vs dense multi-material (Bardenhagen) grid storage parity on the GPU MPM solver.
// Each scenario runs the production MPMSolver3DCUDA twice in lockstep (dense layout and compact
// layout, identical particles and identical dt sequence) plus a second dense run that measures the
// float-atomic ordering noise floor. Scenarios cover all three P2G/G2P stencil families
// (tensor-product B-spline, cubic B-spline, radial MLS), Leapfrog and RK2 integration,
// 2- and 3-material contact, frictional sliding and slot-buffer regrowth.
std::vector<BenchmarkResult> run_mpm_compact_contact_benchmarks();

} // namespace Blast::VV
