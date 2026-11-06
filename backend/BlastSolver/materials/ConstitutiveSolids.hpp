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
    T T_homo = (T_curr - T_room) / (T_melt - T_room + 1e-6f);
    T_homo = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), T_homo));
    T thermal_factor = static_cast<T>(1.0) - std::pow(T_homo, m);

    // Strain rate factor (reference eps_dot_0 = 1.0 s^-1)
    T eps_dot_norm = std::max(static_cast<T>(1.0), eps_dot);
    T rate_factor = static_cast<T>(1.0) + C * std::log(eps_dot_norm);

    // Strain hardening
    T strain_factor = A + B * std::pow(std::max(static_cast<T>(0.0), ep_bar), n);
    T current_yield = strain_factor * rate_factor * thermal_factor;

    T f_yield = sigma_eq_trial - current_yield;
    if (f_yield > static_cast<T>(0.0)) {
        T d_gamma = f_yield / (static_cast<T>(3.0) * G);
        T factor = current_yield / (sigma_eq_trial + 1e-12f);

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

    // Strain hardening
    T strain_factor = A + B * std::pow(std::max(static_cast<T>(0.0), ep_bar), n);
    T current_yield = strain_factor * rate_factor * thermal_factor;

    T f_yield = sigma_eq_trial - current_yield;
    if (f_yield > static_cast<T>(0.0)) {
        T d_gamma = f_yield / (static_cast<T>(3.0) * G);
        T factor = current_yield / (sigma_eq_trial + static_cast<T>(1e-12));

        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * factor;
            }
        }
        ep_bar += d_gamma;

        // Triaxiality-dependent fracture strain (Johnson-Cook failure criterion)
        // eta = sigma_m / sigma_eq = -p / sigma_eq
        T sigma_m = -p;
        T eta = sigma_m / (sigma_eq_trial + static_cast<T>(1e-12));
        eta = std::max(static_cast<T>(-5.0), std::min(static_cast<T>(5.0), eta));

        T eps_f = (d1 + d2 * std::exp(d3 * eta)) *
                  (static_cast<T>(1.0) + d4 * std::log(eps_dot_norm)) *
                  (static_cast<T>(1.0) + d5 * T_homo);
        eps_f = std::max(static_cast<T>(1e-4), eps_f);

        damage += d_gamma / eps_f;
        if (damage >= static_cast<T>(1.0)) {
            damage = static_cast<T>(1.0);
            has_failed = true;
            for (int i = 0; i < 3; ++i)
                for (int j = 0; j < 3; ++j)
                    s_dev[i][j] = static_cast<T>(0.0);
            if (p < static_cast<T>(0.0)) p = static_cast<T>(0.0);
        } else if (damage > static_cast<T>(0.0)) {
            // Continuum damage degradation: (1 - D)
            T deg = static_cast<T>(1.0) - damage;
            for (int i = 0; i < 3; ++i)
                for (int j = 0; j < 3; ++j)
                    s_dev[i][j] *= deg;
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
    // 1. Unilateral Crack Closure Recovery Formulation:
    // Strains decompose into tensile and compressive projections
    T trace = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];
    T G0 = E0 / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K0 = E0 / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0)*nu));

    // Elastic trial update
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? 1.0f : 0.0f;
            sigma[i][j] += 2.0f * G0 * (d_eps[i][j] - (1.0f/3.0f)*trace*delta_ij) + K0 * trace * delta_ij;
        }
    }

    // Principal stress evaluation for tension/compression split
    T p_mean = (sigma[0][0] + sigma[1][1] + sigma[2][2]) / 3.0f;
    if (p_mean >= 0.0f) {
        // Tension regime: accumulate tensile damage
        T eps_t_max = (2.0f * G_f) / (f_t0 * l_ch + 1e-12f);
        ep_t += std::abs(trace);
        if (ep_t > f_t0 / E0) {
            d_t = std::min(static_cast<T>(0.99), static_cast<T>((ep_t - f_t0/E0) / (eps_t_max + 1e-12f)));
        }
    } else {
        // Compression regime: unilateral crack closure recovers 100% of elastic contact
        // d_t is deactivated in compression, only compressive crushing d_c applies
        ep_c += std::abs(trace);
        T eps_c_peak = f_c0 / E0;
        if (ep_c > eps_c_peak) {
            d_c = std::min(static_cast<T>(0.95), static_cast<T>((ep_c - eps_c_peak) / (4.0f * eps_c_peak)));
        }
    }

    // Degradation factor (1 - d)
    T one_minus_d = (p_mean >= 0.0f) ? (1.0f - d_t) : (1.0f - d_c);
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            sigma[i][j] *= one_minus_d;
        }
    }
}

// --- 7. Orthotropic Yield: Hill48 Model ---
template <typename T>
HD_MAT_FUNC void update_constitutive_hill48(
    T F_h, T G_h, T H_h, T L_h, T M_h, T N_h,
    T sigma_y0,
    const T d_eps[3][3],
    T sigma[3][3],
    T& ep_bar
) {
    (void)d_eps;
    // Hill's 1948 quadratic anisotropic yield:
    // 2*f = F*(syy - szz)^2 + G*(szz - sxx)^2 + H*(sxx - syy)^2 + 2*L*syz^2 + 2*M*szx^2 + 2*N*sxy^2
    T sxx = sigma[0][0];
    T syy = sigma[1][1];
    T szz = sigma[2][2];
    T sxy = sigma[0][1];
    T syz = sigma[1][2];
    T szx = sigma[0][2];

    T hill_val = F_h * (syy - szz)*(syy - szz) +
                 G_h * (szz - sxx)*(szz - sxx) +
                 H_h * (sxx - syy)*(sxx - syy) +
                 static_cast<T>(2.0) * (L_h*syz*syz + M_h*szx*szx + N_h*sxy*sxy);

    T sigma_hill = std::sqrt(hill_val);
    if (sigma_hill > sigma_y0) {
        T factor = sigma_y0 / (sigma_hill + 1e-12f);
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                sigma[i][j] *= factor;
            }
        }
        ep_bar += (sigma_hill - sigma_y0) / (210.0e9f * 0.01f);
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
    using std::max;
    const T d_ref = max(static_cast<T>(0.05), d1 + d2 * std::exp(d3 * static_cast<T>(1.0 / 3.0)));
    const T d_tri = max(static_cast<T>(0.02), d1 + d2 * std::exp(d3 * sigma_star));
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

} // namespace Blast::Materials

