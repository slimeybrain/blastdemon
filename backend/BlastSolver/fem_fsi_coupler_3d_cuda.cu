#include "fem_fsi_coupler_3d_cuda.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "ImmersedBoundary.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <device_launch_parameters.h>
#include <cmath>
#include <iostream>

namespace Blast {

// CUDA Kernel: Zero external forces on all FEM structural nodes
template <typename T>
__global__ void kernel_zero_fem_ext_forces_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    d_nodes[idx].f_ext[0] = static_cast<T>(0.0f);
    d_nodes[idx].f_ext[1] = static_cast<T>(0.0f);
    d_nodes[idx].f_ext[2] = static_cast<T>(0.0f);
}

// CUDA Kernel: Rasterize moving FEM solid volumetric elements into Eulerian CFD Geometry Tiles
template <typename T>
__global__ void kernel_rasterize_fem_elements_to_geom_3d(
    const FEMNode3D<T>* __restrict__ d_nodes,
    const FEMElement3D<T>* __restrict__ d_elements,
    int num_elements,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    const FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded) return;

    Point3D v[8];
    float avg_vx = 0.0f, avg_vy = 0.0f, avg_vz = 0.0f;
    float el_xmin = 1e30f, el_xmax = -1e30f;
    float el_ymin = 1e30f, el_ymax = -1e30f;
    float el_zmin = 1e30f, el_zmax = -1e30f;

    #pragma unroll
    for (int k = 0; k < 8; ++k) {
        int nid = elem.node_ids[k];
        v[k] = { static_cast<float>(d_nodes[nid].x[0]), static_cast<float>(d_nodes[nid].x[1]), static_cast<float>(d_nodes[nid].x[2]) };
        avg_vx += static_cast<float>(d_nodes[nid].v[0]);
        avg_vy += static_cast<float>(d_nodes[nid].v[1]);
        avg_vz += static_cast<float>(d_nodes[nid].v[2]);

        if (v[k].x < el_xmin) el_xmin = v[k].x;
        if (v[k].x > el_xmax) el_xmax = v[k].x;
        if (v[k].y < el_ymin) el_ymin = v[k].y;
        if (v[k].y > el_ymax) el_ymax = v[k].y;
        if (v[k].z < el_zmin) el_zmin = v[k].z;
        if (v[k].z > el_zmax) el_zmax = v[k].z;
    }
    avg_vx *= 0.125f;
    avg_vy *= 0.125f;
    avg_vz *= 0.125f;

    int imin = max(0, min(nx - 1, static_cast<int>(floorf((el_xmin - xmin) / dx))));
    int imax = max(0, min(nx - 1, static_cast<int>(ceilf((el_xmax - xmin) / dx))));
    int jmin = max(0, min(ny - 1, static_cast<int>(floorf((el_ymin - ymin) / dy))));
    int jmax = max(0, min(ny - 1, static_cast<int>(ceilf((el_ymax - ymin) / dy))));
    int kmin = max(0, min(nz - 1, static_cast<int>(floorf((el_zmin - zmin) / dz))));
    int kmax = max(0, min(nz - 1, static_cast<int>(ceilf((el_zmax - zmin) / dz))));

    const int faces[6][4] = {
        { 0, 3, 2, 1 }, // bottom (-zeta)
        { 4, 5, 6, 7 }, // top (+zeta)
        { 0, 1, 5, 4 }, // front (-eta)
        { 1, 2, 6, 5 }, // right (+xi)
        { 2, 3, 7, 6 }, // back (+eta)
        { 3, 0, 4, 7 }  // left (-xi)
    };

    Point3D face_normals[6];
    Point3D face_centers[6];

    #pragma unroll
    for (int f = 0; f < 6; ++f) {
        Point3D p0 = v[faces[f][0]];
        Point3D p1 = v[faces[f][1]];
        Point3D p2 = v[faces[f][2]];
        Point3D p3 = v[faces[f][3]];

        face_centers[f] = {
            0.25f * (p0.x + p1.x + p2.x + p3.x),
            0.25f * (p0.y + p1.y + p2.y + p3.y),
            0.25f * (p0.z + p1.z + p2.z + p3.z)
        };

        float d10_x = p1.x - p0.x, d10_y = p1.y - p0.y, d10_z = p1.z - p0.z;
        float d30_x = p3.x - p0.x, d30_y = p3.y - p0.y, d30_z = p3.z - p0.z;
        face_normals[f] = {
            d10_y * d30_z - d10_z * d30_y,
            d10_z * d30_x - d10_x * d30_z,
            d10_x * d30_y - d10_y * d30_x
        };
    }

    for (int k = kmin; k <= kmax; ++k) {
        float cz = zmin + (k + 0.5f) * dz;
        for (int j = jmin; j <= jmax; ++j) {
            float cy = ymin + (j + 0.5f) * dy;
            for (int i = imin; i <= imax; ++i) {
                float cx = xmin + (i + 0.5f) * dx;

                bool inside = true;
                #pragma unroll
                for (int f = 0; f < 6; ++f) {
                    float dot = (cx - face_centers[f].x) * face_normals[f].x +
                                (cy - face_centers[f].y) * face_normals[f].y +
                                (cz - face_centers[f].z) * face_normals[f].z;
                    if (dot > 1.0e-5f) {
                        inside = false;
                        break;
                    }
                }

                if (inside) {
                    int t_idx = (i >> 3) + (j >> 3) * ntx + (k >> 3) * ntx * nty;
                    int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;

                    d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, 0.0f, 0.0f, 0.0f, 1.0f);

                    if (d_solid_vel) {
                        d_solid_vel[t_idx].vx[c_idx] = avg_vx;
                        d_solid_vel[t_idx].vy[c_idx] = avg_vy;
                        d_solid_vel[t_idx].vz[c_idx] = avg_vz;
                    }
                }
            }
        }
    }
}

