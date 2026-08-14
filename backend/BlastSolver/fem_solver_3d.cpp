#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
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

    T dx = lx / static_cast<T>(nx);
    T dy = ly / static_cast<T>(ny);
    T dz = lz / static_cast<T>(nz);

    int num_nodes_x = nx + 1;
    int num_nodes_y = ny + 1;
    int num_nodes_z = nz + 1;

    int base_node_idx = static_cast<int>(m_nodes.size());
    int base_elem_idx = static_cast<int>(m_elements.size());

    bool is_fixed_base = (boundary_condition == "Fixed Base");
    bool is_fixed_entire = (boundary_condition == "Fixed Entire");

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

                for (int g = 0; g < 8; ++g) {
                    std::memset(elem.F_gp[g], 0, sizeof(elem.F_gp[g]));
                    elem.F_gp[g][0][0] = 1.0f; elem.F_gp[g][1][1] = 1.0f; elem.F_gp[g][2][2] = 1.0f;
                    std::memset(elem.s_dev_gp[g], 0, sizeof(elem.s_dev_gp[g]));
                    elem.ep_bar_gp[g] = 0.0f;
                    elem.temp_gp[g] = 293.0f;
                    elem.damage_gp[g] = 0.0f;
                }

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
    static const int HEX8_EDGES[12][2] = {
        {0,1}, {1,2}, {2,3}, {3,0},
        {4,5}, {5,6}, {6,7}, {7,4},
        {0,4}, {1,5}, {2,6}, {3,7}
    };
    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        T h_min = static_cast<T>(1.0e30f);
        for (int e_edge = 0; e_edge < 12; ++e_edge) {
            int n1 = elem.node_ids[HEX8_EDGES[e_edge][0]];
            int n2 = elem.node_ids[HEX8_EDGES[e_edge][1]];
            T edx = m_nodes[n1].x[0] - m_nodes[n2].x[0];
            T edy = m_nodes[n1].x[1] - m_nodes[n2].x[1];
            T edz = m_nodes[n1].x[2] - m_nodes[n2].x[2];
            T len = std::sqrt(edx*edx + edy*edy + edz*edz);
            if (len < h_min) h_min = len;
        }

        const auto& mat_tb = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat_tb.youngs_modulus > 0.0f ? mat_tb.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat_tb.poissons_ratio);
        T density = static_cast<T>(mat_tb.density > 0.0f ? mat_tb.density : 7850.0f);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        T cd = std::sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);
        elem.dt0 = h_min / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));
    }
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

                for (int g = 0; g < 8; ++g) {
                    std::memset(elem.F_gp[g], 0, sizeof(elem.F_gp[g]));
                    elem.F_gp[g][0][0] = 1.0f; elem.F_gp[g][1][1] = 1.0f; elem.F_gp[g][2][2] = 1.0f;
                    std::memset(elem.s_dev_gp[g], 0, sizeof(elem.s_dev_gp[g]));
                    elem.ep_bar_gp[g] = 0.0f;
                    elem.temp_gp[g] = 293.0f;
                    elem.damage_gp[g] = 0.0f;
                }

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

                    for (int g = 0; g < 8; ++g) {
                        std::memset(elem.F_gp[g], 0, sizeof(elem.F_gp[g]));
                        elem.F_gp[g][0][0] = 1.0f; elem.F_gp[g][1][1] = 1.0f; elem.F_gp[g][2][2] = 1.0f;
                        std::memset(elem.s_dev_gp[g], 0, sizeof(elem.s_dev_gp[g]));
                        elem.ep_bar_gp[g] = 0.0f;
                        elem.temp_gp[g] = 293.0f;
                        elem.damage_gp[g] = 0.0f;
                    }

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
    static const int HEX8_EDGES[12][2] = {
        {0,1}, {1,2}, {2,3}, {3,0},
        {4,5}, {5,6}, {6,7}, {7,4},
        {0,4}, {1,5}, {2,6}, {3,7}
    };
    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
        T h_min = static_cast<T>(1.0e30f);
        for (int e_edge = 0; e_edge < 12; ++e_edge) {
            int n1 = elem.node_ids[HEX8_EDGES[e_edge][0]];
            int n2 = elem.node_ids[HEX8_EDGES[e_edge][1]];
            T edx = m_nodes[n1].x[0] - m_nodes[n2].x[0];
            T edy = m_nodes[n1].x[1] - m_nodes[n2].x[1];
            T edz = m_nodes[n1].x[2] - m_nodes[n2].x[2];
            T len = std::sqrt(edx*edx + edy*edy + edz*edz);
            if (len < h_min) h_min = len;
        }

        const auto& mat_tb = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat_tb.youngs_modulus > 0.0f ? mat_tb.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat_tb.poissons_ratio);
        T density = static_cast<T>(mat_tb.density > 0.0f ? mat_tb.density : 7850.0f);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        T cd = std::sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);
        elem.dt0 = h_min / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));
    }
}

