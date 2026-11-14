#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include "ImmersedBoundary.hpp"
#include "materials/ConstitutiveGeomaterials.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <limits>
#include <algorithm>
#include <cstring>

namespace Blast {

// Hex8 isoparametric reference coordinates in [-1, +1]^3
static const float HEX8_XI[8][3] = {
    {-1.0f, -1.0f, -1.0f},
    { 1.0f, -1.0f, -1.0f},
    { 1.0f,  1.0f, -1.0f},
    {-1.0f,  1.0f, -1.0f},
    {-1.0f, -1.0f,  1.0f},
    { 1.0f, -1.0f,  1.0f},
    { 1.0f,  1.0f,  1.0f},
    {-1.0f,  1.0f,  1.0f}
};

// Flanagan-Belytschko Hourglass Base Gamma Vectors
static const float FB_GAMMA[4][8] = {
    { 1.0f,  1.0f, -1.0f, -1.0f, -1.0f, -1.0f,  1.0f,  1.0f}, // Gamma 1
    { 1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f}, // Gamma 2
    { 1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f}, // Gamma 3
    {-1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f}  // Gamma 4
};

// Hex8 Element 12 Local Edges
static const int HEX8_EDGES[12][2] = {
    {0,1}, {1,2}, {2,3}, {3,0},
    {4,5}, {5,6}, {6,7}, {7,4},
    {0,4}, {1,5}, {2,6}, {3,7}
};

template <typename T>
static inline T computeFEMWeibullFactor(uint32_t seed_base, const BlastPhysicsParams<T>& params) {
    if (!params.enable_heterogeneity) return static_cast<T>(1.0f);
    uint32_t seed = seed_base;
    seed = (seed ^ 61u) ^ (seed >> 16);
    seed *= 9u;
    seed = seed ^ (seed >> 4);
    seed *= 0x27d4eb2du;
    seed = seed ^ (seed >> 15);
    float u = std::clamp(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.001f, 0.999f);
    float m_w = (params.weibull_modulus > static_cast<T>(0.001f))
        ? static_cast<float>(params.weibull_modulus)
        : ((params.material_heterogeneity > static_cast<T>(1.0e-4f)) ? (1.0f / static_cast<float>(params.material_heterogeneity)) : 8.0f);
    float eta_w = (params.weibull_scale > static_cast<T>(0.001f)) ? static_cast<float>(params.weibull_scale) : 1.0f;
    float gamma_mean = std::tgamma(1.0f + 1.0f / m_w);
    float w = (std::pow(-std::log(1.0f - u), 1.0f / m_w) / gamma_mean) * eta_w;
    return static_cast<T>(std::clamp(w, 0.10f, 3.0f));
}

template <typename T>
FEMSolver3D<T>::FEMSolver3D() {
#ifdef __CUDACC__
    cudaStreamCreateWithFlags(&m_cuda_stream, cudaStreamNonBlocking);
#endif
}

template <typename T>
FEMSolver3D<T>::~FEMSolver3D() {
#ifdef __CUDACC__
    if (m_cuda_stream) {
        cudaStreamDestroy(m_cuda_stream);
        m_cuda_stream = nullptr;
    }
#endif
}

template <typename T>
void FEMSolver3D<T>::ensureGaussPointHistory() {
    if (m_integration_scheme == FEMIntegrationScheme::FullGauss8 || m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
        if (m_gp_history.size() != m_elements.size()) {
            size_t old_size = m_gp_history.size();
            m_gp_history.resize(m_elements.size());
            for (size_t e = old_size; e < m_elements.size(); ++e) {
                for (int g = 0; g < 8; ++g) {
                    std::memset(m_gp_history[e].F_gp[g], 0, sizeof(m_gp_history[e].F_gp[g]));
                    m_gp_history[e].F_gp[g][0][0] = static_cast<T>(1.0f);
                    m_gp_history[e].F_gp[g][1][1] = static_cast<T>(1.0f);
                    m_gp_history[e].F_gp[g][2][2] = static_cast<T>(1.0f);
                    std::memset(m_gp_history[e].s_dev_gp[g], 0, sizeof(m_gp_history[e].s_dev_gp[g]));
                    m_gp_history[e].ep_bar_gp[g] = static_cast<T>(0.0f);
                    m_gp_history[e].temp_gp[g] = static_cast<T>(293.0f);
                    m_gp_history[e].damage_gp[g] = static_cast<T>(0.0f);
                    m_gp_history[e].lambda_gp[g] = static_cast<T>(0.0f);
                }
            }
        }
    } else {
        if (!m_gp_history.empty()) {
            m_gp_history.clear();
            m_gp_history.shrink_to_fit();
        }
    }
}

template <typename T>
void FEMSolver3D<T>::initializeDomain(T xmin, T xmax, T ymin, T ymax, T zmin, T zmax) {
    m_xmin = xmin; m_xmax = xmax;
    m_ymin = ymin; m_ymax = ymax;
    m_zmin = zmin; m_zmax = zmax;
}

template <typename T>
void FEMSolver3D<T>::createStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, const std::string& boundary_condition) {
    m_nodes.clear();
    m_elements.clear();
    m_material_tables.clear();
    addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, material, 0.0f, 0.0f, 0.0f, boundary_condition);
}

template <typename T>
void FEMSolver3D<T>::addStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x, T vel_y, T vel_z, const std::string& boundary_condition) {
    int mat_id = static_cast<int>(m_material_tables.size());
    m_material_tables.push_back(material);

    nx = std::max(1, nx);
    ny = std::max(1, ny);
    nz = std::max(1, nz);

    T dx = lx / static_cast<T>(nx);
    T dy = ly / static_cast<T>(ny);
    T dz = lz / static_cast<T>(nz);

    int num_nodes_x = nx + 1;
    int num_nodes_y = ny + 1;
    int num_nodes_z = nz + 1;

    int base_node_idx = static_cast<int>(m_nodes.size());
    int base_elem_idx = static_cast<int>(m_elements.size());

    bool is_fixed_base = (boundary_condition == "Fixed Base" || boundary_condition == "Clamped" || boundary_condition == "FixedBase");
    bool is_fixed_entire = (boundary_condition == "Fixed Entire" || boundary_condition == "FixedEntire" || boundary_condition == "Encastre");

    // Create 3D Nodal Grid
    for (int k = 0; k < num_nodes_z; ++k) {
        for (int j = 0; j < num_nodes_y; ++j) {
            for (int i = 0; i < num_nodes_x; ++i) {
                FEMNode3D<T> node{};
                node.x[0] = pos_x + static_cast<T>(i) * dx;
                node.x[1] = pos_y + static_cast<T>(j) * dy;
                node.x[2] = pos_z + static_cast<T>(k) * dz;
                node.x0[0] = node.x[0]; node.x0[1] = node.x[1]; node.x0[2] = node.x[2];
                node.v[0] = vel_x; node.v[1] = vel_y; node.v[2] = vel_z;
                node.a[0] = 0.0f; node.a[1] = 0.0f; node.a[2] = 0.0f;
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
                node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
                node.f_contact[0] = 0.0f; node.f_contact[1] = 0.0f; node.f_contact[2] = 0.0f;
                node.m = 0.0f;
                if (is_fixed_entire || (is_fixed_base && k == 0)) {
                    node.is_fixed[0] = true;
                    node.is_fixed[1] = true;
                    node.is_fixed[2] = true;
                }
                m_nodes.push_back(node);
            }
        }
    }

    int part_id = m_next_part_id++;

    // Create Hex8 Elements
    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                FEMElement3D<T> elem{};
                elem.node_ids[0] = base_node_idx + (k * num_nodes_y + j) * num_nodes_x + i;
                elem.node_ids[1] = base_node_idx + (k * num_nodes_y + j) * num_nodes_x + (i + 1);
                elem.node_ids[2] = base_node_idx + (k * num_nodes_y + (j + 1)) * num_nodes_x + (i + 1);
                elem.node_ids[3] = base_node_idx + (k * num_nodes_y + (j + 1)) * num_nodes_x + i;
                elem.node_ids[4] = base_node_idx + ((k + 1) * num_nodes_y + j) * num_nodes_x + i;
                elem.node_ids[5] = base_node_idx + ((k + 1) * num_nodes_y + j) * num_nodes_x + (i + 1);
                elem.node_ids[6] = base_node_idx + ((k + 1) * num_nodes_y + (j + 1)) * num_nodes_x + (i + 1);
                elem.node_ids[7] = base_node_idx + ((k + 1) * num_nodes_y + (j + 1)) * num_nodes_x + i;

                elem.mat_id = mat_id;
                elem.part_id = part_id;

                std::memset(elem.F, 0, sizeof(elem.F));
                elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));
                std::memset(elem.s_dev, 0, sizeof(elem.s_dev));

                T x_nodes[8][3];
                for (int n = 0; n < 8; ++n) {
                    int nid = elem.node_ids[n];
                    x_nodes[n][0] = m_nodes[nid].x[0];
                    x_nodes[n][1] = m_nodes[nid].x[1];
                    x_nodes[n][2] = m_nodes[nid].x[2];
                }

                T B[6][24], detJ;
                computeHex8BMatrix(x_nodes, B, detJ);
                elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
                elem.V = elem.V0;

                m_elements.push_back(elem);
            }
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();

    // Evaluate Time-Zero Baseline Timesteps (dt0)
    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        T x_n[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            x_n[n][0] = m_nodes[nid].x[0];
            x_n[n][1] = m_nodes[nid].x[1];
            x_n[n][2] = m_nodes[nid].x[2];
        }
        T L_e = computeHex8CharacteristicLength(x_n, elem.V0);
        const auto& mat_tb = m_material_tables[elem.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);
        elem.dt0 = L_e / cd;
    }
    ensureGaussPointHistory();
}

template <typename T>
void FEMSolver3D<T>::createStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T inner_radius, const std::string& boundary_condition) {
    m_nodes.clear();
    m_elements.clear();
    m_material_tables.clear();
    addStructuredCylinderMesh(nr, nz, radius, height, pos_x, pos_y, pos_z, material, static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f), inner_radius, boundary_condition);
}

template <typename T>
void FEMSolver3D<T>::addStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x, T vel_y, T vel_z, T inner_radius, const std::string& boundary_condition) {
    int mat_id = static_cast<int>(m_material_tables.size());
    m_material_tables.push_back(material);

    int base_node_idx = static_cast<int>(m_nodes.size());
    int base_elem_idx = static_cast<int>(m_elements.size());
    int part_id = m_next_part_id++;

    bool is_fixed_base = (boundary_condition == "Fixed Base");
    bool is_fixed_entire = (boundary_condition == "Fixed Entire");

    int Nc = std::max(1, nr);
    int Nring = std::max(1, nr);
    int Nz = std::max(1, nz);

    bool is_hollow = (inner_radius > static_cast<T>(1.0e-6f) && inner_radius < radius);

    if (!is_hollow) {
        // High-Quality 5-Block Cubed-Circle / O-Grid Topology for Solid Cylinder
        // Core scale factor s_core chosen to equalize radial and circumferential edge lengths
        constexpr double M_PI_VAL = 3.14159265358979323846;
        T s_core = radius * (static_cast<T>(Nc) / (static_cast<T>(Nc) + static_cast<T>(2 * Nring)));

        struct Node2D { T x, y; };
        std::vector<Node2D> nodes2D;

        // 1. Core nodes: (Nc+1) x (Nc+1) flat Cartesian square grid from -s_core to +s_core
        std::vector<std::vector<int>> core_map(Nc + 1, std::vector<int>(Nc + 1, -1));
        for (int j = 0; j <= Nc; ++j) {
            T v = static_cast<T>(j) / static_cast<T>(Nc);
            T y_c = (static_cast<T>(2.0f) * v - static_cast<T>(1.0f)) * s_core;
            for (int i = 0; i <= Nc; ++i) {
                T u = static_cast<T>(i) / static_cast<T>(Nc);
                T x_c = (static_cast<T>(2.0f) * u - static_cast<T>(1.0f)) * s_core;

                core_map[i][j] = static_cast<int>(nodes2D.size());
                nodes2D.push_back({x_c, y_c});
            }
        }

        // Equal-Arc Outer Circle Parametrization
        auto getTopCirclePt = [&](T u) -> Node2D {
            double th = M_PI_VAL * 0.75 - static_cast<double>(u) * M_PI_VAL * 0.5;
            return { radius * static_cast<T>(std::cos(th)), radius * static_cast<T>(std::sin(th)) };
        };
        auto getBottomCirclePt = [&](T u) -> Node2D {
            double th = M_PI_VAL * 1.25 + static_cast<double>(u) * M_PI_VAL * 0.5;
            return { radius * static_cast<T>(std::cos(th)), radius * static_cast<T>(std::sin(th)) };
        };
        auto getRightCirclePt = [&](T u) -> Node2D {
            double th = M_PI_VAL * 1.75 + static_cast<double>(u) * M_PI_VAL * 0.5;
            return { radius * static_cast<T>(std::cos(th)), radius * static_cast<T>(std::sin(th)) };
        };
        auto getLeftCirclePt = [&](T u) -> Node2D {
            double th = M_PI_VAL * 1.25 - static_cast<double>(u) * M_PI_VAL * 0.5;
            return { radius * static_cast<T>(std::cos(th)), radius * static_cast<T>(std::sin(th)) };
        };

        // 2. Ring Quadrants (Nring layers from core boundary to outer radius R)
        // Top Ring
        std::vector<std::vector<int>> top_ring(Nc + 1, std::vector<int>(Nring + 1, -1));
        for (int i = 0; i <= Nc; ++i) top_ring[i][0] = core_map[i][Nc];
        for (int kr = 1; kr <= Nring; ++kr) {
            T t = static_cast<T>(kr) / static_cast<T>(Nring);
            for (int i = 0; i <= Nc; ++i) {
                T u = static_cast<T>(i) / static_cast<T>(Nc);
                T P_core_x = nodes2D[core_map[i][Nc]].x;
                T P_core_y = nodes2D[core_map[i][Nc]].y;
                Node2D P_circle = getTopCirclePt(u);
                T x = (static_cast<T>(1.0f) - t) * P_core_x + t * P_circle.x;
                T y = (static_cast<T>(1.0f) - t) * P_core_y + t * P_circle.y;
                top_ring[i][kr] = static_cast<int>(nodes2D.size());
                nodes2D.push_back({x, y});
            }
        }

        // Bottom Ring
        std::vector<std::vector<int>> bottom_ring(Nc + 1, std::vector<int>(Nring + 1, -1));
        for (int i = 0; i <= Nc; ++i) bottom_ring[i][0] = core_map[i][0];
        for (int kr = 1; kr <= Nring; ++kr) {
            T t = static_cast<T>(kr) / static_cast<T>(Nring);
            for (int i = 0; i <= Nc; ++i) {
                T u = static_cast<T>(i) / static_cast<T>(Nc);
                T P_core_x = nodes2D[core_map[i][0]].x;
                T P_core_y = nodes2D[core_map[i][0]].y;
                Node2D P_circle = getBottomCirclePt(u);
                T x = (static_cast<T>(1.0f) - t) * P_core_x + t * P_circle.x;
                T y = (static_cast<T>(1.0f) - t) * P_core_y + t * P_circle.y;
                bottom_ring[i][kr] = static_cast<int>(nodes2D.size());
                nodes2D.push_back({x, y});
            }
        }

        // Right Ring
        std::vector<std::vector<int>> right_ring(Nc + 1, std::vector<int>(Nring + 1, -1));
        for (int j = 0; j <= Nc; ++j) right_ring[j][0] = core_map[Nc][j];
        for (int kr = 1; kr <= Nring; ++kr) {
            right_ring[0][kr] = bottom_ring[Nc][kr];
            right_ring[Nc][kr] = top_ring[Nc][kr];
            T t = static_cast<T>(kr) / static_cast<T>(Nring);
            for (int j = 1; j < Nc; ++j) {
                T u = static_cast<T>(j) / static_cast<T>(Nc);
                T P_core_x = nodes2D[core_map[Nc][j]].x;
                T P_core_y = nodes2D[core_map[Nc][j]].y;
                Node2D P_circle = getRightCirclePt(u);
                T x = (static_cast<T>(1.0f) - t) * P_core_x + t * P_circle.x;
                T y = (static_cast<T>(1.0f) - t) * P_core_y + t * P_circle.y;
                right_ring[j][kr] = static_cast<int>(nodes2D.size());
                nodes2D.push_back({x, y});
            }
        }

        // Left Ring
        std::vector<std::vector<int>> left_ring(Nc + 1, std::vector<int>(Nring + 1, -1));
        for (int j = 0; j <= Nc; ++j) left_ring[j][0] = core_map[0][j];
        for (int kr = 1; kr <= Nring; ++kr) {
            left_ring[0][kr] = bottom_ring[0][kr];
            left_ring[Nc][kr] = top_ring[0][kr];
            T t = static_cast<T>(kr) / static_cast<T>(Nring);
            for (int j = 1; j < Nc; ++j) {
                T u = static_cast<T>(j) / static_cast<T>(Nc);
                T P_core_x = nodes2D[core_map[0][j]].x;
                T P_core_y = nodes2D[core_map[0][j]].y;
                Node2D P_circle = getLeftCirclePt(u);
                T x = (static_cast<T>(1.0f) - t) * P_core_x + t * P_circle.x;
                T y = (static_cast<T>(1.0f) - t) * P_core_y + t * P_circle.y;
                left_ring[j][kr] = static_cast<int>(nodes2D.size());
                nodes2D.push_back({x, y});
            }
        }

        // 3. Assemble 2D Quads topology to build adjacency graph for Laplacian smoothing
        struct Quad2D { int n0, n1, n2, n3; };
        std::vector<Quad2D> quads;

        for (int j = 0; j < Nc; ++j) {
            for (int i = 0; i < Nc; ++i) {
                quads.push_back({core_map[i][j], core_map[i+1][j], core_map[i+1][j+1], core_map[i][j+1]});
            }
        }
        for (int kr = 0; kr < Nring; ++kr) {
            for (int i = 0; i < Nc; ++i) {
                quads.push_back({top_ring[i][kr], top_ring[i+1][kr], top_ring[i+1][kr+1], top_ring[i][kr+1]});
            }
        }
        for (int kr = 0; kr < Nring; ++kr) {
            for (int i = 0; i < Nc; ++i) {
                quads.push_back({bottom_ring[i][kr+1], bottom_ring[i+1][kr+1], bottom_ring[i+1][kr], bottom_ring[i][kr]});
            }
        }
        for (int kr = 0; kr < Nring; ++kr) {
            for (int j = 0; j < Nc; ++j) {
                quads.push_back({right_ring[j][kr], right_ring[j][kr+1], right_ring[j+1][kr+1], right_ring[j+1][kr]});
            }
        }
        for (int kr = 0; kr < Nring; ++kr) {
            for (int j = 0; j < Nc; ++j) {
                quads.push_back({left_ring[j][kr+1], left_ring[j][kr], left_ring[j+1][kr], left_ring[j+1][kr+1]});
            }
        }


        int num_2d_nodes = static_cast<int>(nodes2D.size());

        // Create 3D Nodes by extruding 2D nodes over Nz layers
        T dz = height / static_cast<T>(Nz);
        for (int k = 0; k <= Nz; ++k) {
            T z_val = pos_z + static_cast<T>(k) * dz;
            for (int n2d = 0; n2d < num_2d_nodes; ++n2d) {
                FEMNode3D<T> node{};
                node.x[0] = pos_x + nodes2D[n2d].x;
                node.x[1] = pos_y + nodes2D[n2d].y;
                node.x[2] = z_val;
                node.x0[0] = node.x[0]; node.x0[1] = node.x[1]; node.x0[2] = node.x[2];
                node.v[0] = vel_x; node.v[1] = vel_y; node.v[2] = vel_z;
                node.a[0] = 0.0f; node.a[1] = 0.0f; node.a[2] = 0.0f;
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
                node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
                node.f_contact[0] = 0.0f; node.f_contact[1] = 0.0f; node.f_contact[2] = 0.0f;
                node.m = 0.0f;
                if (is_fixed_entire || (is_fixed_base && k == 0)) {
                    node.is_fixed[0] = true;
                    node.is_fixed[1] = true;
                    node.is_fixed[2] = true;
                }
                m_nodes.push_back(node);
            }
        }

        auto getNode3D = [&](int n2d, int k) {
            return base_node_idx + k * num_2d_nodes + n2d;
        };

        // Create Hex8 Elements across all Z layers
        for (int k = 0; k < Nz; ++k) {
            for (const auto& q : quads) {
                FEMElement3D<T> elem{};
                elem.node_ids[0] = getNode3D(q.n0, k);
                elem.node_ids[1] = getNode3D(q.n1, k);
                elem.node_ids[2] = getNode3D(q.n2, k);
                elem.node_ids[3] = getNode3D(q.n3, k);
                elem.node_ids[4] = getNode3D(q.n0, k + 1);
                elem.node_ids[5] = getNode3D(q.n1, k + 1);
                elem.node_ids[6] = getNode3D(q.n2, k + 1);
                elem.node_ids[7] = getNode3D(q.n3, k + 1);

                elem.mat_id = mat_id;
                elem.part_id = part_id;

                std::memset(elem.F, 0, sizeof(elem.F));
                elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));
                std::memset(elem.s_dev, 0, sizeof(elem.s_dev));

                T x_nodes[8][3];
                for (int n = 0; n < 8; ++n) {
                    int nid = elem.node_ids[n];
                    x_nodes[n][0] = m_nodes[nid].x[0];
                    x_nodes[n][1] = m_nodes[nid].x[1];
                    x_nodes[n][2] = m_nodes[nid].x[2];
                }

                T B[6][24], detJ;
                computeHex8BMatrix(x_nodes, B, detJ);
                if (detJ <= static_cast<T>(0.0f)) {
                    std::cout << "[ERROR] Cylinder Element " << elem.node_ids[0] << " has non-positive Jacobian detJ = " << detJ << std::endl;
                }
                elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
                elem.V = elem.V0;

                m_elements.push_back(elem);
            }
        }
    } else {
        // Hollow Cylinder / Tube
        constexpr double M_PI_VAL = 3.14159265358979323846;
        int Ntheta = 4 * std::max(1, nr);
        int Nring = std::max(1, nr);
        int Nz = std::max(1, nz);

        int num_2d_nodes = Ntheta * (Nring + 1);
        T dtheta = static_cast<T>(2.0 * M_PI_VAL) / static_cast<T>(Ntheta);
        T dr = (radius - inner_radius) / static_cast<T>(Nring);
        T dz = height / static_cast<T>(Nz);

        std::vector<std::pair<T, T>> nodes2D(num_2d_nodes);
        for (int kr = 0; kr <= Nring; ++kr) {
            T r_val = inner_radius + static_cast<T>(kr) * dr;
            for (int th = 0; th < Ntheta; ++th) {
                T theta = static_cast<T>(th) * dtheta;
                T x = r_val * std::cos(theta);
                T y = r_val * std::sin(theta);
                nodes2D[kr * Ntheta + th] = {x, y};
            }
        }

        // Extrude 3D nodes
        for (int k = 0; k <= Nz; ++k) {
            T z_val = pos_z + static_cast<T>(k) * dz;
            for (int n2d = 0; n2d < num_2d_nodes; ++n2d) {
                FEMNode3D<T> node{};
                node.x[0] = pos_x + nodes2D[n2d].first;
                node.x[1] = pos_y + nodes2D[n2d].second;
                node.x[2] = z_val;
                node.x0[0] = node.x[0]; node.x0[1] = node.x[1]; node.x0[2] = node.x[2];
                node.v[0] = vel_x; node.v[1] = vel_y; node.v[2] = vel_z;
                node.a[0] = 0.0f; node.a[1] = 0.0f; node.a[2] = 0.0f;
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
                node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
                node.f_contact[0] = 0.0f; node.f_contact[1] = 0.0f; node.f_contact[2] = 0.0f;
                node.m = 0.0f;
                if (is_fixed_entire || (is_fixed_base && k == 0)) {
                    node.is_fixed[0] = true;
                    node.is_fixed[1] = true;
                    node.is_fixed[2] = true;
                }
                m_nodes.push_back(node);
            }
        }

        auto getNode3D = [&](int th, int kr, int k) {
            return base_node_idx + k * num_2d_nodes + kr * Ntheta + (th % Ntheta);
        };

        // Hex8 Elements
        for (int k = 0; k < Nz; ++k) {
            for (int kr = 0; kr < Nring; ++kr) {
                for (int th = 0; th < Ntheta; ++th) {
                    FEMElement3D<T> elem{};
                    elem.node_ids[0] = getNode3D(th, kr, k);
                    elem.node_ids[1] = getNode3D(th, kr + 1, k);
                    elem.node_ids[2] = getNode3D(th + 1, kr + 1, k);
                    elem.node_ids[3] = getNode3D(th + 1, kr, k);
                    elem.node_ids[4] = getNode3D(th, kr, k + 1);
                    elem.node_ids[5] = getNode3D(th, kr + 1, k + 1);
                    elem.node_ids[6] = getNode3D(th + 1, kr + 1, k + 1);
                    elem.node_ids[7] = getNode3D(th + 1, kr, k + 1);

                    elem.mat_id = mat_id;
                    elem.part_id = part_id;

                    std::memset(elem.F, 0, sizeof(elem.F));
                    elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                    std::memset(elem.sigma, 0, sizeof(elem.sigma));
                    std::memset(elem.s_dev, 0, sizeof(elem.s_dev));

                    T x_nodes[8][3];
                    for (int n = 0; n < 8; ++n) {
                        int nid = elem.node_ids[n];
                        x_nodes[n][0] = m_nodes[nid].x[0];
                        x_nodes[n][1] = m_nodes[nid].x[1];
                        x_nodes[n][2] = m_nodes[nid].x[2];
                    }

                    T B[6][24], detJ;
                    computeHex8BMatrix(x_nodes, B, detJ);
                    elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
                    elem.V = elem.V0;

                    m_elements.push_back(elem);
                }
            }
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();

    // Evaluate Time-Zero Baseline Timesteps (dt0)
    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        T x_n[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            x_n[n][0] = m_nodes[nid].x[0];
            x_n[n][1] = m_nodes[nid].x[1];
            x_n[n][2] = m_nodes[nid].x[2];
        }
        T L_e = computeHex8CharacteristicLength(x_n, elem.V0);
        const auto& mat_tb = m_material_tables[elem.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);
        elem.dt0 = L_e / cd;
    }
    ensureGaussPointHistory();
}

template <typename T>
void FEMSolver3D<T>::createStructuredTetBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, const std::string& boundary_condition) {
    m_nodes.clear();
    m_elements.clear();
    m_material_tables.clear();
    addStructuredTetBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, material, static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f), boundary_condition);
}