// CUDA Kernel: Rasterize moving FEM surface facets into Eulerian CFD Geometry Tiles
template <typename T>
__global__ void kernel_rasterize_fem_facets_to_geom_3d(
    const FEMNode3D<T>* __restrict__ d_nodes,
    const FEMFacet3D<T>* __restrict__ d_facets,
    int num_facets,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[idx];
    if (facet.is_eroded) return;

    // Retrieve the 4 facet nodes
    Point3D v0 = { static_cast<float>(d_nodes[facet.node_ids[0]].x[0]), static_cast<float>(d_nodes[facet.node_ids[0]].x[1]), static_cast<float>(d_nodes[facet.node_ids[0]].x[2]) };
    Point3D v1 = { static_cast<float>(d_nodes[facet.node_ids[1]].x[0]), static_cast<float>(d_nodes[facet.node_ids[1]].x[1]), static_cast<float>(d_nodes[facet.node_ids[1]].x[2]) };
    Point3D v2 = { static_cast<float>(d_nodes[facet.node_ids[2]].x[0]), static_cast<float>(d_nodes[facet.node_ids[2]].x[1]), static_cast<float>(d_nodes[facet.node_ids[2]].x[2]) };
    Point3D v3 = { static_cast<float>(d_nodes[facet.node_ids[3]].x[0]), static_cast<float>(d_nodes[facet.node_ids[3]].x[1]), static_cast<float>(d_nodes[facet.node_ids[3]].x[2]) };

    float avg_vx = 0.25f * (static_cast<float>(d_nodes[facet.node_ids[0]].v[0] + d_nodes[facet.node_ids[1]].v[0] + d_nodes[facet.node_ids[2]].v[0] + d_nodes[facet.node_ids[3]].v[0]));
    float avg_vy = 0.25f * (static_cast<float>(d_nodes[facet.node_ids[0]].v[1] + d_nodes[facet.node_ids[1]].v[1] + d_nodes[facet.node_ids[2]].v[1] + d_nodes[facet.node_ids[3]].v[1]));
    float avg_vz = 0.25f * (static_cast<float>(d_nodes[facet.node_ids[0]].v[2] + d_nodes[facet.node_ids[1]].v[2] + d_nodes[facet.node_ids[2]].v[2] + d_nodes[facet.node_ids[3]].v[2]));

    Triangle triA = { v0, v1, v2 };
    Triangle triB = { v0, v2, v3 };

    float fnx = static_cast<float>(facet.normal[0]);
    float fny = static_cast<float>(facet.normal[1]);
    float fnz = static_cast<float>(facet.normal[2]);

    int imin = max(0, min(nx - 1, static_cast<int>(floorf((static_cast<float>(facet.bbox_min[0]) - xmin) / dx))));
    int imax = max(0, min(nx - 1, static_cast<int>(ceilf((static_cast<float>(facet.bbox_max[0]) - xmin) / dx))));
    int jmin = max(0, min(ny - 1, static_cast<int>(floorf((static_cast<float>(facet.bbox_min[1]) - ymin) / dy))));
    int jmax = max(0, min(ny - 1, static_cast<int>(ceilf((static_cast<float>(facet.bbox_max[1]) - ymin) / dy))));
    int kmin = max(0, min(nz - 1, static_cast<int>(floorf((static_cast<float>(facet.bbox_min[2]) - zmin) / dz))));
    int kmax = max(0, min(nz - 1, static_cast<int>(ceilf((static_cast<float>(facet.bbox_max[2]) - zmin) / dz))));

    float half_dx = 0.5f * dx;

    for (int k = kmin; k <= kmax; ++k) {
        float cz = zmin + (k + 0.5f) * dz;
        for (int j = jmin; j <= jmax; ++j) {
            float cy = ymin + (j + 0.5f) * dy;
            for (int i = imin; i <= imax; ++i) {
                float cx = xmin + (i + 0.5f) * dx;
                Point3D cell_center = { cx, cy, cz };

                if (tri_box_overlap(cell_center, half_dx, triA) || tri_box_overlap(cell_center, half_dx, triB)) {
                    int t_idx = (i >> 3) + (j >> 3) * ntx + (k >> 3) * ntx * nty;
                    int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;

                    d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, fnx, fny, fnz, 1.0f);

                    if (d_solid_vel) {
                        d_solid_vel[t_idx].vx[c_idx] = avg_vx;
                        d_solid_vel[t_idx].vy[c_idx] = avg_vy;
                        d_solid_vel[t_idx].vz[c_idx] = avg_vz;
                    }
                }
            }
        }
    }
}

