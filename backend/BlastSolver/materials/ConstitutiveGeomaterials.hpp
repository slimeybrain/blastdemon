#pragma once

#include <cmath>
#include <algorithm>
#include "ConstitutiveSolids.hpp"

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

    // Conical yield shear strength q_yield = c_dp + H_plastic * ep_bar + M_dp * p_hydro
    T M_dp = params.M_dp();
    T c_curr = params.c_dp() + params.H_plastic * ep_bar;
    T q_yield = c_curr + M_dp * p_hydro;
    if (q_yield < static_cast<T>(0.0)) {
        q_yield = static_cast<T>(0.0);
    }

    // Radial / non-associated return mapping
    if (q_trial > q_yield && q_trial > static_cast<T>(1.0e-9)) {
        T s_psi = std::sin(std::max(static_cast<T>(0.0), params.dilatancy_angle));
        T M_psi = (params.dilatancy_angle > static_cast<T>(1.0e-6))
            ? (static_cast<T>(6.0) * s_psi) / (static_cast<T>(3.0) - s_psi)
            : static_cast<T>(0.0);
        T denom = std::max(
            static_cast<T>(1.0),
            static_cast<T>(3.0) * G + K * M_dp * M_psi + params.H_plastic
        );
        T d_lambda = (q_trial - q_yield) / denom;
        ep_bar += d_lambda;

        // Dilatancy: plastic volume expansion (deps_v^p = M_psi * d_lambda > 0)
        // increases compressive elastic back-pressure under confined shear: p_new = p_trial + K * deps_v^p
        if (M_psi > static_cast<T>(0.0)) {
            p_hydro += K * M_psi * d_lambda;
            if (p_hydro < -params.tensile_cutoff) {
                p_hydro = -params.tensile_cutoff;
            }
        }

        T q_target = std::max(
            static_cast<T>(0.0),
            params.c_dp() + params.H_plastic * ep_bar + M_dp * p_hydro
        );
        T scale = std::min(static_cast<T>(1.0), q_target / q_trial);
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                s_dev[i][j] = s_trial[i][j] * scale;
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

// --- 2. Hexagonal Mohr-Coulomb Soil/Rock with Rankine Tension Cutoff ---
template <typename T>
HD_GEO_FUNC void update_constitutive_mohr_coulomb(
    T E, T nu, const DruckerPragerParams<T>& params,
    const T d_eps[3][3],
    T sigma[3][3],
    T& ep_bar
) {
    const T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    const T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    const T lam = K - static_cast<T>(2.0 / 3.0) * G;
    const T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    T sig_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            sig_trial[i][j] = sigma[i][j] + static_cast<T>(2.0) * G * d_dev + K * trace_deps * delta_ij;
        }
    }

    T s_evals[3], vecs[3][3];
    sym3_eigen(sig_trial, s_evals, vecs);
    // Ordered principal stresses: s_evals[0] >= s_evals[1] >= s_evals[2] (tension positive)
    const T s0_tr = s_evals[0];
    const T s1_tr = s_evals[1];
    const T s2_tr = s_evals[2];

    const T s_phi = std::sin(std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.52), params.friction_angle)));
    const T s_psi = std::sin(std::max(static_cast<T>(0.0), std::min(s_phi, params.dilatancy_angle)));
    const T N_phi = (static_cast<T>(1.0) + s_phi) / std::max(static_cast<T>(1.0e-4), static_cast<T>(1.0) - s_phi);
    const T N_psi = (static_cast<T>(1.0) + s_psi) / std::max(static_cast<T>(1.0e-4), static_cast<T>(1.0) - s_psi);

    const T coh_curr = std::max(static_cast<T>(0.0), params.cohesion + params.H_plastic * ep_bar);
    const T sig_c = static_cast<T>(2.0) * coh_curr * std::sqrt(N_phi);
    const T H_mc = params.H_plastic * static_cast<T>(2.0) * std::sqrt(N_phi);

    // Physical Mohr-Coulomb apex limit vs user tensile cutoff
    const T s_apex = (s_phi > static_cast<T>(1.0e-4))
        ? (sig_c / std::max(static_cast<T>(1.0e-6), N_phi - static_cast<T>(1.0)))
        : static_cast<T>(1.0e12);
    const T sig_t = (params.tensile_cutoff >= static_cast<T>(0.0))
        ? std::min(params.tensile_cutoff, s_apex)
        : s_apex;

    T s0 = s0_tr, s1 = s1_tr, s2 = s2_tr;
    const T f_mc_tr = N_phi * s0_tr - s2_tr - sig_c;

    if (f_mc_tr > static_cast<T>(0.0)) {
        // Elastic return matrix entries D * m for main face flow m = (N_psi, 0, -1)
        const T dm0 = static_cast<T>(2.0) * G * N_psi + lam * (N_psi - static_cast<T>(1.0));
        const T dm1 = lam * (N_psi - static_cast<T>(1.0));
        const T dm2 = -static_cast<T>(2.0) * G + lam * (N_psi - static_cast<T>(1.0));
        const T d_face = std::max(static_cast<T>(1.0), N_phi * dm0 - dm2 + H_mc);
        const T dl_face = f_mc_tr / d_face;

        const T s0_f = s0_tr - dl_face * dm0;
        const T s1_f = s1_tr - dl_face * dm1;
        const T s2_f = s2_tr - dl_face * dm2;

        if (s0_f >= s1_f - static_cast<T>(1.0e-6) * std::abs(s0_f + s1_f + static_cast<T>(1.0)) &&
            s1_f >= s2_f - static_cast<T>(1.0e-6) * std::abs(s1_f + s2_f + static_cast<T>(1.0))) {
            s0 = s0_f; s1 = s1_f; s2 = s2_f;
            ep_bar += dl_face;
        } else {
            // Try Left Ridge (Triaxial Compression edge: s0 == s1 > s2)
            bool solved = false;
            const T a11 = d_face;
            const T a12 = lam * (N_phi * N_psi - N_phi - N_psi + static_cast<T>(1.0)) + static_cast<T>(2.0) * G;
            const T det_tc = a11 * a11 - a12 * a12;
            if (std::abs(det_tc) > static_cast<T>(1.0e-12)) {
                const T f1 = N_phi * s0_tr - s2_tr - sig_c;
                const T f2 = N_phi * s1_tr - s2_tr - sig_c;
                const T dl1 = (a11 * f1 - a12 * f2) / det_tc;
                const T dl2 = (a11 * f2 - a12 * f1) / det_tc;
                if (dl1 >= static_cast<T>(0.0) && dl2 >= static_cast<T>(0.0)) {
                    const T s0_tc = s0_tr - dl1 * dm0 - dl2 * dm1;
                    const T s1_tc = s1_tr - dl1 * dm1 - dl2 * dm0;
                    const T s2_tc = s2_tr - (dl1 + dl2) * dm2;
                    if (s0_tc >= s2_tc - static_cast<T>(1.0e-6)) {
                        s0 = static_cast<T>(0.5) * (s0_tc + s1_tc);
                        s1 = s0;
                        s2 = s2_tc;
                        ep_bar += dl1 + dl2;
                        solved = true;
                    }
                }
            }
            if (!solved) {
                // Try Right Ridge (Triaxial Extension edge: s0 > s1 == s2)
                const T b11 = d_face;
                const T b12 = static_cast<T>(2.0) * G * N_phi * N_psi + lam * (N_phi - static_cast<T>(1.0)) * (N_psi - static_cast<T>(1.0));
                const T det_te = b11 * b11 - b12 * b12;
                if (std::abs(det_te) > static_cast<T>(1.0e-12)) {
                    const T f1 = N_phi * s0_tr - s2_tr - sig_c;
                    const T f3 = N_phi * s0_tr - s1_tr - sig_c;
                    const T dl1 = (b11 * f1 - b12 * f3) / det_te;
                    const T dl3 = (b11 * f3 - b12 * f1) / det_te;
                    if (dl1 >= static_cast<T>(0.0) && dl3 >= static_cast<T>(0.0)) {
                        const T s0_te = s0_tr - (dl1 + dl3) * dm0;
                        const T s1_te = s1_tr - dl1 * dm1 - dl3 * dm2;
                        const T s2_te = s2_tr - dl1 * dm2 - dl3 * dm1;
                        if (s0_te >= s1_te - static_cast<T>(1.0e-6)) {
                            s0 = s0_te;
                            s1 = static_cast<T>(0.5) * (s1_te + s2_te);
                            s2 = s1;
                            ep_bar += dl1 + dl3;
                            solved = true;
                        }
                    }
                }
            }
            if (!solved) {
                // Mohr-Coulomb Apex return
                const T s_ap_val = std::min(s_apex, sig_t);
                const T dep_approx = std::max(static_cast<T>(0.0), (s0_tr - s_ap_val) / std::max(static_cast<T>(1.0), static_cast<T>(2.0) * G));
                s0 = s_ap_val; s1 = s_ap_val; s2 = s_ap_val;
                ep_bar += dep_approx;
            }
        }
    }

    // Rankine Tension Cutoff check on principal stresses (elastic Poisson contraction correction)
    if (s0 > sig_t) {
        const T E_lame = lam + static_cast<T>(2.0) * G;
        const T dl_t1 = (s0 - sig_t) / std::max(static_cast<T>(1.0), E_lame);
        const T s1_r1 = s1 - lam * dl_t1;
        const T s2_r1 = s2 - lam * dl_t1;
        if (s1_r1 <= sig_t) {
            s0 = sig_t; s1 = s1_r1; s2 = s2_r1;
        } else {
            const T d2 = std::max(static_cast<T>(1.0), lam + G);
            const T s1_mid = static_cast<T>(0.5) * (s0 + s1) - sig_t;
            const T s2_r2 = s2 - (lam / d2) * s1_mid;
            if (s2_r2 <= sig_t) {
                s0 = sig_t; s1 = sig_t; s2 = s2_r2;
            } else {
                s0 = sig_t; s1 = sig_t; s2 = sig_t;
            }
        }
    }

    const T sig_out_evals[3] = {s0, s1, s2};
    sym3_from_eigen(sig_out_evals, vecs, sigma);
}