template <typename T>
void FEMSolver3D<T>::addStructuredTetBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x, T vel_y, T vel_z, const std::string& boundary_condition) {
    size_t base_elem_idx = m_elements.size();
    addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, material, vel_x, vel_y, vel_z, boundary_condition);

    static const int FREUDENTHAL_TETS[6][4] = {
        {0, 1, 2, 6},
        {0, 1, 6, 5},
        {0, 2, 3, 6},
        {0, 3, 7, 6},
        {0, 4, 5, 6},
        {0, 7, 4, 6}
    };

    std::vector<FEMElement3D<T>> hex_elems(m_elements.begin() + base_elem_idx, m_elements.end());
    m_elements.resize(base_elem_idx);
    m_elements.reserve(base_elem_idx + hex_elems.size() * 6);

    for (const auto& hex : hex_elems) {
        const auto& mat_tb = m_material_tables[hex.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);
        for (int t = 0; t < 6; ++t) {
            FEMElement3D<T> tet = hex;
            int n0 = hex.node_ids[FREUDENTHAL_TETS[t][0]];
            int n1 = hex.node_ids[FREUDENTHAL_TETS[t][1]];
            int n2 = hex.node_ids[FREUDENTHAL_TETS[t][2]];
            int n3 = hex.node_ids[FREUDENTHAL_TETS[t][3]];
            T x_tet[4][3] = {
                {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
            };
            T v_signed = computeTet4SignedVolume(x_tet);
            if (v_signed < static_cast<T>(0.0f)) {
                std::swap(n2, n3);
                std::swap(x_tet[2][0], x_tet[3][0]);
                std::swap(x_tet[2][1], x_tet[3][1]);
                std::swap(x_tet[2][2], x_tet[3][2]);
                v_signed = -v_signed;
            }
            tet.node_ids[0] = n0;
            tet.node_ids[1] = n1;
            tet.node_ids[2] = n2;
            tet.node_ids[3] = n3;
            tet.node_ids[4] = n3;
            tet.node_ids[5] = n3;
            tet.node_ids[6] = n3;
            tet.node_ids[7] = n3;
            tet.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
            tet.V = tet.V0;
            T L_e = computeTet4CharacteristicLength(x_tet, tet.V0);
            tet.dt0 = L_e / cd;
            m_elements.push_back(tet);
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    ensureGaussPointHistory();
}

template <typename T>
void FEMSolver3D<T>::addStructuredTetCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x, T vel_y, T vel_z, T inner_radius, const std::string& boundary_condition) {
    size_t base_elem_idx = m_elements.size();
    addStructuredCylinderMesh(nr, nz, radius, height, pos_x, pos_y, pos_z, material, vel_x, vel_y, vel_z, inner_radius, boundary_condition);

    static const int FREUDENTHAL_TETS[6][4] = {
        {0, 1, 2, 6},
        {0, 1, 6, 5},
        {0, 2, 3, 6},
        {0, 3, 7, 6},
        {0, 4, 5, 6},
        {0, 7, 4, 6}
    };

    std::vector<FEMElement3D<T>> hex_elems(m_elements.begin() + base_elem_idx, m_elements.end());
    m_elements.resize(base_elem_idx);
    m_elements.reserve(base_elem_idx + hex_elems.size() * 6);

    for (const auto& hex : hex_elems) {
        const auto& mat_tb = m_material_tables[hex.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);
        for (int t = 0; t < 6; ++t) {
            FEMElement3D<T> tet = hex;
            int n0 = hex.node_ids[FREUDENTHAL_TETS[t][0]];
            int n1 = hex.node_ids[FREUDENTHAL_TETS[t][1]];
            int n2 = hex.node_ids[FREUDENTHAL_TETS[t][2]];
            int n3 = hex.node_ids[FREUDENTHAL_TETS[t][3]];
            T x_tet[4][3] = {
                {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
            };
            T v_signed = computeTet4SignedVolume(x_tet);
            if (v_signed < static_cast<T>(0.0f)) {
                std::swap(n2, n3);
                std::swap(x_tet[2][0], x_tet[3][0]);
                std::swap(x_tet[2][1], x_tet[3][1]);
                std::swap(x_tet[2][2], x_tet[3][2]);
                v_signed = -v_signed;
            }
            tet.node_ids[0] = n0;
            tet.node_ids[1] = n1;
            tet.node_ids[2] = n2;
            tet.node_ids[3] = n3;
            tet.node_ids[4] = n3;
            tet.node_ids[5] = n3;
            tet.node_ids[6] = n3;
            tet.node_ids[7] = n3;
            tet.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
            tet.V = tet.V0;
            T L_e = computeTet4CharacteristicLength(x_tet, tet.V0);
            tet.dt0 = L_e / cd;
            m_elements.push_back(tet);
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    ensureGaussPointHistory();
}

template <typename T>
void FEMSolver3D<T>::addSTLMesh(const std::string& stl_filepath, int nx, int ny, int nz, T pos_x, T pos_y, T pos_z, T scale_x, T scale_y, T scale_z, T rot_x, T rot_y, T rot_z, const std::string& origin_mode, const MaterialTable3D& material, T vel_x, T vel_y, T vel_z, bool use_tet4, const std::string& boundary_condition) {
    if (stl_filepath.empty()) return;
    std::vector<Triangle> raw_triangles;
    try {
        raw_triangles = read_stl(stl_filepath);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] FEMSolver3D::addSTLMesh failed to load STL (" << stl_filepath << "): " << e.what() << std::endl;
        return;
    }
    if (raw_triangles.empty()) return;

    float sx = (scale_x > static_cast<T>(0.0f)) ? static_cast<float>(scale_x) : 1.0f;
    float sy = (scale_y > static_cast<T>(0.0f)) ? static_cast<float>(scale_y) : 1.0f;
    float sz = (scale_z > static_cast<T>(0.0f)) ? static_cast<float>(scale_z) : 1.0f;

    std::vector<Triangle> triangles = transform_triangles(
        raw_triangles, sx, sy, sz,
        static_cast<float>(pos_x), static_cast<float>(pos_y), static_cast<float>(pos_z),
        static_cast<float>(rot_x), static_cast<float>(rot_y), static_cast<float>(rot_z),
        origin_mode
    );

    float min_x = 1.0e30f, max_x = -1.0e30f;
    float min_y = 1.0e30f, max_y = -1.0e30f;
    float min_z = 1.0e30f, max_z = -1.0e30f;
    for (const auto& tri : triangles) {
        min_x = std::min({min_x, tri.v0.x, tri.v1.x, tri.v2.x});
        max_x = std::max({max_x, tri.v0.x, tri.v1.x, tri.v2.x});
        min_y = std::min({min_y, tri.v0.y, tri.v1.y, tri.v2.y});
        max_y = std::max({max_y, tri.v0.y, tri.v1.y, tri.v2.y});
        min_z = std::min({min_z, tri.v0.z, tri.v1.z, tri.v2.z});
        max_z = std::max({max_z, tri.v0.z, tri.v1.z, tri.v2.z});
    }
    if (min_x >= max_x || min_y >= max_y || min_z >= max_z) return;

    nx = std::clamp(nx, 2, 128);
    ny = std::clamp(ny, 2, 128);
    nz = std::clamp(nz, 2, 128);
    const float dx = (max_x - min_x) / static_cast<float>(nx);
    const float dy = (max_y - min_y) / static_cast<float>(ny);
    const float dz = (max_z - min_z) / static_cast<float>(nz);

    // Build 2D Y-Z acceleration bins for ray-casting
    int ny_bins = std::clamp(ny, 1, 256);
    int nz_bins = std::clamp(nz, 1, 256);
    const float bin_dy = (max_y - min_y) / static_cast<float>(ny_bins);
    const float bin_dz = (max_z - min_z) / static_cast<float>(nz_bins);
    std::vector<std::vector<int>> yz_bins(static_cast<size_t>(ny_bins) * nz_bins);
    for (int idx = 0; idx < static_cast<int>(triangles.size()); ++idx) {
        const auto& tri = triangles[idx];
        float t_min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
        float t_max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
        float t_min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
        float t_max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});
        int by0 = std::clamp(static_cast<int>(std::floor((t_min_y - min_y) / std::max(bin_dy, 1.0e-9f))), 0, ny_bins - 1);
        int by1 = std::clamp(static_cast<int>(std::floor((t_max_y - min_y) / std::max(bin_dy, 1.0e-9f))), 0, ny_bins - 1);
        int bz0 = std::clamp(static_cast<int>(std::floor((t_min_z - min_z) / std::max(bin_dz, 1.0e-9f))), 0, nz_bins - 1);
        int bz1 = std::clamp(static_cast<int>(std::floor((t_max_z - min_z) / std::max(bin_dz, 1.0e-9f))), 0, nz_bins - 1);
        for (int bz = bz0; bz <= bz1; ++bz) {
            for (int by = by0; by <= by1; ++by) {
                yz_bins[by + bz * ny_bins].push_back(idx);
            }
        }
    }

    std::vector<uint8_t> voxel_inside(static_cast<size_t>(nx) * ny * nz, 0);
    for (int k = 0; k < nz; ++k) {
        float z = min_z + (k + 0.5f) * dz;
        int bz = std::clamp(static_cast<int>(std::floor((z - min_z) / std::max(bin_dz, 1.0e-9f))), 0, nz_bins - 1);
        for (int j = 0; j < ny; ++j) {
            float y = min_y + (j + 0.5f) * dy;
            int by = std::clamp(static_cast<int>(std::floor((y - min_y) / std::max(bin_dy, 1.0e-9f))), 0, ny_bins - 1);
            std::vector<int> candidates;
            for (int cbz = std::max(0, bz - 1); cbz <= std::min(nz_bins - 1, bz + 1); ++cbz) {
                for (int cby = std::max(0, by - 1); cby <= std::min(ny_bins - 1, by + 1); ++cby) {
                    const auto& b_tris = yz_bins[cby + cbz * ny_bins];
                    candidates.insert(candidates.end(), b_tris.begin(), b_tris.end());
                }
            }
            if (candidates.empty()) continue;
            std::sort(candidates.begin(), candidates.end());
            candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());

            auto traceRay = [&](float y_pos, float z_pos, std::vector<float>& out_hits) {
                out_hits.clear();
                Point3D O = { min_x - 2.0f * dx, y_pos, z_pos };
                Point3D D = { 1.0f, 0.0f, 0.0f };
                for (int tidx : candidates) {
                    const auto& tri = triangles[tidx];
                    float t_hit;
                    if (ray_triangle_intersect(O, D, tri.v0, tri.v1, tri.v2, t_hit) && t_hit >= 0.0f) {
                        out_hits.push_back(O.x + t_hit);
                    }
                }
                if (out_hits.empty()) return;
                std::sort(out_hits.begin(), out_hits.end());
                std::vector<float> clustered;
                const float eps_merge = std::max(1.0e-3f * dx, 1.0e-5f);
                for (float xi : out_hits) {
                    if (clustered.empty() || (xi - clustered.back() > eps_merge)) {
                        clustered.push_back(xi);
                    }
                }
                out_hits = std::move(clustered);
            };

            std::vector<float> intersects;
            traceRay(y + 1.234e-4f * dy, z + 5.678e-4f * dz, intersects);
            if (intersects.size() % 2 != 0) {
                const float offsets[4][2] = {{-0.05f*dy, 0.03f*dz}, {0.07f*dy, -0.04f*dz}, {-0.03f*dy, -0.06f*dz}, {0.06f*dy, 0.07f*dz}};
                for (int oi = 0; oi < 4; ++oi) {
                    std::vector<float> alt;
                    traceRay(y + offsets[oi][0], z + offsets[oi][1], alt);
                    if (!alt.empty() && alt.size() % 2 == 0) {
                        intersects = std::move(alt);
                        break;
                    }
                }
            }
            size_t num_pairs = intersects.size() / 2;
            if (num_pairs == 0) continue;
            for (int i = 0; i < nx; ++i) {
                float x = min_x + (i + 0.5f) * dx;
                for (size_t p_idx = 0; p_idx < num_pairs; ++p_idx) {
                    if (x >= intersects[2 * p_idx] && x <= intersects[2 * p_idx + 1]) {
                        voxel_inside[(static_cast<size_t>(k) * ny + j) * nx + i] = 1;
                        break;
                    }
                }
            }
        }
    }

    int mat_id = static_cast<int>(m_material_tables.size());
    m_material_tables.push_back(material);
    int part_id = m_next_part_id++;
    T cd = computeDilatationalWaveSpeed<T>(material);

    bool is_fixed_base = (boundary_condition == "Fixed Base" || boundary_condition == "Clamped" || boundary_condition == "FixedBase");
    bool is_fixed_entire = (boundary_condition == "Fixed Entire" || boundary_condition == "FixedEntire" || boundary_condition == "Encastre");

    const int num_nodes_x = nx + 1;
    const int num_nodes_y = ny + 1;
    const int num_nodes_z = nz + 1;
    std::vector<int> grid_to_node(static_cast<size_t>(num_nodes_x) * num_nodes_y * num_nodes_z, -1);

    auto getOrCreateGridNode = [&](int gi, int gj, int gk) -> int {
        size_t g_idx = (static_cast<size_t>(gk) * num_nodes_y + gj) * num_nodes_x + gi;
        if (grid_to_node[g_idx] >= 0) return grid_to_node[g_idx];
        FEMNode3D<T> node{};
        node.x[0] = static_cast<T>(min_x + gi * dx);
        node.x[1] = static_cast<T>(min_y + gj * dy);
        node.x[2] = static_cast<T>(min_z + gk * dz);
        node.x0[0] = node.x[0]; node.x0[1] = node.x[1]; node.x0[2] = node.x[2];
        node.v[0] = vel_x; node.v[1] = vel_y; node.v[2] = vel_z;
        node.a[0] = static_cast<T>(0.0f); node.a[1] = static_cast<T>(0.0f); node.a[2] = static_cast<T>(0.0f);
        node.f_ext[0] = static_cast<T>(0.0f); node.f_ext[1] = static_cast<T>(0.0f); node.f_ext[2] = static_cast<T>(0.0f);
        node.f_int[0] = static_cast<T>(0.0f); node.f_int[1] = static_cast<T>(0.0f); node.f_int[2] = static_cast<T>(0.0f);
        node.f_contact[0] = static_cast<T>(0.0f); node.f_contact[1] = static_cast<T>(0.0f); node.f_contact[2] = static_cast<T>(0.0f);
        node.m = static_cast<T>(0.0f);
        if (is_fixed_entire || (is_fixed_base && gk == 0)) {
            node.is_fixed[0] = true;
            node.is_fixed[1] = true;
            node.is_fixed[2] = true;
        }
        int nid = static_cast<int>(m_nodes.size());
        m_nodes.push_back(node);
        grid_to_node[g_idx] = nid;
        return nid;
    };

    static const int FREUDENTHAL_TETS[6][4] = {
        {0, 1, 2, 6},
        {0, 1, 6, 5},
        {0, 2, 3, 6},
        {0, 3, 7, 6},
        {0, 4, 5, 6},
        {0, 7, 4, 6}
    };

    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                if (!voxel_inside[(static_cast<size_t>(k) * ny + j) * nx + i]) continue;
                int h_nodes[8] = {
                    getOrCreateGridNode(i,     j,     k),
                    getOrCreateGridNode(i + 1, j,     k),
                    getOrCreateGridNode(i + 1, j + 1, k),
                    getOrCreateGridNode(i,     j + 1, k),
                    getOrCreateGridNode(i,     j,     k + 1),
                    getOrCreateGridNode(i + 1, j,     k + 1),
                    getOrCreateGridNode(i + 1, j + 1, k + 1),
                    getOrCreateGridNode(i,     j + 1, k + 1)
                };
                if (use_tet4) {
                    for (int t = 0; t < 6; ++t) {
                        FEMElement3D<T> tet{};
                        int n0 = h_nodes[FREUDENTHAL_TETS[t][0]];
                        int n1 = h_nodes[FREUDENTHAL_TETS[t][1]];
                        int n2 = h_nodes[FREUDENTHAL_TETS[t][2]];
                        int n3 = h_nodes[FREUDENTHAL_TETS[t][3]];
                        T x_tet[4][3] = {
                            {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                            {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                            {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                            {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
                        };
                        T v_signed = computeTet4SignedVolume(x_tet);
                        if (v_signed < static_cast<T>(0.0f)) {
                            std::swap(n2, n3);
                            std::swap(x_tet[2][0], x_tet[3][0]);
                            std::swap(x_tet[2][1], x_tet[3][1]);
                            std::swap(x_tet[2][2], x_tet[3][2]);
                            v_signed = -v_signed;
                        }
                        tet.node_ids[0] = n0; tet.node_ids[1] = n1; tet.node_ids[2] = n2; tet.node_ids[3] = n3;
                        tet.node_ids[4] = n3; tet.node_ids[5] = n3; tet.node_ids[6] = n3; tet.node_ids[7] = n3;
                        tet.mat_id = mat_id;
                        tet.part_id = part_id;
                        std::memset(tet.F, 0, sizeof(tet.F));
                        tet.F[0][0] = static_cast<T>(1.0f); tet.F[1][1] = static_cast<T>(1.0f); tet.F[2][2] = static_cast<T>(1.0f);
                        std::memset(tet.sigma, 0, sizeof(tet.sigma));
                        std::memset(tet.s_dev, 0, sizeof(tet.s_dev));
                        tet.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
                        tet.V = tet.V0;
                        T L_e = computeTet4CharacteristicLength(x_tet, tet.V0);
                        tet.dt0 = L_e / cd;
                        m_elements.push_back(tet);
                    }
                } else {
                    FEMElement3D<T> hex{};
                    for (int n = 0; n < 8; ++n) hex.node_ids[n] = h_nodes[n];
                    hex.mat_id = mat_id;
                    hex.part_id = part_id;
                    std::memset(hex.F, 0, sizeof(hex.F));
                    hex.F[0][0] = static_cast<T>(1.0f); hex.F[1][1] = static_cast<T>(1.0f); hex.F[2][2] = static_cast<T>(1.0f);
                    std::memset(hex.sigma, 0, sizeof(hex.sigma));
                    std::memset(hex.s_dev, 0, sizeof(hex.s_dev));
                    hex.V0 = static_cast<T>(dx * dy * dz);
                    hex.V = hex.V0;
                    T x_n[8][3];
                    for (int n = 0; n < 8; ++n) {
                        x_n[n][0] = m_nodes[h_nodes[n]].x[0];
                        x_n[n][1] = m_nodes[h_nodes[n]].x[1];
                        x_n[n][2] = m_nodes[h_nodes[n]].x[2];
                    }
                    T L_e = computeHex8CharacteristicLength(x_n, hex.V0);
                    hex.dt0 = L_e / cd;
                    m_elements.push_back(hex);
                }
            }
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    ensureGaussPointHistory();
}

template <typename T>
void FEMSolver3D<T>::addDetonator(const FEMDetonator3D& det) {
    m_detonators.push_back(det);
    igniteDetonator(static_cast<T>(det.x), static_cast<T>(det.y), static_cast<T>(det.z),
                    static_cast<T>(det.radius), det.target_part_id, static_cast<T>(det.time_delay));
}

template <typename T>
void FEMSolver3D<T>::igniteDetonator(T det_x, T det_y, T det_z, T det_r, int target_part_id, T time_delay) {
    for (size_t e = 0; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded) continue;
        if (target_part_id >= 0 && elem.part_id != target_part_id) continue;
        if (elem.mat_id < 0 || elem.mat_id >= static_cast<int>(m_material_tables.size())) continue;

        const auto& mat = m_material_tables[elem.mat_id];
        bool is_jwl_prog = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn);
        bool is_crest = (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
        bool is_lee_tarver = (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        if (!is_jwl_prog && !is_crest && !is_lee_tarver) continue;

        bool is_tet = isTet4Element(elem);
        int n_verts = is_tet ? 4 : 8;
        T cx = static_cast<T>(0.0f), cy = static_cast<T>(0.0f), cz = static_cast<T>(0.0f);
        for (int n = 0; n < n_verts; ++n) {
            int nid = elem.node_ids[n];
            cx += m_nodes[nid].x[0];
            cy += m_nodes[nid].x[1];
            cz += m_nodes[nid].x[2];
        }
        T inv_nv = static_cast<T>(1.0f) / static_cast<T>(n_verts);
        cx *= inv_nv; cy *= inv_nv; cz *= inv_nv;

        T dx = cx - det_x;
        T dy = cy - det_y;
        T dz = cz - det_z;
        T dist = std::sqrt(dx * dx + dy * dy + dz * dz);
        T h_elem = std::cbrt(std::max(elem.V0, static_cast<T>(1.0e-18f)));
        T eff_rad = std::max(det_r, static_cast<T>(1.75f) * h_elem);

        ReactionKinetics active_burn = mat.burn_model;
        if (is_crest && mat.burn_model == ReactionKinetics::ProgrammedBurn) active_burn = ReactionKinetics::CRESTEntropy;
        else if (is_lee_tarver && mat.burn_model == ReactionKinetics::ProgrammedBurn) active_burn = ReactionKinetics::LeeTarverODE;

        bool use_davis_prod = (mat.product_model == DetonationProductEOS::DavisProduct) || (is_crest && mat.product_model == DetonationProductEOS::JWLProductGas && mat.jwl_A <= 0.0f);
        T q_det = static_cast<T>(use_davis_prod ? std::max(mat.davis_q_det, mat.detonation_energy) : mat.detonation_energy);

        if (active_burn == ReactionKinetics::ProgrammedBurn) {
            T eff_dist = (det_r > static_cast<T>(0.0f)) ? std::max(static_cast<T>(0.0f), dist - det_r) : dist;
            T d_vel = static_cast<T>(mat.det_vel > 100.0f ? mat.det_vel : 6930.0f);
            T t_arr = time_delay + eff_dist / d_vel;
            if (t_arr < elem.t_arrival) {
                elem.t_arrival = t_arr;
            }
            if (elem.t_arrival <= m_sim_time) {
                elem.lambda = static_cast<T>(1.0f);
                elem.e_int = q_det;
                float v_rel = static_cast<float>(elem.V0 > static_cast<T>(0.0f) ? elem.V / elem.V0 : static_cast<T>(1.0f));
                float p_init = 0.0f;
                if (use_davis_prod) {
                    float rho0 = (mat.davis_rho0 > 10.0f) ? mat.davis_rho0 : mat.density;
                    p_init = CrestDavis::computeDavisProductPressure(v_rel, static_cast<float>(elem.e_int), mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, rho0);
                } else {
                    p_init = JWL::computeJWLProductPressure(v_rel, static_cast<float>(elem.e_int), mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.sigma[r][c] = (r == c) ? static_cast<T>(-p_init) : static_cast<T>(0.0f);
                    }
                }
            }
        } else if (active_burn == ReactionKinetics::CRESTEntropy) {
            if (time_delay <= m_sim_time && dist <= eff_rad) {
                elem.s_shock = static_cast<T>((mat.crest_awe_c0 > 0.0f) ? std::max(0.02f, 2.0f * mat.crest_awe_c13) : 2.0f * std::max(mat.crest_s_threshold, 100.0f));
                elem.lambda = static_cast<T>(1.0f);
                elem.e_int = q_det;
                elem.v_min = static_cast<T>((mat.davis_vc > 0.1f) ? mat.davis_vc : 0.70f);
                T p_init = static_cast<T>((mat.davis_pc > 1.0e6f) ? mat.davis_pc : 15.0e9f);
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.sigma[r][c] = (r == c) ? -p_init : static_cast<T>(0.0f);
                    }
                }
            }
        } else if (active_burn == ReactionKinetics::LeeTarverODE) {
            if (time_delay <= m_sim_time && dist <= eff_rad) {
                elem.lambda = static_cast<T>(1.0f);
                elem.e_int = q_det;
                float p_init = 20.0e9f;
                if (!use_davis_prod && mat.jwl_A > 0.0f) {
                    p_init = JWL::computeJWLProductPressure(1.0f, static_cast<float>(elem.e_int), mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.sigma[r][c] = (r == c) ? static_cast<T>(-p_init) : static_cast<T>(0.0f);
                    }
                }
            }
        }
    }
}

template <typename T>
void FEMSolver3D<T>::setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat) {
    m_nodes.clear();
    m_elements.clear();
    m_trusses.clear();
    m_beams.clear();
    m_rot_nodes.clear();
    m_global_to_rot_node.clear();
    m_material_tables.clear();
    m_next_part_id = 1;
    appendNodesAndElements(nodes, elements, mat);
}

template <typename T>
void FEMSolver3D<T>::setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const std::vector<MaterialTable3D>& materials) {
    m_nodes.clear();
    m_elements.clear();
    m_trusses.clear();
    m_beams.clear();
    m_rot_nodes.clear();
    m_global_to_rot_node.clear();
    m_material_tables = materials;
    if (m_material_tables.empty()) {
        MaterialTable3D def_mat{};
        m_material_tables.push_back(def_mat);
    }
    m_next_part_id = 1;

    m_nodes = nodes;
    for (size_t n = 0; n < m_nodes.size(); ++n) {
        m_nodes[n].x0[0] = m_nodes[n].x[0];
        m_nodes[n].x0[1] = m_nodes[n].x[1];
        m_nodes[n].x0[2] = m_nodes[n].x[2];
    }

    m_elements.reserve(elements.size());
    for (auto elem : elements) {
        if (elem.part_id <= 0) elem.part_id = 1;
        if (elem.mat_id < 0 || elem.mat_id >= static_cast<int>(m_material_tables.size())) {
            elem.mat_id = 0;
        }
        m_elements.push_back(elem);
    }

    for (size_t e = 0; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        const auto& mat_tb = m_material_tables[elem.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);

        if (isTet4Element(elem)) {
            int n0 = elem.node_ids[0], n1 = elem.node_ids[1], n2 = elem.node_ids[2], n3 = elem.node_ids[3];
            T x_tet[4][3] = {
                {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
            };
            T v_signed = computeTet4SignedVolume(x_tet);
            if (v_signed < static_cast<T>(0.0f)) {
                std::swap(elem.node_ids[2], elem.node_ids[3]);
                elem.node_ids[4] = elem.node_ids[5] = elem.node_ids[6] = elem.node_ids[7] = elem.node_ids[3];
                std::swap(x_tet[2][0], x_tet[3][0]);
                std::swap(x_tet[2][1], x_tet[3][1]);
                std::swap(x_tet[2][2], x_tet[3][2]);
                v_signed = -v_signed;
            }
            elem.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
            elem.V = elem.V0;
            T L_e = computeTet4CharacteristicLength(x_tet, elem.V0);
            elem.dt0 = L_e / cd;
        } else {
            T x_nodes[8][3];
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                x_nodes[n][0] = m_nodes[nid].x[0];
                x_nodes[n][1] = m_nodes[nid].x[1];
                x_nodes[n][2] = m_nodes[nid].x[2];
            }
            T B[6][24], detJ;
            computeHex8BMatrix(x_nodes, B, detJ);
            elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
            elem.V = elem.V0;
            T L_e = computeHex8CharacteristicLength(x_nodes, elem.V0);
            elem.dt0 = L_e / cd;
        }
    }
    ensureGaussPointHistory();

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    computeGlobalEnergy();
}

template <typename T>
void FEMSolver3D<T>::appendNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat) {
    int mat_id = static_cast<int>(m_material_tables.size());
    m_material_tables.push_back(mat);
    int part_id = m_next_part_id++;

    int base_node_idx = static_cast<int>(m_nodes.size());
    int base_elem_idx = static_cast<int>(m_elements.size());

    m_nodes.insert(m_nodes.end(), nodes.begin(), nodes.end());
    for (size_t n = base_node_idx; n < m_nodes.size(); ++n) {
        m_nodes[n].x0[0] = m_nodes[n].x[0];
        m_nodes[n].x0[1] = m_nodes[n].x[1];
        m_nodes[n].x0[2] = m_nodes[n].x[2];
    }

    for (auto elem : elements) {
        for (int n = 0; n < 8; ++n) {
            elem.node_ids[n] += base_node_idx;
        }
        if (elem.part_id <= 0) elem.part_id = part_id;
        if (elem.mat_id < 0 || elem.mat_id >= static_cast<int>(m_material_tables.size())) {
            elem.mat_id = mat_id;
        }
        m_elements.push_back(elem);
    }

    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        const auto& mat_tb = m_material_tables[elem.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);

        if (isTet4Element(elem)) {
            int n0 = elem.node_ids[0], n1 = elem.node_ids[1], n2 = elem.node_ids[2], n3 = elem.node_ids[3];
            T x_tet[4][3] = {
                {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
            };
            T v_signed = computeTet4SignedVolume(x_tet);
            if (v_signed < static_cast<T>(0.0f)) {
                std::swap(elem.node_ids[2], elem.node_ids[3]);
                elem.node_ids[4] = elem.node_ids[5] = elem.node_ids[6] = elem.node_ids[7] = elem.node_ids[3];
                std::swap(x_tet[2][0], x_tet[3][0]);
                std::swap(x_tet[2][1], x_tet[3][1]);
                std::swap(x_tet[2][2], x_tet[3][2]);
                v_signed = -v_signed;
            }
            elem.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
            elem.V = elem.V0;
            T L_e = computeTet4CharacteristicLength(x_tet, elem.V0);
            elem.dt0 = L_e / cd;
        } else {
            T x_nodes[8][3];
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                x_nodes[n][0] = m_nodes[nid].x[0];
                x_nodes[n][1] = m_nodes[nid].x[1];
                x_nodes[n][2] = m_nodes[nid].x[2];
            }
            T B[6][24], detJ;
            computeHex8BMatrix(x_nodes, B, detJ);
            elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
            elem.V = elem.V0;
            T L_e = computeHex8CharacteristicLength(x_nodes, elem.V0);
            elem.dt0 = L_e / cd;
        }
    }
    ensureGaussPointHistory();

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    computeGlobalEnergy();
}

template <typename T>
void FEMSolver3D<T>::appendNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const std::vector<MaterialTable3D>& materials) {
    if (m_nodes.empty() && m_elements.empty()) {
        setNodesAndElements(nodes, elements, materials);
        int max_pid = 1;
        for (const auto& el : m_elements) {
            if (el.part_id > max_pid) max_pid = el.part_id;
        }
        m_next_part_id = max_pid + 1;
        return;
    }

    int mat_offset = static_cast<int>(m_material_tables.size());
    if (materials.empty()) {
        MaterialTable3D def_mat{};
        m_material_tables.push_back(def_mat);
    } else {
        m_material_tables.insert(m_material_tables.end(), materials.begin(), materials.end());
    }

    int max_existing_pid = 0;
    for (const auto& el : m_elements) {
        if (el.part_id > max_existing_pid) max_existing_pid = el.part_id;
    }
    int part_offset = std::max(max_existing_pid, m_next_part_id - 1);

    int base_node_idx = static_cast<int>(m_nodes.size());
    int base_elem_idx = static_cast<int>(m_elements.size());

    m_nodes.insert(m_nodes.end(), nodes.begin(), nodes.end());
    for (size_t n = base_node_idx; n < m_nodes.size(); ++n) {
        m_nodes[n].x0[0] = m_nodes[n].x[0];
        m_nodes[n].x0[1] = m_nodes[n].x[1];
        m_nodes[n].x0[2] = m_nodes[n].x[2];
    }

    int max_new_pid = part_offset;
    for (auto elem : elements) {
        for (int n = 0; n < 8; ++n) {
            elem.node_ids[n] += base_node_idx;
        }
        int local_pid = (elem.part_id > 0) ? elem.part_id : 1;
        elem.part_id = part_offset + local_pid;
        if (elem.part_id > max_new_pid) max_new_pid = elem.part_id;

        int local_mid = (elem.mat_id >= 0) ? elem.mat_id : 0;
        elem.mat_id = std::clamp(mat_offset + local_mid, 0, static_cast<int>(m_material_tables.size()) - 1);
        m_elements.push_back(elem);
    }
    m_next_part_id = max_new_pid + 1;

    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        const auto& mat_tb = m_material_tables[elem.mat_id];
        T cd = computeDilatationalWaveSpeed<T>(mat_tb);

        if (isTet4Element(elem)) {
            int n0 = elem.node_ids[0], n1 = elem.node_ids[1], n2 = elem.node_ids[2], n3 = elem.node_ids[3];
            T x_tet[4][3] = {
                {m_nodes[n0].x[0], m_nodes[n0].x[1], m_nodes[n0].x[2]},
                {m_nodes[n1].x[0], m_nodes[n1].x[1], m_nodes[n1].x[2]},
                {m_nodes[n2].x[0], m_nodes[n2].x[1], m_nodes[n2].x[2]},
                {m_nodes[n3].x[0], m_nodes[n3].x[1], m_nodes[n3].x[2]}
            };
            T v_signed = computeTet4SignedVolume(x_tet);
            if (v_signed < static_cast<T>(0.0f)) {
                std::swap(elem.node_ids[2], elem.node_ids[3]);
                elem.node_ids[4] = elem.node_ids[5] = elem.node_ids[6] = elem.node_ids[7] = elem.node_ids[3];
                std::swap(x_tet[2][0], x_tet[3][0]);
                std::swap(x_tet[2][1], x_tet[3][1]);
                std::swap(x_tet[2][2], x_tet[3][2]);
                v_signed = -v_signed;
            }
            elem.V0 = std::max(v_signed, static_cast<T>(1.0e-18f));
            elem.V = elem.V0;
            T L_e = computeTet4CharacteristicLength(x_tet, elem.V0);
            elem.dt0 = L_e / cd;
        } else {
            T x_nodes[8][3];
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                x_nodes[n][0] = m_nodes[nid].x[0];
                x_nodes[n][1] = m_nodes[nid].x[1];
                x_nodes[n][2] = m_nodes[nid].x[2];
            }
            T B[6][24], detJ;
            computeHex8BMatrix(x_nodes, B, detJ);
            elem.V0 = std::abs(detJ) * static_cast<T>(8.0f);
            elem.V = elem.V0;
            T L_e = computeHex8CharacteristicLength(x_nodes, elem.V0);
            elem.dt0 = L_e / cd;
        }
    }
    ensureGaussPointHistory();

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    computeGlobalEnergy();
}

