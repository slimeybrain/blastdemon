#pragma once

#include <cmath>
#include <algorithm>
#include "../cfd_eos_water.hpp"

#ifdef __CUDACC__
#define HD_MAT_FUNC __host__ __device__
#else
#define HD_MAT_FUNC inline
#endif

namespace Blast::Materials {

// --- 0. Shared Tensor & Eigen Decomposition Helpers (Zero Heap Allocation, Host+Device) ---
template <typename T>
HD_MAT_FUNC void sym3_eigen(const T A_in[3][3], T evals[3], T V[3][3]) {
    T A[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            A[i][j] = (i == j) ? A_in[i][i] : static_cast<T>(0.5) * (A_in[i][j] + A_in[j][i]);
            V[i][j] = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
        }
    }

    const T scale = std::abs(A[0][0]) + std::abs(A[1][1]) + std::abs(A[2][2]) +
                    std::abs(A[0][1]) + std::abs(A[0][2]) + std::abs(A[1][2]) + static_cast<T>(1.0e-30);
    const T tol = scale * static_cast<T>(1.0e-12);

    for (int sweep = 0; sweep < 15; ++sweep) {
        T off = std::abs(A[0][1]) + std::abs(A[0][2]) + std::abs(A[1][2]);
        if (off <= tol) break;

        for (int p = 0; p < 2; ++p) {
            for (int q = p + 1; q < 3; ++q) {
                T apq = A[p][q];
                if (std::abs(apq) <= tol * static_cast<T>(0.1)) continue;
                T tau = (A[q][q] - A[p][p]) / (static_cast<T>(2.0) * apq);
                T t_rot = (tau >= static_cast<T>(0.0))
                    ? static_cast<T>(1.0) / (tau + std::sqrt(static_cast<T>(1.0) + tau * tau))
                    : static_cast<T>(-1.0) / (-tau + std::sqrt(static_cast<T>(1.0) + tau * tau));
                T c = static_cast<T>(1.0) / std::sqrt(static_cast<T>(1.0) + t_rot * t_rot);
                T s = t_rot * c;

                T app = A[p][p];
                T aqq = A[q][q];
                A[p][p] = app - t_rot * apq;
                A[q][q] = aqq + t_rot * apq;
                A[p][q] = static_cast<T>(0.0);
                A[q][p] = static_cast<T>(0.0);

                for (int r = 0; r < 3; ++r) {
                    if (r != p && r != q) {
                        T arp = A[r][p];
                        T arq = A[r][q];
                        A[r][p] = A[p][r] = c * arp - s * arq;
                        A[r][q] = A[q][r] = s * arp + c * arq;
                    }
                    T vrp = V[r][p];
                    T vrq = V[r][q];
                    V[r][p] = c * vrp - s * vrq;
                    V[r][q] = s * vrp + c * vrq;
                }
            }
        }
    }

    evals[0] = A[0][0];
    evals[1] = A[1][1];
    evals[2] = A[2][2];

    // Sort eigenvalues descending: evals[0] >= evals[1] >= evals[2]
    for (int i = 0; i < 2; ++i) {
        int max_i = i;
        for (int j = i + 1; j < 3; ++j) {
            if (evals[j] > evals[max_i]) max_i = j;
        }
        if (max_i != i) {
            T tmp = evals[i]; evals[i] = evals[max_i]; evals[max_i] = tmp;
            for (int r = 0; r < 3; ++r) {
                T tv = V[r][i]; V[r][i] = V[r][max_i]; V[r][max_i] = tv;
            }
        }
    }
}

template <typename T>
HD_MAT_FUNC void sym3_from_eigen(const T evals[3], const T V[3][3], T A_out[3][3]) {
    for (int i = 0; i < 3; ++i) {
        for (int j = i; j < 3; ++j) {
            T sum = evals[0] * V[i][0] * V[j][0] +
                    evals[1] * V[i][1] * V[j][1] +
                    evals[2] * V[i][2] * V[j][2];
            A_out[i][j] = sum;
            A_out[j][i] = sum;
        }
    }
}

template <typename T>
HD_MAT_FUNC void mat3_rotate_to_local(const T Q[3][3], const T M[3][3], T out[3][3]) {
    // out = Q^T * M * Q (columns of Q are local basis vectors in global frame)
    T tmp[3][3]{};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            tmp[i][j] = M[i][0] * Q[0][j] + M[i][1] * Q[1][j] + M[i][2] * Q[2][j];
        }
    }
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            out[i][j] = Q[0][i] * tmp[0][j] + Q[1][i] * tmp[1][j] + Q[2][i] * tmp[2][j];
        }
    }
}

template <typename T>
HD_MAT_FUNC void mat3_rotate_to_global(const T Q[3][3], const T M[3][3], T out[3][3]) {
    // out = Q * M * Q^T
    T tmp[3][3]{};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            tmp[i][j] = M[i][0] * Q[j][0] + M[i][1] * Q[j][1] + M[i][2] * Q[j][2];
        }
    }
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            out[i][j] = Q[i][0] * tmp[0][j] + Q[i][1] * tmp[1][j] + Q[i][2] * tmp[2][j];
        }
    }
}

// --- 1. Linear Elasticity ---
template <typename T>
HD_MAT_FUNC void update_constitutive_elastic(
    T E, T nu,
    const T d_eps[3][3],
    T sigma[3][3]
) {
    T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            sigma[i][j] += static_cast<T>(2.0) * G * d_dev + K * trace_deps * delta_ij;
        }
    }
}