// Helper device function: sample CFD pressure from tiled state
// Helper device function: sample CFD fluid pressure, probing outward from immersed solid boundary
template <typename StateRealType, bool StateMultiMat>
__device__ inline float get_fsi_fluid_pressure_at(
    const PrimitiveTile3D<StateRealType, StateMultiMat>* __restrict__ d_states,
    const GeometryTile3D* __restrict__ d_geom,
    float gx, float gy, float gz,
    float unx, float uny, float unz,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float ambient_p = 101325.0f
) {
    float p_fallback = ambient_p;
    for (float dist = 0.5f; dist <= 3.5f; dist += 0.5f) {
        float px = gx + dist * dx * unx;
        float py = gy + dist * dy * uny;
        float pz = gz + dist * dz * unz;

        int ci = static_cast<int>(floorf((px - xmin) / dx));
        int cj = static_cast<int>(floorf((py - ymin) / dy));
        int ck = static_cast<int>(floorf((pz - zmin) / dz));

        if (ci < 0 || ci >= nx || cj < 0 || cj >= ny || ck < 0 || ck >= nz) continue;

        int tx = ci >> 3, ty = cj >> 3, tz = ck >> 3;
        int t_idx = tx + ty * ntx + tz * ntx * nty;
        int lx = ci & 7, ly = cj & 7, lz = ck & 7;
        int c_idx = lx + ly * 8 + lz * 64;

        if (d_geom && d_geom[t_idx].cells[c_idx].is_boundary) {
            continue; // Cell is flagged as immersed solid, step further outward into fluid
        }

        // Pure fluid cell found
        return static_cast<float>(d_states[t_idx].p[c_idx]);
    }
    return p_fallback;
}