template <typename T>
int FEMSolver3D<T>::mergeCoincidentNodes(T tolerance) {
    if (m_nodes.size() < 2 || tolerance <= static_cast<T>(0.0f)) return 0;

    const T tol2 = tolerance * tolerance;
    const T inv_cell = static_cast<T>(1.0f) / std::max(tolerance * static_cast<T>(2.0f), static_cast<T>(1.0e-7f));

    struct GridKey {
        int64_t ix, iy, iz;
        bool operator==(const GridKey& o) const { return ix == o.ix && iy == o.iy && iz == o.iz; }
    };
    struct GridKeyHash {
        size_t operator()(const GridKey& k) const {
            size_t h = static_cast<size_t>(k.ix) * 73856093ULL;
            h ^= static_cast<size_t>(k.iy) * 19349663ULL;
            h ^= static_cast<size_t>(k.iz) * 83492791ULL;
            return h;
        }
    };

    std::unordered_map<GridKey, std::vector<int>, GridKeyHash> spatial_bins;
    std::vector<int> old_to_new(m_nodes.size(), -1);
    std::vector<FEMNode3D<T>> welded_nodes;
    welded_nodes.reserve(m_nodes.size());

    int merged_count = 0;
    for (size_t i = 0; i < m_nodes.size(); ++i) {
        const auto& nd = m_nodes[i];
        int64_t bx = static_cast<int64_t>(std::floor(nd.x[0] * inv_cell));
        int64_t by = static_cast<int64_t>(std::floor(nd.x[1] * inv_cell));
        int64_t bz = static_cast<int64_t>(std::floor(nd.x[2] * inv_cell));

        int matched_idx = -1;
        for (int64_t dz = -1; dz <= 1 && matched_idx < 0; ++dz) {
            for (int64_t dy = -1; dy <= 1 && matched_idx < 0; ++dy) {
                for (int64_t dx = -1; dx <= 1 && matched_idx < 0; ++dx) {
                    auto it = spatial_bins.find({bx + dx, by + dy, bz + dz});
                    if (it == spatial_bins.end()) continue;
                    for (int cand_idx : it->second) {
                        const auto& cn = welded_nodes[cand_idx];
                        T ddx = nd.x[0] - cn.x[0];
                        T ddy = nd.x[1] - cn.x[1];
                        T ddz = nd.x[2] - cn.x[2];
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) {
                            matched_idx = cand_idx;
                            break;
                        }
                    }
                }
            }
        }

        if (matched_idx >= 0) {
            old_to_new[i] = matched_idx;
            for (int d = 0; d < 3; ++d) {
                if (nd.is_fixed[d]) welded_nodes[matched_idx].is_fixed[d] = true;
            }
            ++merged_count;
        } else {
            int new_idx = static_cast<int>(welded_nodes.size());
            welded_nodes.push_back(nd);
            old_to_new[i] = new_idx;
            spatial_bins[{bx, by, bz}].push_back(new_idx);
        }
    }

    if (merged_count == 0) return 0;

    m_nodes = std::move(welded_nodes);
    for (auto& elem : m_elements) {
        for (int n = 0; n < 8; ++n) {
            int old_id = elem.node_ids[n];
            if (old_id >= 0 && old_id < static_cast<int>(old_to_new.size())) {
                elem.node_ids[n] = old_to_new[old_id];
            }
        }
    }
    for (auto& tr : m_trusses) {
        for (int n = 0; n < 2; ++n) {
            int old_id = tr.node_ids[n];
            if (old_id >= 0 && old_id < static_cast<int>(old_to_new.size())) {
                tr.node_ids[n] = old_to_new[old_id];
            }
        }
    }
    for (auto& bm : m_beams) {
        for (int n = 0; n < 2; ++n) {
            int old_id = bm.node_ids[n];
            if (old_id >= 0 && old_id < static_cast<int>(old_to_new.size())) {
                bm.node_ids[n] = old_to_new[old_id];
            }
        }
    }
    for (auto& rn : m_rot_nodes) {
        if (rn.global_node_id >= 0 && rn.global_node_id < static_cast<int>(old_to_new.size())) {
            rn.global_node_id = old_to_new[rn.global_node_id];
        }
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    computeGlobalEnergy();
    return merged_count;
}

template <typename T>
void FEMSolver3D<T>::addTruss(int n1, int n2, T area, const MaterialTable3D& mat, T failure_strain, int64_t lsdyna_id) {
    if (n1 < 0 || n1 >= static_cast<int>(m_nodes.size()) || n2 < 0 || n2 >= static_cast<int>(m_nodes.size()) || n1 == n2) {
        return;
    }
    MaterialTable3D truss_mat = mat;
    if (truss_mat.youngs_modulus < 100.0e9f || truss_mat.yield_stress < 100.0e6f ||
        truss_mat.material_model == MPMMaterialModel::RHTConcrete ||
        truss_mat.material_model == MPMMaterialModel::KCConcrete ||
        truss_mat.material_model == MPMMaterialModel::CSCMConcrete) {
        truss_mat.youngs_modulus = 200.0e9f;
        truss_mat.yield_stress = 500.0e6f;
        truss_mat.hardening_modulus = 2.0e9f;
        truss_mat.poissons_ratio = 0.30f;
        truss_mat.density = 7850.0f;
        truss_mat.material_model = MPMMaterialModel::Hypoelastic;
        truss_mat.failure_strain = 0.20f;
    }

    int mat_id = -1;
    for (size_t i = 0; i < m_material_tables.size(); ++i) {
        if (std::abs(m_material_tables[i].density - truss_mat.density) < 1.0f &&
            std::abs(m_material_tables[i].youngs_modulus - truss_mat.youngs_modulus) < 1.0e6f &&
            std::abs(m_material_tables[i].yield_stress - truss_mat.yield_stress) < 1.0e5f) {
            mat_id = static_cast<int>(i);
            break;
        }
    }
    if (mat_id < 0) {
        mat_id = static_cast<int>(m_material_tables.size());
        m_material_tables.push_back(truss_mat);
    }
    int part_id = m_next_part_id++;

    T dx = m_nodes[n2].x[0] - m_nodes[n1].x[0];
    T dy = m_nodes[n2].x[1] - m_nodes[n1].x[1];
    T dz = m_nodes[n2].x[2] - m_nodes[n1].x[2];
    T L0 = std::sqrt(dx*dx + dy*dy + dz*dz);

    FEMTrussElement3D<T> truss{};
    truss.node_ids[0] = n1;
    truss.node_ids[1] = n2;
    truss.A = area > static_cast<T>(0.0f) ? area : static_cast<T>(1.13097e-4f);
    truss.L0 = L0;
    truss.eps_p = static_cast<T>(0.0f);
    truss.ep_bar = static_cast<T>(0.0f);
    truss.failure_strain = failure_strain > static_cast<T>(0.0f) ? failure_strain : static_cast<T>(0.20f);
    truss.mat_id = mat_id;
    truss.part_id = part_id;
    truss.lsdyna_id = lsdyna_id;

    m_trusses.push_back(truss);
    T truss_density = (mat_id >= 0 && mat_id < static_cast<int>(m_material_tables.size()))
                        ? static_cast<T>(m_material_tables[mat_id].density)
                        : static_cast<T>(7850.0f);
    T half_truss_mass = truss_density * truss.A * L0 * static_cast<T>(0.5f);
    m_nodes[n1].m += half_truss_mass;
    m_nodes[n2].m += half_truss_mass;
}

template <typename T>
void FEMSolver3D<T>::addBeam3D(int n1, int n2, T diameter, const MaterialTable3D& mat, T failure_strain, int64_t lsdyna_id) {
    if (n1 < 0 || n1 >= static_cast<int>(m_nodes.size()) || n2 < 0 || n2 >= static_cast<int>(m_nodes.size()) || n1 == n2) {
        return;
    }
    MaterialTable3D beam_mat = mat;
    if (beam_mat.youngs_modulus < 100.0e9f || beam_mat.yield_stress < 100.0e6f ||
        beam_mat.material_model == MPMMaterialModel::RHTConcrete ||
        beam_mat.material_model == MPMMaterialModel::KCConcrete ||
        beam_mat.material_model == MPMMaterialModel::CSCMConcrete) {
        beam_mat.youngs_modulus = 200.0e9f;
        beam_mat.yield_stress = 500.0e6f;
        beam_mat.hardening_modulus = 2.0e9f;
        beam_mat.poissons_ratio = 0.30f;
        beam_mat.density = 7850.0f;
        beam_mat.material_model = MPMMaterialModel::Hypoelastic;
        beam_mat.failure_strain = 0.20f;
    }

    int mat_id = -1;
    for (size_t i = 0; i < m_material_tables.size(); ++i) {
        if (std::abs(m_material_tables[i].density - beam_mat.density) < 1.0f &&
            std::abs(m_material_tables[i].youngs_modulus - beam_mat.youngs_modulus) < 1.0e6f &&
            std::abs(m_material_tables[i].yield_stress - beam_mat.yield_stress) < 1.0e5f) {
            mat_id = static_cast<int>(i);
            break;
        }
    }
    if (mat_id < 0) {
        mat_id = static_cast<int>(m_material_tables.size());
        m_material_tables.push_back(beam_mat);
    }
    int part_id = m_next_part_id++;

    T d = diameter > static_cast<T>(0.0f) ? diameter : static_cast<T>(0.012f);
    T A = static_cast<T>(M_PI) * (d * d) * static_cast<T>(0.25f);
    T I_val = static_cast<T>(M_PI) * (d * d * d * d) / static_cast<T>(64.0f);
    T J_val = static_cast<T>(2.0f) * I_val;
    T Zp_val = (d * d * d) / static_cast<T>(6.0f);

    T dx = m_nodes[n2].x[0] - m_nodes[n1].x[0];
    T dy = m_nodes[n2].x[1] - m_nodes[n1].x[1];
    T dz = m_nodes[n2].x[2] - m_nodes[n1].x[2];
    T L0 = std::sqrt(dx*dx + dy*dy + dz*dz);
    if (L0 < static_cast<T>(1.0e-12f)) return;

    auto getOrCreateRotNode = [this](int global_node) -> int {
        if (global_node < 0 || global_node >= static_cast<int>(m_nodes.size())) return -1;
        if (m_global_to_rot_node.size() < m_nodes.size()) {
            m_global_to_rot_node.assign(m_nodes.size(), -1);
        }
        int existing = m_global_to_rot_node[global_node];
        if (existing >= 0 && existing < static_cast<int>(m_rot_nodes.size())) {
            return existing;
        }
        FEMNodeRotationalState3D<T> rnode{};
        rnode.global_node_id = global_node;
        int new_idx = static_cast<int>(m_rot_nodes.size());
        m_rot_nodes.push_back(rnode);
        m_global_to_rot_node[global_node] = new_idx;
        return new_idx;
    };

    int rot1 = getOrCreateRotNode(n1);
    int rot2 = getOrCreateRotNode(n2);

    FEMBeam3DElement<T> beam{};
    beam.node_ids[0] = n1;
    beam.node_ids[1] = n2;
    beam.rot_node_ids[0] = rot1;
    beam.rot_node_ids[1] = rot2;
    beam.d = d;
    beam.A = A;
    beam.I2 = I_val;
    beam.I3 = I_val;
    beam.J = J_val;
    beam.Zp = Zp_val;
    beam.L0 = L0;
    beam.failure_strain = failure_strain > static_cast<T>(0.0f) ? failure_strain : static_cast<T>(0.20f);
    beam.mat_id = mat_id;
    beam.part_id = part_id;
    beam.lsdyna_id = lsdyna_id;

    T invL = static_cast<T>(1.0f) / L0;
    T e1[3] = { dx * invL, dy * invL, dz * invL };

    T v_ref[3] = { static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f) };
    if (std::abs(e1[1]) > static_cast<T>(0.90f)) {
        v_ref[0] = static_cast<T>(1.0f);
        v_ref[1] = static_cast<T>(0.0f);
        v_ref[2] = static_cast<T>(0.0f);
    }

    T e3_raw[3] = {
        e1[1] * v_ref[2] - e1[2] * v_ref[1],
        e1[2] * v_ref[0] - e1[0] * v_ref[2],
        e1[0] * v_ref[1] - e1[1] * v_ref[0]
    };
    T norm_e3 = std::sqrt(e3_raw[0]*e3_raw[0] + e3_raw[1]*e3_raw[1] + e3_raw[2]*e3_raw[2]);
    if (norm_e3 < static_cast<T>(1.0e-12f)) norm_e3 = static_cast<T>(1.0f);
    beam.e3[0] = e3_raw[0] / norm_e3;
    beam.e3[1] = e3_raw[1] / norm_e3;
    beam.e3[2] = e3_raw[2] / norm_e3;

    beam.e2[0] = beam.e3[1] * e1[2] - beam.e3[2] * e1[1];
    beam.e2[1] = beam.e3[2] * e1[0] - beam.e3[0] * e1[2];
    beam.e2[2] = beam.e3[0] * e1[1] - beam.e3[1] * e1[0];

    m_beams.push_back(beam);

    T beam_density = (mat_id >= 0 && mat_id < static_cast<int>(m_material_tables.size()))
                        ? static_cast<T>(m_material_tables[mat_id].density)
                        : static_cast<T>(7850.0f);
    T half_beam_mass = beam_density * beam.A * L0 * static_cast<T>(0.5f);
    m_nodes[n1].m += half_beam_mass;
    m_nodes[n2].m += half_beam_mass;

    T I_rot_half = static_cast<T>(0.5f) * beam_density * ( (beam.A * beam.L0 * beam.L0 * beam.L0) / static_cast<T>(12.0f) + beam.I2 * beam.L0 );
    if (rot1 >= 0 && rot1 < static_cast<int>(m_rot_nodes.size())) {
        m_rot_nodes[rot1].I_rot += I_rot_half;
    }
    if (rot2 >= 0 && rot2 < static_cast<int>(m_rot_nodes.size())) {
        m_rot_nodes[rot2].I_rot += I_rot_half;
    }
}

template <typename T>
void FEMSolver3D<T>::computeTrussForces1D(T dt) {
    (void)dt;
    if (m_trusses.empty()) return;

#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int e = 0; e < static_cast<int>(m_trusses.size()); ++e) {
        auto& truss = m_trusses[e];
        if (truss.is_eroded || truss.L0 <= static_cast<T>(0.0f)) continue;

        int n1 = truss.node_ids[0];
        int n2 = truss.node_ids[1];

        T dx = m_nodes[n2].x[0] - m_nodes[n1].x[0];
        T dy = m_nodes[n2].x[1] - m_nodes[n1].x[1];
        T dz = m_nodes[n2].x[2] - m_nodes[n1].x[2];
        T L = std::sqrt(dx*dx + dy*dy + dz*dz);
        if (L < static_cast<T>(1.0e-12f)) continue;

        T invL = static_cast<T>(1.0f) / L;
        T e1[3] = { dx * invL, dy * invL, dz * invL };

        T eps = (L - truss.L0) / truss.L0;

        const auto& mat = m_material_tables[truss.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
        T sigma_y0 = static_cast<T>(mat.yield_stress > 0.0f ? mat.yield_stress : 500.0e6f);
        T Etan = static_cast<T>(mat.hardening_modulus > 0.0f ? mat.hardening_modulus : 2.0e9f);

        T trial_stress = E * (eps - truss.eps_p);
        T abs_trial = std::abs(trial_stress);
        T current_yield = sigma_y0 + Etan * truss.ep_bar;

        T sigma = trial_stress;
        if (abs_trial > current_yield) {
            T dep = (abs_trial - current_yield) / (E + Etan);
            T sign_trial = (trial_stress > static_cast<T>(0.0f) ? static_cast<T>(1.0f) : static_cast<T>(-1.0f));
            truss.eps_p += sign_trial * dep;
            truss.ep_bar += dep;
            sigma = sign_trial * (current_yield + Etan * dep);
        }
        truss.sigma = sigma;

        if (truss.ep_bar >= truss.failure_strain) {
            truss.is_eroded = true;
            continue;
        }

        T N = sigma * truss.A;
        T fx = N * e1[0];
        T fy = N * e1[1];
        T fz = N * e1[2];

#ifdef _OPENMP
        #pragma omp atomic
        m_nodes[n2].f_int[0] += fx;
        #pragma omp atomic
        m_nodes[n2].f_int[1] += fy;
        #pragma omp atomic
        m_nodes[n2].f_int[2] += fz;

        #pragma omp atomic
        m_nodes[n1].f_int[0] -= fx;
        #pragma omp atomic
        m_nodes[n1].f_int[1] -= fy;
        #pragma omp atomic
        m_nodes[n1].f_int[2] -= fz;
#else
        m_nodes[n2].f_int[0] += fx;
        m_nodes[n2].f_int[1] += fy;
        m_nodes[n2].f_int[2] += fz;

        m_nodes[n1].f_int[0] -= fx;
        m_nodes[n1].f_int[1] -= fy;
        m_nodes[n1].f_int[2] -= fz;
#endif
    }
}

template <typename T>
void FEMSolver3D<T>::computeBeamForces3D(T dt) {
    if (m_beams.empty()) return;

    for (auto& rnode : m_rot_nodes) {
        rnode.m_int[0] = static_cast<T>(0.0f);
        rnode.m_int[1] = static_cast<T>(0.0f);
        rnode.m_int[2] = static_cast<T>(0.0f);
    }

#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int e = 0; e < static_cast<int>(m_beams.size()); ++e) {
        auto& beam = m_beams[e];
        if (beam.is_eroded || beam.L0 <= static_cast<T>(0.0f)) continue;

        int n1 = beam.node_ids[0];
        int n2 = beam.node_ids[1];
        int r1 = beam.rot_node_ids[0];
        int r2 = beam.rot_node_ids[1];

        T dx = m_nodes[n2].x[0] - m_nodes[n1].x[0];
        T dy = m_nodes[n2].x[1] - m_nodes[n1].x[1];
        T dz = m_nodes[n2].x[2] - m_nodes[n1].x[2];
        T L = std::sqrt(dx*dx + dy*dy + dz*dz);
        if (L < static_cast<T>(1.0e-12f)) continue;

        T invL = static_cast<T>(1.0f) / L;
        T e1[3] = { dx * invL, dy * invL, dz * invL };

        T eps = (L - beam.L0) / beam.L0;

        const auto& mat = m_material_tables[beam.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
        T nu = static_cast<T>(mat.poissons_ratio > 0.0f ? mat.poissons_ratio : 0.30f);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T sigma_y0 = static_cast<T>(mat.yield_stress > 0.0f ? mat.yield_stress : 500.0e6f);
        T Etan = static_cast<T>(mat.hardening_modulus > 0.0f ? mat.hardening_modulus : 2.0e9f);

        T trial_stress = E * (eps - beam.eps_p);
        T abs_trial = std::abs(trial_stress);
        T current_yield = sigma_y0 + Etan * beam.ep_bar;

        T sigma = trial_stress;
        if (abs_trial > current_yield) {
            T dep = (abs_trial - current_yield) / (E + Etan);
            T sign_trial = (trial_stress > static_cast<T>(0.0f) ? static_cast<T>(1.0f) : static_cast<T>(-1.0f));
            beam.eps_p += sign_trial * dep;
            beam.ep_bar += dep;
            sigma = sign_trial * (current_yield + Etan * dep);
        }
        T N = sigma * beam.A;

        T w1[3] = { static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f) };
        T w2[3] = { static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f) };
        if (r1 >= 0 && r1 < static_cast<int>(m_rot_nodes.size())) {
            w1[0] = m_rot_nodes[r1].omega[0];
            w1[1] = m_rot_nodes[r1].omega[1];
            w1[2] = m_rot_nodes[r1].omega[2];
        }
        if (r2 >= 0 && r2 < static_cast<int>(m_rot_nodes.size())) {
            w2[0] = m_rot_nodes[r2].omega[0];
            w2[1] = m_rot_nodes[r2].omega[1];
            w2[2] = m_rot_nodes[r2].omega[2];
        }

        T dw[3] = { w2[0] - w1[0], w2[1] - w1[1], w2[2] - w1[2] };
        T dot_kappa2 = (dw[0]*beam.e2[0] + dw[1]*beam.e2[1] + dw[2]*beam.e2[2]) * invL;
        T dot_kappa3 = (dw[0]*beam.e3[0] + dw[1]*beam.e3[1] + dw[2]*beam.e3[2]) * invL;
        T dot_kappa_tor = (dw[0]*e1[0] + dw[1]*e1[1] + dw[2]*e1[2]) * invL;

        beam.kappa2 += dot_kappa2 * dt;
        beam.kappa3 += dot_kappa3 * dt;
        beam.kappa_tor += dot_kappa_tor * dt;

        T dv[3] = { m_nodes[n2].v[0] - m_nodes[n1].v[0], m_nodes[n2].v[1] - m_nodes[n1].v[1], m_nodes[n2].v[2] - m_nodes[n1].v[2] };
        T omega_rigid[3] = {
            (e1[1]*dv[2] - e1[2]*dv[1]) * invL,
            (e1[2]*dv[0] - e1[0]*dv[2]) * invL,
            (e1[0]*dv[1] - e1[1]*dv[0]) * invL
        };
        T w_avg[3] = {
            static_cast<T>(0.5f) * (w1[0] + w2[0]),
            static_cast<T>(0.5f) * (w1[1] + w2[1]),
            static_cast<T>(0.5f) * (w1[2] + w2[2])
        };
        T dot_gamma12 = 0.0f;
        T dot_gamma13 = 0.0f;
        T V2 = 0.0f;
        T V3 = 0.0f;

        if (r1 >= 0 && r1 < static_cast<int>(m_rot_nodes.size()) && r2 >= 0 && r2 < static_cast<int>(m_rot_nodes.size())) {
            T w_mag_sq = w1[0]*w1[0] + w1[1]*w1[1] + w1[2]*w1[2] + w2[0]*w2[0] + w2[1]*w2[1] + w2[2]*w2[2];
            if (w_mag_sq > static_cast<T>(1.0e-12f)) {
                T w_avg[3] = {
                    static_cast<T>(0.5f) * (w1[0] + w2[0]),
                    static_cast<T>(0.5f) * (w1[1] + w2[1]),
                    static_cast<T>(0.5f) * (w1[2] + w2[2])
                };
                T w_rel[3] = { w_avg[0] - omega_rigid[0], w_avg[1] - omega_rigid[1], w_avg[2] - omega_rigid[2] };
                dot_gamma12 = w_rel[0]*beam.e3[0] + w_rel[1]*beam.e3[1] + w_rel[2]*beam.e3[2];
                dot_gamma13 = -(w_rel[0]*beam.e2[0] + w_rel[1]*beam.e2[1] + w_rel[2]*beam.e2[2]);
                beam.gamma12 += dot_gamma12 * dt;
                beam.gamma13 += dot_gamma13 * dt;
                T kappa_shear = static_cast<T>(0.90f);
                V2 = kappa_shear * G * beam.A * beam.gamma12;
                V3 = kappa_shear * G * beam.A * beam.gamma13;
            }
        }

        T M2 = E * beam.I2 * beam.kappa2;
        T M3 = E * beam.I3 * beam.kappa3;
        T M_res = std::sqrt(M2*M2 + M3*M3);
        T Mp = beam.Zp * current_yield;
        if (M_res > Mp && M_res > static_cast<T>(1.0e-12f)) {
            T scale_m = Mp / M_res;
            M2 *= scale_m;
            M3 *= scale_m;
        }

        T T_tor = G * beam.J * beam.kappa_tor;

        if (beam.ep_bar >= beam.failure_strain) {
            beam.is_eroded = true;
            continue;
        }

        T f2_x = N * e1[0];
        T f2_y = N * e1[1];
        T f2_z = N * e1[2];

#ifdef _OPENMP
        #pragma omp atomic
        m_nodes[n2].f_int[0] += f2_x;
        #pragma omp atomic
        m_nodes[n2].f_int[1] += f2_y;
        #pragma omp atomic
        m_nodes[n2].f_int[2] += f2_z;

        #pragma omp atomic
        m_nodes[n1].f_int[0] -= f2_x;
        #pragma omp atomic
        m_nodes[n1].f_int[1] -= f2_y;
        #pragma omp atomic
        m_nodes[n1].f_int[2] -= f2_z;
#else
        m_nodes[n2].f_int[0] += f2_x;
        m_nodes[n2].f_int[1] += f2_y;
        m_nodes[n2].f_int[2] += f2_z;

        m_nodes[n1].f_int[0] -= f2_x;
        m_nodes[n1].f_int[1] -= f2_y;
        m_nodes[n1].f_int[2] -= f2_z;
#endif

        T half_L = static_cast<T>(0.5f) * L;
        T V_cross[3] = {
            -V3 * beam.e2[0] + V2 * beam.e3[0],
            -V3 * beam.e2[1] + V2 * beam.e3[1],
            -V3 * beam.e2[2] + V2 * beam.e3[2]
        };

        T m2_x = T_tor * e1[0] + M2 * beam.e2[0] + M3 * beam.e3[0] + half_L * V_cross[0];
        T m2_y = T_tor * e1[1] + M2 * beam.e2[1] + M3 * beam.e3[1] + half_L * V_cross[1];
        T m2_z = T_tor * e1[2] + M2 * beam.e2[2] + M3 * beam.e3[2] + half_L * V_cross[2];

        T m1_x = -T_tor * e1[0] - M2 * beam.e2[0] - M3 * beam.e3[0] + half_L * V_cross[0];
        T m1_y = -T_tor * e1[1] - M2 * beam.e2[1] - M3 * beam.e3[1] + half_L * V_cross[1];
        T m1_z = -T_tor * e1[2] - M2 * beam.e2[2] - M3 * beam.e3[2] + half_L * V_cross[2];

        if (r2 >= 0 && r2 < static_cast<int>(m_rot_nodes.size())) {
#ifdef _OPENMP
            #pragma omp atomic
            m_rot_nodes[r2].m_int[0] += m2_x;
            #pragma omp atomic
            m_rot_nodes[r2].m_int[1] += m2_y;
            #pragma omp atomic
            m_rot_nodes[r2].m_int[2] += m2_z;
#else
            m_rot_nodes[r2].m_int[0] += m2_x;
            m_rot_nodes[r2].m_int[1] += m2_y;
            m_rot_nodes[r2].m_int[2] += m2_z;
#endif
        }

        if (r1 >= 0 && r1 < static_cast<int>(m_rot_nodes.size())) {
#ifdef _OPENMP
            #pragma omp atomic
            m_rot_nodes[r1].m_int[0] += m1_x;
            #pragma omp atomic
            m_rot_nodes[r1].m_int[1] += m1_y;
            #pragma omp atomic
            m_rot_nodes[r1].m_int[2] += m1_z;
#else
            m_rot_nodes[r1].m_int[0] += m1_x;
            m_rot_nodes[r1].m_int[1] += m1_y;
            m_rot_nodes[r1].m_int[2] += m1_z;
#endif
        }
    }
}

template <typename T>
void FEMSolver3D<T>::updateRotationalKinematicsCentralDifference(T dt) {
    if (m_rot_nodes.empty()) return;

#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int i = 0; i < static_cast<int>(m_rot_nodes.size()); ++i) {
        auto& rnode = m_rot_nodes[i];
        if (rnode.I_rot <= static_cast<T>(1.0e-12f)) continue;

        for (int c = 0; c < 3; ++c) {
            if (rnode.is_fixed[c]) {
                rnode.omega[c] = static_cast<T>(0.0f);
                rnode.alpha[c] = static_cast<T>(0.0f);
                continue;
            }
            T m_net = rnode.m_ext[c] - rnode.m_int[c];
            rnode.alpha[c] = m_net / rnode.I_rot;
            rnode.omega[c] += rnode.alpha[c] * dt;
        }
    }
}