// --- 2. J2 von Mises Plasticity with Radial Return Mapping ---
template <typename T>
HD_MAT_FUNC void update_constitutive_j2(
    T E, T nu, T sigma_y0, T H_prime,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& ep_bar
) {
    T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    // Hydrostatic pressure update
    p -= K * trace_deps;

    // Trial deviatoric stress
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
        }
    }

    // Equivalent trial stress J2
    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0]*s_trial[0][0] + s_trial[1][1]*s_trial[1][1] + s_trial[2][2]*s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1]*s_trial[0][1] + s_trial[0][2]*s_trial[0][2] + s_trial[1][2]*s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(static_cast<T>(3.0) * J2);

    T current_yield = sigma_y0 + H_prime * ep_bar;
    T f_yield = sigma_eq_trial - current_yield;

    if (f_yield > static_cast<T>(0.0)) {
        // Radial return mapping plastic multiplier
        T d_gamma = f_yield / (static_cast<T>(3.0) * G + H_prime);
        T factor = static_cast<T>(1.0) - (static_cast<T>(3.0) * G * d_gamma) / (sigma_eq_trial + 1e-12f);

        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
        ep_bar += d_gamma;
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- 3. Johnson-Cook Viscoplasticity with Thermal Softening ---
template <typename T>
HD_MAT_FUNC void update_constitutive_johnson_cook(
    T A, T B, T n, T C, T m,
    T T_room, T T_melt, T T_curr,
    T eps_dot,
    T G, T K,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& ep_bar
) {
    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    p -= K * trace_deps;

    // Trial deviatoric stress
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
        }
    }

    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0]*s_trial[0][0] + s_trial[1][1]*s_trial[1][1] + s_trial[2][2]*s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1]*s_trial[0][1] + s_trial[0][2]*s_trial[0][2] + s_trial[1][2]*s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(static_cast<T>(3.0) * J2);

    // Thermal homologated temperature
    T T_homo = (T_curr - T_room) / (T_melt - T_room + static_cast<T>(1e-6));
    T_homo = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), T_homo));
    T thermal_factor = static_cast<T>(1.0) - std::pow(T_homo, m);

    // Strain rate factor (reference eps_dot_0 = 1.0 s^-1)
    T eps_dot_norm = std::max(static_cast<T>(1.0), eps_dot);
    T rate_factor = static_cast<T>(1.0) + C * std::log(eps_dot_norm);

    // Strain hardening and consistent tangent modulus H_jc
    T ep_safe = std::max(static_cast<T>(0.0), ep_bar);
    T strain_factor = A + B * std::pow(ep_safe, n);
    T current_yield = strain_factor * rate_factor * thermal_factor;
    T ep_deriv = std::max(static_cast<T>(1.0e-4), ep_safe);
    T H_jc = (B > static_cast<T>(0.0) && n > static_cast<T>(0.0))
        ? std::min(static_cast<T>(10.0) * G, B * n * std::pow(ep_deriv, n - static_cast<T>(1.0)) * rate_factor * thermal_factor)
        : static_cast<T>(0.0);

    T f_yield = sigma_eq_trial - current_yield;
    if (f_yield > static_cast<T>(0.0)) {
        T d_gamma = f_yield / (static_cast<T>(3.0) * G + H_jc);
        T factor = current_yield / (sigma_eq_trial + static_cast<T>(1e-12));

        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
        ep_bar += d_gamma;
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- 3b. Johnson-Cook Viscoplasticity with Triaxiality Damage Accumulation & Failure ---
template <typename T>
HD_MAT_FUNC void update_constitutive_johnson_cook_with_damage(
    T A, T B, T n, T C, T m,
    T d1, T d2, T d3, T d4, T d5,
    T T_room, T T_melt, T T_curr,
    T eps_dot,
    T G, T K,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& ep_bar,
    T& damage,
    bool& has_failed
) {
    if (has_failed || damage >= static_cast<T>(1.0)) {
        has_failed = true;
        damage = static_cast<T>(1.0);
        // Failed / fractured material loses deviatoric shear strength (purely hydrodynamic pressure)
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = static_cast<T>(0.0);
        T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
        p -= K * trace_deps;
        if (p < static_cast<T>(0.0)) p = static_cast<T>(0.0); // Zero tensile resistance upon fracture
        return;
    }

    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    p -= K * trace_deps;

    // Current intact-to-nominal damage factor (Lemaitre strain equivalence)
    T deg_old = std::max(static_cast<T>(1.0e-6), static_cast<T>(1.0) - std::max(static_cast<T>(0.0), damage));

    // Trial deviatoric stress in nominal space with degraded shear stiffness (1 - D)*G
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * (deg_old * G) * d_dev;
        }
    }

    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0]*s_trial[0][0] + s_trial[1][1]*s_trial[1][1] + s_trial[2][2]*s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1]*s_trial[0][1] + s_trial[0][2]*s_trial[0][2] + s_trial[1][2]*s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(static_cast<T>(3.0) * J2);

    // Thermal homologated temperature
    T T_homo = (T_curr - T_room) / (T_melt - T_room + static_cast<T>(1e-6));
    T_homo = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), T_homo));
    T thermal_factor = static_cast<T>(1.0) - std::pow(T_homo, m);

    // Strain rate factor (reference eps_dot_0 = 1.0 s^-1)
    T eps_dot_norm = std::max(static_cast<T>(1.0), eps_dot);
    T rate_factor = static_cast<T>(1.0) + C * std::log(eps_dot_norm);

    // Strain hardening and consistent tangent modulus
    T ep_safe = std::max(static_cast<T>(0.0), ep_bar);
    T strain_factor = A + B * std::pow(ep_safe, n);
    T current_yield = strain_factor * rate_factor * thermal_factor;
    T damaged_yield = deg_old * current_yield;
    T ep_deriv = std::max(static_cast<T>(1.0e-4), ep_safe);
    T H_jc = (B > static_cast<T>(0.0) && n > static_cast<T>(0.0))
        ? std::min(static_cast<T>(10.0) * G, B * n * std::pow(ep_deriv, n - static_cast<T>(1.0)) * rate_factor * thermal_factor)
        : static_cast<T>(0.0);

    T f_yield = sigma_eq_trial - damaged_yield;
    if (f_yield > static_cast<T>(0.0)) {
        // Return in effective space: d_gamma = (sigma_eq_eff - current_yield) / (3*G + H_jc)
        T d_gamma = (f_yield / deg_old) / (static_cast<T>(3.0) * G + H_jc);
        ep_bar += d_gamma;

        // Triaxiality-dependent fracture strain (Johnson-Cook failure criterion)
        // eta = sigma_m / sigma_eq_eff = -p / (sigma_eq_trial / deg_old)
        T sigma_eq_eff = sigma_eq_trial / deg_old;
        T sigma_m = -p;
        T eta = sigma_m / (sigma_eq_eff + static_cast<T>(1e-12));
        eta = std::max(static_cast<T>(-5.0), std::min(static_cast<T>(5.0), eta));
        T exp_arg = std::max(static_cast<T>(-30.0), std::min(static_cast<T>(30.0), d3 * eta));

        T eps_f = (d1 + d2 * std::exp(exp_arg)) *
                  (static_cast<T>(1.0) + d4 * std::log(eps_dot_norm)) *
                  (static_cast<T>(1.0) + d5 * T_homo);
        eps_f = std::max(static_cast<T>(1e-4), eps_f);

        damage = std::min(static_cast<T>(1.0), std::max(static_cast<T>(0.0), damage) + d_gamma / eps_f);
        if (damage >= static_cast<T>(1.0)) {
            damage = static_cast<T>(1.0);
            has_failed = true;
            for (int i = 0; i < 3; ++i)
                for (int j = 0; j < 3; ++j)
                    s_dev[i][j] = static_cast<T>(0.0);
            if (p < static_cast<T>(0.0)) p = static_cast<T>(0.0);
        } else {
            // Return directly onto newly degraded yield surface (1 - D_new) * current_yield
            T deg_new = static_cast<T>(1.0) - damage;
            T factor = (deg_new * current_yield) / (sigma_eq_trial + static_cast<T>(1e-12));
            for (int i = 0; i < 3; ++i) {
                for (int j = 0; j < 3; ++j) {
                    s_dev[i][j] = s_trial[i][j] * factor;
                }
            }
        }
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- 3c. Mott Fragmentation Statistical Distribution ---
template <typename T>
struct MottFragmentation {
    // Computes characteristic fragment mass mu_mott (kg) from expansion velocity V,
    // cylinder radius R, wall thickness h, density rho, and dynamic fracture energy gamma_f
    HD_MAT_FUNC static T compute_characteristic_mass(T V_expansion, T R_casing, T h_wall, T rho, T gamma_f) {
        T eps_dot = V_expansion / std::max(static_cast<T>(1e-4), R_casing);
        // Grady-Mott formulation: characteristic fragment size s = (24 * gamma_f / (rho * eps_dot^2))^(1/3)
        T s_char = std::cbrt(static_cast<T>(24.0) * gamma_f / (rho * eps_dot * eps_dot + static_cast<T>(1e-12)));
        // Characteristic mass mu = rho * s_char * s_char * h_wall
        return rho * s_char * s_char * h_wall;
    }

    // Cumulative distribution function: P(m > M) = exp(-sqrt(M / mu))
    HD_MAT_FUNC static T cumulative_exceedance(T mass, T mu) {
        if (mass <= static_cast<T>(0.0) || mu <= static_cast<T>(0.0)) return static_cast<T>(1.0);
        return std::exp(-std::sqrt(mass / mu));
    }

    // Cumulative distribution function: P(m <= M) = 1 - exp(-sqrt(M / mu))
    HD_MAT_FUNC static T cumulative_distribution(T mass, T mu) {
        return static_cast<T>(1.0) - cumulative_exceedance(mass, mu);
    }
};

// --- 3d. Gurney Analytical High-Pressure Gas Cylinder Expansion Terminal Velocity ---
template <typename T>
struct GurneyExpansion {
    // Cylindrical casing: V_g = sqrt(2 * E) / sqrt(M / C + 0.5)
    // where E is specific internal energy (J/kg), M is casing mass (kg), C is gas mass (kg)
    HD_MAT_FUNC static T cylinder_velocity(T specific_energy, T mass_casing, T mass_gas) {
        T mass_ratio = mass_casing / std::max(static_cast<T>(1e-6), mass_gas);
        T denom = std::sqrt(mass_ratio + static_cast<T>(0.5));
        return std::sqrt(static_cast<T>(2.0) * specific_energy) / denom;
    }

    // Spherical casing: V_g = sqrt(2 * E) / sqrt(M / C + 0.6)
    HD_MAT_FUNC static T sphere_velocity(T specific_energy, T mass_casing, T mass_gas) {
        T mass_ratio = mass_casing / std::max(static_cast<T>(1e-6), mass_gas);
        T denom = std::sqrt(mass_ratio + static_cast<T>(0.6));
        return std::sqrt(static_cast<T>(2.0) * specific_energy) / denom;
    }
};

// --- 4. Hyperelasticity: Yeoh Model ---
template <typename T>
HD_MAT_FUNC void update_constitutive_yeoh(
    T C10, T C20, T C30, T K_bulk,
    const T F[3][3],
    T sigma[3][3]
) {
    // Jacobian determinant J = det(F)
    T J = F[0][0]*(F[1][1]*F[2][2] - F[1][2]*F[2][1]) -
          F[0][1]*(F[1][0]*F[2][2] - F[1][2]*F[2][0]) +
          F[0][2]*(F[1][0]*F[2][1] - F[1][1]*F[2][0]);
    if (J < static_cast<T>(1e-4)) J = static_cast<T>(1e-4);

    T J_m23 = std::pow(J, static_cast<T>(-2.0 / 3.0));

    // Left Cauchy-Green tensor B = F * F^T
    T B[3][3]{0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            for (int k = 0; k < 3; ++k) {
                B[i][j] += F[i][k] * F[j][k];
            }
        }
    }

    // Isochoric B_bar = J^(-2/3) * B
    T B_bar[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            B_bar[i][j] = J_m23 * B[i][j];
        }
    }

    T I1_bar = B_bar[0][0] + B_bar[1][1] + B_bar[2][2];
    T delta_I1 = I1_bar - static_cast<T>(3.0);

    // Yeoh strain energy derivative dW/dI1 = C10 + 2*C20*(I1-3) + 3*C30*(I1-3)^2
    T dW_dI1 = C10 + static_cast<T>(2.0)*C20*delta_I1 + static_cast<T>(3.0)*C30*delta_I1*delta_I1;

    // Cauchy stress: sigma = (2/J) * dW/dI1 * dev(B_bar) + K*(J - 1)*I
    T p_vol = K_bulk * (J - static_cast<T>(1.0));
    T two_div_J = static_cast<T>(2.0) / J;

    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T dev_B = B_bar[i][j] - static_cast<T>(1.0 / 3.0) * I1_bar * delta_ij;
            sigma[i][j] = two_div_J * dW_dI1 * dev_B + p_vol * delta_ij;
        }
    }
}