template <typename T>
void FEMSolver3D<T>::setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat) {
    m_nodes.clear();
    m_elements.clear();
    m_material_tables.clear();
    m_next_part_id = 1;
    appendNodesAndElements(nodes, elements, mat);
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
        elem.mat_id = mat_id;
        elem.part_id = part_id;
        m_elements.push_back(elem);
    }

    for (size_t e = base_elem_idx; e < m_elements.size(); ++e) {
        auto& elem = m_elements[e];
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

        for (int g = 0; g < 8; ++g) {
            std::memset(elem.F_gp[g], 0, sizeof(elem.F_gp[g]));
            elem.F_gp[g][0][0] = 1.0f; elem.F_gp[g][1][1] = 1.0f; elem.F_gp[g][2][2] = 1.0f;
            std::memset(elem.s_dev_gp[g], 0, sizeof(elem.s_dev_gp[g]));
            elem.ep_bar_gp[g] = 0.0f;
            elem.temp_gp[g] = 293.0f;
            elem.damage_gp[g] = 0.0f;
        }

        T h_min = static_cast<T>(1.0e30f);
        for (int e_edge = 0; e_edge < 12; ++e_edge) {
            int n1 = elem.node_ids[HEX8_EDGES[e_edge][0]];
            int n2 = elem.node_ids[HEX8_EDGES[e_edge][1]];
            T edx = m_nodes[n1].x[0] - m_nodes[n2].x[0];
            T edy = m_nodes[n1].x[1] - m_nodes[n2].x[1];
            T edz = m_nodes[n1].x[2] - m_nodes[n2].x[2];
            T len = std::sqrt(edx*edx + edy*edy + edz*edz);
            if (len < h_min) h_min = len;
        }

        const auto& mat_tb = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat_tb.youngs_modulus > 0.0f ? mat_tb.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat_tb.poissons_ratio);
        T density = static_cast<T>(mat_tb.density > 0.0f ? mat_tb.density : 7850.0f);
        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        T cd = std::sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);
        elem.dt0 = h_min / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));
    }

    m_surface_facets_dirty = true;
    computeLumpedMasses();
    extractBoundaryFacets();
    computeGlobalEnergy();
}

template <typename T>
void FEMSolver3D<T>::computeLumpedMasses() {
    for (auto& node : m_nodes) {
        node.m = static_cast<T>(0.0f);
    }

    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        T density = (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(m_material_tables.size()))
                    ? static_cast<T>(m_material_tables[elem.mat_id].density)
                    : static_cast<T>(7850.0f);
        T elem_mass = density * elem.V0;
        T node_mass = elem_mass / static_cast<T>(8.0f);

        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            m_nodes[nid].m += node_mass;
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
    if (elem.is_eroded || m_hourglass_coeff <= static_cast<T>(1.0e-6)) return;

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
#else
                m_nodes[nid].f_int[c] += f_hg;
#endif
            }
        }
    }
}