template <typename T>
void FEMSolver3D<T>::computeLumpedMasses() {
    m_max_nodes_capacity = std::max(m_max_nodes_capacity, m_nodes.size() + 4 * m_elements.size());
    m_nodes.reserve(m_max_nodes_capacity);
    m_nodal_vol_cur.resize(m_max_nodes_capacity, static_cast<T>(0.0f));
    m_nodal_vol_ref.resize(m_max_nodes_capacity, static_cast<T>(0.0f));
    m_node_elem_ref_count.assign(m_max_nodes_capacity, 0);

    for (auto& node : m_nodes) {
        node.m = static_cast<T>(0.0f);
    }
    for (auto& rnode : m_rot_nodes) {
        rnode.I_rot = static_cast<T>(0.0f);
    }

    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        T density = (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(m_material_tables.size()))
                    ? static_cast<T>(m_material_tables[elem.mat_id].density)
                    : static_cast<T>(7850.0f);
        T elem_mass = density * elem.V0;
        if (isTet4Element(elem)) {
            T node_mass = elem_mass * static_cast<T>(0.25f);
            for (int n = 0; n < 4; ++n) {
                int nid = elem.node_ids[n];
                m_nodes[nid].m += node_mass;
                if (nid >= 0 && nid < static_cast<int>(m_node_elem_ref_count.size())) {
                    m_node_elem_ref_count[nid]++;
                }
            }
        } else {
            T node_mass = elem_mass / static_cast<T>(8.0f);
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                m_nodes[nid].m += node_mass;
                if (nid >= 0 && nid < static_cast<int>(m_node_elem_ref_count.size())) {
                    m_node_elem_ref_count[nid]++;
                }
            }
        }
    }

    for (const auto& truss : m_trusses) {
        if (truss.is_eroded || truss.L0 <= static_cast<T>(0.0f)) continue;
        T density = (truss.mat_id >= 0 && truss.mat_id < static_cast<int>(m_material_tables.size()))
                    ? static_cast<T>(m_material_tables[truss.mat_id].density)
                    : static_cast<T>(7850.0f);
        T truss_mass = density * truss.A * truss.L0;
        T half_mass = truss_mass * static_cast<T>(0.5f);
        m_nodes[truss.node_ids[0]].m += half_mass;
        m_nodes[truss.node_ids[1]].m += half_mass;
    }

    for (const auto& beam : m_beams) {
        if (beam.is_eroded || beam.L0 <= static_cast<T>(0.0f)) continue;
        T density = (beam.mat_id >= 0 && beam.mat_id < static_cast<int>(m_material_tables.size()))
                    ? static_cast<T>(m_material_tables[beam.mat_id].density)
                    : static_cast<T>(7850.0f);
        T beam_mass = density * beam.A * beam.L0;
        T half_mass = beam_mass * static_cast<T>(0.5f);
        m_nodes[beam.node_ids[0]].m += half_mass;
        m_nodes[beam.node_ids[1]].m += half_mass;

        T I_rot_half = static_cast<T>(0.5f) * density * ( (beam.A * beam.L0 * beam.L0 * beam.L0) / static_cast<T>(12.0f) + beam.I2 * beam.L0 );
        if (beam.rot_node_ids[0] >= 0 && beam.rot_node_ids[0] < static_cast<int>(m_rot_nodes.size())) {
            m_rot_nodes[beam.rot_node_ids[0]].I_rot += I_rot_half;
        }
        if (beam.rot_node_ids[1] >= 0 && beam.rot_node_ids[1] < static_cast<int>(m_rot_nodes.size())) {
            m_rot_nodes[beam.rot_node_ids[1]].I_rot += I_rot_half;
        }
    }
}

template <typename T>
void FEMSolver3D<T>::computeHex8BMatrix(const T x_nodes[8][3], T B[6][24], T& detJ) const {
    std::memset(B, 0, sizeof(T) * 6 * 24);

    // Evaluate shape function derivatives at center (xi=0, eta=0, zeta=0)
    T dN_dxi[8][3];
    for (int i = 0; i < 8; ++i) {
        dN_dxi[i][0] = 0.125f * HEX8_XI[i][0];
        dN_dxi[i][1] = 0.125f * HEX8_XI[i][1];
        dN_dxi[i][2] = 0.125f * HEX8_XI[i][2];
    }

    // Subtract element centroid to preserve 24-bit floating point precision in Jacobian
    T x_center[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < 8; ++n) {
        x_center[0] += x_nodes[n][0];
        x_center[1] += x_nodes[n][1];
        x_center[2] += x_nodes[n][2];
    }
    x_center[0] *= static_cast<T>(0.125f);
    x_center[1] *= static_cast<T>(0.125f);
    x_center[2] *= static_cast<T>(0.125f);

    T x_rel[8][3];
    for (int n = 0; n < 8; ++n) {
        x_rel[n][0] = x_nodes[n][0] - x_center[0];
        x_rel[n][1] = x_nodes[n][1] - x_center[1];
        x_rel[n][2] = x_nodes[n][2] - x_center[2];
    }

    // Compute Jacobian matrix J (3x3)
    T J[3][3] = {{0.0f}};
    for (int i = 0; i < 8; ++i) {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                J[r][c] += dN_dxi[i][r] * x_rel[i][c];
            }
        }
    }

    // Determinant of J
    detJ = J[0][0] * (J[1][1]*J[2][2] - J[1][2]*J[2][1])
         - J[0][1] * (J[1][0]*J[2][2] - J[1][2]*J[2][0])
         + J[0][2] * (J[1][0]*J[2][1] - J[1][1]*J[2][0]);

    T invDetJ = static_cast<T>(0.0f);
    if (std::abs(detJ) > static_cast<T>(1.0e-15f)) {
        invDetJ = static_cast<T>(1.0f) / detJ;
    }

    // Inverse Jacobian J_inv (3x3)
    T J_inv[3][3];
    J_inv[0][0] = (J[1][1]*J[2][2] - J[1][2]*J[2][1]) * invDetJ;
    J_inv[0][1] = (J[0][2]*J[2][1] - J[0][1]*J[2][2]) * invDetJ;
    J_inv[0][2] = (J[0][1]*J[1][2] - J[0][2]*J[1][1]) * invDetJ;

    J_inv[1][0] = (J[1][2]*J[2][0] - J[1][0]*J[2][2]) * invDetJ;
    J_inv[1][1] = (J[0][0]*J[2][2] - J[0][2]*J[2][0]) * invDetJ;
    J_inv[1][2] = (J[0][2]*J[1][0] - J[0][0]*J[1][2]) * invDetJ;

    J_inv[2][0] = (J[1][0]*J[2][1] - J[1][1]*J[2][0]) * invDetJ;
    J_inv[2][1] = (J[0][1]*J[2][0] - J[0][0]*J[2][1]) * invDetJ;
    J_inv[2][2] = (J[0][0]*J[1][1] - J[0][1]*J[1][0]) * invDetJ;

    // Compute spatial shape function derivatives dN_dx[8][3]
    T dN_dx[8][3];
    for (int i = 0; i < 8; ++i) {
        for (int c = 0; c < 3; ++c) {
            dN_dx[i][c] = J_inv[c][0] * dN_dxi[i][0] + J_inv[c][1] * dN_dxi[i][1] + J_inv[c][2] * dN_dxi[i][2];
        }
    }

    // Assemble B Matrix (6x24)
    for (int i = 0; i < 8; ++i) {
        int col = i * 3;
        B[0][col + 0] = dN_dx[i][0];
        B[1][col + 1] = dN_dx[i][1];
        B[2][col + 2] = dN_dx[i][2];

        B[3][col + 0] = dN_dx[i][1]; B[3][col + 1] = dN_dx[i][0];
        B[4][col + 1] = dN_dx[i][2]; B[4][col + 2] = dN_dx[i][1];
        B[5][col + 0] = dN_dx[i][2]; B[5][col + 2] = dN_dx[i][0];
    }
}

template <typename T>
void FEMSolver3D<T>::computeHourglassForcesFB(FEMElement3D<T>& elem, T dt, const T x_nodes[8][3], const T v_nodes[8][3], const T B[6][24], const T dN_dx[8][3], T detJ, T cd, T char_len) {
    (void)dt;
    (void)B;
    (void)detJ;
    if (elem.is_eroded || isTet4Element(elem) || m_hourglass_coeff <= static_cast<T>(1.0e-6)) return;

    const auto& mat = m_material_tables[elem.mat_id];
    T E = static_cast<T>(mat.youngs_modulus);
    T density = static_cast<T>(mat.density);

    T viscous_factor = static_cast<T>(0.05f) * m_hourglass_coeff * density * cd * char_len * char_len;
    T stiffness_factor = static_cast<T>(0.25f) * m_hourglass_coeff * E * char_len;

    // Newton-Schulz Polar Decomposition to extract element rotation R_elem
    T R_elem[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            R_elem[r][c] = elem.F[r][c];
        }
    }
    for (int iter = 0; iter < 4; ++iter) {
        T det = R_elem[0][0]*(R_elem[1][1]*R_elem[2][2] - R_elem[1][2]*R_elem[2][1])
              - R_elem[0][1]*(R_elem[1][0]*R_elem[2][2] - R_elem[1][2]*R_elem[2][0])
              + R_elem[0][2]*(R_elem[1][0]*R_elem[2][1] - R_elem[1][1]*R_elem[2][0]);
        if (std::abs(det) < static_cast<T>(1.0e-9f)) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    R_elem[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f));
                }
            }
            break;
        }
        T invDet = static_cast<T>(1.0f) / det;
        T R_inv_T[3][3];
        R_inv_T[0][0] = (R_elem[1][1]*R_elem[2][2] - R_elem[1][2]*R_elem[2][1]) * invDet;
        R_inv_T[1][0] = (R_elem[0][2]*R_elem[2][1] - R_elem[0][1]*R_elem[2][2]) * invDet;
        R_inv_T[2][0] = (R_elem[0][1]*R_elem[1][2] - R_elem[0][2]*R_elem[1][1]) * invDet;
        R_inv_T[0][1] = (R_elem[1][2]*R_elem[2][0] - R_elem[1][0]*R_elem[2][2]) * invDet;
        R_inv_T[1][1] = (R_elem[0][0]*R_elem[2][2] - R_elem[0][2]*R_elem[2][0]) * invDet;
        R_inv_T[2][1] = (R_elem[0][2]*R_elem[1][0] - R_elem[0][0]*R_elem[1][2]) * invDet;
        R_inv_T[0][2] = (R_elem[1][0]*R_elem[2][1] - R_elem[1][1]*R_elem[2][0]) * invDet;
        R_inv_T[1][2] = (R_elem[0][1]*R_elem[2][0] - R_elem[0][0]*R_elem[2][1]) * invDet;
        R_inv_T[2][2] = (R_elem[0][0]*R_elem[1][1] - R_elem[0][1]*R_elem[1][0]) * invDet;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                R_elem[r][c] = static_cast<T>(0.5f) * (R_elem[r][c] + R_inv_T[r][c]);
            }
        }
    }

    T x_center[3] = {0.0f, 0.0f, 0.0f};
    T x0_center[3] = {0.0f, 0.0f, 0.0f};
    T v_center[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < 8; ++n) {
        int nid = elem.node_ids[n];
        for (int c = 0; c < 3; ++c) {
            x_center[c] += x_nodes[n][c];
            x0_center[c] += m_nodes[nid].x0[c];
            v_center[c] += v_nodes[n][c];
        }
    }
    x_center[0] *= static_cast<T>(0.125f); x_center[1] *= static_cast<T>(0.125f); x_center[2] *= static_cast<T>(0.125f);
    x0_center[0] *= static_cast<T>(0.125f); x0_center[1] *= static_cast<T>(0.125f); x0_center[2] *= static_cast<T>(0.125f);
    v_center[0] *= static_cast<T>(0.125f); v_center[1] *= static_cast<T>(0.125f); v_center[2] *= static_cast<T>(0.125f);

    T u_rel[8][3], v_rel[8][3];
    for (int n = 0; n < 8; ++n) {
        int nid = elem.node_ids[n];
        T x_rel[3], x0_rel[3];
        for (int c = 0; c < 3; ++c) {
            x_rel[c] = x_nodes[n][c] - x_center[c];
            x0_rel[c] = m_nodes[nid].x0[c] - x0_center[c];
            v_rel[n][c] = v_nodes[n][c] - v_center[c];
        }

        // Rotate initial reference relative coordinates to current frame
        T x0_rot[3] = {0.0f, 0.0f, 0.0f};
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                x0_rot[r] += R_elem[r][c] * x0_rel[c];
            }
        }

        for (int c = 0; c < 3; ++c) {
            u_rel[n][c] = x_rel[c] - x0_rot[c];
        }
    }

    for (int alpha = 0; alpha < 4; ++alpha) {
        T sub[3] = {0.0f, 0.0f, 0.0f};
        for (int n = 0; n < 8; ++n) {
            T g_raw = FB_GAMMA[alpha][n];
            for (int c = 0; c < 3; ++c) {
                sub[c] += g_raw * x_nodes[n][c];
            }
        }

        T gamma_ortho[8];
        for (int n = 0; n < 8; ++n) {
            gamma_ortho[n] = FB_GAMMA[alpha][n] - (sub[0] * dN_dx[n][0] + sub[1] * dN_dx[n][1] + sub[2] * dN_dx[n][2]);
        }

        T q_vel[3] = {0.0f, 0.0f, 0.0f};
        T q_disp[3] = {0.0f, 0.0f, 0.0f};
        for (int n = 0; n < 8; ++n) {
            for (int c = 0; c < 3; ++c) {
                q_vel[c] += gamma_ortho[n] * v_rel[n][c];
                q_disp[c] += gamma_ortho[n] * u_rel[n][c];
            }
        }

        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            for (int c = 0; c < 3; ++c) {
                T f_hg = (m_hourglass_model == FEMHourglassModel::FlanaganBelytschkoViscous)
                         ? viscous_factor * gamma_ortho[n] * q_vel[c]
                         : stiffness_factor * gamma_ortho[n] * q_disp[c];
#ifdef _OPENMP
                #pragma omp atomic
                m_nodes[nid].f_int[c] += f_hg;
                #pragma omp atomic
                m_energy_tracker.E_hg += std::abs(f_hg * v_nodes[n][c] * dt);
#else
                m_nodes[nid].f_int[c] += f_hg;
                m_energy_tracker.E_hg += std::abs(f_hg * v_nodes[n][c] * dt);
#endif
            }
        }
    }
}

template <typename T>
void FEMSolver3D<T>::computeElementForces(T dt) {
    if (m_nodal_vol_cur.size() < m_nodes.size()) {
        m_nodal_vol_cur.resize(m_nodes.size(), static_cast<T>(0.0f));
        m_nodal_vol_ref.resize(m_nodes.size(), static_cast<T>(0.0f));
    }

    // Reset internal nodal forces and ANP volume accumulators
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        m_nodes[nid].f_int[0] = static_cast<T>(0.0f);
        m_nodes[nid].f_int[1] = static_cast<T>(0.0f);
        m_nodes[nid].f_int[2] = static_cast<T>(0.0f);
        m_nodal_vol_cur[nid] = static_cast<T>(0.0f);
        m_nodal_vol_ref[nid] = static_cast<T>(0.0f);
    }

    // Pass 1: Tet4-ANP Nodal Volume Scatter (Bonet & Burton 1998) for non-energetic solid tetrahedra
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded || !isTet4Element(elem)) continue;
        const auto& mat = m_material_tables[elem.mat_id];
        bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                             mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                             mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        if (is_energetic || elem.is_detached) continue;

        T x_mid_t[4][3];
        for (int n = 0; n < 4; ++n) {
            int nid = elem.node_ids[n];
            for (int c = 0; c < 3; ++c) {
                x_mid_t[n][c] = m_nodes[nid].x[c] - static_cast<T>(0.5f) * m_nodes[nid].v[c] * dt;
            }
        }
        T V_cur = computeTet4SignedVolume(x_mid_t);
        if (V_cur <= static_cast<T>(1.0e-18f)) continue;
        T v_cur_q = static_cast<T>(0.25f) * V_cur;
        T v_ref_q = static_cast<T>(0.25f) * elem.V0;
        for (int n = 0; n < 4; ++n) {
            int nid = elem.node_ids[n];
#ifdef _OPENMP
            #pragma omp atomic
            m_nodal_vol_cur[nid] += v_cur_q;
            #pragma omp atomic
            m_nodal_vol_ref[nid] += v_ref_q;
#else
            m_nodal_vol_cur[nid] += v_cur_q;
            m_nodal_vol_ref[nid] += v_ref_q;
#endif
        }
    }