// --- 5. Hyperelasticity: Mooney-Rivlin Model ---
template <typename T>
HD_MAT_FUNC void update_constitutive_mooney_rivlin(
    T C10, T C01, T K_bulk,
    const T F[3][3],
    T sigma[3][3]
) {
    T J = F[0][0]*(F[1][1]*F[2][2] - F[1][2]*F[2][1]) -
          F[0][1]*(F[1][0]*F[2][2] - F[1][2]*F[2][0]) +
          F[0][2]*(F[1][0]*F[2][1] - F[1][1]*F[2][0]);
    if (J < static_cast<T>(1e-4)) J = static_cast<T>(1e-4);

    T J_m23 = std::pow(J, static_cast<T>(-2.0 / 3.0));
    T J_m43 = J_m23 * J_m23;

    T B[3][3]{0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            for (int k = 0; k < 3; ++k) {
                B[i][j] += F[i][k] * F[j][k];
            }
        }
    }

    T B_bar[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            B_bar[i][j] = J_m23 * B[i][j];
        }
    }

    // B_bar^2
    T B_bar2[3][3]{0};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            for (int k = 0; k < 3; ++k) {
                B_bar2[i][j] += B_bar[i][k] * B_bar[k][j];
            }
        }
    }

    T I1_bar = B_bar[0][0] + B_bar[1][1] + B_bar[2][2];
    T tr_B_bar2 = B_bar2[0][0] + B_bar2[1][1] + B_bar2[2][2];
    T I2_bar = static_cast<T>(0.5) * (I1_bar * I1_bar - tr_B_bar2);

    T p_vol = K_bulk * (J - static_cast<T>(1.0));
    T two_div_J = static_cast<T>(2.0) / J;

    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T dev_B = B_bar[i][j] - static_cast<T>(1.0 / 3.0) * I1_bar * delta_ij;
            T dev_B2 = B_bar2[i][j] - static_cast<T>(1.0 / 3.0) * tr_B_bar2 * delta_ij;
            sigma[i][j] = two_div_J * ((C10 + I1_bar*C01)*dev_B - C01*dev_B2) + p_vol * delta_ij;
        }
    }
}