// CUDA Kernel: 2x2 Gauss Quadrature CFD Fluid Pressure Integration onto Structural Facet Nodes
template <typename T, typename RealType, bool IsMultiMaterial>
__global__ void kernel_integrate_cfd_pressure_to_fem_nodes_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ d_states,
    const GeometryTile3D* __restrict__ d_geom,
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* __restrict__ d_facets,
    int num_facets,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float ambient_p
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[idx];
    if (facet.is_eroded) return;

    T xn[4][3];
    #pragma unroll
    for (int k = 0; k < 4; ++k) {
        int nid = facet.node_ids[k];
        xn[k][0] = d_nodes[nid].x[0];
        xn[k][1] = d_nodes[nid].x[1];
        xn[k][2] = d_nodes[nid].x[2];
    }

    static const double GAUSS_XI[4]  = {-0.5773502691896257,  0.5773502691896257, 0.5773502691896257, -0.5773502691896257};
    static const double GAUSS_ETA[4] = {-0.5773502691896257, -0.5773502691896257, 0.5773502691896257,  0.5773502691896257};

    #pragma unroll
    for (int g = 0; g < 4; ++g) {
        double xi = GAUSS_XI[g];
        double eta = GAUSS_ETA[g];

        double N[4] = {
            0.25 * (1.0 - xi) * (1.0 - eta),
            0.25 * (1.0 + xi) * (1.0 - eta),
            0.25 * (1.0 + xi) * (1.0 + eta),
            0.25 * (1.0 - xi) * (1.0 + eta)
        };

        double dN_dxi[4] = {
            -0.25 * (1.0 - eta),
             0.25 * (1.0 - eta),
             0.25 * (1.0 + eta),
            -0.25 * (1.0 + eta)
        };

        double dN_deta[4] = {
            -0.25 * (1.0 - xi),
            -0.25 * (1.0 + xi),
             0.25 * (1.0 + xi),
             0.25 * (1.0 - xi)
        };

        double gx = 0.0, gy = 0.0, gz = 0.0;
        double t_xi[3] = {0.0, 0.0, 0.0};
        double t_eta[3] = {0.0, 0.0, 0.0};

        #pragma unroll
        for (int k = 0; k < 4; ++k) {
            gx += N[k] * static_cast<double>(xn[k][0]);
            gy += N[k] * static_cast<double>(xn[k][1]);
            gz += N[k] * static_cast<double>(xn[k][2]);

            t_xi[0] += dN_dxi[k] * static_cast<double>(xn[k][0]);
            t_xi[1] += dN_dxi[k] * static_cast<double>(xn[k][1]);
            t_xi[2] += dN_dxi[k] * static_cast<double>(xn[k][2]);

            t_eta[0] += dN_deta[k] * static_cast<double>(xn[k][0]);
            t_eta[1] += dN_deta[k] * static_cast<double>(xn[k][1]);
            t_eta[2] += dN_deta[k] * static_cast<double>(xn[k][2]);
        }

        // Normal cross product: n_cross = t_xi x t_eta (pointing outward from solid into fluid)
        double n_cross[3] = {
            t_xi[1] * t_eta[2] - t_xi[2] * t_eta[1],
            t_xi[2] * t_eta[0] - t_xi[0] * t_eta[2],
            t_xi[0] * t_eta[1] - t_xi[1] * t_eta[0]
        };

        double n_len = sqrt(n_cross[0] * n_cross[0] + n_cross[1] * n_cross[1] + n_cross[2] * n_cross[2]);
        float unx = 0.0f, uny = 0.0f, unz = 0.0f;
        if (n_len > 1.0e-12) {
            unx = static_cast<float>(n_cross[0] / n_len);
            uny = static_cast<float>(n_cross[1] / n_len);
            unz = static_cast<float>(n_cross[2] / n_len);
        }

        float p_fluid = get_fsi_fluid_pressure_at(
            d_states, d_geom,
            static_cast<float>(gx), static_cast<float>(gy), static_cast<float>(gz),
            unx, uny, unz,
            nx, ny, nz, ntx, nty,
            dx, dy, dz,
            xmin, ymin, zmin,
            ambient_p
        );

        // Fluid driving overpressure on structural boundary: p_overpressure = p_fluid - ambient_p
        float p_overpressure = p_fluid - ambient_p;
        if (fabsf(p_overpressure) > 1.0e-3f) {
            // Net compressive / suction force on solid: -p_overpressure * n_outward * dA = -p_overpressure * n_cross
            double dF[3] = {
                -static_cast<double>(p_overpressure) * n_cross[0],
                -static_cast<double>(p_overpressure) * n_cross[1],
                -static_cast<double>(p_overpressure) * n_cross[2]
            };

            #pragma unroll
            for (int k = 0; k < 4; ++k) {
                int nid = facet.node_ids[k];
                atomicAdd(&d_nodes[nid].f_ext[0], static_cast<T>(N[k] * dF[0]));
                atomicAdd(&d_nodes[nid].f_ext[1], static_cast<T>(N[k] * dF[1]));
                atomicAdd(&d_nodes[nid].f_ext[2], static_cast<T>(N[k] * dF[2]));
            }
        }
    }
}

template <typename T>
void launch_zero_fem_ext_forces_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    cudaStream_t stream
) {
    if (!d_nodes || num_nodes <= 0) return;
    int threads = 256;
    int blocks = (num_nodes + threads - 1) / threads;
    kernel_zero_fem_ext_forces_3d<T><<<blocks, threads, 0, stream>>>(d_nodes, num_nodes);
}