#ifdef _OPENMP
    #pragma omp parallel for schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        const bool is_tet4 = isTet4Element(elem);
        const auto& mat = m_material_tables[elem.mat_id];
        const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                   mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                   mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        T E = static_cast<T>(mat.youngs_modulus);
        T nu = static_cast<T>(mat.poissons_ratio);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        T density = static_cast<T>(mat.density);

        T x_nodes[8][3], v_nodes[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            for (int c = 0; c < 3; ++c) {
                x_nodes[n][c] = m_nodes[nid].x[c];
                v_nodes[n][c] = m_nodes[nid].v[c];
            }
        }

        T x_mid[8][3];
        for (int n = 0; n < 8; ++n) {
            for (int c = 0; c < 3; ++c) {
                x_mid[n][c] = x_nodes[n][c] - static_cast<T>(0.5f) * v_nodes[n][c] * dt;
            }
        }

        T cs_C = m_physics_params.cowper_symonds_C;
        T cs_P = m_physics_params.cowper_symonds_P;
        T b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : m_physics_params.bulk_viscosity_b1);
        T b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : m_physics_params.bulk_viscosity_b2);
        T cd = std::sqrt((K + static_cast<T>(4.0f) / static_cast<T>(3.0f) * G) / density);

        if (!is_tet4 && !is_energetic && (m_integration_scheme == FEMIntegrationScheme::FullGauss8 || m_integration_scheme == FEMIntegrationScheme::SelectiveReduced)) {
            ensureGaussPointHistory();
            auto& gp_hist = m_gp_history[e];
            static const T gp_coords[8][3] = {
                {static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257)},
                {static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257)},
                {static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257)},
                {static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257)},
                {static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257)},
                {static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257)},
                {static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257)},
                {static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257)}
            };

            T B_center[6][24], detJ_center;
            computeHex8BMatrix(x_mid, B_center, detJ_center);
            T min_vol_r = m_erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? m_erosion_criteria.min_volume_ratio : static_cast<T>(0.02f);
            if (detJ_center <= static_cast<T>(1.0e-15f) || (elem.V0 > static_cast<T>(1.0e-18f) && (detJ_center * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
                if (elem.damage > static_cast<T>(0.70f) || elem.ep_bar > static_cast<T>(0.15f)) {
                    elem.is_eroded = true;
                    m_surface_facets_dirty = true;
                }
                continue;
            }
            elem.V = detJ_center * static_cast<T>(8.0f);

            T div_v_center = 0.0f;
            if (m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
                T v_center_local[3] = {0.0f, 0.0f, 0.0f};
                for (int n = 0; n < 8; ++n) {
                    v_center_local[0] += v_nodes[n][0]; v_center_local[1] += v_nodes[n][1]; v_center_local[2] += v_nodes[n][2];
                }
                v_center_local[0] *= static_cast<T>(0.125f); v_center_local[1] *= static_cast<T>(0.125f); v_center_local[2] *= static_cast<T>(0.125f);

                T v_vec_center[24];
                for (int n = 0; n < 8; ++n) {
                    v_vec_center[n * 3 + 0] = v_nodes[n][0] - v_center_local[0];
                    v_vec_center[n * 3 + 1] = v_nodes[n][1] - v_center_local[1];
                    v_vec_center[n * 3 + 2] = v_nodes[n][2] - v_center_local[2];
                }
                T strain_rate_center[6] = {0.0f};
                for (int r = 0; r < 6; ++r) {
                    for (int c = 0; c < 24; ++c) {
                        strain_rate_center[r] += B_center[r][c] * v_vec_center[c];
                    }
                }
                div_v_center = strain_rate_center[0] + strain_rate_center[1] + strain_rate_center[2];
                if (std::abs(div_v_center) * dt < static_cast<T>(1.0e-6f)) {
                    div_v_center = static_cast<T>(0.0f);
                }
            }

            T sigma_avg[3][3] = {{0.0f}};
            T s_dev_avg[3][3] = {{0.0f}};
            T ep_bar_avg = 0.0f;
            T temp_avg = 0.0f;
            T damage_avg = 0.0f;
            T V_sum = 0.0f;

            for (int g = 0; g < 8; ++g) {
                T dN_dxi_g[8][3];
                T xi = gp_coords[g][0];
                T eta = gp_coords[g][1];
                T zeta = gp_coords[g][2];
                for (int i = 0; i < 8; ++i) {
                    dN_dxi_g[i][0] = 0.125f * HEX8_XI[i][0] * (1.0f + HEX8_XI[i][1] * eta) * (1.0f + HEX8_XI[i][2] * zeta);
                    dN_dxi_g[i][1] = 0.125f * HEX8_XI[i][1] * (1.0f + HEX8_XI[i][0] * xi)  * (1.0f + HEX8_XI[i][2] * zeta);
                    dN_dxi_g[i][2] = 0.125f * HEX8_XI[i][2] * (1.0f + HEX8_XI[i][0] * xi)  * (1.0f + HEX8_XI[i][1] * eta);
                }

                T x_center_local[3] = {0.0f, 0.0f, 0.0f};
                for (int n = 0; n < 8; ++n) {
                    x_center_local[0] += x_mid[n][0]; x_center_local[1] += x_mid[n][1]; x_center_local[2] += x_mid[n][2];
                }
                x_center_local[0] *= static_cast<T>(0.125f); x_center_local[1] *= static_cast<T>(0.125f); x_center_local[2] *= static_cast<T>(0.125f);

                T x_rel_local[8][3];
                for (int n = 0; n < 8; ++n) {
                    x_rel_local[n][0] = x_mid[n][0] - x_center_local[0];
                    x_rel_local[n][1] = x_mid[n][1] - x_center_local[1];
                    x_rel_local[n][2] = x_mid[n][2] - x_center_local[2];
                }

                T J_g[3][3] = {{0.0f}};
                for (int i = 0; i < 8; ++i) {
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            J_g[r][c] += dN_dxi_g[i][r] * x_rel_local[i][c];
                        }
                    }
                }

                T detJ_g = J_g[0][0] * (J_g[1][1]*J_g[2][2] - J_g[1][2]*J_g[2][1])
                         - J_g[0][1] * (J_g[1][0]*J_g[2][2] - J_g[1][2]*J_g[2][0])
                         + J_g[0][2] * (J_g[1][0]*J_g[2][1] - J_g[1][1]*J_g[2][0]);

                if (detJ_g <= static_cast<T>(1.0e-15f)) {
                    if (elem.damage > static_cast<T>(0.70f) || elem.ep_bar > static_cast<T>(0.15f)) {
                        elem.is_eroded = true;
                        m_surface_facets_dirty = true;
                    }
                    break;
                }
                V_sum += detJ_g;
                T invDetJ_g = static_cast<T>(1.0f) / detJ_g;

                T J_inv_g[3][3];
                J_inv_g[0][0] = (J_g[1][1]*J_g[2][2] - J_g[1][2]*J_g[2][1]) * invDetJ_g;
                J_inv_g[0][1] = (J_g[0][2]*J_g[2][1] - J_g[0][1]*J_g[2][2]) * invDetJ_g;
                J_inv_g[0][2] = (J_g[0][1]*J_g[1][2] - J_g[0][2]*J_g[1][1]) * invDetJ_g;
                J_inv_g[1][0] = (J_g[1][2]*J_g[2][0] - J_g[1][0]*J_g[2][2]) * invDetJ_g;
                J_inv_g[1][1] = (J_g[0][0]*J_g[2][2] - J_g[0][2]*J_g[2][0]) * invDetJ_g;
                J_inv_g[1][2] = (J_g[0][2]*J_g[1][0] - J_g[0][0]*J_g[1][2]) * invDetJ_g;
                J_inv_g[2][0] = (J_g[1][0]*J_g[2][1] - J_g[1][1]*J_g[2][0]) * invDetJ_g;
                J_inv_g[2][1] = (J_g[0][1]*J_g[2][0] - J_g[0][0]*J_g[2][1]) * invDetJ_g;
                J_inv_g[2][2] = (J_g[0][0]*J_g[1][1] - J_g[0][1]*J_g[1][0]) * invDetJ_g;

                T dN_dx_g[8][3];
                for (int i = 0; i < 8; ++i) {
                    for (int c = 0; c < 3; ++c) {
                        dN_dx_g[i][c] = J_inv_g[c][0] * dN_dxi_g[i][0] + J_inv_g[c][1] * dN_dxi_g[i][1] + J_inv_g[c][2] * dN_dxi_g[i][2];
                    }
                }

                T B_g[6][24] = {{0.0f}};
                for (int i = 0; i < 8; ++i) {
                    int col = i * 3;
                    B_g[0][col + 0] = dN_dx_g[i][0];
                    B_g[1][col + 1] = dN_dx_g[i][1];
                    B_g[2][col + 2] = dN_dx_g[i][2];
                    B_g[3][col + 0] = dN_dx_g[i][1]; B_g[3][col + 1] = dN_dx_g[i][0];
                    B_g[4][col + 1] = dN_dx_g[i][2]; B_g[4][col + 2] = dN_dx_g[i][1];
                    B_g[5][col + 0] = dN_dx_g[i][2]; B_g[5][col + 2] = dN_dx_g[i][0];
                }

                T v_center_g[3] = {0.0f, 0.0f, 0.0f};
                for (int n = 0; n < 8; ++n) {
                    v_center_g[0] += v_nodes[n][0]; v_center_g[1] += v_nodes[n][1]; v_center_g[2] += v_nodes[n][2];
                }
                v_center_g[0] *= static_cast<T>(0.125f); v_center_g[1] *= static_cast<T>(0.125f); v_center_g[2] *= static_cast<T>(0.125f);

                T v_vec_g[24];
                for (int n = 0; n < 8; ++n) {
                    v_vec_g[n * 3 + 0] = v_nodes[n][0] - v_center_g[0];
                    v_vec_g[n * 3 + 1] = v_nodes[n][1] - v_center_g[1];
                    v_vec_g[n * 3 + 2] = v_nodes[n][2] - v_center_g[2];
                }

                T strain_rate_g[6] = {0.0f};
                for (int r = 0; r < 6; ++r) {
                    for (int c = 0; c < 24; ++c) {
                        strain_rate_g[r] += B_g[r][c] * v_vec_g[c];
                    }
                }

                T div_v_g = strain_rate_g[0] + strain_rate_g[1] + strain_rate_g[2];
                if (std::abs(div_v_g) * dt < static_cast<T>(1.0e-6f)) {
                    div_v_g = static_cast<T>(0.0f);
                }

                T h_e_g = std::cbrt(std::max(static_cast<T>(1.0e-18f), detJ_g * static_cast<T>(8.0f)));
                T q_visc_g = static_cast<T>(0.0f);
                if (div_v_g < static_cast<T>(0.0f)) {
                    T div_v_mag = -div_v_g;
                    q_visc_g = density * (b1 * cd * h_e_g * div_v_mag + b2 * (h_e_g * div_v_mag) * (h_e_g * div_v_mag));
                }

                T d_dev_g[3][3];
                T active_div_v = (m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) ? div_v_center : div_v_g;
                d_dev_g[0][0] = strain_rate_g[0] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
                d_dev_g[1][1] = strain_rate_g[1] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
                d_dev_g[2][2] = strain_rate_g[2] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
                d_dev_g[0][1] = d_dev_g[1][0] = static_cast<T>(0.5f) * strain_rate_g[3];
                d_dev_g[1][2] = d_dev_g[2][1] = static_cast<T>(0.5f) * strain_rate_g[4];
                d_dev_g[2][0] = d_dev_g[0][2] = static_cast<T>(0.5f) * strain_rate_g[5];

                T ep_norm_sq_g = d_dev_g[0][0]*d_dev_g[0][0] + d_dev_g[1][1]*d_dev_g[1][1] + d_dev_g[2][2]*d_dev_g[2][2] +
                                static_cast<T>(2.0f)*(d_dev_g[0][1]*d_dev_g[0][1] + d_dev_g[1][2]*d_dev_g[1][2] + d_dev_g[2][0]*d_dev_g[2][0]);
                T ep_dot_g = std::sqrt(static_cast<T>(2.0f) / static_cast<T>(3.0f) * ep_norm_sq_g);

                // Johnson-Cook Plasticity & Thermal Softening
                T dynamic_yield_g = static_cast<T>(mat.yield_stress);
                bool is_jc_g = (mat.jc_A > static_cast<T>(0.0f));
                T A_g = is_jc_g ? static_cast<T>(mat.jc_A) : static_cast<T>(mat.yield_stress);
                T B_g_mat = is_jc_g ? static_cast<T>(mat.jc_B) : static_cast<T>(mat.hardening_modulus);
                T n_exp_g = is_jc_g ? static_cast<T>(mat.jc_n) : static_cast<T>(1.0f);
                T C_rate_g = is_jc_g ? static_cast<T>(mat.jc_C) : static_cast<T>(0.0f);
                T m_exp_g = is_jc_g ? static_cast<T>(mat.jc_m) : static_cast<T>(0.0f);
                T T_melt_g = static_cast<T>(mat.T_melt > 0.0f ? mat.T_melt : 1793.0f);
                T T_room_g = static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.0f);

                T ep_val_g = std::max(static_cast<T>(0.0f), gp_hist.ep_bar_gp[g]);
                T sigma_hard_g = A_g + (B_g_mat > static_cast<T>(0.0f) ? B_g_mat * std::pow(ep_val_g, n_exp_g) : static_cast<T>(0.0f));

                T strain_rate_factor_g = static_cast<T>(1.0f);
                if (ep_dot_g > static_cast<T>(1.0e-3f)) {
                    if (C_rate_g > static_cast<T>(0.0f)) {
                        T ep_dot_star = std::max(static_cast<T>(1.0f), ep_dot_g);
                        strain_rate_factor_g += C_rate_g * std::log(ep_dot_star);
                        if (strain_rate_factor_g < static_cast<T>(0.1f)) strain_rate_factor_g = static_cast<T>(0.1f);
                    } else if (cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
                        strain_rate_factor_g += std::pow(ep_dot_g / cs_C, static_cast<T>(1.0f) / cs_P);
                    }
                }

                T thermal_factor_g = static_cast<T>(1.0f);
                if (m_exp_g > static_cast<T>(0.0f) && T_melt_g > T_room_g) {
                    T T_star_g = (gp_hist.temp_gp[g] - T_room_g) / (T_melt_g - T_room_g);
                    T_star_g = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), T_star_g));
                    thermal_factor_g = static_cast<T>(1.0f) - std::pow(T_star_g, m_exp_g);
                    if (thermal_factor_g < static_cast<T>(0.01f)) thermal_factor_g = static_cast<T>(0.01f);
                }
                uint32_t user_seed_g = static_cast<uint32_t>(m_physics_params.random_seed) * 2654435761u;
                uint32_t elem_seed_g = user_seed_g ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u) ^ (static_cast<uint32_t>(elem.node_ids[6]) * 19349663u) ^ (static_cast<uint32_t>(e) * 83492791u) ^ (static_cast<uint32_t>(g) * 374761393u);
                T het_factor_g = computeFEMWeibullFactor(elem_seed_g, m_physics_params);
                dynamic_yield_g = std::max(static_cast<T>(1.0e6f), sigma_hard_g * strain_rate_factor_g * thermal_factor_g * het_factor_g);

                T L_g[3][3] = {{static_cast<T>(0.0f)}};
                for (int i = 0; i < 8; ++i) {
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            L_g[r][c] += v_vec_g[i * 3 + r] * dN_dx_g[i][c];
                        }
                    }
                }
                T W_g[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        W_g[r][c] = static_cast<T>(0.5f) * (L_g[r][c] - L_g[c][r]);
                    }
                }
                T theta_sq_g = (W_g[0][1]*W_g[0][1] + W_g[1][2]*W_g[1][2] + W_g[2][0]*W_g[2][0]) * (dt * dt);
                T R_dt_g[3][3] = {
                    {static_cast<T>(1.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)},
                    {static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f)},
                    {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(1.0f)}
                };
                if (theta_sq_g > static_cast<T>(1.0e-24f)) {
                    T theta = std::sqrt(theta_sq_g);
                    T Omega[3][3];
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            Omega[r][c] = W_g[r][c] * dt;
                        }
                    }
                    T c1 = std::sin(theta) / theta;
                    T c2 = (static_cast<T>(1.0f) - std::cos(theta)) / theta_sq_g;
                    T Om2[3][3] = {{static_cast<T>(0.0f)}};
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            for (int k = 0; k < 3; ++k) {
                                Om2[r][c] += Omega[r][k] * Omega[k][c];
                            }
                        }
                    }
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            R_dt_g[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f))
                                         + c1 * Omega[r][c] + c2 * Om2[r][c];
                        }
                    }
                    T s_temp[3][3] = {{static_cast<T>(0.0f)}};
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            for (int k = 0; k < 3; ++k) {
                                s_temp[r][c] += R_dt_g[r][k] * gp_hist.s_dev_gp[g][k][c];
                            }
                        }
                    }
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            gp_hist.s_dev_gp[g][r][c] = static_cast<T>(0.0f);
                            for (int k = 0; k < 3; ++k) {
                                gp_hist.s_dev_gp[g][r][c] += s_temp[r][k] * R_dt_g[c][k];
                            }
                        }
                    }
                }

                T F_new_g[3][3] = {{static_cast<T>(0.0f)}};
                T I_plus_Ldt_g[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        I_plus_Ldt_g[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f)) + L_g[r][c] * dt;
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        for (int k = 0; k < 3; ++k) {
                            F_new_g[r][c] += I_plus_Ldt_g[r][k] * gp_hist.F_gp[g][k][c];
                        }
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        gp_hist.F_gp[g][r][c] = F_new_g[r][c];
                    }
                }

                T vol_strain_g = 0.0f;
                if (m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
                    T F_det = elem.F[0][0] * (elem.F[1][1]*elem.F[2][2] - elem.F[1][2]*elem.F[2][1])
                            - elem.F[0][1] * (elem.F[1][0]*elem.F[2][2] - elem.F[1][2]*elem.F[2][0])
                            + elem.F[0][2] * (elem.F[1][0]*elem.F[2][1] - elem.F[1][1]*elem.F[2][0]);
                    vol_strain_g = F_det - static_cast<T>(1.0f);
                } else {
                    T F_det = gp_hist.F_gp[g][0][0] * (gp_hist.F_gp[g][1][1]*gp_hist.F_gp[g][2][2] - gp_hist.F_gp[g][1][2]*gp_hist.F_gp[g][2][1])
                            - gp_hist.F_gp[g][0][1] * (gp_hist.F_gp[g][1][0]*gp_hist.F_gp[g][2][2] - gp_hist.F_gp[g][1][2]*gp_hist.F_gp[g][2][0])
                            + gp_hist.F_gp[g][0][2] * (gp_hist.F_gp[g][1][0]*gp_hist.F_gp[g][2][1] - gp_hist.F_gp[g][1][1]*gp_hist.F_gp[g][2][0]);
                    vol_strain_g = F_det - static_cast<T>(1.0f);
                }
                if (std::abs(vol_strain_g) < static_cast<T>(1.0e-14f)) {
                    vol_strain_g = static_cast<T>(0.0f);
                }
                
                // Mie-Grueneisen Shock EOS or Tait Water Hydrostatic Pressure
                T p_hydro_g = static_cast<T>(0.0f);
                if (mat.material_model == MPMMaterialModel::TaitWater) {
                    T J_elem = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
                             ? (elem.V / elem.V0) : static_cast<T>(1.0f);
                    T rho_elem = static_cast<T>(mat.tait_rho0) / std::max(static_cast<T>(0.05f), J_elem);
                    T e_elem = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 4184.0f) * (gp_hist.temp_gp[g] - static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.15f));
                    if (mat.tait_variant == 1) { // Caloric
                        p_hydro_g = Blast::TaitEOSWater::compute_pressure_caloric(rho_elem, e_elem, static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_gruneisen), static_cast<T>(mat.tait_p_cav));
                    } else if (mat.tait_variant == 2) { // Shock Hugoniot
                        p_hydro_g = Blast::TaitEOSWater::compute_pressure_hugoniot(rho_elem, e_elem, static_cast<T>(mat.tait_c0), static_cast<T>(1.75), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_gruneisen), static_cast<T>(mat.tait_p_cav));
                    } else { // Isentropic
                        p_hydro_g = Blast::TaitEOSWater::compute_pressure_isentropic(rho_elem, static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_p_cav));
                    }
                    p_hydro_g += q_visc_g;
                } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
                    T c0 = static_cast<T>(mat.mg_c0);
                    T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
                    T gamma0 = static_cast<T>(mat.mg_gamma0);
                    T mu = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
                         ? (elem.V0 / elem.V - static_cast<T>(1.0f))
                         : static_cast<T>(0.0f);
                    if (std::abs(mu) < static_cast<T>(1.0e-14f)) {
                        mu = static_cast<T>(0.0f);
                    }
                    T E_v = density * (mat.Cp > 0.0f ? mat.Cp : 477.0f) * (gp_hist.temp_gp[g] - (mat.T_room > 0.0f ? mat.T_room : 293.0f));
                    if (mu > static_cast<T>(0.0f)) {
                        T denom = static_cast<T>(1.0f) - (s1 - static_cast<T>(1.0f)) * mu;
                        if (denom > static_cast<T>(0.1f)) {
                            p_hydro_g = (density * c0 * c0 * mu * (static_cast<T>(1.0f) + (static_cast<T>(1.0f) - static_cast<T>(0.5f) * gamma0) * mu)) / (denom * denom) + gamma0 * E_v;
                        } else {
                            p_hydro_g = K * mu + gamma0 * E_v;
                        }
                    } else {
                        p_hydro_g = density * c0 * c0 * mu + gamma0 * E_v;
                    }
                    p_hydro_g += q_visc_g;
                } else {
                    p_hydro_g = -K * vol_strain_g + q_visc_g;
                }

                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        gp_hist.s_dev_gp[g][r][c] += static_cast<T>(2.0f) * G * d_dev_g[r][c] * dt;
                    }
                }

                if (mat.material_model == MPMMaterialModel::RHTConcrete) {
                    RHTStateVariables<T> rht_state;
                    rht_state.damage = gp_hist.damage_gp[g];
                    rht_state.ep_bar = gp_hist.ep_bar_gp[g];
                    rht_state.p_hydro = p_hydro_g;
                    updateRHTStress<T>(
                        gp_hist.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                        static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                        static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                        static_cast<T>(mat.rht_A), static_cast<T>(mat.rht_N),
                        static_cast<T>(mat.rht_B), static_cast<T>(mat.rht_M),
                        static_cast<T>(mat.rht_Q0), static_cast<T>(mat.rht_BQ),
                        static_cast<T>(mat.rht_D1), static_cast<T>(mat.rht_D2),
                        static_cast<T>(mat.rht_p_crush), static_cast<T>(mat.rht_p_lock),
                        static_cast<T>(mat.rht_alpha0), static_cast<T>(mat.rht_n_comp),
                        static_cast<T>(mat.rht_betac), static_cast<T>(mat.rht_deltat),
                        static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                        rht_state
                    );
                    gp_hist.damage_gp[g] = rht_state.damage;
                    gp_hist.ep_bar_gp[g] = rht_state.ep_bar;
                    p_hydro_g = rht_state.p_hydro;
                } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
                    KCStateVariables<T> kc_state;
                    kc_state.damage = gp_hist.damage_gp[g];
                    kc_state.lambda = gp_hist.lambda_gp[g];
                    kc_state.ep_bar = gp_hist.ep_bar_gp[g];
                    kc_state.p_hydro = p_hydro_g;
                    updateKCStress<T>(
                        gp_hist.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                        static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                        static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                        mat.kc_auto_generate,
                        static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
                        static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
                        static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
                        static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
                        static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                        kc_state
                    );
                    gp_hist.damage_gp[g] = kc_state.damage;
                    gp_hist.lambda_gp[g] = kc_state.lambda;
                    gp_hist.ep_bar_gp[g] = kc_state.ep_bar;
                    p_hydro_g = kc_state.p_hydro;
                } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
                    CSCMStateVariables<T> cscm_state;
                    cscm_state.damage = gp_hist.damage_gp[g];
                    cscm_state.kappa = gp_hist.lambda_gp[g];
                    cscm_state.ep_bar = gp_hist.ep_bar_gp[g];
                    cscm_state.p_hydro = p_hydro_g;
                    updateCSCMStress<T>(
                        gp_hist.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                        static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                        static_cast<T>(mat.G_f),
                        static_cast<T>(mat.cscm_alpha), static_cast<T>(mat.cscm_theta),
                        static_cast<T>(mat.cscm_lambda), static_cast<T>(mat.cscm_beta),
                        static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
                        static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
                        static_cast<T>(mat.cscm_D2),
                        static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                        cscm_state
                    );
                    gp_hist.damage_gp[g] = cscm_state.damage;
                    gp_hist.lambda_gp[g] = cscm_state.kappa;
                    gp_hist.ep_bar_gp[g] = cscm_state.ep_bar;
                } else if (mat.material_model == MPMMaterialModel::DruckerPragerSoil) {
                    Blast::Materials::DruckerPragerParams<T> dp_p;
                    dp_p.cohesion = static_cast<T>(mat.dp_cohesion);
                    dp_p.friction_angle = static_cast<T>(mat.dp_friction_angle * 3.14159265358979323846 / 180.0);
                    dp_p.dilatancy_angle = static_cast<T>(mat.dp_dilatancy_angle * 3.14159265358979323846 / 180.0);
                    dp_p.tensile_cutoff = static_cast<T>(mat.dp_tensile_cutoff);
                    dp_p.H_plastic = static_cast<T>(mat.dp_hardening_modulus);

                    T d_eps_g[3][3];
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            d_eps_g[r][c] = d_dev_g[r][c] * dt + (r == c ? static_cast<T>(1.0 / 3.0) * div_v_g * dt : static_cast<T>(0.0));
                        }
                    }
                    Blast::Materials::update_constitutive_drucker_prager<T>(
                        E, nu, dp_p, d_eps_g, gp_hist.s_dev_gp[g], p_hydro_g, gp_hist.ep_bar_gp[g], false
                    );
                } else if (mat.material_model == MPMMaterialModel::LinearElastic || mat.material_model == MPMMaterialModel::TaitWater) {
                    // Pure Hookean linear elasticity or Tait fluid - no plastic yielding
                    if (mat.material_model == MPMMaterialModel::TaitWater) {
                        T mu_fluid = static_cast<T>(mat.tait_viscosity > 0.0f ? mat.tait_viscosity : 1.002e-3f);
                        for (int r = 0; r < 3; ++r) {
                            for (int c = 0; c < 3; ++c) {
                                gp_hist.s_dev_gp[g][r][c] = static_cast<T>(2.0f) * mu_fluid * d_dev_g[r][c];
                            }
                        }
                    }
                } else {
                    T s_norm_g = std::sqrt(
                        gp_hist.s_dev_gp[g][0][0]*gp_hist.s_dev_gp[g][0][0] + gp_hist.s_dev_gp[g][1][1]*gp_hist.s_dev_gp[g][1][1] + gp_hist.s_dev_gp[g][2][2]*gp_hist.s_dev_gp[g][2][2] +
                        static_cast<T>(2.0f)*(gp_hist.s_dev_gp[g][0][1]*gp_hist.s_dev_gp[g][0][1] + gp_hist.s_dev_gp[g][1][2]*gp_hist.s_dev_gp[g][1][2] + gp_hist.s_dev_gp[g][2][0]*gp_hist.s_dev_gp[g][2][0])
                    );
                    T vm_trial_g = std::sqrt(static_cast<T>(1.5f)) * s_norm_g;

                    if (vm_trial_g > dynamic_yield_g && vm_trial_g > static_cast<T>(1.0e-6f)) {
                        T scale = dynamic_yield_g / vm_trial_g;
                        T d_ep = (vm_trial_g - dynamic_yield_g) / (static_cast<T>(3.0f) * G + static_cast<T>(mat.hardening_modulus));
                        gp_hist.ep_bar_gp[g] += d_ep;
                        for (int r = 0; r < 3; ++r) {
                            for (int c = 0; c < 3; ++c) {
                                gp_hist.s_dev_gp[g][r][c] *= scale;
                            }
                        }
                        T plastic_work = dynamic_yield_g * d_ep;
                        T chi = m_physics_params.taylor_quinney_factor;
                        T Cp = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 477.0f);
                        gp_hist.temp_gp[g] += (chi * plastic_work) / (density * Cp);
                    }
                }

                T eta_shear_g = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e_g;
                T sigma_g[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        sigma_g[r][c] = gp_hist.s_dev_gp[g][r][c] + static_cast<T>(2.0f) * eta_shear_g * d_dev_g[r][c] - (r == c ? p_hydro_g : static_cast<T>(0.0f));
                    }
                }

                T sig_voigt_g[6] = {
                    sigma_g[0][0], sigma_g[1][1], sigma_g[2][2],
                    sigma_g[0][1], sigma_g[1][2], sigma_g[2][0]
                };

                T f_elem_g[24] = {0.0f};
                for (int r = 0; r < 24; ++r) {
                    for (int c = 0; c < 6; ++c) {
                        f_elem_g[r] += B_g[c][r] * sig_voigt_g[c] * detJ_g;
                    }
                }

                for (int n = 0; n < 8; ++n) {
                    int nid = elem.node_ids[n];
#ifdef _OPENMP
                    #pragma omp atomic
                    m_nodes[nid].f_int[0] += f_elem_g[n * 3 + 0];
                    #pragma omp atomic
                    m_nodes[nid].f_int[1] += f_elem_g[n * 3 + 1];
                    #pragma omp atomic
                    m_nodes[nid].f_int[2] += f_elem_g[n * 3 + 2];
#else
                    m_nodes[nid].f_int[0] += f_elem_g[n * 3 + 0];
                    m_nodes[nid].f_int[1] += f_elem_g[n * 3 + 1];
                    m_nodes[nid].f_int[2] += f_elem_g[n * 3 + 2];
#endif
                }

                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        sigma_avg[r][c] += 0.125f * sigma_g[r][c];
                        s_dev_avg[r][c] += 0.125f * gp_hist.s_dev_gp[g][r][c];
                    }
                }
                ep_bar_avg += 0.125f * gp_hist.ep_bar_gp[g];
                temp_avg += 0.125f * gp_hist.temp_gp[g];
                damage_avg += 0.125f * gp_hist.damage_gp[g];
            }

            if (elem.is_eroded) continue;

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.sigma[r][c] = sigma_avg[r][c];
                    elem.s_dev[r][c] = s_dev_avg[r][c];
                }
            }
            elem.ep_bar = ep_bar_avg;
            elem.temperature = temp_avg;
            elem.damage = damage_avg;
            elem.lambda = gp_hist.lambda_gp[0];
            elem.V = V_sum;

            T F_avg[3][3] = {{0.0f}};
            for (int g = 0; g < 8; ++g) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        F_avg[r][c] += 0.125f * gp_hist.F_gp[g][r][c];
                    }
                }
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.F[r][c] = F_avg[r][c];
                }
            }
            continue;
        }


        T B[6][24], detJ = static_cast<T>(0.0f);
        T v_center[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};
        const int num_elem_nodes = is_tet4 ? 4 : 8;
        const T min_vol_r = is_energetic
            ? static_cast<T>(0.005f)
            : (m_erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? m_erosion_criteria.min_volume_ratio : static_cast<T>(0.02f));

        if (is_tet4) {
            std::memset(B, 0, sizeof(T) * 6 * 24);
            T dN_tet[4][3], V_tet = static_cast<T>(0.0f);
            computeTet4ShapeGradients(x_mid, dN_tet, V_tet);
            if (V_tet <= static_cast<T>(1.0e-18f) || (elem.V0 > static_cast<T>(1.0e-18f) && (V_tet / elem.V0) <= min_vol_r)) {
                if (is_energetic || elem.damage > static_cast<T>(0.70f) || elem.ep_bar > static_cast<T>(0.15f) || elem.is_detached) {
                    elem.is_eroded = true;
                    m_surface_facets_dirty = true;
                }
                continue;
            }
            elem.V = V_tet;
            detJ = V_tet;
            for (int i = 0; i < 4; ++i) {
                int col = i * 3;
                B[0][col + 0] = dN_tet[i][0];
                B[1][col + 1] = dN_tet[i][1];
                B[2][col + 2] = dN_tet[i][2];
                B[3][col + 0] = dN_tet[i][1]; B[3][col + 1] = dN_tet[i][0];
                B[4][col + 1] = dN_tet[i][2]; B[4][col + 2] = dN_tet[i][1];
                B[5][col + 0] = dN_tet[i][2]; B[5][col + 2] = dN_tet[i][0];
                v_center[0] += v_nodes[i][0];
                v_center[1] += v_nodes[i][1];
                v_center[2] += v_nodes[i][2];
            }
            v_center[0] *= static_cast<T>(0.25f);
            v_center[1] *= static_cast<T>(0.25f);
            v_center[2] *= static_cast<T>(0.25f);
        } else {
            computeHex8BMatrix(x_mid, B, detJ);
            if (detJ <= static_cast<T>(1.0e-15f) || (elem.V0 > static_cast<T>(1.0e-18f) && (detJ * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
                if (is_energetic || elem.damage > static_cast<T>(0.70f) || elem.ep_bar > static_cast<T>(0.15f) || elem.is_detached) {
                    elem.is_eroded = true;
                    m_surface_facets_dirty = true;
                }
                continue; // Skip force generation for inverted or severely crushed elements
            }
            elem.V = detJ * static_cast<T>(8.0f);
            for (int n = 0; n < 8; ++n) {
                v_center[0] += v_nodes[n][0];
                v_center[1] += v_nodes[n][1];
                v_center[2] += v_nodes[n][2];
            }
            v_center[0] *= static_cast<T>(0.125f);
            v_center[1] *= static_cast<T>(0.125f);
            v_center[2] *= static_cast<T>(0.125f);
        }

        T v_vec[24] = {static_cast<T>(0.0f)};
        for (int n = 0; n < num_elem_nodes; ++n) {
            v_vec[n * 3 + 0] = v_nodes[n][0] - v_center[0];
            v_vec[n * 3 + 1] = v_nodes[n][1] - v_center[1];
            v_vec[n * 3 + 2] = v_nodes[n][2] - v_center[2];
        }

        T strain_rate[6] = {0.0f};
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < num_elem_nodes * 3; ++c) {
                strain_rate[r] += B[r][c] * v_vec[c];
            }
        }

        T div_v = strain_rate[0] + strain_rate[1] + strain_rate[2];
        if (std::abs(div_v) * dt < static_cast<T>(1.0e-6f)) {
            div_v = static_cast<T>(0.0f);
        }

        T h_e = is_tet4
              ? computeTet4CharacteristicLength(x_nodes, elem.V)
              : std::cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
        T v_rel_elem = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f);
        T p_prev_elem = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        cd = computeDilatationalWaveSpeed<T>(mat, v_rel_elem, elem.lambda, p_prev_elem);
        b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : m_physics_params.bulk_viscosity_b1);
        b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : m_physics_params.bulk_viscosity_b2);

        T rho_curr = density / std::max(static_cast<T>(0.05f), v_rel_elem);
        T q_visc = (div_v < static_cast<T>(0.0f))
                 ? (rho_curr * (-b1 * h_e * div_v * cd + b2 * h_e * h_e * div_v * div_v))
                 : static_cast<T>(0.0f);
        elem.q_visc = q_visc;

        T d_dev[3][3];
        d_dev[0][0] = strain_rate[0] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
        d_dev[1][1] = strain_rate[1] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
        d_dev[2][2] = strain_rate[2] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
        d_dev[0][1] = d_dev[1][0] = static_cast<T>(0.5f) * strain_rate[3];
        d_dev[1][2] = d_dev[2][1] = static_cast<T>(0.5f) * strain_rate[4];
        d_dev[2][0] = d_dev[0][2] = static_cast<T>(0.5f) * strain_rate[5];

        T d_norm_sq = d_dev[0][0]*d_dev[0][0] + d_dev[1][1]*d_dev[1][1] + d_dev[2][2]*d_dev[2][2] +
                      static_cast<T>(2.0f)*(d_dev[0][1]*d_dev[0][1] + d_dev[1][2]*d_dev[1][2] + d_dev[2][0]*d_dev[2][0]);
        T ep_dot = std::sqrt(static_cast<T>(2.0f) / static_cast<T>(3.0f) * d_norm_sq);

        cs_C = m_physics_params.cowper_symonds_C;
        cs_P = m_physics_params.cowper_symonds_P;

        // Johnson-Cook Plasticity & Thermal Softening
        T dynamic_yield = static_cast<T>(mat.yield_stress);
        bool is_jc = (mat.jc_A > static_cast<T>(0.0f));
        T A_mat = is_jc ? static_cast<T>(mat.jc_A) : static_cast<T>(mat.yield_stress);
        T B_mat = is_jc ? static_cast<T>(mat.jc_B) : static_cast<T>(mat.hardening_modulus);
        T n_exp = is_jc ? static_cast<T>(mat.jc_n) : static_cast<T>(1.0f);
        T C_rate = is_jc ? static_cast<T>(mat.jc_C) : static_cast<T>(0.0f);
        T m_exp = is_jc ? static_cast<T>(mat.jc_m) : static_cast<T>(0.0f);
        T T_melt = static_cast<T>(mat.T_melt > 0.0f ? mat.T_melt : 1793.0f);
        T T_room = static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.0f);

        T ep_val = std::max(static_cast<T>(0.0f), elem.ep_bar);
        T sigma_hard = A_mat + (B_mat > static_cast<T>(0.0f) ? B_mat * std::pow(ep_val, n_exp) : static_cast<T>(0.0f));

        T strain_rate_factor = static_cast<T>(1.0f);
        if (ep_dot > static_cast<T>(1.0e-3f)) {
            if (C_rate > static_cast<T>(0.0f)) {
                T ep_dot_star = std::max(static_cast<T>(1.0f), ep_dot);
                strain_rate_factor += C_rate * std::log(ep_dot_star);
                if (strain_rate_factor < static_cast<T>(0.1f)) strain_rate_factor = static_cast<T>(0.1f);
            } else if (cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
                strain_rate_factor += std::pow(ep_dot / cs_C, static_cast<T>(1.0f) / cs_P);
            }
        }

        T thermal_factor = static_cast<T>(1.0f);
        if (m_exp > static_cast<T>(0.0f) && T_melt > T_room) {
            T T_star = (elem.temperature - T_room) / (T_melt - T_room);
            T_star = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), T_star));
            thermal_factor = static_cast<T>(1.0f) - std::pow(T_star, m_exp);
            if (thermal_factor < static_cast<T>(0.01f)) thermal_factor = static_cast<T>(0.01f);
        }
        uint32_t user_seed = static_cast<uint32_t>(m_physics_params.random_seed) * 2654435761u;
        uint32_t elem_seed = user_seed ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u) ^ (static_cast<uint32_t>(elem.node_ids[is_tet4 ? 3 : 6]) * 19349663u) ^ (static_cast<uint32_t>(e) * 83492791u);
        T het_factor = computeFEMWeibullFactor(elem_seed, m_physics_params);
        dynamic_yield = std::max(static_cast<T>(1.0e6f), sigma_hard * strain_rate_factor * thermal_factor * het_factor);
        if (elem.is_detached) {
            dynamic_yield *= static_cast<T>(0.15f);
        }

        T dN_dx[8][3] = {{static_cast<T>(0.0f)}};
        for (int i = 0; i < num_elem_nodes; ++i) {
            dN_dx[i][0] = B[0][i * 3 + 0];
            dN_dx[i][1] = B[1][i * 3 + 1];
            dN_dx[i][2] = B[2][i * 3 + 2];
        }

        // 1. Calculate Velocity Gradient Tensor L[3][3]
        T L[3][3] = {{static_cast<T>(0.0f)}};
        for (int i = 0; i < num_elem_nodes; ++i) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    L[r][c] += (v_nodes[i][r] - v_center[r]) * dN_dx[i][c];
                }
            }
        }

        // 2. Extract Anti-Symmetric Spin Tensor W[3][3]
        T W[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                W[r][c] = static_cast<T>(0.5f) * (L[r][c] - L[c][r]);
            }
        }

        // 3. Compute Rotation Angle theta and Rotation Matrix R_dt using Rodrigues' Formula
        T theta_sq = (W[0][1]*W[0][1] + W[1][2]*W[1][2] + W[2][0]*W[2][0]) * (dt * dt);
        T R_dt[3][3] = {
            {static_cast<T>(1.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)},
            {static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f)},
            {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(1.0f)}
        };

        if (theta_sq > static_cast<T>(1.0e-24f)) {
            T theta = std::sqrt(theta_sq);
            T Omega[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    Omega[r][c] = W[r][c] * dt;
                }
            }

            T c1 = std::sin(theta) / theta;
            T c2 = (static_cast<T>(1.0f) - std::cos(theta)) / theta_sq;

            T Om2[3][3] = {{static_cast<T>(0.0f)}};
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    for (int k = 0; k < 3; ++k) {
                        Om2[r][c] += Omega[r][k] * Omega[k][c];
                    }
                }
            }

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    R_dt[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f))
                               + c1 * Omega[r][c] + c2 * Om2[r][c];
                }
            }

            // Objective Jaumann Rotation of Deviatoric Stress Tensor: s_dev = R_dt * s_dev * R_dt^T
            T s_temp[3][3] = {{static_cast<T>(0.0f)}};
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    for (int k = 0; k < 3; ++k) {
                        s_temp[r][c] += R_dt[r][k] * elem.s_dev[k][c];
                    }
                }
            }

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev[r][c] = static_cast<T>(0.0f);
                    for (int k = 0; k < 3; ++k) {
                        elem.s_dev[r][c] += s_temp[r][k] * R_dt[c][k];
                    }
                }
            }
        }

        // 4. Update Deformation Gradient Tensor F^{n+1} = (I + L * dt) * F^n
        T F_new[3][3] = {{static_cast<T>(0.0f)}};
        T I_plus_Ldt[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                I_plus_Ldt[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f)) + L[r][c] * dt;
            }
        }
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                for (int k = 0; k < 3; ++k) {
                    F_new[r][c] += I_plus_Ldt[r][k] * elem.F[k][c];
                }
            }
        }
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.F[r][c] = F_new[r][c];
            }
        }

        // Compute effective volumetric ratio J_elem (using Average Nodal Pressure J_anp for non-energetic solid Tet4)
        T J_elem = v_rel_elem;
        if (is_tet4 && !is_energetic && !elem.is_detached) {
            T J_anp_sum = static_cast<T>(0.0f);
            int valid_anp = 0;
            for (int n = 0; n < 4; ++n) {
                int nid = elem.node_ids[n];
                if (m_nodal_vol_ref[nid] > static_cast<T>(1.0e-18f)) {
                    J_anp_sum += m_nodal_vol_cur[nid] / m_nodal_vol_ref[nid];
                    valid_anp++;
                }
            }
            if (valid_anp > 0) {
                J_elem = J_anp_sum / static_cast<T>(valid_anp);
            }
        }

        T vol_strain = J_elem - static_cast<T>(1.0f);
        if (std::abs(vol_strain) < static_cast<T>(1.0e-14f)) {
            vol_strain = static_cast<T>(0.0f);
        }

        T p_hydro = static_cast<T>(0.0f);

        // --- Three-Pillar Energetic Material Suite (JWL / Davis / Programmed Burn / Lee-Tarver / CREST) ---
        if (is_energetic) {
            const float v_rel_f = std::max(static_cast<float>(v_rel_elem), 0.02f);
            float lam_curr = static_cast<float>(elem.lambda);
            float lam_new = lam_curr;

            bool is_crest_kinetics = (mat.burn_model == ReactionKinetics::CRESTEntropy) ||
                                     (mat.material_model == MPMMaterialModel::CRESTReactiveBurn && mat.burn_model != ReactionKinetics::LeeTarverODE);
            bool is_lt_kinetics = (mat.burn_model == ReactionKinetics::LeeTarverODE) ||
                                  (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth && mat.burn_model != ReactionKinetics::CRESTEntropy);
            bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) ||
                                   (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
            const bool awe = is_crest_kinetics && mat.crest_awe_c0 > 0.0f;
            bool use_davis_prod = !awe && ((mat.product_model == DetonationProductEOS::DavisProduct) ||
                                  (mat.material_model == MPMMaterialModel::CRESTReactiveBurn));
            CrestDavis::CRESTSolidParams awe_q{};
            float awe_vtmd = 1.0f;
            if (awe) {
                const float rho0s = (mat.davis_rho0 > 0.0f) ? mat.davis_rho0 : mat.density;
                awe_q = {mat.density, rho0s, mat.crest_awe_K0s, mat.detonation_energy,
                         mat.crest_awe_A1, mat.crest_awe_A2, mat.crest_awe_A3,
                         mat.crest_awe_B1, mat.crest_awe_B2, mat.crest_awe_B3,
                         mat.crest_awe_fc, mat.crest_awe_delta,
                         mat.crest_awe_Gamma1, mat.crest_awe_Gamma2, mat.crest_awe_gamma00, mat.crest_awe_m};
                awe_vtmd = rho0s / mat.density;
            }

            float p_curr_comp = static_cast<float>(-(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f) + q_visc);
            if (p_curr_comp < 0.0f) p_curr_comp = 0.0f;

            if (awe) {
                elem.v_min = std::min(elem.v_min, static_cast<T>(v_rel_f));
                elem.s_shock = std::max(elem.s_shock, static_cast<T>(CrestDavis::computeCRESTShockEntropy(static_cast<double>(elem.v_min), awe_q)));
                float e_th_trial = std::max(0.0f, static_cast<float>(elem.e_int) - lam_curr * mat.detonation_energy);
                float p_react_trial = static_cast<float>(CrestDavis::computeCRESTSolidPressure(v_rel_f, e_th_trial, awe_q));
                float p_mech_trial = p_react_trial + static_cast<float>(q_visc);
                float p_eff_comp = (lam_curr <= 1.0e-5f) ? std::max(p_curr_comp, p_mech_trial) : p_mech_trial;
                if (p_eff_comp > 1.0e6f)
                    elem.s_shock = std::max(elem.s_shock, static_cast<T>(CrestDavis::computeCRESTShockEntropyFromPressure(p_eff_comp, awe_q)));
                lam_new = static_cast<float>(CrestDavis::advanceAWECRESTProgress(static_cast<double>(dt), static_cast<double>(elem.s_shock), lam_curr,
                    mat.crest_awe_c0, mat.crest_awe_c1, mat.crest_awe_c2, mat.crest_awe_c3, mat.crest_awe_c6,
                    mat.crest_awe_c8, mat.crest_awe_c9, mat.crest_awe_c10, mat.crest_awe_c11, mat.crest_awe_c12, mat.crest_awe_c13));
            } else if (is_crest_kinetics) {
                elem.v_min = std::min(elem.v_min, static_cast<T>(v_rel_f));
                float s_calc = CrestDavis::computeDavisShockEntropy(
                    static_cast<float>(elem.v_min), mat.davis_c0, mat.davis_s1, mat.davis_gamma0,
                    mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                elem.s_shock = std::max(elem.s_shock, static_cast<T>(s_calc));

                float q_heat_trial = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
                float e_th_trial = std::max(0.0f, static_cast<float>(elem.e_int) - lam_curr * q_heat_trial);
                float p_react_trial = use_davis_solid
                    ? CrestDavis::computeDavisReactantPressure(v_rel_f, e_th_trial, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                    : JWL::computeSolidReactantPressure(v_rel_f, e_th_trial, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
                float p_mech_trial = p_react_trial + static_cast<float>(q_visc);
                float p_eff_comp = (lam_curr <= 1.0e-5f) ? std::max(p_curr_comp, p_mech_trial) : p_mech_trial;
                if (p_eff_comp > 1.0e6f) {
                    float s_p = CrestDavis::computeDavisShockEntropyFromPressure(
                        p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                    elem.s_shock = std::max(elem.s_shock, static_cast<T>(s_p));
                }

                lam_new = CrestDavis::advanceCRESTProgress(
                    static_cast<float>(dt), static_cast<float>(elem.s_shock), lam_curr,
                    mat.crest_b1, mat.crest_c1, mat.crest_m1,
                    mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2,
                    mat.crest_s0, mat.crest_s_threshold);
            } else if (is_lt_kinetics) {
                const float e_th_lt = static_cast<float>(elem.e_int) - lam_curr * mat.detonation_energy;
                float p_react_trial = (mat.solid_model == SolidReactantEOS::JWLReactant)
                    ? JWL::computeJWLReactantPressure(v_rel_f, e_th_lt, mat.jwlr_A, mat.jwlr_B, mat.jwlr_R1, mat.jwlr_R2, mat.jwlr_omega, mat.jwlr_Cv, mat.jwlr_T0, mat.density)
                    : use_davis_solid
                    ? CrestDavis::computeDavisReactantPressure(v_rel_f, e_th_lt, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                    : JWL::computeSolidReactantPressure(v_rel_f, e_th_lt, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
                float p_lt = std::max(p_curr_comp, p_react_trial + static_cast<float>(q_visc));
                lam_new = LeeTarver::advanceLeeTarver(
                    static_cast<float>(dt), lam_curr, v_rel_f, p_lt,
                    mat.lt_I, mat.lt_a, mat.lt_b, mat.lt_x, mat.lt_ig_max,
                    mat.lt_G1, mat.lt_c, mat.lt_d, mat.lt_y, mat.lt_growth_max,
                    mat.lt_G2, mat.lt_e, mat.lt_g, mat.lt_z, mat.lt_comp_min);
            } else {
                // Programmed Wavefront Burn
                float t_arr = static_cast<float>(elem.t_arrival);
                float eff_dx = (mat.cell_dx > 0.0f) ? mat.cell_dx : std::max(2.0f * static_cast<float>(h_e), 0.002f);
                float tau_burn = std::max(static_cast<float>(mat.burn_zone_cells) * eff_dx / std::max(mat.det_vel, 100.0f), mat.tau_burn_min);
                float lam_prog = JWL::computeProgrammedProgress(static_cast<float>(m_sim_time), t_arr, tau_burn);
                lam_new = std::max(lam_curr, lam_prog);
            }

            elem.lambda = static_cast<T>(lam_new);
            float d_lam = std::max(0.0f, lam_new - lam_curr);

            float q_heat = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
            float e_th = static_cast<float>(elem.e_int) - lam_curr * q_heat;
            float e_prod = e_th + q_heat;

            float p_ambient = 101325.0f;
            const bool use_jwl_reactant = (mat.solid_model == SolidReactantEOS::JWLReactant);
            auto solid_pressure_at = [&](float v) -> float {
                return awe
                    ? (p_ambient + static_cast<float>(CrestDavis::computeCRESTSolidPressure(v, std::max(0.0f, e_th), awe_q)))
                    : use_jwl_reactant
                    ? (p_ambient + JWL::computeJWLReactantPressure(v, e_th, mat.jwlr_A, mat.jwlr_B, mat.jwlr_R1, mat.jwlr_R2, mat.jwlr_omega, mat.jwlr_Cv, mat.jwlr_T0, mat.density))
                    : use_davis_solid
                    ? (p_ambient + CrestDavis::computeDavisReactantPressure(v, e_th, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0))
                    : (p_ambient + JWL::computeSolidReactantPressure(v, e_th, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density));
            };
            auto product_pressure_at = [&](float v) -> float {
                return awe
                    ? JWL::computeJWLProductPressure(v * awe_vtmd, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, static_cast<float>(awe_q.rho0s))
                    : use_davis_prod
                    ? CrestDavis::computeDavisProductPressure(v, e_prod, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0)
                    : JWL::computeJWLProductPressure(v, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
            };

            // Lee-Tarver kinetics use the selectable mixture rule (default: pressure equilibrium, volume additive);
            // all other reactive models keep the linear blend.
            const Mixture::Rule mix_rule = is_lt_kinetics
                ? static_cast<Mixture::Rule>(mat.mixture_rule) : Mixture::Rule::LinearBlend;
            const Mixture::Result mix = Mixture::mixturePressure(mix_rule, static_cast<double>(v_rel_f), static_cast<double>(lam_new),
                [&](double v) { return static_cast<double>(solid_pressure_at(static_cast<float>(v))); },
                [&](double v) { return static_cast<double>(product_pressure_at(static_cast<float>(v))); });
            float p_mix = static_cast<float>(mix.p);
            if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;
            // Phase pressures at the phase volumes chosen by the mixture rule (used by sound-speed/CFL closures)
            [[maybe_unused]] const float p_solid = solid_pressure_at(static_cast<float>(mix.v_s));
            [[maybe_unused]] const float p_prod = product_pressure_at(static_cast<float>(mix.v_p));

            float rho_eff = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
            float tr_deps = static_cast<float>(div_v * dt);
            float de_comp = (tr_deps < 0.0f) ? -((p_mix + static_cast<float>(q_visc)) / rho_eff) * tr_deps : 0.0f;
            float de_chem = d_lam * q_heat;
            elem.e_int += static_cast<T>(de_comp + de_chem);

            float cv_eff = use_davis_solid ? (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f) : (mat.Cp > 1.0f ? mat.Cp : 1000.0f);
            float t0_eff = use_davis_solid ? mat.davis_t0 : mat.T_room;
            elem.temperature = static_cast<T>(t0_eff) + elem.e_int / static_cast<T>(cv_eff);

            p_hydro = static_cast<T>(p_mix) + q_visc;

            T solid_frac = static_cast<T>(1.0f - lam_new);
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev[r][c] = solid_frac * (elem.s_dev[r][c] + static_cast<T>(2.0f) * solid_frac * G * d_dev[r][c] * dt);
                }
            }
            T s_norm = std::sqrt(
                elem.s_dev[0][0]*elem.s_dev[0][0] + elem.s_dev[1][1]*elem.s_dev[1][1] + elem.s_dev[2][2]*elem.s_dev[2][2] +
                static_cast<T>(2.0f)*(elem.s_dev[0][1]*elem.s_dev[0][1] + elem.s_dev[1][2]*elem.s_dev[1][2] + elem.s_dev[2][0]*elem.s_dev[2][0])
            );
            T vm_trial = std::sqrt(static_cast<T>(1.5f)) * s_norm;
            T q_yield = solid_frac * dynamic_yield;
            if (vm_trial > q_yield && vm_trial > static_cast<T>(1.0e-6f)) {
                T scale = q_yield / vm_trial;
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.s_dev[r][c] *= scale;
                    }
                }
            }
        } else {
            // Mie-Grueneisen Shock EOS or Tait Water Hydrostatic Pressure
            if (mat.material_model == MPMMaterialModel::TaitWater) {
                T rho_elem = static_cast<T>(mat.tait_rho0) / std::max(static_cast<T>(0.05f), J_elem);
                T e_elem = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 4184.0f) * (elem.temperature - static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.15f));
                if (mat.tait_variant == 1) { // Caloric
                    p_hydro = Blast::TaitEOSWater::compute_pressure_caloric(rho_elem, e_elem, static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_gruneisen), static_cast<T>(mat.tait_p_cav));
                } else if (mat.tait_variant == 2) { // Shock Hugoniot
                    p_hydro = Blast::TaitEOSWater::compute_pressure_hugoniot(rho_elem, e_elem, static_cast<T>(mat.tait_c0), static_cast<T>(1.75), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_gruneisen), static_cast<T>(mat.tait_p_cav));
                } else { // Isentropic
                    p_hydro = Blast::TaitEOSWater::compute_pressure_isentropic(rho_elem, static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), static_cast<T>(mat.tait_rho0), static_cast<T>(mat.tait_p_cav));
                }
                p_hydro += q_visc;
            } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
                T c0 = static_cast<T>(mat.mg_c0);
                T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
                T gamma0 = static_cast<T>(mat.mg_gamma0);
                T mu = (J_elem > static_cast<T>(1.0e-6f))
                     ? (static_cast<T>(1.0f) / J_elem - static_cast<T>(1.0f))
                     : static_cast<T>(0.0f);
                if (std::abs(mu) < static_cast<T>(1.0e-14f)) {
                    mu = static_cast<T>(0.0f);
                }
                T E_v = density * (mat.Cp > 0.0f ? mat.Cp : 477.0f) * (elem.temperature - (mat.T_room > 0.0f ? mat.T_room : 293.0f));
                if (mu > static_cast<T>(0.0f)) {
                    T denom = static_cast<T>(1.0f) - (s1 - static_cast<T>(1.0f)) * mu;
                    if (denom > static_cast<T>(0.1f)) {
                        p_hydro = (density * c0 * c0 * mu * (static_cast<T>(1.0f) + (static_cast<T>(1.0f) - static_cast<T>(0.5f) * gamma0) * mu)) / (denom * denom) + gamma0 * E_v;
                    } else {
                        p_hydro = K * mu + gamma0 * E_v;
                    }
                } else {
                    p_hydro = density * c0 * c0 * mu + gamma0 * E_v;
                }
                p_hydro += q_visc;
            } else {
                p_hydro = -K * vol_strain + q_visc;
            }
            if (elem.is_detached && p_hydro < static_cast<T>(0.0f)) {
                p_hydro = static_cast<T>(0.0f);
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev[r][c] += static_cast<T>(2.0f) * G * d_dev[r][c] * dt;
                }
            }

            if (mat.material_model == MPMMaterialModel::RHTConcrete) {
                RHTStateVariables<T> rht_state;
                rht_state.damage = elem.damage;
                rht_state.ep_bar = elem.ep_bar;
                rht_state.p_hydro = p_hydro;
                updateRHTStress<T>(
                    elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                    static_cast<T>(mat.rht_A), static_cast<T>(mat.rht_N),
                    static_cast<T>(mat.rht_B), static_cast<T>(mat.rht_M),
                    static_cast<T>(mat.rht_Q0), static_cast<T>(mat.rht_BQ),
                    static_cast<T>(mat.rht_D1), static_cast<T>(mat.rht_D2),
                    static_cast<T>(mat.rht_p_crush), static_cast<T>(mat.rht_p_lock),
                    static_cast<T>(mat.rht_alpha0), static_cast<T>(mat.rht_n_comp),
                    static_cast<T>(mat.rht_betac), static_cast<T>(mat.rht_deltat),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    rht_state
                );
                elem.damage = rht_state.damage;
                elem.ep_bar = rht_state.ep_bar;
                p_hydro = rht_state.p_hydro;
            } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
                KCStateVariables<T> kc_state;
                kc_state.damage = elem.damage;
                kc_state.lambda = elem.lambda;
                kc_state.ep_bar = elem.ep_bar;
                kc_state.p_hydro = p_hydro;
                updateKCStress<T>(
                    elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                    mat.kc_auto_generate,
                    static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
                    static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
                    static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
                    static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    kc_state
                );
                elem.damage = kc_state.damage;
                elem.lambda = kc_state.lambda;
                elem.ep_bar = kc_state.ep_bar;
                p_hydro = kc_state.p_hydro;
            } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
                CSCMStateVariables<T> cscm_state;
                cscm_state.damage = elem.damage;
                cscm_state.kappa = elem.lambda;
                cscm_state.ep_bar = elem.ep_bar;
                cscm_state.p_hydro = p_hydro;
                updateCSCMStress<T>(
                    elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f),
                    static_cast<T>(mat.cscm_alpha), static_cast<T>(mat.cscm_theta),
                    static_cast<T>(mat.cscm_lambda), static_cast<T>(mat.cscm_beta),
                    static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
                    static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
                    static_cast<T>(mat.cscm_D2),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    cscm_state
                );
                elem.damage = cscm_state.damage;
                elem.lambda = cscm_state.kappa;
                elem.ep_bar = cscm_state.ep_bar;
                p_hydro = cscm_state.p_hydro;
            } else if (mat.material_model == MPMMaterialModel::DruckerPragerSoil) {
                Blast::Materials::DruckerPragerParams<T> dp_p;
                dp_p.cohesion = static_cast<T>(mat.dp_cohesion);
                dp_p.friction_angle = static_cast<T>(mat.dp_friction_angle * 3.14159265358979323846 / 180.0);
                dp_p.dilatancy_angle = static_cast<T>(mat.dp_dilatancy_angle * 3.14159265358979323846 / 180.0);
                dp_p.tensile_cutoff = static_cast<T>(mat.dp_tensile_cutoff);
                dp_p.H_plastic = static_cast<T>(mat.dp_hardening_modulus);

                T d_eps_elem[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        d_eps_elem[r][c] = d_dev[r][c] * dt + (r == c ? static_cast<T>(1.0 / 3.0) * div_v * dt : static_cast<T>(0.0));
                    }
                }
                Blast::Materials::update_constitutive_drucker_prager<T>(
                    E, nu, dp_p, d_eps_elem, elem.s_dev, p_hydro, elem.ep_bar, false
                );
            } else if (mat.material_model == MPMMaterialModel::LinearElastic || mat.material_model == MPMMaterialModel::TaitWater) {
                // Pure Hookean linear elasticity or Tait fluid - no plastic yielding
                if (mat.material_model == MPMMaterialModel::TaitWater) {
                    T mu_fluid = static_cast<T>(mat.tait_viscosity > 0.0f ? mat.tait_viscosity : 1.002e-3f);
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            elem.s_dev[r][c] = static_cast<T>(2.0f) * mu_fluid * d_dev[r][c];
                        }
                    }
                }
            } else {
                T s_norm = std::sqrt(
                    elem.s_dev[0][0]*elem.s_dev[0][0] + elem.s_dev[1][1]*elem.s_dev[1][1] + elem.s_dev[2][2]*elem.s_dev[2][2] +
                    static_cast<T>(2.0f)*(elem.s_dev[0][1]*elem.s_dev[0][1] + elem.s_dev[1][2]*elem.s_dev[1][2] + elem.s_dev[2][0]*elem.s_dev[2][0])
                );
                T vm_trial = std::sqrt(static_cast<T>(1.5f)) * s_norm;

                if (vm_trial > dynamic_yield && vm_trial > static_cast<T>(1.0e-6f)) {
                    T scale = dynamic_yield / vm_trial;
                    T d_ep = (vm_trial - dynamic_yield) / (static_cast<T>(3.0f) * G + static_cast<T>(mat.hardening_modulus));
                    elem.ep_bar += d_ep;

                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            elem.s_dev[r][c] *= scale;
                        }
                    }

                    T plastic_work = dynamic_yield * d_ep;
                    T chi = m_physics_params.taylor_quinney_factor;
                    T Cp = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 477.0f);
                    elem.temperature += (chi * plastic_work) / (density * Cp);
                }
            }
        }

        T eta_shear_scale = is_energetic ? (static_cast<T>(1.0f) - elem.lambda) : static_cast<T>(1.0f);
        T eta_shear = eta_shear_scale * static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e;
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.sigma[r][c] = elem.s_dev[r][c] + static_cast<T>(2.0f) * eta_shear * d_dev[r][c] - (r == c ? p_hydro : static_cast<T>(0.0f));
            }
        }

        T sig_voigt[6] = {
            elem.sigma[0][0], elem.sigma[1][1], elem.sigma[2][2],
            elem.sigma[0][1], elem.sigma[1][2], elem.sigma[2][0]
        };

        T f_elem[24] = {0.0f};
        for (int r = 0; r < num_elem_nodes * 3; ++r) {
            for (int c = 0; c < 6; ++c) {
                f_elem[r] += B[c][r] * sig_voigt[c] * elem.V;
            }
        }

        for (int n = 0; n < num_elem_nodes; ++n) {
            int nid = elem.node_ids[n];
#ifdef _OPENMP
            #pragma omp atomic
            m_nodes[nid].f_int[0] += f_elem[n * 3 + 0];
            #pragma omp atomic
            m_nodes[nid].f_int[1] += f_elem[n * 3 + 1];
            #pragma omp atomic
            m_nodes[nid].f_int[2] += f_elem[n * 3 + 2];
#else
            m_nodes[nid].f_int[0] += f_elem[n * 3 + 0];
            m_nodes[nid].f_int[1] += f_elem[n * 3 + 1];
            m_nodes[nid].f_int[2] += f_elem[n * 3 + 2];
#endif
        }

        if (!is_tet4) {
            computeHourglassForcesFB(elem, dt, x_nodes, v_nodes, B, dN_dx, detJ, cd, h_e);
        }
    }
}