// --- 6. Concrete Damage Plasticity (CDP) with Unilateral Stiffness Recovery ---
template <typename T>
HD_MAT_FUNC void update_constitutive_cdp(
    T E0, T nu, T f_t0, T f_c0, T G_f, T l_ch,
    const T d_eps[3][3],
    T sigma[3][3],
    T& d_t, T& d_c,
    T& ep_t, T& ep_c
) {
    // 1. Recover undamaged effective stress sigma_eff from nominal sigma:
    //    sigma = (1 - d_t)*<sigma_eff>_+ + (1 - d_c)*<sigma_eff>_-
    T sigma_eff[3][3];
    if (d_t > static_cast<T>(0.0) || d_c > static_cast<T>(0.0)) {
        T nom_evals[3], nom_vecs[3][3];
        sym3_eigen(sigma, nom_evals, nom_vecs);
        const T denom_t = std::max(static_cast<T>(1.0e-3), static_cast<T>(1.0) - d_t);
        const T denom_c = std::max(static_cast<T>(1.0e-3), static_cast<T>(1.0) - d_c);
        T eff_evals[3];
        for (int k = 0; k < 3; ++k) {
            eff_evals[k] = (nom_evals[k] >= static_cast<T>(0.0))
                ? (nom_evals[k] / denom_t)
                : (nom_evals[k] / denom_c);
        }
        sym3_from_eigen(eff_evals, nom_vecs, sigma_eff);
    } else {
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                sigma_eff[i][j] = sigma[i][j];
    }

    // 2. Elastic trial update in effective stress space
    T trace = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    T G0 = E0 / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K0 = E0 / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace * delta_ij;
            sigma_eff[i][j] += static_cast<T>(2.0) * G0 * d_dev + K0 * trace * delta_ij;
        }
    }

    // 3. Principal stress and strain increment decomposition (handles shear tr(d_eps) == 0)
    T sig_evals[3], sig_vecs[3][3];
    sym3_eigen(sigma_eff, sig_evals, sig_vecs);

    T deps_evals[3], deps_vecs[3][3];
    sym3_eigen(d_eps, deps_evals, deps_vecs);

    T pos_sq = static_cast<T>(0.0), neg_sq = static_cast<T>(0.0);
    for (int k = 0; k < 3; ++k) {
        T p_k = std::max(static_cast<T>(0.0), deps_evals[k]);
        T n_k = std::min(static_cast<T>(0.0), deps_evals[k]);
        pos_sq += p_k * p_k;
        neg_sq += n_k * n_k;
    }
    T d_ep_pos = std::sqrt(pos_sq);
    T d_ep_neg = std::sqrt(neg_sq);

    // 4. Tensile cracking and compressive crushing damage (thermodynamically non-decreasing)
    if (sig_evals[0] > static_cast<T>(0.0) && d_ep_pos > static_cast<T>(0.0)) {
        ep_t += d_ep_pos;
        T eps_t_init = f_t0 / (E0 + static_cast<T>(1.0e-12));
        T eps_t_u = (static_cast<T>(2.0) * G_f) / (f_t0 * std::max(static_cast<T>(1.0e-5), l_ch) + static_cast<T>(1.0e-12));
        T eps_t_span = std::max(static_cast<T>(0.2) * eps_t_init, eps_t_u - eps_t_init);
        if (ep_t > eps_t_init) {
            T dt_cand = (ep_t - eps_t_init) / (eps_t_span + static_cast<T>(1.0e-12));
            d_t = std::max(d_t, std::min(static_cast<T>(0.99), dt_cand));
        }
    }
    if (sig_evals[2] < static_cast<T>(0.0) && d_ep_neg > static_cast<T>(0.0)) {
        ep_c += d_ep_neg;
        T eps_c_peak = f_c0 / (E0 + static_cast<T>(1.0e-12));
        if (ep_c > eps_c_peak) {
            T dc_cand = (ep_c - eps_c_peak) / (static_cast<T>(4.0) * eps_c_peak + static_cast<T>(1.0e-12));
            d_c = std::max(d_c, std::min(static_cast<T>(0.95), dc_cand));
        }
    }

    // 5. Spectral unilateral damage reconstruction: open tension cracked by d_t, closed compression by d_c
    T sig_nom_evals[3];
    for (int k = 0; k < 3; ++k) {
        if (sig_evals[k] >= static_cast<T>(0.0)) {
            sig_nom_evals[k] = (static_cast<T>(1.0) - d_t) * sig_evals[k];
        } else {
            sig_nom_evals[k] = (static_cast<T>(1.0) - d_c) * sig_evals[k];
        }
    }
    sym3_from_eigen(sig_nom_evals, sig_vecs, sigma);
}

