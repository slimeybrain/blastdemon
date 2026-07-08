#include "cfd_solver_init.cpp"
#include "cfd_solver_fluxes.cpp"
#include "cfd_solver_step.cpp"

template class CFDSolverImpl<float, false>;
template class CFDSolverImpl<float, true>;
template class CFDSolverImpl<double, false>;
template class CFDSolverImpl<double, true>;