template <typename T>
void launch_rasterize_fem_elements_to_geom_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    cudaStream_t stream
) {
    if (!d_nodes || !d_elements || num_elements <= 0) return;
    int threads = 256;
    int blocks = (num_elements + threads - 1) / threads;
    kernel_rasterize_fem_elements_to_geom_3d<T><<<blocks, threads, 0, stream>>>(
        d_nodes, d_elements, num_elements, d_geom, d_solid_vel,
        nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
    );
}

template <typename T>
void launch_rasterize_fem_facets_to_geom_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    cudaStream_t stream
) {
    if (!d_nodes || !d_facets || num_facets <= 0) return;
    int threads = 256;
    int blocks = (num_facets + threads - 1) / threads;
    kernel_rasterize_fem_facets_to_geom_3d<T><<<blocks, threads, 0, stream>>>(
        d_nodes, d_facets, num_facets, d_geom, d_solid_vel,
        nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
    );
}

template <typename T, typename RealType, bool IsMultiMaterial>
void launch_integrate_cfd_pressure_to_fem_nodes_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const GeometryTile3D* d_geom,
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float ambient_p,
    cudaStream_t stream
) {
    if (!d_states || !d_nodes || !d_facets || num_facets <= 0) return;
    int threads = 256;
    int blocks = (num_facets + threads - 1) / threads;
    kernel_integrate_cfd_pressure_to_fem_nodes_3d<T, RealType, IsMultiMaterial><<<blocks, threads, 0, stream>>>(
        d_states, d_geom, d_nodes, d_facets, num_facets,
        nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin, ambient_p
    );
}

template <typename T>
FEMFSICoupler3DCUDA<T>::FEMFSICoupler3DCUDA() {}

template <typename T>
FEMFSICoupler3DCUDA<T>::~FEMFSICoupler3DCUDA() {
    if (m_d_fsi_work) {
        cudaFree(m_d_fsi_work);
        m_d_fsi_work = nullptr;
    }
}

template <typename T>
void FEMFSICoupler3DCUDA<T>::attachSolvers(CFDSolver3D* fv_solver, FEMSolver3DCUDA<T>* fem_solver) {
    m_fv_solver = fv_solver;
    m_fem_solver = fem_solver;
    if (m_fem_solver) {
        m_stream = static_cast<cudaStream_t>(m_fem_solver->getStream());
    }
}

template <typename T>
T FEMFSICoupler3DCUDA<T>::computeCoupledDt(T cfl) const {
    T dt_fem = m_fem_solver ? m_fem_solver->computeStepSize(cfl) : static_cast<T>(1.0e-5f);
    T dt_fv = m_fv_solver ? static_cast<T>(m_fv_solver->computeStepSize(static_cast<double>(cfl))) : static_cast<T>(1.0e-5f);
    m_cached_dt = std::min(dt_fem, dt_fv);
    return m_cached_dt;
}

template <typename T>
void FEMFSICoupler3DCUDA<T>::executeGPUCoupling(T dt) {
    if (!m_fv_solver || !m_fem_solver) return;

    int num_nodes = static_cast<int>(m_fem_solver->getNodeCount());
    int num_facets = static_cast<int>(m_fem_solver->getSurfaceFacetCount());

    FEMNode3D<T>* d_nodes = m_fem_solver->getNodesDevice();
    FEMFacet3D<T>* d_facets = m_fem_solver->getSurfaceFacetsDevice();

    auto* mpm_cuda = m_fem_solver->getCUDAMPMSolver();
    bool has_mpm = (mpm_cuda && mpm_cuda->getParticleCount() > 0);

    if (!d_nodes && !has_mpm) return;

    // 1. Reset external forces on FEM nodes
    if (d_nodes && num_nodes > 0) {
        launch_zero_fem_ext_forces_3d<T>(d_nodes, num_nodes, m_stream);
    }

    // 2. If MPM debris solver is active, run P2G scatter before CFD coupling
    if (has_mpm) {
        mpm_cuda->particleToGridDeviceOnly();
    }

    // 3. Rasterize moving boundary facets and MPM debris into CFD geometry tiles and integrate fluid pressure
    m_fv_solver->coupleFSIWithFEMGPU(m_fem_solver);
}