// --- 7. Orthotropic Yield: Hill48 Model (Elastoplastic Return in Local Frame) ---
template <typename T>
HD_MAT_FUNC void update_constitutive_hill48(
    T F_h, T G_h, T H_h, T L_h, T M_h, T N_h,
    T sigma_y0,
    const T d_eps[3][3],
    T sigma[3][3],
    T& ep_bar,
    T E_mod = static_cast<T>(210.0e9),
    T nu_mod = static_cast<T>(0.3),
    T H_iso = static_cast<T>(0.0)
) {
    T G0 = E_mod / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu_mod));
    T K0 = E_mod / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu_mod));

    T deps_norm = std::abs(d_eps[0][0]) + std::abs(d_eps[1][1]) + std::abs(d_eps[2][2]) +
                  std::abs(d_eps[0][1]) + std::abs(d_eps[0][2]) + std::abs(d_eps[1][2]);
    if (deps_norm > static_cast<T>(0.0)) {
        T trace = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
                T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace * delta_ij;
                sigma[i][j] += static_cast<T>(2.0) * G0 * d_dev + K0 * trace * delta_ij;
            }
        }
    }

    // Hill's 1948 quadratic anisotropic yield (strictly pressure-independent):
    // 2*f = F*(syy - szz)^2 + G*(szz - sxx)^2 + H*(sxx - syy)^2 + 2*L*syz^2 + 2*M*szx^2 + 2*N*sxy^2
    T sxx = sigma[0][0];
    T syy = sigma[1][1];
    T szz = sigma[2][2];
    T sxy = sigma[0][1];
    T syz = sigma[1][2];
    T szx = sigma[0][2];

    T hill_val = F_h * (syy - szz) * (syy - szz) +
                 G_h * (szz - sxx) * (szz - sxx) +
                 H_h * (sxx - syy) * (sxx - syy) +
                 static_cast<T>(2.0) * (L_h * syz * syz + M_h * szx * szx + N_h * sxy * sxy);

    T sigma_hill = std::sqrt(std::max(static_cast<T>(0.0), hill_val));
    T current_yield = sigma_y0 + H_iso * ep_bar;
    if (sigma_hill > current_yield) {
        T denom = std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G0 + H_iso);
        T d_ep = (sigma_hill - current_yield) / denom;
        ep_bar += d_ep;
        T yield_post = sigma_y0 + H_iso * ep_bar;
        T factor = std::min(static_cast<T>(1.0), yield_post / (sigma_hill + static_cast<T>(1.0e-12)));

        if (deps_norm > static_cast<T>(0.0)) {
            // Preserve hydrostatic mean stress during deviatoric yield return
            T p_mean = (sigma[0][0] + sigma[1][1] + sigma[2][2]) / static_cast<T>(3.0);
            for (int i = 0; i < 3; ++i) {
                for (int j = 0; j < 3; ++j) {
                    T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
                    T dev = sigma[i][j] - p_mean * delta_ij;
                    sigma[i][j] = dev * factor + p_mean * delta_ij;
                }
            }
        } else {
            for (int i = 0; i < 3; ++i) {
                for (int j = 0; j < 3; ++j) {
                    sigma[i][j] *= factor;
                }
            }
        }
    }
}

// --- 8. Weakly Compressible & Shock Tait Fluid Model ---
template <typename T>
HD_MAT_FUNC void update_constitutive_tait_fluid(
    T B, T gamma, T rho0, T mu_visc, T p_cav, T gruneisen, int variant,
    T J, T dt, T h_elem, T e_int,
    const T d_eps[3][3],
    T sigma[3][3],
    T& p_out,
    T b1_visc = static_cast<T>(0.06),
    T b2_visc = static_cast<T>(1.20),
    T p0 = static_cast<T>(0.0)
) {
    using std::abs;
    using std::max;

    // Density from Jacobian determinant J = V / V0 = rho0 / rho (Directive 19 asymptotic cutoff J >= 0.45 corresponding to physical water compression limit >60 GPa)
    T J_clamped = max(static_cast<T>(0.45), J);
    T rho = rho0 / J_clamped;

    // Fluid cavitation floor: fluids cannot sustain macroscopic tension.
    // In absolute pressure systems (p0 > 0), pressure cannot drop below vacuum (0 Pa).
    // In gauge pressure systems (p0 == 0), cavitation cutoff is bounded by p_cav.
    T p_cav_eff = (p0 > static_cast<T>(0.0)) ? max(static_cast<T>(0.0), p_cav) : p_cav;

    // Compute hydrostatic pressure from Tait EOS variant
    T p;
    if (variant == 1) { // Caloric Gruneisen
        p = TaitEOSWater::compute_pressure_caloric(rho, e_int, B, gamma, rho0, gruneisen, p_cav_eff, p0);
    } else if (variant == 2) { // Shock Hugoniot
        p = TaitEOSWater::compute_pressure_hugoniot(rho, e_int, static_cast<T>(1482.0), static_cast<T>(1.75), rho0, gruneisen, p_cav_eff);
    } else { // Isentropic
        p = TaitEOSWater::compute_pressure_isentropic(rho, B, gamma, rho0, p_cav_eff, p0);
    }

    // Volumetric strain rate and sound speed for artificial bulk viscosity
    T tr_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    T dt_safe = max(static_cast<T>(1e-12), dt);
    T tr_D = tr_deps / dt_safe;
    T c = TaitEOSWater::compute_sound_speed_isentropic(rho, B, gamma, rho0);

    T q_visc = static_cast<T>(0.0);
    if (tr_D < static_cast<T>(0.0)) { // Compressive shock
        // Only activate linear viscosity if compressive strain rate exceeds acoustic threshold
        // to prevent overdamping smooth hydrodynamic flows (e.g. bubble pulsation/collapse).
        T M_comp = h_elem * abs(tr_D) / max(static_cast<T>(1.0), c);
        T b1_eff = (M_comp > static_cast<T>(0.02)) ? b1_visc : (b1_visc * static_cast<T>(50.0) * M_comp);
        T b2_eff = (M_comp > static_cast<T>(0.05)) ? b2_visc : (b2_visc * (M_comp * static_cast<T>(20.0)));
        q_visc = b1_eff * rho * c * h_elem * abs(tr_D) + b2_eff * rho * h_elem * h_elem * tr_D * tr_D;
        using std::min;
        T q_visc_max = static_cast<T>(1.5) * rho * c * min(static_cast<T>(2500.0), h_elem * abs(tr_D));
        q_visc = min(q_visc_max, q_visc);
    }
    T p_total = max(p_cav_eff, p + q_visc);
    p_out = p_total;

    // Deviatoric strain rate for Newtonian viscosity
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * tr_deps * delta_ij;
            T D_dev = d_dev / dt_safe;
            T s_dev = static_cast<T>(2.0) * mu_visc * D_dev;
            sigma[i][j] = s_dev - delta_ij * p_total;
        }
    }
}