// --- 3. Geological Cap (Drucker-Prager Shear + DiMaggio-Sandler Elliptical Pore-Crush Cap) ---
template <typename T>
HD_GEO_FUNC void update_constitutive_geological_cap(
    T E, T nu, const DruckerPragerParams<T>& params,
    T cap_X0, T cap_W, T cap_D1, T cap_D2, T cap_R,
    const T d_eps[3][3],
    T s_dev[3][3],
    T& p_hydro,
    T& X_cap,
    T& ep_bar
) {
    // Geostatic initialization safeguard: prevent step-0 crush rebound when static overburden > X0
    if (X_cap <= static_cast<T>(0.0)) {
        X_cap = std::max(cap_X0, p_hydro);
    }

    const T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    const T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    const T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    const T p_trial = p_hydro - K * trace_deps;
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

    const T c_dp = params.c_dp() + params.H_plastic * ep_bar;
    const T M_dp = params.M_dp();
    const T R_safe = std::max(static_cast<T>(0.1), cap_R);
    const T X_old = std::max(cap_X0, X_cap);
    const T p_a_old = (X_old - R_safe * c_dp) / (static_cast<T>(1.0) + R_safe * M_dp);

    if (p_trial <= p_a_old) {
        // Shear failure cone / tension cutoff regime
        p_hydro = p_trial;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = s_trial[i][j];
        update_constitutive_drucker_prager(E, nu, params, d_eps, s_dev, p_hydro, ep_bar, false);
        if (p_hydro < -params.tensile_cutoff) p_hydro = -params.tensile_cutoff;
        return;
    }

    // Elliptical cap regime (p_trial > p_a_old)
    const T rad_old = std::max(static_cast<T>(1.0), R_safe * (c_dp + M_dp * p_a_old));
    const T dp_old = p_trial - p_a_old;
    const T phi_cap = std::sqrt(dp_old * dp_old + (R_safe * q_trial) * (R_safe * q_trial));
    const T cap_eps = (sizeof(T) > 4) ? static_cast<T>(1.0e-12) : static_cast<T>(1.0e-6);
    if (phi_cap <= rad_old * (static_cast<T>(1.0) + cap_eps)) {
        p_hydro = p_trial;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s_dev[i][j] = s_trial[i][j];
        return;
    }

    const T K_safe = std::max(static_cast<T>(1.0), K);
    const T G_safe = std::max(static_cast<T>(1.0), G);
    const T dX_old = std::max(static_cast<T>(0.0), X_old - cap_X0);
    const T exp_old = std::exp(-std::min(static_cast<T>(30.0), cap_D1 * dX_old + cap_D2 * dX_old * dX_old));
    const T evp_old = cap_W * (static_cast<T>(1.0) - exp_old);

    // Bracket cap apex X* in [X_old, X_hi] such that (p_trial, q_trial) is inside cone/cap at X_hi
    const T p_cone_req = (M_dp > static_cast<T>(1.0e-5) && q_trial > c_dp + M_dp * p_trial)
        ? ((q_trial - c_dp) / M_dp)
        : p_trial;
    const T p_a_hi_req = std::max(p_trial, p_cone_req);
    const T X_hi_req = p_a_hi_req + R_safe * std::max(static_cast<T>(0.0), c_dp + M_dp * p_a_hi_req);
    T X_lo = X_old;
    T X_hi = std::max(X_old + static_cast<T>(1.0), X_hi_req + static_cast<T>(1.0));
    T p_best = p_trial, q_best = q_trial, X_best = X_old;

    if (cap_W <= static_cast<T>(1.0e-7) || cap_D1 <= static_cast<T>(0.0)) {
        // Non-hardening cap (rigid hardening fallback onto current cap)
        T d_mu = (phi_cap - rad_old) / (rad_old * std::max(K_safe, static_cast<T>(3.0) * G_safe * R_safe * R_safe));
        for (int k = 0; k < 4; ++k) {
            T inv_p = static_cast<T>(1.0) / (static_cast<T>(1.0) + K_safe * d_mu);
            T inv_q = static_cast<T>(1.0) / (static_cast<T>(1.0) + static_cast<T>(3.0) * G_safe * R_safe * R_safe * d_mu);
            T dp_k = dp_old * inv_p;
            T rq_k = R_safe * q_trial * inv_q;
            T fk = std::sqrt(dp_k * dp_k + rq_k * rq_k) - rad_old;
            if (std::abs(fk) <= static_cast<T>(1.0e-5) * rad_old) break;
            T dfk = -(K_safe * dp_k * dp_k * inv_p + static_cast<T>(3.0) * G_safe * R_safe * R_safe * rq_k * rq_k * inv_q)
                    / std::max(static_cast<T>(1.0), fk + rad_old);
            d_mu = std::max(static_cast<T>(0.0), d_mu - fk / std::min(static_cast<T>(-1.0e-12), dfk));
        }
        p_best = p_a_old + dp_old / (static_cast<T>(1.0) + K_safe * d_mu);
        q_best = q_trial / (static_cast<T>(1.0) + static_cast<T>(3.0) * G_safe * R_safe * R_safe * d_mu);
        X_best = X_old;
    } else {
        for (int it = 0; it < 24; ++it) {
            const T X_mid = static_cast<T>(0.5) * (X_lo + X_hi);
            const T p_a_m = (X_mid - R_safe * c_dp) / (static_cast<T>(1.0) + R_safe * M_dp);
            const T rad_m = std::max(static_cast<T>(1.0), R_safe * (c_dp + M_dp * p_a_m));
            T p_on = p_trial, q_on = q_trial;
            if (p_trial > p_a_m) {
                const T dp_m = p_trial - p_a_m;
                const T phi_m = std::sqrt(dp_m * dp_m + (R_safe * q_trial) * (R_safe * q_trial));
                if (phi_m > rad_m) {
                    T d_mu = (phi_m - rad_m) / (rad_m * std::max(K_safe, static_cast<T>(3.0) * G_safe * R_safe * R_safe));
                    for (int k = 0; k < 4; ++k) {
                        T inv_p = static_cast<T>(1.0) / (static_cast<T>(1.0) + K_safe * d_mu);
                        T inv_q = static_cast<T>(1.0) / (static_cast<T>(1.0) + static_cast<T>(3.0) * G_safe * R_safe * R_safe * d_mu);
                        T dp_k = dp_m * inv_p;
                        T rq_k = R_safe * q_trial * inv_q;
                        T fk = std::sqrt(dp_k * dp_k + rq_k * rq_k) - rad_m;
                        T dfk = -(K_safe * dp_k * dp_k * inv_p + static_cast<T>(3.0) * G_safe * R_safe * R_safe * rq_k * rq_k * inv_q)
                                / std::max(static_cast<T>(1.0), fk + rad_m);
                        d_mu = std::max(static_cast<T>(0.0), d_mu - fk / std::min(static_cast<T>(-1.0e-12), dfk));
                    }
                    p_on = p_a_m + dp_m / (static_cast<T>(1.0) + K_safe * d_mu);
                    q_on = q_trial / (static_cast<T>(1.0) + static_cast<T>(3.0) * G_safe * R_safe * R_safe * d_mu);
                }
            } else {
                q_on = std::min(q_trial, std::max(static_cast<T>(0.0), c_dp + M_dp * p_trial));
            }
            const T dX_m = std::max(static_cast<T>(0.0), X_mid - cap_X0);
            const T exp_m = std::exp(-std::min(static_cast<T>(30.0), cap_D1 * dX_m + cap_D2 * dX_m * dX_m));
            const T evp_m = cap_W * (static_cast<T>(1.0) - exp_m);
            const T res = (p_trial - p_on) / K_safe - (evp_m - evp_old);
            p_best = p_on; q_best = q_on; X_best = X_mid;
            if (std::abs(res) <= static_cast<T>(1.0e-9)) break;
            if (res > static_cast<T>(0.0)) {
                X_lo = X_mid;
            } else {
                X_hi = X_mid;
            }
        }
    }

    const T d_evp = std::max(static_cast<T>(0.0), (p_trial - p_best) / K_safe);
    const T d_eq = std::max(static_cast<T>(0.0), (q_trial - q_best) / (static_cast<T>(3.0) * G_safe));
    ep_bar += std::sqrt(d_evp * d_evp + d_eq * d_eq);
    X_cap = std::max(X_old, X_best);
    p_hydro = p_best;
    const T q_scale = (q_trial > static_cast<T>(1.0e-12)) ? (q_best / q_trial) : static_cast<T>(1.0);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            s_dev[i][j] = s_trial[i][j] * q_scale;
}

