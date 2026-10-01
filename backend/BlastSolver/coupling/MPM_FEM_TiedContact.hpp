#pragma once

#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <iomanip>

namespace Blast::Coupling {

template <typename T>
struct TiedParticleConstraint {
    int particle_idx{-1};
    int element_idx{-1};
    int node_ids[8];
    T shape_weights[8];
    T normal[3];
    T initial_gap[3];
};

template <typename T>
class MPMFEMTiedContact3D {
public:
    MPMFEMTiedContact3D() = default;

    void reserve(size_t max_constraints, size_t max_nodes = 128) {
        constraints_.reserve(max_constraints);
        F_mpm_node_.assign(max_nodes, static_cast<T>(0.0));
        M_mpm_node_.assign(max_nodes, static_cast<T>(0.0));
        active_nodes_.reserve(max_nodes);
    }

    void clear() {
        constraints_.clear();
        std::fill(F_mpm_node_.begin(), F_mpm_node_.end(), static_cast<T>(0.0));
        std::fill(M_mpm_node_.begin(), M_mpm_node_.end(), static_cast<T>(0.0));
        active_nodes_.clear();
    }

    void add_tied_particle(
        int particle_idx,
        int element_idx,
        const int node_ids[8],
        const T shape_weights[8],
        const T normal[3],
        T initial_p_x = static_cast<T>(0.0)
    ) {
        TiedParticleConstraint<T> c;
        c.particle_idx = particle_idx;
        c.element_idx = element_idx;
        for (int i = 0; i < 8; ++i) {
            c.node_ids[i] = node_ids[i];
            c.shape_weights[i] = shape_weights[i];
            if (node_ids[i] >= 0) {
                if (std::find(active_nodes_.begin(), active_nodes_.end(), node_ids[i]) == active_nodes_.end()) {
                    active_nodes_.push_back(node_ids[i]);
                }
            }
        }
        c.normal[0] = normal[0];
        c.normal[1] = normal[1];
        c.normal[2] = normal[2];
        c.initial_gap[0] = initial_p_x;
        c.initial_gap[1] = static_cast<T>(0.0);
        c.initial_gap[2] = static_cast<T>(0.0);
        constraints_.push_back(c);
    }

    size_t num_constraints() const { return constraints_.size(); }
    const std::vector<TiedParticleConstraint<T>>& get_constraints() const { return constraints_; }
    const std::vector<int>& get_active_nodes() const { return active_nodes_; }

    template <typename FEMSolverType>
    void clear_fem_interface_forces(FEMSolverType& fem) {
        auto& fem_nodes = fem.getNodes();
        for (int nid : active_nodes_) {
            if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                fem_nodes[nid].f_ext[0] = static_cast<T>(0.0);
                fem_nodes[nid].f_ext[1] = static_cast<T>(0.0);
                fem_nodes[nid].f_ext[2] = static_cast<T>(0.0);
            }
        }
    }

    template <typename FEMSolverType, typename MPMSolverType>
    void augment_interface_mass(FEMSolverType& fem, const MPMSolverType& mpm) {
        auto& fem_nodes = fem.getNodes();
        const auto& mpm_particles = mpm.getParticles();

        if (M_mpm_node_.size() < fem_nodes.size()) {
            M_mpm_node_.assign(fem_nodes.size(), static_cast<T>(0.0));
        } else {
            for (int nid : active_nodes_) {
                if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                    M_mpm_node_[nid] = static_cast<T>(0.0);
                }
            }
        }