template <typename T>
void FEMSolver3D<T>::computeElementForces(T dt) {
    // Reset internal nodal forces
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (int nid = 0; nid < static_cast<int>(m_nodes.size()); ++nid) {
        m_nodes[nid].f_int[0] = static_cast<T>(0.0f);
        m_nodes[nid].f_int[1] = static_cast<T>(0.0f);
        m_nodes[nid].f_int[2] = static_cast<T>(0.0f);
    }

#ifdef _OPENMP
    #pragma omp parallel for schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        const auto& mat = m_material_tables[elem.mat_id];
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

        if (m_integration_scheme == FEMIntegrationScheme::FullGauss8 || m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
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
                elem.is_eroded = true;
                m_surface_facets_dirty = true;
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
                    elem.is_eroded = true;
                    m_surface_facets_dirty = true;
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

                T h_e_g = std::cbrt(detJ_g * static_cast<T>(8.0f));
                T q_visc_g = (div_v_g < static_cast<T>(0.0f))
                           ? (density * (-b1 * h_e_g * div_v_g * cd + b2 * h_e_g * h_e_g * div_v_g * div_v_g))
                           : static_cast<T>(0.0f);

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

                T ep_val_g = std::max(static_cast<T>(0.0f), elem.ep_bar_gp[g]);
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
                    T T_star_g = (elem.temp_gp[g] - T_room_g) / (T_melt_g - T_room_g);
                    T_star_g = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), T_star_g));
                    thermal_factor_g = static_cast<T>(1.0f) - std::pow(T_star_g, m_exp_g);
                    if (thermal_factor_g < static_cast<T>(0.01f)) thermal_factor_g = static_cast<T>(0.01f);
                }
                dynamic_yield_g = std::max(static_cast<T>(1.0e6f), sigma_hard_g * strain_rate_factor_g * thermal_factor_g);

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
                                s_temp[r][c] += R_dt_g[r][k] * elem.s_dev_gp[g][k][c];
                            }
                        }
                    }
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            elem.s_dev_gp[g][r][c] = static_cast<T>(0.0f);
                            for (int k = 0; k < 3; ++k) {
                                elem.s_dev_gp[g][r][c] += s_temp[r][k] * R_dt_g[c][k];
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
                            F_new_g[r][c] += I_plus_Ldt_g[r][k] * elem.F_gp[g][k][c];
                        }
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.F_gp[g][r][c] = F_new_g[r][c];
                    }
                }

                T vol_strain_g = 0.0f;
                if (m_integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
                    T F_det = elem.F[0][0] * (elem.F[1][1]*elem.F[2][2] - elem.F[1][2]*elem.F[2][1])
                            - elem.F[0][1] * (elem.F[1][0]*elem.F[2][2] - elem.F[1][2]*elem.F[2][0])
                            + elem.F[0][2] * (elem.F[1][0]*elem.F[2][1] - elem.F[1][1]*elem.F[2][0]);
                    vol_strain_g = F_det - static_cast<T>(1.0f);
                } else {
                    T F_det = elem.F_gp[g][0][0] * (elem.F_gp[g][1][1]*elem.F_gp[g][2][2] - elem.F_gp[g][1][2]*elem.F_gp[g][2][1])
                            - elem.F_gp[g][0][1] * (elem.F_gp[g][1][0]*elem.F_gp[g][2][2] - elem.F_gp[g][1][2]*elem.F_gp[g][2][0])
                            + elem.F_gp[g][0][2] * (elem.F_gp[g][1][0]*elem.F_gp[g][2][1] - elem.F_gp[g][1][1]*elem.F_gp[g][2][0]);
                    vol_strain_g = F_det - static_cast<T>(1.0f);
                }
                if (std::abs(vol_strain_g) < static_cast<T>(1.0e-6f)) {
                    vol_strain_g = static_cast<T>(0.0f);
                }
                
                // Mie-Grueneisen Shock EOS Hydrostatic Pressure
                T p_hydro_g = static_cast<T>(0.0f);
                if (mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
                    T c0 = static_cast<T>(mat.mg_c0);
                    T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
                    T gamma0 = static_cast<T>(mat.mg_gamma0);
                    T mu = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
                         ? (elem.V0 / elem.V - static_cast<T>(1.0f))
                         : static_cast<T>(0.0f);
                    T E_v = density * (mat.Cp > 0.0f ? mat.Cp : 477.0f) * (elem.temp_gp[g] - (mat.T_room > 0.0f ? mat.T_room : 293.0f));
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
                        elem.s_dev_gp[g][r][c] += static_cast<T>(2.0f) * G * d_dev_g[r][c] * dt;
                    }
                }

                if (mat.material_model == MPMMaterialModel::RHTConcrete) {
                    RHTStateVariables<T> rht_state;
                    rht_state.damage = elem.damage_gp[g];
                    rht_state.ep_bar = elem.ep_bar_gp[g];
                    rht_state.p_hydro = p_hydro_g;
                    updateRHTStress<T>(
                        elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
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
                    elem.damage_gp[g] = rht_state.damage;
                    elem.ep_bar_gp[g] = rht_state.ep_bar;
                    p_hydro_g = rht_state.p_hydro;
                } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
                    KCStateVariables<T> kc_state;
                    kc_state.damage = elem.damage_gp[g];
                    kc_state.lambda = elem.lambda_gp[g];
                    kc_state.ep_bar = elem.ep_bar_gp[g];
                    kc_state.p_hydro = p_hydro_g;
                    updateKCStress<T>(
                        elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
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
                    elem.damage_gp[g] = kc_state.damage;
                    elem.lambda_gp[g] = kc_state.lambda;
                    elem.ep_bar_gp[g] = kc_state.ep_bar;
                    p_hydro_g = kc_state.p_hydro;
                } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
                    CSCMStateVariables<T> cscm_state;
                    cscm_state.damage = elem.damage_gp[g];
                    cscm_state.kappa = elem.lambda_gp[g];
                    cscm_state.ep_bar = elem.ep_bar_gp[g];
                    cscm_state.p_hydro = p_hydro_g;
                    updateCSCMStress<T>(
                        elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
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
                    elem.damage_gp[g] = cscm_state.damage;
                    elem.lambda_gp[g] = cscm_state.kappa;
                    elem.ep_bar_gp[g] = cscm_state.ep_bar;
                    p_hydro_g = cscm_state.p_hydro;
                } else {
                    T s_norm_g = std::sqrt(
                        elem.s_dev_gp[g][0][0]*elem.s_dev_gp[g][0][0] + elem.s_dev_gp[g][1][1]*elem.s_dev_gp[g][1][1] + elem.s_dev_gp[g][2][2]*elem.s_dev_gp[g][2][2] +
                        static_cast<T>(2.0f)*(elem.s_dev_gp[g][0][1]*elem.s_dev_gp[g][0][1] + elem.s_dev_gp[g][1][2]*elem.s_dev_gp[g][1][2] + elem.s_dev_gp[g][2][0]*elem.s_dev_gp[g][2][0])
                    );
                    T vm_trial_g = std::sqrt(static_cast<T>(1.5f)) * s_norm_g;

                    if (vm_trial_g > dynamic_yield_g && vm_trial_g > static_cast<T>(1.0e-6f)) {
                        T scale = dynamic_yield_g / vm_trial_g;
                        T d_ep = (vm_trial_g - dynamic_yield_g) / (static_cast<T>(3.0f) * G + static_cast<T>(mat.hardening_modulus));
                        elem.ep_bar_gp[g] += d_ep;
                        for (int r = 0; r < 3; ++r) {
                            for (int c = 0; c < 3; ++c) {
                                elem.s_dev_gp[g][r][c] *= scale;
                            }
                        }
                        T plastic_work = dynamic_yield_g * d_ep;
                        T chi = m_physics_params.taylor_quinney_factor;
                        T Cp = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 477.0f);
                        elem.temp_gp[g] += (chi * plastic_work) / (density * Cp);
                    }
                }

                T eta_shear_g = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e_g;
                T sigma_g[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        sigma_g[r][c] = elem.s_dev_gp[g][r][c] + static_cast<T>(2.0f) * eta_shear_g * d_dev_g[r][c] - (r == c ? p_hydro_g : static_cast<T>(0.0f));
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
                        s_dev_avg[r][c] += 0.125f * elem.s_dev_gp[g][r][c];
                    }
                }
                ep_bar_avg += 0.125f * elem.ep_bar_gp[g];
                temp_avg += 0.125f * elem.temp_gp[g];
                damage_avg += 0.125f * elem.damage_gp[g];
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
            elem.lambda = elem.lambda_gp[0];
            elem.V = V_sum;

            T F_avg[3][3] = {{0.0f}};
            for (int g = 0; g < 8; ++g) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        F_avg[r][c] += 0.125f * elem.F_gp[g][r][c];
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


        T B[6][24], detJ;
        computeHex8BMatrix(x_mid, B, detJ);
        
        T min_vol_r = m_erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? m_erosion_criteria.min_volume_ratio : static_cast<T>(0.02f);
        if (detJ <= static_cast<T>(1.0e-15f) || (elem.V0 > static_cast<T>(1.0e-18f) && (detJ * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
            elem.is_eroded = true;
            m_surface_facets_dirty = true;
            continue; // Skip force generation for inverted or severely crushed elements
        }
        
        elem.V = detJ * static_cast<T>(8.0f);

        T v_center[3] = {0.0f, 0.0f, 0.0f};
        for (int n = 0; n < 8; ++n) {
            v_center[0] += v_nodes[n][0];
            v_center[1] += v_nodes[n][1];
            v_center[2] += v_nodes[n][2];
        }
        v_center[0] *= static_cast<T>(0.125f);
        v_center[1] *= static_cast<T>(0.125f);
        v_center[2] *= static_cast<T>(0.125f);

        T v_vec[24];
        for (int n = 0; n < 8; ++n) {
            v_vec[n * 3 + 0] = v_nodes[n][0] - v_center[0];
            v_vec[n * 3 + 1] = v_nodes[n][1] - v_center[1];
            v_vec[n * 3 + 2] = v_nodes[n][2] - v_center[2];
        }

        T strain_rate[6] = {0.0f};
        for (int r = 0; r < 6; ++r) {
            for (int c = 0; c < 24; ++c) {
                strain_rate[r] += B[r][c] * v_vec[c];
            }
        }

        T div_v = strain_rate[0] + strain_rate[1] + strain_rate[2];
        if (std::abs(div_v) * dt < static_cast<T>(1.0e-6f)) {
            div_v = static_cast<T>(0.0f);
        }

        T h_e = std::cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
        cd = std::sqrt((K + static_cast<T>(4.0f) / static_cast<T>(3.0f) * G) / density);
        b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : m_physics_params.bulk_viscosity_b1);
        b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : m_physics_params.bulk_viscosity_b2);

        T q_visc = (div_v < static_cast<T>(0.0f))
                 ? (density * (-b1 * h_e * div_v * cd + b2 * h_e * h_e * div_v * div_v))
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
        dynamic_yield = std::max(static_cast<T>(1.0e6f), sigma_hard * strain_rate_factor * thermal_factor);

        T dN_dx[8][3];
        for (int i = 0; i < 8; ++i) {
            dN_dx[i][0] = B[0][i * 3 + 0];
            dN_dx[i][1] = B[1][i * 3 + 1];
            dN_dx[i][2] = B[2][i * 3 + 2];
        }

        // 1. Calculate Velocity Gradient Tensor L[3][3]
        T L[3][3] = {{static_cast<T>(0.0f)}};
        for (int i = 0; i < 8; ++i) {
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

        T vol_strain = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0 - static_cast<T>(1.0f)) : static_cast<T>(0.0f);
        if (std::abs(vol_strain) < static_cast<T>(1.0e-6f)) {
            vol_strain = static_cast<T>(0.0f);
        }

        // Mie-Grueneisen Shock EOS Hydrostatic Pressure
        T p_hydro = static_cast<T>(0.0f);
        if (mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
            T c0 = static_cast<T>(mat.mg_c0);
            T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
            T gamma0 = static_cast<T>(mat.mg_gamma0);
            T mu = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
                 ? (elem.V0 / elem.V - static_cast<T>(1.0f))
                 : static_cast<T>(0.0f);
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

        T eta_shear = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e;
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
        for (int r = 0; r < 24; ++r) {
            for (int c = 0; c < 6; ++c) {
                f_elem[r] += B[c][r] * sig_voigt[c] * elem.V;
            }
        }

        for (int n = 0; n < 8; ++n) {
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

        computeHourglassForcesFB(elem, dt, x_nodes, v_nodes, B, dN_dx, detJ, cd, h_e);
    }
}