// --- 4. Hoek-Brown Generalized Jointed Rock Mass Model ---
template <typename T>
HD_GEO_FUNC void update_constitutive_hoek_brown(
    T E, T nu,
    T hb_sigma_ci, T hb_mi, T hb_gsi, T hb_D,
    T dilatancy_angle, T tensile_cutoff,
    const T d_eps[3][3],
    T sigma[3][3],
    T& ep_bar
) {
    const T G = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    const T K = E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
    const T lam = K - static_cast<T>(2.0 / 3.0) * G;
    const T trace_deps = d_eps[0][0] + d_eps[1][1] + d_eps[2][2];

    T sig_trial[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            T delta_ij = (i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0);
            T d_dev = d_eps[i][j] - static_cast<T>(1.0 / 3.0) * trace_deps * delta_ij;
            sig_trial[i][j] = sigma[i][j] + static_cast<T>(2.0) * G * d_dev + K * trace_deps * delta_ij;
        }
    }

    // Generalized Hoek-Brown rock-mass parameters (Hoek, Carranza-Torres, Corkum 2002)
    const T gsi = std::max(static_cast<T>(5.0), std::min(static_cast<T>(100.0), hb_gsi));
    const T D_clamped = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), hb_D));
    const T mb = hb_mi * std::exp(std::max(static_cast<T>(-30.0), std::min(static_cast<T>(5.0), (gsi - static_cast<T>(100.0)) / (static_cast<T>(28.0) - static_cast<T>(14.0) * D_clamped))));
    const T s_hb = std::exp(std::max(static_cast<T>(-30.0), std::min(static_cast<T>(5.0), (gsi - static_cast<T>(100.0)) / (static_cast<T>(9.0) - static_cast<T>(3.0) * D_clamped))));
    const T a_hb = static_cast<T>(0.5) + (static_cast<T>(1.0) / static_cast<T>(6.0)) * (std::exp(-gsi / static_cast<T>(15.0)) - std::exp(static_cast<T>(-20.0 / 3.0)));
    const T sci = std::max(static_cast<T>(1.0e3), hb_sigma_ci);

    const T sig_t_hb = s_hb * sci / std::max(static_cast<T>(1.0e-6), mb);
    const T sig_t_lim = (tensile_cutoff >= static_cast<T>(0.0)) ? std::min(tensile_cutoff, sig_t_hb) : sig_t_hb;

    T evals[3], vecs[3][3];
    sym3_eigen(sig_trial, evals, vecs);
    // Compressive-positive principal stresses: sig_1 >= sig_2 >= sig_3
    T sig_3 = -evals[0];
    T sig_2 = -evals[1];
    T sig_1 = -evals[2];

    const T s_psi = std::sin(std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.45), dilatancy_angle)));
    const T N_psi = (static_cast<T>(1.0) + s_psi) / std::max(static_cast<T>(1.0e-4), static_cast<T>(1.0) - s_psi);

    const T term0 = mb * (sig_3 / sci) + s_hb;
    const T f_hb0 = (term0 > static_cast<T>(0.0))
        ? (sig_1 - sig_3 - sci * std::pow(term0, a_hb))
        : (sig_1 - sig_3);

    if (f_hb0 > static_cast<T>(0.0)) {
        // Local Newton-tangent non-associated return in principal compression stresses (Cundall-Clausen)
        const T E_0 = lam + static_cast<T>(2.0) * G;
        const T dm_1 = E_0 - lam * N_psi;
        const T dm_2 = lam * (static_cast<T>(1.0) - N_psi);
        const T dm_3 = lam - E_0 * N_psi;
        T dl = static_cast<T>(0.0);

        for (int it = 0; it < 4; ++it) {
            const T s1_k = sig_1 - dl * dm_1;
            const T s3_k = sig_3 - dl * dm_3;
            const T trm_k = mb * (s3_k / sci) + s_hb;
            T f_k = static_cast<T>(0.0);
            T N_phi_k = static_cast<T>(1.0);
            if (trm_k > static_cast<T>(1.0e-9)) {
                f_k = s1_k - s3_k - sci * std::pow(trm_k, a_hb);
                N_phi_k = static_cast<T>(1.0) + a_hb * mb * std::pow(trm_k, a_hb - static_cast<T>(1.0));
            } else {
                // Past tensile vertex: enforce tensile limit
                break;
            }
            if (std::abs(f_k) <= static_cast<T>(1.0e-5) * sci) break;
            const T denom_k = std::max(static_cast<T>(1.0), dm_1 - N_phi_k * dm_3);
            dl = std::max(static_cast<T>(0.0), dl + f_k / denom_k);
        }

        const T s1_n = sig_1 - dl * dm_1;
        const T s2_n = sig_2 - dl * dm_2;
        const T s3_n = sig_3 - dl * dm_3;
        if (-s3_n > sig_t_lim) {
            const T ten_c = -sig_t_lim;
            sig_3 = ten_c;
            sig_2 = std::max(sig_2, ten_c);
            const T trm_t = std::max(static_cast<T>(0.0), mb * (ten_c / sci) + s_hb);
            sig_1 = std::min(sig_1, ten_c + sci * std::pow(trm_t, a_hb));
        } else {
            sig_1 = s1_n;
            sig_2 = std::max(s3_n, std::min(s1_n, s2_n));
            sig_3 = s3_n;
        }
        ep_bar += dl;
    }

    // Tensile cutoff check (in compression-positive coordinates, minimum sig_k >= -sig_t_lim)
    if (sig_3 < -sig_t_lim) sig_3 = -sig_t_lim;
    if (sig_2 < -sig_t_lim) sig_2 = -sig_t_lim;
    if (sig_1 < -sig_t_lim) sig_1 = -sig_t_lim;

    const T sig_out_evals[3] = {-sig_3, -sig_2, -sig_1};
    sym3_from_eigen(sig_out_evals, vecs, sigma);
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
