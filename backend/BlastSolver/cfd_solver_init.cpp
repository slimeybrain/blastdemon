#include "cfd_solver.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

template <bool IsMultiMaterial>
CFDSolverImpl<IsMultiMaterial>::CFDSolverImpl(int num_cells, double domain_radius, double gamma)
    : n_cells(num_cells), radius(domain_radius), gamma(gamma), currentTime(0.0), currentScheme(RUSANOV),
      ambient_rho(1.2), ambient_p(101325.0), active_r_idx(num_cells) {
    dr = radius / n_cells;
    states.resize(n_cells);
    U.resize(n_cells);
    v_int.resize(n_cells + 1);

    geom_V.resize(n_cells);
    geom_A.resize(n_cells + 1);

    for (int i = 0; i <= n_cells; ++i) {
        double r = i * dr;
        geom_A[i] = 4.0 * M_PI * r * r;
    }

    for (int i = 0; i < n_cells; ++i) {
        double r_left = i * dr;
        double r_right = (i + 1) * dr;
        geom_V[i] = (4.0 / 3.0) * M_PI * (std::pow(r_right, 3) - std::pow(r_left, 3));
    }
}

template <bool IsMultiMaterial>
void CFDSolverImpl<IsMultiMaterial>::setFluxScheme(const std::string& scheme_name) {
    if (scheme_name == "ausm_plus" || scheme_name == "AUSMPlus" || scheme_name == "ausm+" || scheme_name == "AUSM+") {
        currentScheme = AUSM_PLUS;
    } else {
        currentScheme = RUSANOV;
    }
}

template <bool IsMultiMaterial>
void CFDSolverImpl<IsMultiMaterial>::setInitialConditionTNT(double explosive_radius, double high_rho, double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    for (int i = 0; i < n_cells; ++i) {
        double r = (i + 0.5) * dr;
        if (r <= explosive_radius) {
            states[i].rho = high_rho;
            states[i].p = ambient_p;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 1.0;
                states[i].arho1 = 0; states[i].arho2 = high_rho;
                states[i].E = states[i].rho * MultiMat::getEnergy_JWL(ambient_p, high_rho, currentMaterials.unreacted);
            } else {
                states[i].E = states[i].rho * MultiMat::getEnergy_IdealGas(ambient_p, high_rho, gamma);
            }
        } else {
            states[i].rho = ambient_rho;
            states[i].p = ambient_p;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 0;
                states[i].arho1 = 0; states[i].arho2 = 0;
            }
            states[i].E = states[i].rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
        }
    }
    active_r_idx = static_cast<int>(explosive_radius / dr) + 8;
    if (active_r_idx > n_cells) active_r_idx = n_cells;
    if (active_r_idx < 5) active_r_idx = 5;
    updateConservativeFromPrimitive(states, U);
}

template <bool IsMultiMaterial>
void CFDSolverImpl<IsMultiMaterial>::setInitialConditionIdealGas(double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    for (int i = 0; i < n_cells; ++i) {
        double r = (i + 0.5) * dr;
        if (r <= explosive_radius) {
            states[i].rho = high_rho;
            states[i].p = (gamma - 1.0) * high_rho * detonation_energy;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 0;
                states[i].arho1 = 0; states[i].arho2 = 0;
            }
            states[i].E = states[i].p / (gamma - 1.0);
        } else {
            states[i].rho = ambient_rho;
            states[i].p = ambient_p;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 0;
                states[i].arho1 = 0; states[i].arho2 = 0;
            }
            states[i].E = states[i].p / (gamma - 1.0);
        }
    }
    active_r_idx = static_cast<int>(explosive_radius / dr) + 8;
    if (active_r_idx > n_cells) active_r_idx = n_cells;
    if (active_r_idx < 5) active_r_idx = 5;
    updateConservativeFromPrimitive(states, U);
}

template <bool IsMultiMaterial>
void CFDSolverImpl<IsMultiMaterial>::setInitialConditionRoseTNT(double explosive_radius, double high_rho, double chemical_energy, double ambient_rho, double ambient_p, double det_vel) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->currentTime = explosive_radius / det_vel;
    for (int i = 0; i < n_cells; ++i) {
        double r = (i + 0.5) * dr;
        if (r <= explosive_radius) {
            states[i].rho = high_rho;
            states[i].p = (gamma - 1.0) * high_rho * chemical_energy;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 0;
                states[i].arho1 = 0; states[i].arho2 = 0;
            }
            states[i].E = states[i].p / (gamma - 1.0);
        } else {
            states[i].rho = ambient_rho;
            states[i].p = ambient_p;
            states[i].u = 0;
            if constexpr (IsMultiMaterial) {
                states[i].alpha1 = 0; states[i].alpha2 = 0;
                states[i].arho1 = 0; states[i].arho2 = 0;
            }
            states[i].E = states[i].p / (gamma - 1.0);
        }
    }
    active_r_idx = static_cast<int>(explosive_radius / dr) + 8;
    if (active_r_idx > n_cells) active_r_idx = n_cells;
    if (active_r_idx < 5) active_r_idx = 5;
    updateConservativeFromPrimitive(states, U);
}