template <typename T>
void FEMSolver3D<T>::evaluateErosionCriteria() {
    bool erosion_occurred = false;

#ifdef _OPENMP
    #pragma omp parallel for schedule(guided)
#endif
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        T h_min = std::cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
        const auto& mat = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat.poissons_ratio);
        T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);

        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        T cd = std::sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);
        T current_dt = h_min / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));

        bool newly_eroded = false;
        T min_vol_r = m_erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? m_erosion_criteria.min_volume_ratio : static_cast<T>(0.02f);
        if (elem.V <= static_cast<T>(1.0e-18f) || (elem.V0 > static_cast<T>(1.0e-18f) && (elem.V / elem.V0) <= min_vol_r)) {
            newly_eroded = true;
        }

        if (mat.enable_timestep_erosion && mat.timestep_erosion_factor > static_cast<T>(1.0e-5f)) {
            T eta = static_cast<T>(mat.timestep_erosion_factor > 0.0f ? mat.timestep_erosion_factor : m_erosion_criteria.timestep_erosion_factor);
            if (current_dt <= eta * elem.dt0) {
                newly_eroded = true;
            }
        }

        if (mat.enable_strain_erosion) {
            T fail_strain = static_cast<T>(mat.erosion_strain > 0.0f ? mat.erosion_strain : (mat.failure_strain > 0.0f ? mat.failure_strain : m_erosion_criteria.failure_strain));
            if (fail_strain > static_cast<T>(0.0f) && elem.ep_bar >= fail_strain) {
                newly_eroded = true;
            }
        }

        if (mat.enable_stress_erosion) {
            T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
            T fail_stress = static_cast<T>(mat.erosion_stress > 0.0f ? mat.erosion_stress : (mat.tensile_failure_stress > 0.0f ? mat.tensile_failure_stress : m_erosion_criteria.tensile_failure_stress));
            if (fail_stress > static_cast<T>(0.0f) && mean_s >= fail_stress) {
                newly_eroded = true;
            }
        }

        if (newly_eroded) {
            elem.is_eroded = true;
            std::memset(elem.sigma, 0, sizeof(elem.sigma));
            std::memset(elem.s_dev, 0, sizeof(elem.s_dev));
            erosion_occurred = true;
        }
    }

    if (erosion_occurred) {
        m_surface_facets_dirty = true;
    }
    updateNodeErosionStatus();
}

