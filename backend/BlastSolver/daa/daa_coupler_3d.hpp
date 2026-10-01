#pragma once

#include "HMatrixACA.hpp"
#include "analytical_bubble_3d.hpp"
#include <vector>
#include <array>
#include <cmath>

namespace Blast::DAA {

struct alignas(32) WetSurfaceFacet {
    int facet_id;
    int node_ids[4];
    double center[3];
    double normal[3];
    double area;
    double p_total;     // Total wet surface pressure (incident + scattered)
    double p_scattered; // DAA scattered wave pressure
    double u_dot_n;     // Normal structural structural velocity
    double a_dot_n;     // Normal structural acceleration
    bool is_cavitating; // Bleich-Sandler cavitation detachment active
};

class DAACoupler3D {
public:
    DAACoupler3D() = default;
    ~DAACoupler3D() = default;

    void initialize(
        const std::vector<WetSurfaceFacet>& facets,
        double rho_water = 1000.0,
        double c_water = 1500.0,
        bool use_hmatrix_aca = true
    ) {
        m_facets = facets;
        m_rho = rho_water;
        m_c = c_water;
        m_use_aca = use_hmatrix_aca;

        if (m_use_aca && !m_facets.empty()) {
            std::vector<std::array<double, 3>> centers(m_facets.size());
            std::vector<std::array<double, 3>> normals(m_facets.size());
            std::vector<double> areas(m_facets.size());

            for (size_t i = 0; i < m_facets.size(); ++i) {
                centers[i] = {m_facets[i].center[0], m_facets[i].center[1], m_facets[i].center[2]};
                normals[i] = {m_facets[i].normal[0], m_facets[i].normal[1], m_facets[i].normal[2]};
                areas[i] = m_facets[i].area;
            }

            m_hmatrix.compress_facet_kernel(centers, normals, areas, m_rho, 1.0e-4, 32);
        }
    }

    // Step DAA equations:
    // DAA1: dp_s/dt + (rho * c * M_added^-1) * p_s = rho * c * a_n
    // Bleich-Sandler cavitation cutoff: if p_total < p_cav, set p_total = p_cav, facet detaches
    void step_daa(double dt, double p_incident_uniform = 0.0) {
        const double P_CAV = -1.0e5; // Cavitation tension cutoff (Pa)

        for (auto& facet : m_facets) {
            // Early acoustic limit: p_s ~ rho * c * u_dot_n
            // Late added mass limit: dp_s/dt ~ M_added * a_n
            double p_early = m_rho * m_c * facet.u_dot_n;
            double p_late = m_rho * facet.a_dot_n * std::sqrt(facet.area);

            // DAA1 interpolation: p_s(t + dt)
            double dp_s = (p_early - facet.p_scattered) * (dt * 500.0) + p_late * dt;
            facet.p_scattered += dp_s;

            double p_tot = p_incident_uniform + facet.p_scattered;

            // Bleich-Sandler cavitation cutoff
            if (p_tot < P_CAV) {
                facet.p_total = P_CAV;
                facet.is_cavitating = true;
            } else {
                facet.p_total = p_tot;
                facet.is_cavitating = false;
            }
        }
    }

    const std::vector<WetSurfaceFacet>& get_facets() const { return m_facets; }

private:
    std::vector<WetSurfaceFacet> m_facets;
    double m_rho{1000.0};
    double m_c{1500.0};
    bool m_use_aca{true};
    HMatrixAddedMass m_hmatrix;
};

} // namespace Blast::DAA
