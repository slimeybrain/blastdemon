#include "cfd_solver_init.cpp"
#include "cfd_solver_fluxes.cpp"
#include "cfd_solver_step.cpp"

template class CFDSolverImpl<false>;
template class CFDSolverImpl<true>;
