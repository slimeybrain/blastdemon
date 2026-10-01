#pragma once

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_GEO_FUNC __host__ __device__
#else
#define HD_GEO_FUNC inline
#endif

namespace Blast::Materials {

template <typename T>
struct DruckerPragerParams {
    T cohesion{static_cast<T>(20.0e3)};        // Cohesion c (Pa)
    T friction_angle{static_cast<T>(0.5235987756)}; // Friction angle phi (radians, 30 deg)
    T dilatancy_angle{static_cast<T>(0.0)};     // Dilatancy angle psi (radians, 0 deg)
    T tensile_cutoff{static_cast<T>(10.0e3)};   // Tensile stress cutoff (Pa)
    T H_plastic{static_cast<T>(0.0)};          // Plastic hardening modulus (Pa)

    HD_GEO_FUNC T alpha() const {
        T s_phi = std::sin(friction_angle);
        return (static_cast<T>(2.0) * s_phi) / (std::sqrt(static_cast<T>(3.0)) * (static_cast<T>(3.0) - s_phi));
    }

    HD_GEO_FUNC T k() const {
        T s_phi = std::sin(friction_angle);
        T c_phi = std::cos(friction_angle);
        return (static_cast<T>(6.0) * cohesion * c_phi) / (std::sqrt(static_cast<T>(3.0)) * (static_cast<T>(3.0) - s_phi));
    }

    HD_GEO_FUNC T M_dp() const {
        return static_cast<T>(3.0) * std::sqrt(static_cast<T>(3.0)) * alpha();
    }

    HD_GEO_FUNC T c_dp() const {
        return std::sqrt(static_cast<T>(3.0)) * k();
    }

    HD_GEO_FUNC T p_apex() const {
        T m = M_dp();
        return (m > static_cast<T>(1.0e-9)) ? (c_dp() / m) : static_cast<T>(1.0e9);
    }
};

// --- Drucker-Prager Soil Mechanics with Conical Return Mapping & Tension Cutoff ---
template <typename T>
HD_GEO_FUNC void update_constitutive_drucker_prager(
    T E, T nu, const DruckerPragerParams<T>& params,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p_hydro,
    T& ep_bar,
    bool update_elastic_trial = true
) {
    T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    if (update_elastic_trial) {
        // Hydrostatic pressure update (compression positive)
        p_hydro -= K * trace_deps;
    }

    // Tension cutoff
    if (p_hydro < -params.tensile_cutoff) {
        p_hydro = -params.tensile_cutoff;
    }

    // Trial deviatoric stress
    T s_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            if (update_elastic_trial) {
                T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
                T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
                s_trial[i][j] = s_dev[i][j] + static_cast<T>(2.0) * G * d_dev;
            } else {
                s_trial[i][j] = s_dev[i][j];
            }
        }
    }

    // Second deviatoric invariant J2 and equivalent shear stress q
    T J2 = static_cast<T>(0.5) * (
        s_trial[0][0]*s_trial[0][0] + s_trial[1][1]*s_trial[1][1] + s_trial[2][2]*s_trial[2][2] +
        static_cast<T>(2.0) * (s_trial[0][1]*s_trial[0][1] + s_trial[0][2]*s_trial[0][2] + s_trial[1][2]*s_trial[1][2])
    );
    T q_trial = std::sqrt(static_cast<T>(3.0) * J2);

    // Conical yield shear strength q_yield = c_dp + M_dp * p_hydro
    T q_yield = params.c_dp() + params.M_dp() * p_hydro;
    if (q_yield < static_cast<T>(0.0)) {
        q_yield = static_cast<T>(0.0);
    }

    // Radial return mapping
    if (q_trial > q_yield && q_trial > static_cast<T>(1.0e-9)) {
        T d_lambda = (q_trial - q_yield) / (static_cast<T>(3.0) * G + params.H_plastic);
        T scale = q_yield / q_trial;
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * scale;
            }
        }
        ep_bar += d_lambda;

        // Dilatancy: plastic volume expansion decreases compressive pressure
        if (params.dilatancy_angle > static_cast<T>(1.0e-6)) {
            p_hydro += K * std::sin(params.dilatancy_angle) * d_lambda;
        }
    } else {
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j];
            }
        }
    }
}

// --- Analytical Seismic Wave Mechanics in Geotechnical Media ---
template <typename T>
struct SeismicWaveAcoustics {
    static HD_GEO_FUNC T compute_p_wave_speed(T K, T G, T rho) {
        return std::sqrt((K + static_cast<T>(4.0 / 3.0) * G) / rho);
    }

    static HD_GEO_FUNC T compute_s_wave_speed(T G, T rho) {
        return std::sqrt(G / rho);
    }

    static HD_GEO_FUNC T compute_impedance(T rho, T c) {
        return rho * c;
    }

    static HD_GEO_FUNC T transmission_coeff(T Z1, T Z2) {
        return (static_cast<T>(2.0) * Z2) / (Z1 + Z2);
    }

    static HD_GEO_FUNC T reflection_coeff(T Z1, T Z2) {
        return (Z2 - Z1) / (Z1 + Z2);
    }

    static HD_GEO_FUNC T energy_partition_error(T Z1, T Z2) {
        T T_coeff = transmission_coeff(Z1, Z2);
        T R_coeff = reflection_coeff(Z1, Z2);
        T E_trans = (Z1 / Z2) * T_coeff * T_coeff;
        T E_refl = R_coeff * R_coeff;
        return std::abs((E_trans + E_refl) - static_cast<T>(1.0));
    }
};

} // namespace Blast::Materials