template <typename T>
void FEMSolver3D<T>::evaluateErosionCriteria() {
    bool erosion_occurred = false;

    if (m_physics_params.enable_nonlocal_damage && m_face_neighbors.size() != m_elements.size() * 6) {
        buildFaceConnectivity();
    }

    std::vector<T> ep_bar_effective(m_elements.size());
    for (size_t e = 0; e < m_elements.size(); ++e) {
        ep_bar_effective[e] = m_elements[e].ep_bar;
    }

    if (m_physics_params.enable_nonlocal_damage) {
        for (size_t e = 0; e < m_elements.size(); ++e) {
            if (m_elements[e].is_eroded) continue;
            const auto& mat = m_material_tables[m_elements[e].mat_id];
            float R_c = mat.nonlocal_radius;
            if (R_c > 1.0e-4f) {
                T w_sum = static_cast<T>(1.0f);
                T val_sum = m_elements[e].ep_bar;
                T h_elem = std::cbrt(m_elements[e].V0 > static_cast<T>(1.0e-18f) ? m_elements[e].V0 : static_cast<T>(1.0e-6f));
                T R_sq = static_cast<T>(R_c * R_c);

                for (int f = 0; f < 6; ++f) {
                    int nb = m_face_neighbors[e * 6 + f];
                    if (nb >= 0 && nb < static_cast<int>(m_elements.size()) && !m_elements[nb].is_eroded) {
                        T dist_sq = h_elem * h_elem;
                        T w = std::exp(-dist_sq / R_sq);
                        w_sum += w;
                        val_sum += w * m_elements[nb].ep_bar;
                    }
                }
                if (w_sum > static_cast<T>(0.0f)) {
                    ep_bar_effective[e] = val_sum / w_sum;
                }
            }
        }
    }

#ifdef _OPENMP
    #pragma omp parallel for schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        const bool is_tet4 = isTet4Element(elem);
        const auto& mat = m_material_tables[elem.mat_id];
        const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                   mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                   mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);

        T x_curr[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            x_curr[n][0] = m_nodes[nid].x[0];
            x_curr[n][1] = m_nodes[nid].x[1];
            x_curr[n][2] = m_nodes[nid].x[2];
        }
        T V_cur = elem.V > static_cast<T>(0.0f) ? elem.V : elem.V0;
        T v_rel = (elem.V0 > static_cast<T>(1.0e-18f)) ? (V_cur / elem.V0) : static_cast<T>(1.0f);

        if (is_energetic) {
            if (elem.V <= static_cast<T>(1.0e-18f) || v_rel <= static_cast<T>(0.005f) || v_rel >= static_cast<T>(25.0f)) {
                elem.is_eroded = true;
                elem.mpm_converted = true;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));
                std::memset(elem.s_dev, 0, sizeof(elem.s_dev));
                erosion_occurred = true;
            }
            continue;
        }

        T L_e = is_tet4 ? computeTet4CharacteristicLength(x_curr, V_cur) : computeHex8CharacteristicLength(x_curr, V_cur);
        T p_elem = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        T cd = computeDilatationalWaveSpeed<T>(mat, v_rel, elem.lambda, p_elem);
        T current_dt = L_e / cd;

        bool severe_crush = false;
        bool newly_fractured = false;
        T min_vol_r = m_erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? m_erosion_criteria.min_volume_ratio : static_cast<T>(0.02f);
        if (elem.V <= static_cast<T>(1.0e-18f) || (elem.V0 > static_cast<T>(1.0e-18f) && (elem.V / elem.V0) <= min_vol_r)) {
            severe_crush = true;
        }

        bool check_dt = (mat.enable_timestep_erosion || m_erosion_criteria.enable_timestep_erosion);
        T eta = (mat.timestep_erosion_factor > static_cast<T>(1.0e-5f)) ? static_cast<T>(mat.timestep_erosion_factor) : m_erosion_criteria.timestep_erosion_factor;
        if (check_dt && eta > static_cast<T>(1.0e-5f)) {
            T dt0_eff = elem.dt0;
            if (dt0_eff <= static_cast<T>(1.0e-12f) || dt0_eff >= static_cast<T>(1.0e20f)) {
                T x_0[8][3];
                for (int n = 0; n < 8; ++n) {
                    int nid = elem.node_ids[n];
                    x_0[n][0] = m_nodes[nid].x0[0];
                    x_0[n][1] = m_nodes[nid].x0[1];
                    x_0[n][2] = m_nodes[nid].x0[2];
                }
                T L_e0 = is_tet4 ? computeTet4CharacteristicLength(x_0, elem.V0) : computeHex8CharacteristicLength(x_0, elem.V0);
                dt0_eff = L_e0 / cd;
            }
            if (current_dt <= eta * dt0_eff) {
                severe_crush = true;
            }
        }

        uint32_t user_seed = static_cast<uint32_t>(m_physics_params.random_seed) * 2654435761u;
        uint32_t elem_seed = user_seed ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u) ^ (static_cast<uint32_t>(elem.node_ids[is_tet4 ? 3 : 6]) * 19349663u) ^ (static_cast<uint32_t>(e) * 83492791u);
        T het_factor = computeFEMWeibullFactor(elem_seed, m_physics_params);

        // Directional Material Anisotropy (Transverse Isotropy)
        T aniso_factor = static_cast<T>(1.0f);
        if (m_physics_params.enable_anisotropy && std::abs(m_physics_params.anisotropy_ratio - static_cast<T>(1.0f)) > static_cast<T>(1.0e-4f)) {
            T ax = m_physics_params.anisotropy_dir[0], ay = m_physics_params.anisotropy_dir[1], az = m_physics_params.anisotropy_dir[2];
            T s_a = ax * (elem.sigma[0][0]*ax + elem.sigma[0][1]*ay + elem.sigma[0][2]*az) +
                    ay * (elem.sigma[1][0]*ax + elem.sigma[1][1]*ay + elem.sigma[1][2]*az) +
                    az * (elem.sigma[2][0]*ax + elem.sigma[2][1]*ay + elem.sigma[2][2]*az);
            T s_dev_norm = std::sqrt(elem.sigma[0][0]*elem.sigma[0][0] + elem.sigma[1][1]*elem.sigma[1][1] + elem.sigma[2][2]*elem.sigma[2][2] + 
                                    static_cast<T>(2.0f)*(elem.sigma[0][1]*elem.sigma[0][1] + elem.sigma[1][2]*elem.sigma[1][2] + elem.sigma[2][0]*elem.sigma[2][0]));
            if (s_dev_norm > static_cast<T>(1.0e-6f)) {
                T xi = std::clamp(std::abs(s_a) / s_dev_norm, static_cast<T>(0.0f), static_cast<T>(1.0f));
                aniso_factor = static_cast<T>(1.0f) + (m_physics_params.anisotropy_ratio - static_cast<T>(1.0f)) * (static_cast<T>(1.0f) - xi * xi);
            }
        }

        // Directional Crack Band Normalization (Bažant formulation)
        T dir_factor = static_cast<T>(1.0f);
        if (mat.directional_crack_band && m_physics_params.enable_directional_crack_band) {
            T sxx = elem.sigma[0][0], syy = elem.sigma[1][1], szz = elem.sigma[2][2];
            T s_max = std::max({std::abs(sxx), std::abs(syy), std::abs(szz)});
            T s_norm = std::sqrt(sxx*sxx + syy*syy + szz*szz + 
                                static_cast<T>(2.0f)*(elem.sigma[0][1]*elem.sigma[0][1] + elem.sigma[1][2]*elem.sigma[1][2] + elem.sigma[2][0]*elem.sigma[2][0]));
            if (s_norm > static_cast<T>(1.0e-6f) && s_max > static_cast<T>(1.0e-6f)) {
                T n_dom = s_max / s_norm;
                dir_factor = std::clamp(n_dom, static_cast<T>(0.57735f), static_cast<T>(1.0f));
            }
        }
        (void)dir_factor;

        bool is_concrete = (mat.material_model == MPMMaterialModel::RHTConcrete ||
                            mat.material_model == MPMMaterialModel::KCConcrete ||
                            mat.material_model == MPMMaterialModel::CSCMConcrete);

        if (is_concrete) {
            T conc_erosion_strain = static_cast<T>((mat.erosion_strain >= 0.02f) ? mat.erosion_strain : (m_erosion_criteria.failure_strain >= 0.02f ? m_erosion_criteria.failure_strain : 0.10f));
            conc_erosion_strain *= (het_factor * aniso_factor);
            bool damage_saturated = (elem.damage >= static_cast<T>(0.95f));
            if (damage_saturated && ep_bar_effective[e] >= conc_erosion_strain) {
                newly_fractured = true;
            }
        } else {
            if (mat.enable_strain_erosion || m_erosion_criteria.enable_strain_erosion || mat.failure_strain > 0.0f || mat.erosion_strain > 0.0f || m_erosion_criteria.failure_strain > 0.0f) {
                T fail_strain = static_cast<T>(mat.erosion_strain > 0.0f ? mat.erosion_strain : (mat.failure_strain > 0.0f ? mat.failure_strain : m_erosion_criteria.failure_strain));
                fail_strain *= (het_factor * aniso_factor);
                if (fail_strain > static_cast<T>(0.0f) && ep_bar_effective[e] >= fail_strain) {
                    newly_fractured = true;
                }
            }
        }

        if (mat.enable_stress_erosion || m_erosion_criteria.enable_stress_erosion) {
            T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
            T fail_stress = static_cast<T>(mat.erosion_stress > 0.0f ? mat.erosion_stress : (mat.tensile_failure_stress > 0.0f ? mat.tensile_failure_stress : m_erosion_criteria.tensile_failure_stress));
            fail_stress *= (het_factor * aniso_factor);
            if (fail_stress > static_cast<T>(0.0f) && mean_s >= fail_stress) {
                if (!is_concrete || elem.damage >= static_cast<T>(0.95f)) {
                    newly_fractured = true;
                }
            }
        }

        if (severe_crush) {
            elem.is_eroded = true;
            elem.mpm_converted = false;
            std::memset(elem.sigma, 0, sizeof(elem.sigma));
            std::memset(elem.s_dev, 0, sizeof(elem.s_dev));
            erosion_occurred = true;
        } else if (newly_fractured) {
            if (m_physics_params.enable_cohesive_splitting) {
                if (!elem.is_detached) {
                    elem.damage = static_cast<T>(1.0f);
                    elem.decay_step = 10;
                    erosion_occurred = true;
                }
            } else {
                elem.is_eroded = true;
                elem.mpm_converted = false;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));
                std::memset(elem.s_dev, 0, sizeof(elem.s_dev));
                erosion_occurred = true;
            }
        }
    }

    if (m_physics_params.enable_cohesive_splitting && erosion_occurred) {
        splitFracturedElementNodes();
    }

    if (erosion_occurred || m_surface_facets_dirty) {
        m_surface_facets_dirty = true;
        processErodedElementsToMPM();
    }
    updateNodeErosionStatus();
}