template <typename T>
void FEMFSICoupler3DCUDA<T>::stepWithDt(T dt) {
    if (!m_fv_solver || !m_fem_solver) return;

    m_sim_time += dt;
    m_step_count++;
    m_last_dt = dt;

    // 1. Device-to-device coupling step (Facet rasterization, uncovering, pressure sampling, MPM debris coupling)
    executeGPUCoupling(dt);

    // 2. Advance FEM structural solver by dt on GPU
    auto* mpm_cuda = m_fem_solver->getCUDAMPMSolver();
    size_t prev_mpm_count = mpm_cuda ? mpm_cuda->getParticleCount() : 0;
    m_fem_solver->stepWithDt(dt);

    // 3. If new debris particles were spawned during FEM erosion, scatter to grid
    bool newly_added = (mpm_cuda && mpm_cuda->getParticleCount() > prev_mpm_count);
    if (newly_added) {
        mpm_cuda->particleToGridDeviceOnly();
    }

    // 4. Advance MPM debris solver by dt on GPU (with full FSI forces preserved)
    if (mpm_cuda && mpm_cuda->getParticleCount() > 0) {
        mpm_cuda->stepWithDt(static_cast<float>(dt), false);
    }

    // 4. Advance FV gas dynamics solver by dt on GPU
    m_fv_solver->step(static_cast<double>(dt));
}

template <typename T>
void FEMFSICoupler3DCUDA<T>::step(T cfl) {
    T dt = computeCoupledDt(cfl);
    stepWithDt(dt);
}

// Explicit template instantiations
template class FEMFSICoupler3DCUDA<float>;
template class FEMFSICoupler3DCUDA<double>;

template void launch_zero_fem_ext_forces_3d<float>(FEMNode3D<float>*, int, cudaStream_t);
template void launch_zero_fem_ext_forces_3d<double>(FEMNode3D<double>*, int, cudaStream_t);

template void launch_rasterize_fem_elements_to_geom_3d<float>(const FEMNode3D<float>*, const FEMElement3D<float>*, int, GeometryTile3D*, SolidVelocityTile3D*, int, int, int, int, int, float, float, float, float, float, float, cudaStream_t);
template void launch_rasterize_fem_elements_to_geom_3d<double>(const FEMNode3D<double>*, const FEMElement3D<double>*, int, GeometryTile3D*, SolidVelocityTile3D*, int, int, int, int, int, float, float, float, float, float, float, cudaStream_t);

template void launch_rasterize_fem_facets_to_geom_3d<float>(const FEMNode3D<float>*, const FEMFacet3D<float>*, int, GeometryTile3D*, SolidVelocityTile3D*, int, int, int, int, int, float, float, float, float, float, float, cudaStream_t);
template void launch_rasterize_fem_facets_to_geom_3d<double>(const FEMNode3D<double>*, const FEMFacet3D<double>*, int, GeometryTile3D*, SolidVelocityTile3D*, int, int, int, int, int, float, float, float, float, float, float, cudaStream_t);

template void launch_integrate_cfd_pressure_to_fem_nodes_3d<float, float, true>(const PrimitiveTile3D<float, true>*, const GeometryTile3D*, FEMNode3D<float>*, const FEMFacet3D<float>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<float, float, false>(const PrimitiveTile3D<float, false>*, const GeometryTile3D*, FEMNode3D<float>*, const FEMFacet3D<float>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<float, double, true>(const PrimitiveTile3D<double, true>*, const GeometryTile3D*, FEMNode3D<float>*, const FEMFacet3D<float>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<float, double, false>(const PrimitiveTile3D<double, false>*, const GeometryTile3D*, FEMNode3D<float>*, const FEMFacet3D<float>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);

template void launch_integrate_cfd_pressure_to_fem_nodes_3d<double, float, true>(const PrimitiveTile3D<float, true>*, const GeometryTile3D*, FEMNode3D<double>*, const FEMFacet3D<double>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<double, float, false>(const PrimitiveTile3D<float, false>*, const GeometryTile3D*, FEMNode3D<double>*, const FEMFacet3D<double>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<double, double, true>(const PrimitiveTile3D<double, true>*, const GeometryTile3D*, FEMNode3D<double>*, const FEMFacet3D<double>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);
template void launch_integrate_cfd_pressure_to_fem_nodes_3d<double, double, false>(const PrimitiveTile3D<double, false>*, const GeometryTile3D*, FEMNode3D<double>*, const FEMFacet3D<double>*, int, int, int, int, int, int, float, float, float, float, float, float, float, cudaStream_t);

} // namespace Blast