// --- Mie-Grüneisen compression pressure (mu = rho/rho0 - 1 > 0) ---
// Shock-Hugoniot reference curve with a linear tangent extension beyond mu_max = 0.85 / (s - 1)
// (keeps the denominator 1 - (s - 1)·mu away from its singularity).
//
//   p = p_H(mu) + mu · Γ0 · ρ0 · e_pl = p_H(mu) + Γ0 · (ρ - ρ0) · e_pl
//
// Because MPM tracks mechanical volume J = V/V0 where J = 1 (mu = 0, ρ = ρ0) is the unstressed
// thermally relaxed state at current temperature T (p(0, e_pl) = 0), compressing the heated
// solid to ρ = ρ0·(1 + mu) produces the differential Grüneisen thermal pressure Γ0·(ρ - ρ0)·e_pl
// without introducing a multi-GPa step discontinuity across J = 1.0.
template <typename T>
HD_MAT_FUNC T mie_gruneisen_compression_pressure(T rho0, T c0, T s, T gamma0, T mu_vol, T e_pl) {
    using std::max; using std::min;
    const T s_minus_1 = max(s - static_cast<T>(1.0), static_cast<T>(0.05));
    const T mu_max = static_cast<T>(0.85) / s_minus_1;
    const T mu_eff = min(mu_vol, mu_max);
    const T denom = max(static_cast<T>(0.15), static_cast<T>(1.0) - s_minus_1 * mu_eff);
    T p_H = (rho0 * c0 * c0 * mu_eff * (static_cast<T>(1.0) + (static_cast<T>(1.0) - static_cast<T>(0.5) * gamma0) * mu_eff)) / (denom * denom);
    if (mu_vol > mu_max) {
        const T K_high = rho0 * c0 * c0 * (static_cast<T>(1.0) + static_cast<T>(2.0) * s * mu_max);
        p_H += K_high * (mu_vol - mu_max);
    }
    return p_H + max(static_cast<T>(0.0), mu_vol) * gamma0 * rho0 * e_pl;
}

// --- Johnson-Cook triaxiality fracture-strain ratio ---
//   ratio(σ*) = [d1 + d2·exp(d3·σ*)] / [d1 + d2·exp(d3/3)]
// i.e. the JC fracture locus normalised to uniaxial tension (σ* = 1/3), so that the user's
// calibrated `failure_strain` is the uniaxial-tension anchor and the full JC pressure dependence
// is retained. Under confined compression (σ* << 0, d3 < 0) the ratio grows exponentially, which
// is the physical reason hardened penetrator noses survive multi-GPa confinement.
// Only a lower realizability floor is applied (no artificial upper cap).
template <typename T>
HD_MAT_FUNC T jc_fracture_triaxiality_ratio(T d1, T d2, T d3, T sigma_star) {
    using std::max; using std::min;
    const T arg_ref = max(static_cast<T>(-30.0), min(static_cast<T>(30.0), d3 * static_cast<T>(1.0 / 3.0)));
    const T arg_tri = max(static_cast<T>(-30.0), min(static_cast<T>(30.0), d3 * sigma_star));
    const T d_ref = max(static_cast<T>(0.05), d1 + d2 * std::exp(arg_ref));
    const T d_tri = max(static_cast<T>(0.02), d1 + d2 * std::exp(arg_tri));
    return max(d_tri / d_ref, static_cast<T>(0.15));
}

// --- Residual shear strength of fractured (failed) metal ---
// A fractured metal under compression is a confined, interlocked granular aggregate and transmits
// shear by intergranular Coulomb friction (Drucker-Prager q <= M·p); it carries zero shear in
// tension (open cracks) and zero shear once molten. The residual strength can never exceed the
// intact quasi-static yield stress.
//   q_res = min(M_FRACTURED_METAL · max(p, 0), sigma_y_intact),  M = 0.6 (φ ≈ 16°, conservative
//   relative to Byerlee / dry metal-on-metal friction μ ≈ 0.6 which gives M ≈ 1.2).
template <typename T>
HD_MAT_FUNC T fractured_metal_residual_strength(T p_comp, T sigma_y_intact, bool melted) {
    using std::max; using std::min;
    if (melted) return static_cast<T>(0.0);
    const T M_fractured_metal = static_cast<T>(0.60);
    return min(M_fractured_metal * max(p_comp, static_cast<T>(0.0)), max(sigma_y_intact, static_cast<T>(0.0)));
}