template <typename T>
void FEMSolver3D<T>::updateNodeErosionStatus() {
    std::vector<int> active_elem_count(m_nodes.size(), 0);

    for (const auto& elem : m_elements) {
        if (elem.is_eroded) continue;
        for (int k = 0; k < 8; ++k) {
            int nid = elem.node_ids[k];
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
void FEMSolver3D<T>::extractBoundaryFacets() {
    if (!m_surface_facets_dirty && !m_surface_facets.empty()) return;
    m_surface_facets.clear();

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

    std::unordered_map<QuadKey, int, QuadHasher> quad_counts;
    quad_counts.reserve(m_elements.size() * 3);

    static const int HEX_FACES[6][4] = {
        {0, 3, 2, 1}, {4, 5, 6, 7}, {0, 1, 5, 4},
        {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 0, 4, 7}
    };

    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        for (int f = 0; f < 6; ++f) {
            QuadKey key;
            for (int k = 0; k < 4; ++k) key.n[k] = elem.node_ids[HEX_FACES[f][k]];
            std::sort(key.n, key.n + 4);
            quad_counts[key]++;
        }
    }

    // Unique boundary faces (count == 1)
    for (int e = 0; e < static_cast<int>(m_elements.size()); ++e) {
        const auto& elem = m_elements[e];
        if (elem.is_eroded) continue;

        for (int f = 0; f < 6; ++f) {
            QuadKey key;
            for (int k = 0; k < 4; ++k) key.n[k] = elem.node_ids[HEX_FACES[f][k]];
            std::sort(key.n, key.n + 4);

            if (quad_counts[key] == 1) {
                FEMFacet3D<T> facet{};
                for (int k = 0; k < 4; ++k) facet.node_ids[k] = elem.node_ids[HEX_FACES[f][k]];
                facet.element_id = e;
                facet.part_id = elem.part_id;
                facet.is_eroded = false;

                // Compute normal & area using unbiased diagonal cross product (v2 - v0) x (v3 - v1)
                T v0[3] = {m_nodes[facet.node_ids[0]].x[0], m_nodes[facet.node_ids[0]].x[1], m_nodes[facet.node_ids[0]].x[2]};
                T v1[3] = {m_nodes[facet.node_ids[1]].x[0], m_nodes[facet.node_ids[1]].x[1], m_nodes[facet.node_ids[1]].x[2]};
                T v2[3] = {m_nodes[facet.node_ids[2]].x[0], m_nodes[facet.node_ids[2]].x[1], m_nodes[facet.node_ids[2]].x[2]};
                T v3[3] = {m_nodes[facet.node_ids[3]].x[0], m_nodes[facet.node_ids[3]].x[1], m_nodes[facet.node_ids[3]].x[2]};

                T min_fx = std::min({v0[0], v1[0], v2[0], v3[0]});
                T max_fx = std::max({v0[0], v1[0], v2[0], v3[0]});
                T min_fy = std::min({v0[1], v1[1], v2[1], v3[1]});
                T max_fy = std::max({v0[1], v1[1], v2[1], v3[1]});
                T min_fz = std::min({v0[2], v1[2], v2[2], v3[2]});
                T max_fz = std::max({v0[2], v1[2], v2[2], v3[2]});

                T d1[3] = {v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]};
                T d2[3] = {v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2]};

                facet.normal[0] = d1[1]*d2[2] - d1[2]*d2[1];
                facet.normal[1] = d1[2]*d2[0] - d1[0]*d2[2];
                facet.normal[2] = d1[0]*d2[1] - d1[1]*d2[0];

                T norm = std::sqrt(facet.normal[0]*facet.normal[0] + facet.normal[1]*facet.normal[1] + facet.normal[2]*facet.normal[2]);
                if (norm > static_cast<T>(1.0e-12f)) {
                    facet.normal[0] /= norm;
                    facet.normal[1] /= norm;
                    facet.normal[2] /= norm;
                    facet.area = static_cast<T>(0.5f) * norm;
                }

                T h_elem = std::sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
                T margin = static_cast<T>(0.8f) * h_elem;
                facet.bbox_min[0] = min_fx - margin;
                facet.bbox_min[1] = min_fy - margin;
                facet.bbox_min[2] = min_fz - margin;
                facet.bbox_max[0] = max_fx + margin;
                facet.bbox_max[1] = max_fy + margin;
                facet.bbox_max[2] = max_fz + margin;

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

        T mean_s = (s00 + s11 + s22) / static_cast<T>(3.0f);
        T dev00 = s00 - mean_s; T dev11 = s11 - mean_s; T dev22 = s22 - mean_s;

        T strain_e = (mean_s * mean_s) / (static_cast<T>(2.0f) * K) +
                     (dev00*dev00 + dev11*dev11 + dev22*dev22 + static_cast<T>(2.0f)*(s01*s01 + s12*s12 + s20*s20)) / (static_cast<T>(4.0f) * G);

        e_int += strain_e * elem.V;
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

        static const int HEX8_EDGES_LOCAL[12][2] = {
            {0,1}, {1,2}, {2,3}, {3,0},
            {4,5}, {5,6}, {6,7}, {7,4},
            {0,4}, {1,5}, {2,6}, {3,7}
        };
        T h_min_sq = static_cast<T>(1.0e30f);
        for (int e_edge = 0; e_edge < 12; ++e_edge) {
            int n1 = elem.node_ids[HEX8_EDGES_LOCAL[e_edge][0]];
            int n2 = elem.node_ids[HEX8_EDGES_LOCAL[e_edge][1]];
            T edx = m_nodes[n1].x[0] - m_nodes[n2].x[0];
            T edy = m_nodes[n1].x[1] - m_nodes[n2].x[1];
            T edz = m_nodes[n1].x[2] - m_nodes[n2].x[2];
            T len_sq = edx*edx + edy*edy + edz*edz;
            if (len_sq < h_min_sq) h_min_sq = len_sq;
        }
        T h_min = std::sqrt(h_min_sq);

        const auto& mat = m_material_tables[elem.mat_id];
        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
        T nu = static_cast<T>(mat.poissons_ratio);
        T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);

        T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
        T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
        if (mat.material_model == MPMMaterialModel::RHTConcrete || mat.material_model == MPMMaterialModel::KCConcrete || mat.material_model == MPMMaterialModel::CSCMConcrete) {
            K *= static_cast<T>(1.6f); // Account for compacted solid stiffness
        }
        T cd = std::sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);

        T dt_e = cfl * (h_min / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f)));
        if (dt_e > static_cast<T>(0.0f) && dt_e < min_dt) min_dt = dt_e;
    }

    return (min_dt < static_cast<T>(1.0e30f)) ? min_dt : (m_last_dt > static_cast<T>(0.0f) ? m_last_dt : static_cast<T>(1.0e-6f));
}

template <typename T>
void FEMSolver3D<T>::stepWithDt(T dt) {
    m_last_dt = dt;
    m_sim_time += dt;
    m_step_count++;

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

    // 2. Internal Element Forces and Contact Penalty Assembly at new positions x^{n+1}
    if (m_contact_penalty_scale > static_cast<T>(0.0f) && !getSurfaceFacets().empty()) {
        FEMContact3D<T> contact_solver;
        contact_solver.setContactPenaltyScale(m_contact_penalty_scale);
        contact_solver.setFrictionCoefficients(m_friction_static, m_friction_kinetic);
        contact_solver.solveContact(*this, dt);
    }

    computeElementForces(dt);
    updateKinematicsCentralDifference(dt);

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