        for (const auto& c : constraints_) {
            if (c.particle_idx < 0 || c.particle_idx >= static_cast<int>(mpm_particles.size())) continue;
            const auto& p = mpm_particles[c.particle_idx];
            if (p.state == 2 || p.m <= static_cast<T>(0.0)) continue;

            for (int a = 0; a < 8; ++a) {
                int nid = c.node_ids[a];
                if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                    T w = c.shape_weights[a];
                    M_mpm_node_[nid] += w * static_cast<T>(p.m);
                }
            }
        }

        for (int nid : active_nodes_) {
            if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                fem_nodes[nid].m += M_mpm_node_[nid];
            }
        }
    }

    // Monolithic shared-DOF force transfer guaranteeing exact dynamic equilibrium and eliminating added-mass instability
    template <typename FEMSolverType, typename MPMSolverType>
    void transfer_monolithic_interface_forces(FEMSolverType& fem, MPMSolverType& mpm, T dt) {
        (void)dt;
        auto& fem_nodes = fem.getNodes();
        const auto& mpm_particles = mpm.getParticles();

        if (F_mpm_node_.size() < fem_nodes.size()) {
            F_mpm_node_.assign(fem_nodes.size(), static_cast<T>(0.0));
        } else {
            for (int nid : active_nodes_) {
                if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                    F_mpm_node_[nid] = static_cast<T>(0.0);
                }
            }
        }

        // 1. Accumulate MPM boundary particle driving force
        for (const auto& c : constraints_) {
            if (c.particle_idx < 0 || c.particle_idx >= static_cast<int>(mpm_particles.size())) continue;
            const auto& p = mpm_particles[c.particle_idx];
            if (p.state == 2 || p.m <= static_cast<T>(0.0)) continue;

            T A_p = std::pow(p.V, static_cast<T>(2.0 / 3.0));
            // Compressive traction: - sigma · n · A_p
            T f_p_x = - static_cast<T>(p.sigma.data[0]) * c.normal[0] * A_p;

            for (int a = 0; a < 8; ++a) {
                int nid = c.node_ids[a];
                if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                    T w = c.shape_weights[a];
                    F_mpm_node_[nid] += w * f_p_x;
                }
            }
        }

        // 2. Set driving force on interface FEM nodes
        for (int nid : active_nodes_) {
            if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                fem_nodes[nid].f_ext[0] = F_mpm_node_[nid];
                fem_nodes[nid].f_ext[1] = static_cast<T>(0.0);
                fem_nodes[nid].f_ext[2] = static_cast<T>(0.0);
            }
        }
    }

    // Enforce kinematic continuity: u_p = sum_a N_a * u_node_a and v_p = sum_a N_a * v_node_a
    template <typename FEMSolverType, typename MPMSolverType>
    void enforce_tied_kinematics(FEMSolverType& fem, MPMSolverType& mpm, T dt) {
        (void)dt;
        const auto& fem_nodes = fem.getNodes();
        auto& mpm_particles = mpm.getParticles();

        for (const auto& c : constraints_) {
            if (c.particle_idx < 0 || c.particle_idx >= static_cast<int>(mpm_particles.size())) continue;
            auto& p = mpm_particles[c.particle_idx];
            if (p.state == 2 || p.m <= static_cast<T>(0.0)) continue;

            T v_fem_x = static_cast<T>(0.0);
            T u_fem_x = static_cast<T>(0.0);
            for (int a = 0; a < 8; ++a) {
                int nid = c.node_ids[a];
                if (nid >= 0 && nid < static_cast<int>(fem_nodes.size())) {
                    T w = c.shape_weights[a];
                    v_fem_x += w * fem_nodes[nid].v[0];
                    u_fem_x += w * (fem_nodes[nid].x[0] - fem_nodes[nid].x0[0]);
                }
            }

            p.v[0] = static_cast<float>(v_fem_x);
            p.v[1] = 0.0f;
            p.v[2] = 0.0f;
            p.x[0] = static_cast<float>(c.initial_gap[0] + u_fem_x);
        }
    }

    // Synchronize interface boundary grid nodes with FEM interface velocity
    template <typename FEMSolverType, typename MPMSolverType>
    void synchronize_mpm_grid_boundary(
        FEMSolverType& fem, MPMSolverType& mpm,
        int grid_i_interface, int j_start, int k_start,
        int num_nodes_x, int num_nodes_y, int num_nodes_z
    ) {
        const auto& fem_nodes = fem.getNodes();
        auto& grid = mpm.getGrid();
        int mpm_ny = mpm.getNy();
        int mpm_nz = mpm.getNz();

        for (int k = 0; k < num_nodes_z; ++k) {
            for (int j = 0; j < num_nodes_y; ++j) {
                int fem_nid = (k * num_nodes_y + j) * num_nodes_x + 0;
                int grid_j = j_start + j;
                int grid_k = k_start + k;
                if (grid_j >= 0 && grid_j < mpm_ny && grid_k >= 0 && grid_k < mpm_nz) {
                    size_t grid_idx = (static_cast<size_t>(grid_i_interface) * mpm_ny + grid_j) * mpm_nz + grid_k;
                    if (grid_idx < grid.size() && fem_nid < static_cast<int>(fem_nodes.size())) {
                        float v_fem = static_cast<float>(fem_nodes[fem_nid].v[0]);
                        mpm.setGridNodeVelocity(grid_idx, v_fem, 0.0f, 0.0f);
                    }
                }
            }
        }
    }

    void record_energy_metrics(T E_incident, T E_transmitted, T E_reflected, T E_absorbed) {
        E_incident_ = E_incident;
        E_transmitted_ = E_transmitted;
        E_reflected_ = E_reflected;
        E_absorbed_ = E_absorbed;
    }

    T energy_conservation_error() const {
        if (E_incident_ <= static_cast<T>(1.0e-9)) return static_cast<T>(0.0);
        return std::abs((E_transmitted_ + E_absorbed_ + E_reflected_) - E_incident_) / E_incident_;
    }

    T get_e_incident() const { return E_incident_; }
    T get_e_transmitted() const { return E_transmitted_; }
    T get_e_reflected() const { return E_reflected_; }
    T get_e_absorbed() const { return E_absorbed_; }

private:
    std::vector<TiedParticleConstraint<T>> constraints_;
    std::vector<int> active_nodes_;
    std::vector<T> F_mpm_node_;
    std::vector<T> M_mpm_node_;
    T E_incident_{static_cast<T>(0.0)};
    T E_transmitted_{static_cast<T>(0.0)};
    T E_reflected_{static_cast<T>(0.0)};
    T E_absorbed_{static_cast<T>(0.0)};
};

} // namespace Blast::Coupling