// --- 9. Cowper-Symonds Viscoplastic J2 Plasticity (*MAT_024) ---
template <typename T>
HD_MAT_FUNC void update_constitutive_cowper_symonds_j2(
    T E, T nu, T sigma_y0, T H_prime,
    T cs_C, T cs_P, T eps_dot,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& ep_bar
) {
    T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    p -= K * trace_deps;

    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
        }
    }

    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0] * s_trial[0][0] + s_trial[1][1] * s_trial[1][1] + s_trial[2][2] * s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1] * s_trial[0][1] + s_trial[0][2] * s_trial[0][2] + s_trial[1][2] * s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(3.0) * J2));

    T rate_factor = static_cast<T>(1.0);
    if (cs_C > static_cast<T>(0.0) && cs_P > static_cast<T>(0.0) && eps_dot > static_cast<T>(0.0)) {
        T inv_p = static_cast<T>(1.0) / std::max(static_cast<T>(0.05), cs_P);
        rate_factor = static_cast<T>(1.0) + std::pow(eps_dot / cs_C, inv_p);
    }

    T sigma_y_stat = sigma_y0 + H_prime * ep_bar;
    T current_yield = sigma_y_stat * rate_factor;
    if (sigma_eq_trial > current_yield) {
        T H_eff = H_prime * rate_factor;
        T d_gamma = (sigma_eq_trial - current_yield) / std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G + H_eff);
        ep_bar += d_gamma;
        T yield_post = (sigma_y0 + H_prime * ep_bar) * rate_factor;
        T factor = std::min(static_cast<T>(1.0), yield_post / (sigma_eq_trial + static_cast<T>(1.0e-12)));
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- 10. Johnson-Holmquist II (JH-2) Brittle Ceramic & Glass Model (*MAT_110) ---
template <typename T>
HD_MAT_FUNC void update_constitutive_jh2(
    T G, T eps_dot, T J,
    T jh2_sigma_hel, T jh2_p_hel, T jh2_t_max,
    T jh2_A, T jh2_N, T jh2_B, T jh2_M, T jh2_C,
    T jh2_D1, T jh2_D2,
    T jh2_K1, T jh2_K2, T jh2_K3, T jh2_beta,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& ep_bar,
    T& damage,
    T& delta_P
) {
    const T J_safe = std::max(static_cast<T>(0.05), J);
    const T mu = (static_cast<T>(1.0) / J_safe) - static_cast<T>(1.0);
    const T K1_safe = std::max(static_cast<T>(1.0e6), jh2_K1);

    T P_eos = (mu >= static_cast<T>(0.0))
        ? (K1_safe * mu + jh2_K2 * mu * mu + jh2_K3 * mu * mu * mu)
        : (K1_safe * mu);

    p = P_eos + std::max(static_cast<T>(0.0), delta_P);
    const T p_min = -std::max(static_cast<T>(0.0), jh2_t_max) * std::max(static_cast<T>(0.0), static_cast<T>(1.0) - damage);
    if (p < p_min) p = p_min;

    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
        }
    }

    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0] * s_trial[0][0] + s_trial[1][1] * s_trial[1][1] + s_trial[2][2] * s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1] * s_trial[0][1] + s_trial[0][2] * s_trial[0][2] + s_trial[1][2] * s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(3.0) * J2));

    const T p_hel_safe = std::max(static_cast<T>(1.0e5), jh2_p_hel);
    const T sig_hel_safe = std::max(static_cast<T>(1.0e5), jh2_sigma_hel);
    const T P_star = p / p_hel_safe;
    const T T_star = std::max(static_cast<T>(0.0), jh2_t_max) / p_hel_safe;
    const T p_plus_t = std::max(static_cast<T>(0.0), P_star + T_star);
    const T rate_term = static_cast<T>(1.0) + jh2_C * std::log(std::max(static_cast<T>(1.0), eps_dot));

    const T sig_star_i = (p_plus_t > static_cast<T>(0.0))
        ? (jh2_A * std::pow(p_plus_t, std::max(static_cast<T>(0.0), jh2_N)) * rate_term)
        : static_cast<T>(0.0);
    const T sig_star_f = (P_star > static_cast<T>(0.0))
        ? (jh2_B * std::pow(P_star, std::max(static_cast<T>(0.0), jh2_M)) * rate_term)
        : static_cast<T>(0.0);

    const T d_clamped = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), damage));
    const T sig_y_old = std::max(static_cast<T>(0.0), ((static_cast<T>(1.0) - d_clamped) * sig_star_i + d_clamped * sig_star_f) * sig_hel_safe);

    if (sigma_eq_trial > sig_y_old) {
        const T G_safe = std::max(static_cast<T>(1.0), G);
        const T d_ep = (sigma_eq_trial - sig_y_old) / (static_cast<T>(3.0) * G_safe);
        ep_bar += d_ep;

        T sig_y_final = sig_y_old;
        if (d_clamped < static_cast<T>(1.0)) {
            const T eps_f = std::max(static_cast<T>(1.0e-5), jh2_D1 * std::pow(std::max(static_cast<T>(1.0e-6), p_plus_t), std::max(static_cast<T>(0.0), jh2_D2)));
            const T d_new = std::min(static_cast<T>(1.0), d_clamped + d_ep / eps_f);
            if (d_new > d_clamped) {
                damage = d_new;
                const T sig_y_new = std::max(static_cast<T>(0.0), ((static_cast<T>(1.0) - d_new) * sig_star_i + d_new * sig_star_f) * sig_hel_safe);
                sig_y_final = sig_y_new;

                if (jh2_beta > static_cast<T>(0.0) && mu > static_cast<T>(0.0)) {
                    const T dU = std::max(static_cast<T>(0.0), (sig_y_old * sig_y_old - sig_y_new * sig_y_new) / (static_cast<T>(6.0) * G_safe));
                    if (dU > static_cast<T>(0.0)) {
                        const T dP_old = std::max(static_cast<T>(0.0), delta_P);
                        const T term = K1_safe * mu + dP_old;
                        const T dP_new = std::max(dP_old, -K1_safe * mu + std::sqrt(std::max(static_cast<T>(0.0), term * term + static_cast<T>(2.0) * jh2_beta * K1_safe * dU)));
                        delta_P = dP_new;
                        p += (dP_new - dP_old);
                    }
                }
            }
        }

        const T factor = (sigma_eq_trial > static_cast<T>(1.0e-12)) ? (sig_y_final / sigma_eq_trial) : static_cast<T>(0.0);
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- 11. Deshpande-Fleck Isotropic Crushable Foam (*MAT_063 / *MAT_154) ---
template <typename T>
HD_MAT_FUNC void update_constitutive_crushable_foam(
    T E, T nu,
    T sigma_plateau, T eps_lock, T alpha_foam, T H_foam, T tensile_cutoff,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p,
    T& eps_v_p,
    T& ep_bar
) {
    const T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    const T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    const T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    const T p_trial = p - K * trace_deps;
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
        }
    }

    const T J2 = static_cast<T>(0.5) * (
        s_trial[0][0] * s_trial[0][0] + s_trial[1][1] * s_trial[1][1] + s_trial[2][2] * s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1] * s_trial[0][1] + s_trial[0][2] * s_trial[0][2] + s_trial[1][2] * s_trial[1][2])
    );
    const T q_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(3.0) * J2));

    const T alpha_safe = std::max(static_cast<T>(0.05), alpha_foam);
    const T alpha2 = alpha_safe * alpha_safe;
    const T beta2 = static_cast<T>(1.0) / (static_cast<T>(1.0) + alpha2 / static_cast<T>(9.0));
    const T lock_safe = std::max(static_cast<T>(0.05), eps_lock);
    const T evp_old = std::max(static_cast<T>(0.0), eps_v_p);
    const T ten_cut = std::max(static_cast<T>(0.0), tensile_cutoff);

    const T r0 = evp_old / lock_safe;
    const T exp_arg0 = std::min(static_cast<T>(10.0), static_cast<T>(5.0) * r0 * r0);
    const T sig_c0 = std::max(
        static_cast<T>(1.0),
        sigma_plateau + H_foam * evp_old + static_cast<T>(0.05) * sigma_plateau * (std::exp(exp_arg0) - static_cast<T>(1.0))
    );

    // Tensile cutoff regime
    if (ten_cut > static_cast<T>(0.0) && p_trial < -ten_cut) {
        p = -ten_cut;
        const T q_max = std::sqrt(std::max(static_cast<T>(0.0), (sig_c0 * sig_c0) / beta2 - alpha2 * p * p));
        const T factor = (q_trial > q_max && q_trial > static_cast<T>(1.0e-12)) ? (q_max / q_trial) : static_cast<T>(1.0);
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = s_trial[i][j] * factor;
        return;
    }

    const T sig_e_trial = std::sqrt(beta2 * (q_trial * q_trial + alpha2 * p_trial * p_trial));
    if (sig_e_trial <= sig_c0) {
        p = p_trial;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = s_trial[i][j];
        return;
    }

    // Implicit closest-point return in (p, q) elliptical space
    const T denom_q_inv = static_cast<T>(3.0) * G * beta2;
    const T denom_p_inv = K * beta2 * alpha2;
    const T K_safe = std::max(static_cast<T>(1.0), K);

    T x = (sig_e_trial - sig_c0) / std::max(static_cast<T>(1.0), sig_c0 * (denom_q_inv + denom_p_inv));
    for (int it = 0; it < 6; ++it) {
        const T inv_q = static_cast<T>(1.0) / (static_cast<T>(1.0) + denom_q_inv * x);
        const T inv_p = static_cast<T>(1.0) / (static_cast<T>(1.0) + denom_p_inv * x);
        const T qx = q_trial * inv_q;
        const T px = p_trial * inv_p;
        const T fx_e = std::sqrt(std::max(static_cast<T>(0.0), beta2 * (qx * qx + alpha2 * px * px)));
        const T d_evp = std::max(static_cast<T>(0.0), (p_trial - px) / K_safe);
        const T evp_it = evp_old + d_evp;
        const T r_it = evp_it / lock_safe;
        const T exp_arg = std::min(static_cast<T>(10.0), static_cast<T>(5.0) * r_it * r_it);
        const T exp_val = std::exp(exp_arg);
        const T sig_c_it = sigma_plateau + H_foam * evp_it + static_cast<T>(0.05) * sigma_plateau * (exp_val - static_cast<T>(1.0));
        const T res = fx_e - sig_c_it;
        if (std::abs(res) <= static_cast<T>(1.0e-5) * sig_c_it) break;

        const T dqx = -qx * denom_q_inv * inv_q;
        const T dpx = -px * denom_p_inv * inv_p;
        const T dfx_e = beta2 * (qx * dqx + alpha2 * px * dpx) / std::max(static_cast<T>(1.0e-6), fx_e);
        const T d_evp_dx = (p_trial > static_cast<T>(0.0)) ? (-dpx / K_safe) : static_cast<T>(0.0);
        const T dsig_devp = H_foam + (exp_arg < static_cast<T>(10.0)
            ? (static_cast<T>(0.5) * sigma_plateau * (r_it / lock_safe) * exp_val)
            : static_cast<T>(0.0));
        const T dres = dfx_e - dsig_devp * d_evp_dx;
        x = std::max(static_cast<T>(0.0), x - res / std::min(static_cast<T>(-1.0e-12), dres));
    }

    const T q_scale = static_cast<T>(1.0) / (static_cast<T>(1.0) + denom_q_inv * x);
    const T p_new = p_trial / (static_cast<T>(1.0) + denom_p_inv * x);
    const T d_evp_final = std::max(static_cast<T>(0.0), (p_trial - p_new) / K_safe);
    const T d_eq_final = q_trial * (static_cast<T>(1.0) - q_scale) / std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G);

    p = p_new;
    eps_v_p = evp_old + d_evp_final;
    ep_bar += std::sqrt(d_evp_final * d_evp_final + d_eq_final * d_eq_final);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            s_dev[i][j] = s_trial[i][j] * q_scale;
}