template <typename T>
void FEMSolver3D<T>::splitFracturedElementNodes() {
    if (!m_physics_params.enable_cohesive_splitting) return;

    if (m_max_nodes_capacity < m_nodes.size() + 4 * m_elements.size()) {
        m_max_nodes_capacity = m_nodes.size() + 4 * m_elements.size();
        m_nodes.reserve(m_max_nodes_capacity);
    }
    if (m_node_elem_ref_count.size() < m_max_nodes_capacity) {
        m_node_elem_ref_count.resize(m_max_nodes_capacity, 0);
    }
    std::fill(m_node_elem_ref_count.begin(), m_node_elem_ref_count.begin() + m_nodes.size(), 0);

    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        const int num_n = isTet4Element(elem) ? 4 : 8;
        for (int n = 0; n < num_n; ++n) {
            int nid = elem.node_ids[n];
            if (nid >= 0 && nid < static_cast<int>(m_nodes.size())) {
                m_node_elem_ref_count[nid]++;
            }
        }
    }

    bool any_split = false;
    for (size_t e = 0; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded || elem.is_detached || elem.decay_step < 5) continue;

        elem.is_detached = true;
        elem.damage = static_cast<T>(1.0f);
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.s_dev[r][c] *= static_cast<T>(0.15f);
            }
        }

        const bool is_tet4 = isTet4Element(elem);
        const int num_n = is_tet4 ? 4 : 8;
        T density = (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(m_material_tables.size()))
                    ? static_cast<T>(m_material_tables[elem.mat_id].density)
                    : static_cast<T>(7850.0f);
        T m_elem_node = (density * elem.V0) / static_cast<T>(num_n);

        for (int n = 0; n < num_n; ++n) {
            int old_nid = elem.node_ids[n];
            if (old_nid < 0 || old_nid >= static_cast<int>(m_nodes.size())) continue;
            if (m_node_elem_ref_count[old_nid] > 1 && m_nodes.size() < m_max_nodes_capacity) {
                FEMNode3D<T> new_node = m_nodes[old_nid];
                new_node.is_fixed[0] = false;
                new_node.is_fixed[1] = false;
                new_node.is_fixed[2] = false;
                new_node.m = m_elem_node;
                for (int c = 0; c < 3; ++c) {
                    new_node.f_int[c] = static_cast<T>(0.0f);
                    new_node.f_ext[c] = static_cast<T>(0.0f);
                    new_node.f_contact[c] = static_cast<T>(0.0f);
                }

                m_nodes[old_nid].m = std::max(m_elem_node * static_cast<T>(0.05f), m_nodes[old_nid].m - m_elem_node);
                m_node_elem_ref_count[old_nid]--;

                int new_nid = static_cast<int>(m_nodes.size());
                m_nodes.push_back(new_node);
                m_node_elem_ref_count[new_nid] = 1;

                elem.node_ids[n] = new_nid;
                if (is_tet4 && n == 3) {
                    elem.node_ids[4] = new_nid;
                    elem.node_ids[5] = new_nid;
                    elem.node_ids[6] = new_nid;
                    elem.node_ids[7] = new_nid;
                }
                any_split = true;
            }
        }
    }

    if (any_split) {
        if (m_nodal_vol_cur.size() < m_nodes.size()) {
            m_nodal_vol_cur.resize(m_nodes.size(), static_cast<T>(0.0f));
            m_nodal_vol_ref.resize(m_nodes.size(), static_cast<T>(0.0f));
        }
        m_face_neighbors.clear();
        m_surface_facets_dirty = true;
    }
}

template <typename T>
void FEMSolver3D<T>::processErodedElementsToMPM() {
    if (!m_physics_params.convert_failed_elements_to_mpm || !m_mpm_solver) return;

    if (m_face_neighbors.size() != m_elements.size() * 6) {
        buildFaceConnectivity();
    }

    // Step 1: Identify newly eroded elements that qualify for conversion (exposure / tensile gating)
    std::vector<size_t> ready_elements;
    ready_elements.reserve(m_elements.size() / 16);

    for (size_t e = 0; e < m_elements.size(); ++e) {
        if (m_elements[e].is_eroded && !m_elements[e].mpm_converted) {
            int num_exposed = 0;
            for (int f = 0; f < 6; ++f) {
                int neighbor = m_face_neighbors[e * 6 + f];
                if (neighbor == -1 || m_elements[neighbor].is_eroded) {
                    num_exposed++;
                }
            }
            T V_elem = m_elements[e].V > static_cast<T>(0) ? m_elements[e].V : m_elements[e].V0;
            T V0_elem = m_elements[e].V0 > static_cast<T>(0) ? m_elements[e].V0 : static_cast<T>(1.0e-6f);
            T J_vol = V_elem / V0_elem;
            T mean_s = (m_elements[e].sigma[0][0] + m_elements[e].sigma[1][1] + m_elements[e].sigma[2][2]) / static_cast<T>(3.0f);

            bool is_tensile_failure = (J_vol >= static_cast<T>(0.98f)) || (mean_s >= static_cast<T>(0.0f));
            bool is_sufficiently_exposed = (num_exposed >= 2);

            if (is_tensile_failure || is_sufficiently_exposed) {
                ready_elements.push_back(e);
            }
        }
    }

    if (ready_elements.empty()) return;

    std::vector<MPMParticle3D> new_particles;
    new_particles.reserve(ready_elements.size() * static_cast<size_t>(m_physics_params.mpm_particles_per_failed_element));

    float clumping = std::clamp(static_cast<float>(m_physics_params.debris_clumping), 0.0f, 1.0f);
    int max_clump = std::clamp(m_physics_params.debris_max_clump_size, 1, 64);
    uint32_t user_seed = static_cast<uint32_t>(m_physics_params.random_seed) * 2654435761u;

    if (clumping > 0.001f && max_clump > 1) {
        // Multi-element aggregate clumping across ready elements
        std::unordered_map<size_t, int> elem_to_clump;
        elem_to_clump.reserve(ready_elements.size());
        std::vector<std::vector<size_t>> clumps;
        clumps.reserve(ready_elements.size());

        for (size_t e : ready_elements) {
            if (elem_to_clump.find(e) != elem_to_clump.end()) continue;

            // Start new clump with element e
            std::vector<size_t> current_clump;
            current_clump.push_back(e);
            elem_to_clump[e] = static_cast<int>(clumps.size());

            // BFS expansion across shared faces
            std::vector<size_t> queue;
            queue.push_back(e);
            size_t head = 0;

            while (head < queue.size() && static_cast<int>(current_clump.size()) < max_clump) {
                size_t curr = queue[head++];
                for (int f = 0; f < 6; ++f) {
                    int neighbor = m_face_neighbors[curr * 6 + f];
                    if (neighbor < 0 || neighbor >= static_cast<int>(m_elements.size())) continue;
                    size_t nb_idx = static_cast<size_t>(neighbor);

                    if (m_elements[nb_idx].is_eroded && !m_elements[nb_idx].mpm_converted &&
                        elem_to_clump.find(nb_idx) == elem_to_clump.end()) {
                        // Check stochastic bond retention probability
                        uint32_t bond_seed = user_seed ^ (static_cast<uint32_t>(std::min(curr, nb_idx)) * 73856093u) ^ (static_cast<uint32_t>(std::max(curr, nb_idx)) * 19349663u);
                        bond_seed = (bond_seed ^ 61u) ^ (bond_seed >> 16);
                        bond_seed *= 9u;
                        bond_seed = bond_seed ^ (bond_seed >> 4);
                        bond_seed *= 0x27d4eb2du;
                        bond_seed = bond_seed ^ (bond_seed >> 15);
                        float bond_draw = static_cast<float>(bond_seed & 0xFFFFu) / 65535.0f;

                        if (bond_draw <= clumping) {
                            elem_to_clump[nb_idx] = static_cast<int>(clumps.size());
                            current_clump.push_back(nb_idx);
                            queue.push_back(nb_idx);
                            if (static_cast<int>(current_clump.size()) >= max_clump) break;
                        }
                    }
                }
            }
            clumps.push_back(std::move(current_clump));
        }

        // Process each clump: compute clump COM velocity and convert elements
        for (const auto& clump : clumps) {
            float v_clump_com[3] = {0.0f, 0.0f, 0.0f};
            float total_m = 0.0f;
            for (size_t elem_idx : clump) {
                const auto& elem = m_elements[elem_idx];
                float rho_mat = (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(m_material_tables.size())) ? static_cast<float>(m_material_tables[elem.mat_id].density) : 2400.0f;
                float m_elem = static_cast<float>(elem.V0) * rho_mat;
                if (m_elem <= 0.0f) m_elem = 1.0f;
                total_m += m_elem;
                for (int n = 0; n < 8; ++n) {
                    int nid = elem.node_ids[n];
                    for (int c = 0; c < 3; ++c) {
                        v_clump_com[c] += static_cast<float>(m_nodes[nid].v[c]) * (0.125f * m_elem);
                    }
                }
            }
            if (total_m > 0.0f) {
                float inv_m = 1.0f / total_m;
                v_clump_com[0] *= inv_m;
                v_clump_com[1] *= inv_m;
                v_clump_com[2] *= inv_m;
            }
            for (size_t elem_idx : clump) {
                m_elements[elem_idx].mpm_converted = true;
                convertElementToMPMParticles(m_elements[elem_idx], new_particles, v_clump_com);
            }
        }
    } else {
        // Un-clumped granular / fluid / individual mode (soil, water, sand, or debris_clumping == 0)
        for (size_t e : ready_elements) {
            float v_local[3] = {0.0f, 0.0f, 0.0f};
            int count = 0;
            for (int f = 0; f < 6; ++f) {
                int neighbor = m_face_neighbors[e * 6 + f];
                if (neighbor >= 0 && neighbor < static_cast<int>(m_elements.size()) && m_elements[neighbor].is_eroded) {
                    for (int n = 0; n < 8; ++n) {
                        int nid = m_elements[neighbor].node_ids[n];
                        for (int c = 0; c < 3; ++c) {
                            v_local[c] += static_cast<float>(m_nodes[nid].v[c]) * 0.125f;
                        }
                    }
                    count++;
                }
            }
            const float* p_local = nullptr;
            if (count > 0) {
                float inv_c = 1.0f / static_cast<float>(count);
                v_local[0] *= inv_c; v_local[1] *= inv_c; v_local[2] *= inv_c;
                p_local = v_local;
            }
            m_elements[e].mpm_converted = true;
            convertElementToMPMParticles(m_elements[e], new_particles, p_local);
        }
    }

    if (!new_particles.empty()) {
        if (m_mpm_solver->getMaterialTables().size() < m_material_tables.size()) {
            m_mpm_solver->getMaterialTables() = m_material_tables;
        }
        m_mpm_solver->addParticlesDirect(new_particles);
    }
}

template <typename T>
void FEMSolver3D<T>::convertElementToMPMParticles(const FEMElement3D<T>& elem, std::vector<MPMParticle3D>& out_particles, const float* v_cluster_com) const {
    const auto& mat = m_material_tables[elem.mat_id];
    float density = mat.density > 0.0f ? mat.density : 2400.0f;
    float V_elem = static_cast<float>(elem.V > static_cast<T>(1.0e-18f) ? elem.V : (elem.V0 > static_cast<T>(1.0e-18f) ? elem.V0 : static_cast<T>(1.0e-6f)));
    if (V_elem <= 0.0f) V_elem = 1.0e-6f;

    int np = m_physics_params.mpm_particles_per_failed_element;
    if (np != 1 && np != 8 && np != 27) np = 8;

    float p_mass = (density * V_elem) / static_cast<float>(np);
    float p_vol = V_elem / static_cast<float>(np);

    // Gather nodal positions and velocities
    T x_nodes[8][3], v_nodes[8][3];
    float x_elem_com[3] = {0.0f, 0.0f, 0.0f};
    float v_elem_com[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < 8; ++n) {
        int nid = elem.node_ids[n];
        for (int c = 0; c < 3; ++c) {
            x_nodes[n][c] = m_nodes[nid].x[c];
            v_nodes[n][c] = m_nodes[nid].v[c];
            x_elem_com[c] += static_cast<float>(m_nodes[nid].x[c]) * 0.125f;
            v_elem_com[c] += static_cast<float>(m_nodes[nid].v[c]) * 0.125f;
        }
    }

    // Compute deformed element dimensions to handle crushed / flattened (pancake) hex elements
    float hx = 0.5f * (
        std::sqrt((static_cast<float>(x_nodes[1][0]-x_nodes[0][0]))*(static_cast<float>(x_nodes[1][0]-x_nodes[0][0])) + (static_cast<float>(x_nodes[1][1]-x_nodes[0][1]))*(static_cast<float>(x_nodes[1][1]-x_nodes[0][1])) + (static_cast<float>(x_nodes[1][2]-x_nodes[0][2]))*(static_cast<float>(x_nodes[1][2]-x_nodes[0][2]))) +
        std::sqrt((static_cast<float>(x_nodes[2][0]-x_nodes[3][0]))*(static_cast<float>(x_nodes[2][0]-x_nodes[3][0])) + (static_cast<float>(x_nodes[2][1]-x_nodes[3][1]))*(static_cast<float>(x_nodes[2][1]-x_nodes[3][1])) + (static_cast<float>(x_nodes[2][2]-x_nodes[3][2]))*(static_cast<float>(x_nodes[2][2]-x_nodes[3][2])))
    );
    float hy = 0.5f * (
        std::sqrt((static_cast<float>(x_nodes[3][0]-x_nodes[0][0]))*(static_cast<float>(x_nodes[3][0]-x_nodes[0][0])) + (static_cast<float>(x_nodes[3][1]-x_nodes[0][1]))*(static_cast<float>(x_nodes[3][1]-x_nodes[0][1])) + (static_cast<float>(x_nodes[3][2]-x_nodes[0][2]))*(static_cast<float>(x_nodes[3][2]-x_nodes[0][2]))) +
        std::sqrt((static_cast<float>(x_nodes[2][0]-x_nodes[1][0]))*(static_cast<float>(x_nodes[2][0]-x_nodes[1][0])) + (static_cast<float>(x_nodes[2][1]-x_nodes[1][1]))*(static_cast<float>(x_nodes[2][1]-x_nodes[1][1])) + (static_cast<float>(x_nodes[2][2]-x_nodes[1][2]))*(static_cast<float>(x_nodes[2][2]-x_nodes[1][2])))
    );
    float hz = 0.5f * (
        std::sqrt((static_cast<float>(x_nodes[4][0]-x_nodes[0][0]))*(static_cast<float>(x_nodes[4][0]-x_nodes[0][0])) + (static_cast<float>(x_nodes[4][1]-x_nodes[0][1]))*(static_cast<float>(x_nodes[4][1]-x_nodes[0][1])) + (static_cast<float>(x_nodes[4][2]-x_nodes[0][2]))*(static_cast<float>(x_nodes[4][2]-x_nodes[0][2]))) +
        std::sqrt((static_cast<float>(x_nodes[7][0]-x_nodes[3][0]))*(static_cast<float>(x_nodes[7][0]-x_nodes[3][0])) + (static_cast<float>(x_nodes[7][1]-x_nodes[3][1]))*(static_cast<float>(x_nodes[7][1]-x_nodes[3][1])) + (static_cast<float>(x_nodes[7][2]-x_nodes[3][2]))*(static_cast<float>(x_nodes[7][2]-x_nodes[3][2])))
    );
    float h_min = std::max(1.0e-5f, std::min({hx, hy, hz}));
    float h_max = std::max({hx, hy, hz, 1.0e-5f});
    bool is_flattened = (h_min / h_max < 0.25f) || (elem.V0 > static_cast<T>(1.0e-18f) && (elem.V / elem.V0) < static_cast<T>(0.25f));

    // Clearance-aware geometric contact radius sizing: bounded by deformed minimum gap thickness to prevent double-sided vise-trap jams
    float clearance_factor = (np == 27) ? 0.25f : 0.35f;
    float h_p = std::min(std::cbrt(p_vol) * clearance_factor, 0.38f * h_min);
    if (h_p < 1.0e-4f) h_p = 1.0e-4f;

    // Material-aware acoustic / Gurney velocity physical ceiling
    float E_mat = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 30.0e9f;
    float rho_mat = mat.density > 0.0f ? mat.density : 2400.0f;
    float c_bulk = std::sqrt(E_mat / (rho_mat > 1.0e-6f ? rho_mat : 2400.0f));
    float v_max_birth = std::clamp(c_bulk * 0.85f, 2000.0f, 3500.0f);
    float max_dev = 0.6f * v_max_birth;

    static const float HEX_NODES_LOCAL[8][3] = {
        {-1,-1,-1}, { 1,-1,-1}, { 1, 1,-1}, {-1, 1,-1},
        {-1,-1, 1}, { 1,-1, 1}, { 1, 1, 1}, {-1, 1, 1}
    };

    // Compute element center Jacobian and spin tensor W_ij for physical vorticity micro-mixing
    float W_spin[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
    {
        float J0[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
        for (int a = 0; a < 8; ++a) {
            float dN_dxi[3] = {
                0.125f * HEX_NODES_LOCAL[a][0],
                0.125f * HEX_NODES_LOCAL[a][1],
                0.125f * HEX_NODES_LOCAL[a][2]
            };
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    J0[r][c] += static_cast<float>(x_nodes[a][r]) * dN_dxi[c];
                }
            }
        }
        float detJ = J0[0][0]*(J0[1][1]*J0[2][2] - J0[1][2]*J0[2][1])
                   - J0[0][1]*(J0[1][0]*J0[2][2] - J0[1][2]*J0[2][0])
                   + J0[0][2]*(J0[1][0]*J0[2][1] - J0[1][1]*J0[2][0]);
        if (std::abs(detJ) > 1.0e-12f) {
            float inv_det = 1.0f / detJ;
            float invJ[3][3] = {
                { (J0[1][1]*J0[2][2] - J0[1][2]*J0[2][1]) * inv_det, -(J0[0][1]*J0[2][2] - J0[0][2]*J0[2][1]) * inv_det,  (J0[0][1]*J0[1][2] - J0[0][2]*J0[1][1]) * inv_det},
                {-(J0[1][0]*J0[2][2] - J0[1][2]*J0[2][0]) * inv_det,  (J0[0][0]*J0[2][2] - J0[0][2]*J0[2][0]) * inv_det, -(J0[0][0]*J0[1][2] - J0[0][2]*J0[1][0]) * inv_det},
                { (J0[1][0]*J0[2][1] - J0[1][1]*J0[2][0]) * inv_det, -(J0[0][0]*J0[2][1] - J0[0][1]*J0[2][0]) * inv_det,  (J0[0][0]*J0[1][1] - J0[0][1]*J0[1][0]) * inv_det}
            };
            float L_grad[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
            for (int a = 0; a < 8; ++a) {
                float dN_dxi[3] = {
                    0.125f * HEX_NODES_LOCAL[a][0],
                    0.125f * HEX_NODES_LOCAL[a][1],
                    0.125f * HEX_NODES_LOCAL[a][2]
                };
                float dN_dx[3] = {
                    invJ[0][0]*dN_dxi[0] + invJ[0][1]*dN_dxi[1] + invJ[0][2]*dN_dxi[2],
                    invJ[1][0]*dN_dxi[0] + invJ[1][1]*dN_dxi[1] + invJ[1][2]*dN_dxi[2],
                    invJ[2][0]*dN_dxi[0] + invJ[2][1]*dN_dxi[1] + invJ[2][2]*dN_dxi[2]
                };
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        L_grad[r][c] += static_cast<float>(v_nodes[a][r]) * dN_dx[c];
                    }
                }
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    W_spin[r][c] = 0.5f * (L_grad[r][c] - L_grad[c][r]);
                }
            }
        }
    }

    auto hash_jitter = [](uint32_t seed) -> float {
        seed = (seed ^ 61u) ^ (seed >> 16);
        seed *= 9u;
        seed = seed ^ (seed >> 4);
        seed *= 0x27d4eb2du;
        seed = seed ^ (seed >> 15);
        return (static_cast<float>(seed & 0xFFFFu) / 32767.5f) - 1.0f;
    };
    uint32_t user_seed = static_cast<uint32_t>(m_physics_params.random_seed) * 2654435761u;
    uint32_t base_seed = user_seed ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u) ^ (static_cast<uint32_t>(elem.node_ids[6]) * 19349663u);

    if (np == 1) {
        MPMParticle3D p{};
        float xp[3] = {0.0f, 0.0f, 0.0f};
        float vp[3] = {0.0f, 0.0f, 0.0f};
        for (int n = 0; n < 8; ++n) {
            for (int c = 0; c < 3; ++c) {
                xp[c] += static_cast<float>(x_nodes[n][c]) * 0.125f;
                vp[c] += static_cast<float>(v_nodes[n][c]) * 0.125f;
            }
        }
        float v_mag_sq = vp[0]*vp[0] + vp[1]*vp[1] + vp[2]*vp[2];
        if (v_mag_sq > v_max_birth * v_max_birth) {
            float scale = v_max_birth / std::sqrt(v_mag_sq);
            vp[0] *= scale; vp[1] *= scale; vp[2] *= scale;
        }
        p.x[0] = xp[0]; p.x[1] = xp[1]; p.x[2] = xp[2];
        p.v[0] = vp[0]; p.v[1] = vp[1]; p.v[2] = vp[2];
        p.m = p_mass;
        p.V0 = p_vol;
        p.V = p_vol;
        p.lp[0] = h_p; p.lp[1] = h_p; p.lp[2] = h_p;
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.sigma[r][c] = 0.0f;
                p.B[r][c] = 0.0f;
                p.L_grad[r][c] = 0.0f;
            }
        }
        p.ep_bar = static_cast<float>(elem.ep_bar);
        p.damage = 1.0f;
        p.temperature = static_cast<float>(elem.temperature);
        p.object_id = elem.mat_id;
        p.has_failed = true;
        out_particles.push_back(p);
    } else if (np == 8) {
        // Contracted Gauss coordinates (0.380 instead of 0.577) to guarantee zero initial overlap with adjacent element faces
        const float g_coord = 0.380f;
        for (int p_idx = 0; p_idx < 8; ++p_idx) {
            float jx = 0.08f * hash_jitter(base_seed ^ (static_cast<uint32_t>(p_idx) * 7919u + 1u));
            float jy = 0.08f * hash_jitter(base_seed ^ (static_cast<uint32_t>(p_idx) * 7919u + 2u));
            float jz = 0.08f * hash_jitter(base_seed ^ (static_cast<uint32_t>(p_idx) * 7919u + 3u));

            float xi = (HEX_NODES_LOCAL[p_idx][0] + jx) * g_coord;
            float eta = (HEX_NODES_LOCAL[p_idx][1] + jy) * g_coord;
            float zeta = (HEX_NODES_LOCAL[p_idx][2] + jz) * g_coord;

            // If crushed/flattened, collapse particle sheet along minimum dimension
            if (is_flattened) {
                if (hz <= hx && hz <= hy) zeta *= 0.15f;
                else if (hx <= hy && hx <= hz) xi *= 0.15f;
                else eta *= 0.15f;
            }

            float xp[3] = {0.0f, 0.0f, 0.0f};
            float vp[3] = {0.0f, 0.0f, 0.0f};
            for (int a = 0; a < 8; ++a) {
                float Na = 0.125f * (1.0f + xi * HEX_NODES_LOCAL[a][0]) *
                                   (1.0f + eta * HEX_NODES_LOCAL[a][1]) *
                                   (1.0f + zeta * HEX_NODES_LOCAL[a][2]);
                for (int c = 0; c < 3; ++c) {
                    xp[c] += static_cast<float>(x_nodes[a][c]) * Na;
                    vp[c] += static_cast<float>(v_nodes[a][c]) * Na;
                }
            }

            // Clumping toward element center-of-mass velocity to suppress unphysical explosive dispersion
            float clumping = std::clamp(static_cast<float>(m_physics_params.debris_clumping > 0.0f ? m_physics_params.debris_clumping : 0.60f), 0.0f, 0.95f);
            vp[0] = (1.0f - clumping) * vp[0] + clumping * v_elem_com[0];
            vp[1] = (1.0f - clumping) * vp[1] + clumping * v_elem_com[1];
            vp[2] = (1.0f - clumping) * vp[2] + clumping * v_elem_com[2];

            // Bounded rotational spin from element shearing
            float offset_x = xp[0] - x_elem_com[0];
            float offset_y = xp[1] - x_elem_com[1];
            float offset_z = xp[2] - x_elem_com[2];

            float v_spin_x = W_spin[0][0]*offset_x + W_spin[0][1]*offset_y + W_spin[0][2]*offset_z;
            float v_spin_y = W_spin[1][0]*offset_x + W_spin[1][1]*offset_y + W_spin[1][2]*offset_z;
            float v_spin_z = W_spin[2][0]*offset_x + W_spin[2][1]*offset_y + W_spin[2][2]*offset_z;

            float spin_mag = std::sqrt(v_spin_x*v_spin_x + v_spin_y*v_spin_y + v_spin_z*v_spin_z);
            float v_com_speed = std::sqrt(v_elem_com[0]*v_elem_com[0] + v_elem_com[1]*v_elem_com[1] + v_elem_com[2]*v_elem_com[2]);
            float max_spin = std::max(2.0f, 0.05f * v_com_speed);
            if (spin_mag > max_spin) {
                float scale = max_spin / spin_mag;
                v_spin_x *= scale;
                v_spin_y *= scale;
                v_spin_z *= scale;
            }

            vp[0] += v_spin_x;
            vp[1] += v_spin_y;
            vp[2] += v_spin_z;

            // Inter-element cluster / clump velocity smoothing
            if (v_cluster_com != nullptr && (m_physics_params.debris_clumping > static_cast<T>(1.0e-5f) || m_physics_params.debris_velocity_smoothing > static_cast<T>(1.0e-5f))) {
                float alpha_s = std::clamp(static_cast<float>(std::max(m_physics_params.debris_clumping, m_physics_params.debris_velocity_smoothing)), 0.0f, 0.90f);
                vp[0] = (1.0f - alpha_s) * vp[0] + alpha_s * v_cluster_com[0];
                vp[1] = (1.0f - alpha_s) * vp[1] + alpha_s * v_cluster_com[1];
                vp[2] = (1.0f - alpha_s) * vp[2] + alpha_s * v_cluster_com[2];
            }

            // Filter out single-node hourglassing / rupture singularities
            float diff_x = vp[0] - v_elem_com[0];
            float diff_y = vp[1] - v_elem_com[1];
            float diff_z = vp[2] - v_elem_com[2];
            float diff_sq = diff_x*diff_x + diff_y*diff_y + diff_z*diff_z;
            if (diff_sq > max_dev * max_dev) {
                float scale = max_dev / std::sqrt(diff_sq);
                vp[0] = v_elem_com[0] + diff_x * scale;
                vp[1] = v_elem_com[1] + diff_y * scale;
                vp[2] = v_elem_com[2] + diff_z * scale;
            }

            float v_mag_sq = vp[0]*vp[0] + vp[1]*vp[1] + vp[2]*vp[2];
            if (v_mag_sq > v_max_birth * v_max_birth) {
                float scale = v_max_birth / std::sqrt(v_mag_sq);
                vp[0] *= scale; vp[1] *= scale; vp[2] *= scale;
            }

            // Geometric clearance check against embedded/neighboring rebar elements at birth
            for (const auto& truss : m_trusses) {
                if (truss.is_eroded || truss.node_ids[0] < 0 || truss.node_ids[1] < 0) continue;
                int n1_id = truss.node_ids[0];
                int n2_id = truss.node_ids[1];
                if (n1_id >= static_cast<int>(m_nodes.size()) || n2_id >= static_cast<int>(m_nodes.size())) continue;

                float x1[3] = { static_cast<float>(m_nodes[n1_id].x[0]), static_cast<float>(m_nodes[n1_id].x[1]), static_cast<float>(m_nodes[n1_id].x[2]) };
                float x2[3] = { static_cast<float>(m_nodes[n2_id].x[0]), static_cast<float>(m_nodes[n2_id].x[1]), static_cast<float>(m_nodes[n2_id].x[2]) };

                float ab[3] = { x2[0] - x1[0], x2[1] - x1[1], x2[2] - x1[2] };
                float L2 = ab[0]*ab[0] + ab[1]*ab[1] + ab[2]*ab[2];
                if (L2 < 1.0e-12f) continue;

                float ap[3] = { xp[0] - x1[0], xp[1] - x1[1], xp[2] - x1[2] };
                float t_proj = (ap[0]*ab[0] + ap[1]*ab[1] + ap[2]*ab[2]) / L2;
                if (t_proj < -0.1f || t_proj > 1.1f) continue;
                t_proj = std::clamp(t_proj, 0.0f, 1.0f);

                float xc[3] = { x1[0] + t_proj * ab[0], x1[1] + t_proj * ab[1], x1[2] + t_proj * ab[2] };
                float d_vec[3] = { xp[0] - xc[0], xp[1] - xc[1], xp[2] - xc[2] };
                float dist2 = d_vec[0]*d_vec[0] + d_vec[1]*d_vec[1] + d_vec[2]*d_vec[2];
                float dist = std::sqrt(dist2 > 1.0e-20f ? dist2 : 1.0e-20f);

                float r_rebar = std::sqrt(truss.A > 1.0e-12f ? (static_cast<float>(truss.A) / 3.14159265f) : 0.0001f);
                float min_clearance = r_rebar + h_p + 1.0e-4f;
                if (dist < min_clearance) {
                    if (dist > 1.0e-6f) {
                        float scale_push = min_clearance / dist;
                        xp[0] = xc[0] + d_vec[0] * scale_push;
                        xp[1] = xc[1] + d_vec[1] * scale_push;
                        xp[2] = xc[2] + d_vec[2] * scale_push;
                    } else {
                        float to_com[3] = { xp[0] - x_elem_com[0], xp[1] - x_elem_com[1], xp[2] - x_elem_com[2] };
                        float to_com_len = std::sqrt(to_com[0]*to_com[0] + to_com[1]*to_com[1] + to_com[2]*to_com[2]);
                        if (to_com_len > 1.0e-6f) {
                            xp[0] = xc[0] + (to_com[0] / to_com_len) * min_clearance;
                            xp[1] = xc[1] + (to_com[1] / to_com_len) * min_clearance;
                            xp[2] = xc[2] + (to_com[2] / to_com_len) * min_clearance;
                        } else {
                            xp[0] += min_clearance;
                        }
                    }
                }
            }

            for (const auto& beam : m_beams) {
                if (beam.is_eroded || beam.node_ids[0] < 0 || beam.node_ids[1] < 0) continue;
                int n1_id = beam.node_ids[0];
                int n2_id = beam.node_ids[1];
                if (n1_id >= static_cast<int>(m_nodes.size()) || n2_id >= static_cast<int>(m_nodes.size())) continue;

                float x1[3] = { static_cast<float>(m_nodes[n1_id].x[0]), static_cast<float>(m_nodes[n1_id].x[1]), static_cast<float>(m_nodes[n1_id].x[2]) };
                float x2[3] = { static_cast<float>(m_nodes[n2_id].x[0]), static_cast<float>(m_nodes[n2_id].x[1]), static_cast<float>(m_nodes[n2_id].x[2]) };

                float ab[3] = { x2[0] - x1[0], x2[1] - x1[1], x2[2] - x1[2] };
                float L2 = ab[0]*ab[0] + ab[1]*ab[1] + ab[2]*ab[2];
                if (L2 < 1.0e-12f) continue;

                float ap[3] = { xp[0] - x1[0], xp[1] - x1[1], xp[2] - x1[2] };
                float t_proj = (ap[0]*ab[0] + ap[1]*ab[1] + ap[2]*ab[2]) / L2;
                if (t_proj < -0.1f || t_proj > 1.1f) continue;
                t_proj = std::clamp(t_proj, 0.0f, 1.0f);

                float xc[3] = { x1[0] + t_proj * ab[0], x1[1] + t_proj * ab[1], x1[2] + t_proj * ab[2] };
                float d_vec[3] = { xp[0] - xc[0], xp[1] - xc[1], xp[2] - xc[2] };
                float dist2 = d_vec[0]*d_vec[0] + d_vec[1]*d_vec[1] + d_vec[2]*d_vec[2];
                float dist = std::sqrt(dist2 > 1.0e-20f ? dist2 : 1.0e-20f);

                float r_beam = std::sqrt(beam.A > 1.0e-12f ? (static_cast<float>(beam.A) / 3.14159265f) : 0.0001f);
                float min_clearance = r_beam + h_p + 1.0e-4f;
                if (dist < min_clearance) {
                    if (dist > 1.0e-6f) {
                        float scale_push = min_clearance / dist;
                        xp[0] = xc[0] + d_vec[0] * scale_push;
                        xp[1] = xc[1] + d_vec[1] * scale_push;
                        xp[2] = xc[2] + d_vec[2] * scale_push;
                    }
                }
            }

            MPMParticle3D p{};
            p.x[0] = xp[0]; p.x[1] = xp[1]; p.x[2] = xp[2];
            p.v[0] = vp[0]; p.v[1] = vp[1]; p.v[2] = vp[2];
            p.m = p_mass;
            p.V0 = p_vol;
            p.V = p_vol;
            p.lp[0] = h_p; p.lp[1] = h_p; p.lp[2] = h_p;
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = 0.0f;
                    p.B[r][c] = 0.0f;
                    p.L_grad[r][c] = 0.0f;
                }
            }
            p.ep_bar = static_cast<float>(elem.ep_bar);
            p.damage = 1.0f;
            p.temperature = static_cast<float>(elem.temperature);
            p.object_id = elem.mat_id;
            p.has_failed = true;
            out_particles.push_back(p);
        }
    }
}