// --- 12. Steinberg-Guinan High-Pressure Metal Viscoplasticity (*MAT_011) ---
template <typename T>
HD_MAT_FUNC void update_constitutive_steinberg_guinan(
    T G0, T T_curr, T T_melt, T J,
    T sg_Y0, T sg_Ymax, T sg_beta, T sg_n, T sg_bp, T sg_bT,
    T p_curr,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& ep_bar
) {
    if (T_melt > static_cast<T>(0.0) && T_curr >= T_melt) {
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = static_cast<T>(0.0);
        return;
    }

    const T J_safe = std::max(static_cast<T>(0.05), J);
    const T eta = std::max(static_cast<T>(0.1), static_cast<T>(1.0) / J_safe);
    const T eta_m13 = std::pow(eta, static_cast<T>(-1.0 / 3.0));
    const T p_pos = std::max(static_cast<T>(0.0), p_curr);

    const T g_mod_factor = std::max(
        static_cast<T>(0.05),
        static_cast<T>(1.0) + sg_bp * p_pos * eta_m13 - std::abs(sg_bT) * (T_curr - static_cast<T>(300.0))
    );
    const T G_eff = G0 * g_mod_factor;

    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G_eff * d_dev;
        }
    }

    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0] * s_trial[0][0] + s_trial[1][1] * s_trial[1][1] + s_trial[2][2] * s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1] * s_trial[0][1] + s_trial[0][2] * s_trial[0][2] + s_trial[1][2] * s_trial[1][2])
    );
    T sigma_eq_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(3.0) * J2));

    const T base0 = std::max(static_cast<T>(1.0), static_cast<T>(1.0) + sg_beta * std::max(static_cast<T>(0.0), ep_bar));
    const T work0 = sg_Y0 * std::pow(base0, sg_n);
    const T Y_work = (sg_Ymax > static_cast<T>(0.0)) ? std::min(work0, sg_Ymax) : work0;
    const T Y_eff = Y_work * g_mod_factor;
    if (sigma_eq_trial > Y_eff) {
        const T H_sg = (sg_Ymax <= static_cast<T>(0.0) || work0 < sg_Ymax)
            ? (Y_eff * sg_n * sg_beta / std::max(static_cast<T>(1.0), base0))
            : static_cast<T>(0.0);
        const T d_gamma = (sigma_eq_trial - Y_eff) / std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G_eff + H_sg);
        ep_bar += d_gamma;
        const T base_post = std::max(static_cast<T>(1.0), static_cast<T>(1.0) + sg_beta * std::max(static_cast<T>(0.0), ep_bar));
        const T work_post = sg_Y0 * std::pow(base_post, sg_n);
        const T Y_work_post = (sg_Ymax > static_cast<T>(0.0)) ? std::min(work_post, sg_Ymax) : work_post;
        const T Y_post = Y_work_post * g_mod_factor;
        const T factor = std::min(static_cast<T>(1.0), Y_post / (sigma_eq_trial + static_cast<T>(1.0e-12)));
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

} // namespace Blast::Materials