template <typename T>
void FEMSolver3D<T>::updateNodeErosionStatus() {
    std::vector<int> active_elem_count(m_nodes.size(), 0);

    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        const int num_n = isTet4Element(elem) ? 4 : 8;
        for (int k = 0; k < num_n; ++k) {
            int nid = elem.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(m_nodes.size())) {
                active_elem_count[nid]++;
            }
        }
    }

    for (const auto& truss : m_trusses) {
        if (truss.is_eroded) continue;
        for (int k = 0; k < 2; ++k) {
            int nid = truss.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(m_nodes.size())) {
                active_elem_count[nid]++;
            }
        }
    }

    for (const auto& beam : m_beams) {
        if (beam.is_eroded) continue;
        for (int k = 0; k < 2; ++k) {
            int nid = beam.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(m_nodes.size())) {
                active_elem_count[nid]++;
            }
        }
    }

    bool node_eroded = false;
    for (size_t nid = 0; nid < m_nodes.size(); ++nid) {
        if (!m_nodes[nid].is_eroded && active_elem_count[nid] == 0) {
            m_nodes[nid].is_eroded = true;
            m_nodes[nid].v[0] = static_cast<T>(0.0f);
            m_nodes[nid].v[1] = static_cast<T>(0.0f);
            m_nodes[nid].v[2] = static_cast<T>(0.0f);
            m_nodes[nid].a[0] = static_cast<T>(0.0f);
            m_nodes[nid].a[1] = static_cast<T>(0.0f);
            m_nodes[nid].a[2] = static_cast<T>(0.0f);
            m_nodes[nid].f_int[0] = static_cast<T>(0.0f);
            m_nodes[nid].f_int[1] = static_cast<T>(0.0f);
            m_nodes[nid].f_int[2] = static_cast<T>(0.0f);
            m_nodes[nid].f_contact[0] = static_cast<T>(0.0f);
            m_nodes[nid].f_contact[1] = static_cast<T>(0.0f);
            m_nodes[nid].f_contact[2] = static_cast<T>(0.0f);
            node_eroded = true;
        }
    }

    if (node_eroded) {
        m_surface_facets_dirty = true;
    }
}

template <typename T>
void FEMSolver3D<T>::buildFaceConnectivity() {
    m_face_neighbors.assign(m_elements.size() * 6, -1);

    struct QuadKey {
        int n[4];
        bool operator==(const QuadKey& o) const {
            return n[0] == o.n[0] && n[1] == o.n[1] && n[2] == o.n[2] && n[3] == o.n[3];
        }
    };

    struct QuadHasher {
        std::size_t operator()(const QuadKey& k) const {
            std::size_t h = 0;
            for (int i = 0; i < 4; ++i) {
                h ^= std::hash<int>()(k.n[i]) + static_cast<std::size_t>(0x9e3779b9) + (h << 6) + (h >> 2);
            }
            return h;
        }
    };

    struct FaceRef {
        int elem_id;
        int face_id;
    };

    std::unordered_map<QuadKey, FaceRef, QuadHasher> face_map;
    face_map.reserve(m_elements.size() * 3);

    static const int HEX_FACES[6][4] = {
        {0, 3, 2, 1}, {4, 5, 6, 7}, {0, 1, 5, 4},
        {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 0, 4, 7}
    };
    static const int TET_FACES[4][3] = {
        {0, 2, 1}, {0, 1, 3}, {1, 2, 3}, {2, 0, 3}
    };

    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        const bool is_tet4 = isTet4Element(elem);
        const int num_faces = is_tet4 ? 4 : 6;
        for (int f = 0; f < num_faces; ++f) {
            QuadKey key;
            if (is_tet4) {
                key.n[0] = elem.node_ids[TET_FACES[f][0]];
                key.n[1] = elem.node_ids[TET_FACES[f][1]];
                key.n[2] = elem.node_ids[TET_FACES[f][2]];
                key.n[3] = -1;
            } else {
                for (int k = 0; k < 4; ++k) key.n[k] = elem.node_ids[HEX_FACES[f][k]];
            }
            std::sort(key.n, key.n + 4);

            auto it = face_map.find(key);
            if (it != face_map.end()) {
                int other_e = it->second.elem_id;
                int other_f = it->second.face_id;
                m_face_neighbors[e * 6 + f] = other_e;
                m_face_neighbors[other_e * 6 + other_f] = e;
            } else {
                face_map[key] = {e, f};
            }
        }
    }
}

template <typename T>
void FEMSolver3D<T>::extractBoundaryFacets() {
    m_surface_facets.clear();
    if (m_elements.empty()) {
        m_surface_facets_dirty = false;
        return;
    }

    if (m_face_neighbors.size() != m_elements.size() * 6) {
        buildFaceConnectivity();
    }

    static const int HEX_FACES[6][4] = {
        {0, 3, 2, 1}, {4, 5, 6, 7}, {0, 1, 5, 4},
        {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 0, 4, 7}
    };
    static const int TET_FACES[4][3] = {
        {0, 2, 1}, {0, 1, 3}, {1, 2, 3}, {2, 0, 3}
    };

    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        const bool is_tet4 = isTet4Element(elem);
        const int num_faces = is_tet4 ? 4 : 6;
        for (int f = 0; f < num_faces; ++f) {
            int neighbor = m_face_neighbors[e * 6 + f];
            bool is_boundary = (neighbor == -1 || m_elements[neighbor].is_eroded || elem.is_detached || m_elements[neighbor].is_detached);

            if (is_boundary) {
                FEMFacet3D<T> facet{};
                if (is_tet4) {
                    facet.node_ids[0] = elem.node_ids[TET_FACES[f][0]];
                    facet.node_ids[1] = elem.node_ids[TET_FACES[f][1]];
                    facet.node_ids[2] = elem.node_ids[TET_FACES[f][2]];
                    facet.node_ids[3] = facet.node_ids[2];
                } else {
                    for (int k = 0; k < 4; ++k) {
                        facet.node_ids[k] = elem.node_ids[HEX_FACES[f][k]];
                    }
                }
                facet.element_id = e;
                facet.part_id = elem.part_id;

                const auto& p0 = m_nodes[facet.node_ids[0]].x;
                const auto& p1 = m_nodes[facet.node_ids[1]].x;
                const auto& p2 = m_nodes[facet.node_ids[2]].x;
                const auto& p3 = m_nodes[facet.node_ids[3]].x;

                T v01[3] = {p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]};
                T v03[3] = {p3[0]-p0[0], p3[1]-p0[1], p3[2]-p0[2]};
                T n1[3] = {
                    v01[1]*v03[2] - v01[2]*v03[1],
                    v01[2]*v03[0] - v01[0]*v03[2],
                    v01[0]*v03[1] - v01[1]*v03[0]
                };

                T v23[3] = {p3[0]-p2[0], p3[1]-p2[1], p3[2]-p2[2]};
                T v21[3] = {p1[0]-p2[0], p1[1]-p2[1], p1[2]-p2[2]};
                T n2[3] = {
                    v23[1]*v21[2] - v23[2]*v21[1],
                    v23[2]*v21[0] - v23[0]*v21[2],
                    v23[0]*v21[1] - v23[1]*v21[0]
                };

                T n_sum[3] = {n1[0]+n2[0], n1[1]+n2[1], n1[2]+n2[2]};
                T mag = std::sqrt(n_sum[0]*n_sum[0] + n_sum[1]*n_sum[1] + n_sum[2]*n_sum[2]);
                if (mag > static_cast<T>(1.0e-12f)) {
                    facet.normal[0] = n_sum[0] / mag;
                    facet.normal[1] = n_sum[1] / mag;
                    facet.normal[2] = n_sum[2] / mag;
                    facet.area = static_cast<T>(0.5f) * mag;
                } else {
                    facet.normal[0] = 0.0f; facet.normal[1] = 0.0f; facet.normal[2] = 1.0f;
                    facet.area = 0.0f;
                }

                T margin = static_cast<T>(0.05f) * std::sqrt(facet.area > static_cast<T>(0.0f) ? facet.area : static_cast<T>(1.0e-4f));
                for (int c = 0; c < 3; ++c) {
                    facet.bbox_min[c] = std::min({p0[c], p1[c], p2[c], p3[c]}) - margin;
                    facet.bbox_max[c] = std::max({p0[c], p1[c], p2[c], p3[c]}) + margin;
                }

                m_surface_facets.push_back(facet);
            }
        }
    }

    m_surface_facets_dirty = false;
}

template <typename T>
void FEMSolver3D<T>::updateKinematicsCentralDifference(T dt) {
    (void)dt;
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        auto& node = m_nodes[nid];
        if (node.m <= static_cast<T>(1.0e-12f) || node.is_eroded) continue;

        for (int c = 0; c < 3; ++c) {
            if (node.is_fixed[c]) {
                node.v[c] = static_cast<T>(0.0f);
                node.a[c] = static_cast<T>(0.0f);
                continue;
            }

            T f_net = node.f_ext[c] - node.f_int[c] + node.f_contact[c];
            node.a[c] = f_net / node.m;
        }
    }
}

template <typename T>
void FEMSolver3D<T>::computeGlobalEnergy() {
    T e_kin = static_cast<T>(0.0f);
    T e_int = static_cast<T>(0.0f);
    T e_visc = static_cast<T>(0.0f);

#ifdef _OPENMP
    #pragma omp parallel for reduction(+:e_kin) schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        const auto& node = m_nodes[nid];
        T v2 = node.v[0]*node.v[0] + node.v[1]*node.v[1] + node.v[2]*node.v[2];
        e_kin += static_cast<T>(0.5f) * node.m * v2;
    }

#ifdef _OPENMP
    #pragma omp parallel for reduction(+:e_int, e_visc) schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        if (elem.is_eroded) continue;
        T s00 = elem.sigma[0][0]; T s11 = elem.sigma[1][1]; T s22 = elem.sigma[2][2];
        T s01 = elem.sigma[0][1]; T s12 = elem.sigma[1][2]; T s20 = elem.sigma[2][0];
        const auto& mat = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat.poissons_ratio);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));

        T s_dev00 = s00 - (s00+s11+s22)/3.0f;
        T s_dev11 = s11 - (s00+s11+s22)/3.0f;
        T s_dev22 = s22 - (s00+s11+s22)/3.0f;
        T p = (s00+s11+s22)/3.0f;

        T w_dev = (s_dev00*s_dev00 + s_dev11*s_dev11 + s_dev22*s_dev22 + 2.0f*(s01*s01 + s12*s12 + s20*s20)) / (4.0f * G);
        T w_vol = (p * p) / (2.0f * K);

        e_int += (w_dev + w_vol) * elem.V;
        e_visc += elem.q_visc * elem.V;
    }

    m_energy_tracker.E_kin = e_kin;
    m_energy_tracker.E_int = e_int;
    m_energy_tracker.E_visc = e_visc;
    m_energy_tracker.E_total = e_kin + e_int + e_visc;

    if (m_energy_tracker.E_0 <= static_cast<T>(1.0e-12f)) {
        m_energy_tracker.E_0 = m_energy_tracker.E_total > static_cast<T>(1.0e-12f) ? m_energy_tracker.E_total : static_cast<T>(1.0f);
    }
}

template <typename T>
T FEMSolver3D<T>::computeStepSize(T cfl) const {
    T min_dt = static_cast<T>(1.0e30f);

#ifdef _OPENMP
    #pragma omp parallel for reduction(min:min_dt) schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        T x_curr[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            x_curr[n][0] = m_nodes[nid].x[0];
            x_curr[n][1] = m_nodes[nid].x[1];
            x_curr[n][2] = m_nodes[nid].x[2];
        }
        T V_cur = elem.V > static_cast<T>(0.0f) ? elem.V : elem.V0;
        T L_e = isTet4Element(elem) ? computeTet4CharacteristicLength(x_curr, V_cur) : computeHex8CharacteristicLength(x_curr, V_cur);

        const auto& mat = m_material_tables[elem.mat_id];
        T v_rel = (elem.V0 > static_cast<T>(1.0e-18f)) ? (V_cur / elem.V0) : static_cast<T>(1.0f);
        T p_elem = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        T cd = computeDilatationalWaveSpeed<T>(mat, v_rel, elem.lambda, p_elem);

        T dt_e = cfl * (L_e / cd);
        if (dt_e > static_cast<T>(0.0f) && dt_e < min_dt) min_dt = dt_e;
    }

    for (const auto& truss : m_trusses) {
        if (truss.is_eroded || truss.L0 <= static_cast<T>(0.0f)) continue;
        const auto& mat = m_material_tables[truss.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
        T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
        T cd = std::sqrt(E / density);
        T dt_t = cfl * (truss.L0 / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f)));
        if (dt_t > static_cast<T>(0.0f) && dt_t < min_dt) min_dt = dt_t;
    }

    for (const auto& beam : m_beams) {
        if (beam.is_eroded || beam.L0 <= static_cast<T>(0.0f)) continue;
        const auto& mat = m_material_tables[beam.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
        T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
        T cd = std::sqrt(E / density);
        T dt_axial = beam.L0 / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));
        T d_val = beam.d > static_cast<T>(1e-6f) ? beam.d : static_cast<T>(0.012f);
        T dt_bending = (beam.L0 * beam.L0) / (static_cast<T>(3.464f) * d_val * cd);
        T dt_b = cfl * std::min(dt_axial, dt_bending);
        if (dt_b > static_cast<T>(0.0f) && dt_b < min_dt) min_dt = dt_b;
    }

    return (min_dt < static_cast<T>(1.0e30f)) ? min_dt : (m_last_dt > static_cast<T>(0.0f) ? m_last_dt : static_cast<T>(1.0e-6f));
}

template <typename T>
void FEMSolver3D<T>::stepWithDt(T dt) {
    m_last_dt = dt;
    m_sim_time += dt;
    m_step_count++;

    for (auto& det : m_detonators) {
        if (!det.fired && m_sim_time >= static_cast<T>(det.time_delay)) {
            igniteDetonator(static_cast<T>(det.x), static_cast<T>(det.y), static_cast<T>(det.z),
                            static_cast<T>(det.radius), det.target_part_id, static_cast<T>(det.time_delay));
            det.fired = true;
        }
    }

    // 1. Half-Step Velocity & Nodal Position Update (2nd-Order Velocity-Verlet)
    std::vector<std::array<T, 3>> v_half_list(m_nodes.size());
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        auto& node = m_nodes[nid];
        if (node.m <= static_cast<T>(1.0e-12f) || node.is_eroded) continue;
        for (int c = 0; c < 3; ++c) {
            if (node.is_fixed[c]) {
                node.v[c] = static_cast<T>(0.0f);
                node.a[c] = static_cast<T>(0.0f);
                v_half_list[nid][c] = static_cast<T>(0.0f);
                continue;
            }
            T v_h = node.v[c] + static_cast<T>(0.5f) * node.a[c] * dt;
            v_half_list[nid][c] = v_h;
            node.x[c] += v_h * dt;
            node.v[c] = v_h;
        }
    }

    // 2. Internal Element Forces, Rebar Truss/Beam Forces, and Contact Penalty Assembly at new positions x^{n+1}
    if (m_contact_penalty_scale > static_cast<T>(0.0f)) {
        FEMContact3D<T> contact_solver;
        contact_solver.setContactPenaltyScale(m_contact_penalty_scale);
        contact_solver.setFrictionCoefficients(m_friction_static, m_friction_kinetic);
        if (!getSurfaceFacets().empty()) {
            contact_solver.solveContact(*this, dt);
        }
        if (m_mpm_solver && !m_mpm_solver->getParticles().empty()) {
            contact_solver.solveMPMContact(*this, *m_mpm_solver, dt);
        }
    }

    computeElementForces(dt);
    computeTrussForces1D(dt);
    computeBeamForces3D(dt);
    updateKinematicsCentralDifference(dt);
    if (m_lysmer_params.enabled) {
        applyLysmerDashpots(dt);
    }
    updateRotationalKinematicsCentralDifference(dt);

    // 3. Complete 2nd-Order Full Velocity Update for step n+1
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        auto& node = m_nodes[nid];
        if (node.m <= static_cast<T>(1.0e-12f) || node.is_eroded) continue;
        for (int c = 0; c < 3; ++c) {
            if (node.is_fixed[c]) {
                node.v[c] = static_cast<T>(0.0f);
                node.a[c] = static_cast<T>(0.0f);
                continue;
            }
            node.v[c] = v_half_list[nid][c] + static_cast<T>(0.5f) * node.a[c] * dt;
        }

        T v_mag_sq = node.v[0]*node.v[0] + node.v[1]*node.v[1] + node.v[2]*node.v[2];
        T v_max_phys = static_cast<T>(10000.0f);
        if (v_mag_sq > v_max_phys * v_max_phys) {
            T scale = v_max_phys / std::sqrt(v_mag_sq);
            node.v[0] *= scale;
            node.v[1] *= scale;
            node.v[2] *= scale;
        }
    }

    evaluateErosionCriteria();
    if (m_step_count % 32 == 0 || m_step_count == 1) {
        computeGlobalEnergy();
    }
}

template <typename T>
void FEMSolver3D<T>::step(T cfl) {
    m_last_cfl = cfl;
    T dt = computeStepSize(cfl);
    stepWithDt(dt);
}

template <typename T>
void FEMSolver3D<T>::setNodeFixed(int node_idx, bool fix_x, bool fix_y, bool fix_z) {
    if (node_idx >= 0 && node_idx < static_cast<int>(m_nodes.size())) {
        m_nodes[node_idx].is_fixed[0] = fix_x;
        m_nodes[node_idx].is_fixed[1] = fix_y;
        m_nodes[node_idx].is_fixed[2] = fix_z;
    }
}

template <typename T>
void FEMSolver3D<T>::setNodalVelocity(int node_idx, T vx, T vy, T vz) {
    if (node_idx >= 0 && node_idx < static_cast<int>(m_nodes.size())) {
        m_nodes[node_idx].v[0] = vx;
        m_nodes[node_idx].v[1] = vy;
        m_nodes[node_idx].v[2] = vz;
    }
}

template <typename T>
void FEMSolver3D<T>::applyLysmerDashpots(T dt) {
    (void)dt;
    if (!m_lysmer_params.enabled) return;
    const auto& facets = getSurfaceFacets();
    if (facets.empty()) return;

    T rho = static_cast<T>(m_lysmer_params.rho);
    T cp = static_cast<T>(m_lysmer_params.c_p);
    T cs = static_cast<T>(m_lysmer_params.c_s);
    T norm_rel = static_cast<T>(m_lysmer_params.normal_relaxation);
    T shear_rel = static_cast<T>(m_lysmer_params.shear_relaxation);

    for (const auto& facet : facets) {
        if (facet.is_eroded) continue;

        if (m_lysmer_params.filter_box) {
            T cx = static_cast<T>(0.25f) * (m_nodes[facet.node_ids[0]].x[0] + m_nodes[facet.node_ids[1]].x[0] + m_nodes[facet.node_ids[2]].x[0] + m_nodes[facet.node_ids[3]].x[0]);
            T cy = static_cast<T>(0.25f) * (m_nodes[facet.node_ids[0]].x[1] + m_nodes[facet.node_ids[1]].x[1] + m_nodes[facet.node_ids[2]].x[1] + m_nodes[facet.node_ids[3]].x[1]);
            T cz = static_cast<T>(0.25f) * (m_nodes[facet.node_ids[0]].x[2] + m_nodes[facet.node_ids[1]].x[2] + m_nodes[facet.node_ids[2]].x[2] + m_nodes[facet.node_ids[3]].x[2]);
            T tol = static_cast<T>(m_lysmer_params.tol);

            bool on_bound = (std::abs(cx - static_cast<T>(m_lysmer_params.x_min)) <= tol) ||
                            (std::abs(cx - static_cast<T>(m_lysmer_params.x_max)) <= tol) ||
                            (std::abs(cy - static_cast<T>(m_lysmer_params.y_min)) <= tol) ||
                            (std::abs(cy - static_cast<T>(m_lysmer_params.y_max)) <= tol) ||
                            (std::abs(cz - static_cast<T>(m_lysmer_params.z_min)) <= tol) ||
                            (std::abs(cz - static_cast<T>(m_lysmer_params.z_max)) <= tol);
            if (!on_bound) continue;
        }

        T A_node = static_cast<T>(0.25f) * facet.area;
        T nx = facet.normal[0], ny = facet.normal[1], nz = facet.normal[2];

        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            auto& node = m_nodes[nid];
            if (node.is_eroded || node.m <= static_cast<T>(1.0e-12f)) continue;

            T vn = node.v[0] * nx + node.v[1] * ny + node.v[2] * nz;
            T vs_x = node.v[0] - vn * nx;
            T vs_y = node.v[1] - vn * ny;
            T vs_z = node.v[2] - vn * nz;

            T fn = - A_node * rho * cp * norm_rel * vn;
            T fs_x = - A_node * rho * cs * shear_rel * vs_x;
            T fs_y = - A_node * rho * cs * shear_rel * vs_y;
            T fs_z = - A_node * rho * cs * shear_rel * vs_z;

            node.a[0] += (fn * nx + fs_x) / node.m;
            node.a[1] += (fn * ny + fs_y) / node.m;
            node.a[2] += (fn * nz + fs_z) / node.m;
        }
    }
}

template <typename T>
T FEMSolver3D<T>::getMaxVelocity() const {
    T max_v = static_cast<T>(0.0f);
    for (const auto& node : m_nodes) {
        T v_mag = std::sqrt(node.v[0]*node.v[0] + node.v[1]*node.v[1] + node.v[2]*node.v[2]);
        if (v_mag > max_v) max_v = v_mag;
    }
    return max_v;
}

template <typename T>
T FEMSolver3D<T>::getMaxPlasticStrain() const {
    T max_ep = static_cast<T>(0.0f);
    for (const auto& elem : m_elements) {
        if (!elem.is_eroded && elem.ep_bar > max_ep) max_ep = elem.ep_bar;
    }
    return max_ep;
}

template <typename T>
T FEMSolver3D<T>::getMaxVonMisesStress() const {
    T max_vm = static_cast<T>(0.0f);
    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        T s00 = elem.sigma[0][0] - mean_s;
        T s11 = elem.sigma[1][1] - mean_s;
        T s22 = elem.sigma[2][2] - mean_s;
        T s01 = elem.sigma[0][1];
        T s12 = elem.sigma[1][2];
        T s20 = elem.sigma[2][0];

        T vm = std::sqrt(static_cast<T>(1.5f) * (s00*s00 + s11*s11 + s22*s22 + static_cast<T>(2.0f)*(s01*s01 + s12*s12 + s20*s20)));
        if (vm > max_vm) max_vm = vm;
    }
    return max_vm;
}

// Explicit Instantiations for Single and Double Precision
template class FEMSolver3D<float>;
template class FEMSolver3D<double>;

} // namespace Blast
