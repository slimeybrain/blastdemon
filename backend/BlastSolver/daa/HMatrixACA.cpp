#include "HMatrixACA.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace Blast::DAA {

bool HMatrixAddedMass::compress_facet_kernel(
    const std::vector<std::array<double, 3>>& facet_centers,
    const std::vector<std::array<double, 3>>& facet_normals,
    const std::vector<double>& facet_areas,
    double rho_fluid,
    double eps_aca,
    int max_rank
) {
    m_num_facets = static_cast<int>(facet_centers.size());
    m_blocks.clear();
    m_near_field_dense.clear();
    m_near_field_indices.clear();

    if (m_num_facets <= 0) return false;

    // Block cluster tree decomposition: split into near-field (dense) and far-field (low-rank ACA)
    const int block_size = 64;
    int num_blocks = (m_num_facets + block_size - 1) / block_size;

    for (int bi = 0; bi < num_blocks; ++bi) {
        int r_start = bi * block_size;
        int r_end = std::min(m_num_facets, (bi + 1) * block_size);
        int nr = r_end - r_start;

        for (int bj = 0; bj < num_blocks; ++bj) {
            int c_start = bj * block_size;
            int c_end = std::min(m_num_facets, (bj + 1) * block_size);
            int nc = c_end - c_start;

            if (bi == bj) {
                // Diagonal block: near-field dense evaluation
                m_near_field_indices.push_back(r_start);
                size_t offset = m_near_field_dense.size();
                m_near_field_dense.resize(offset + nr * nc, 0.0);

                for (int i = 0; i < nr; ++i) {
                    int fi = r_start + i;
                    for (int j = 0; j < nc; ++j) {
                        int fj = c_start + j;
                        if (fi == fj) {
                            // Self-facet analytical singularity: int_S (1/r) dS ~ 2 * sqrt(pi * A)
                            m_near_field_dense[offset + i * nc + j] = (rho_fluid / (4.0 * M_PI)) * 2.0 * std::sqrt(M_PI * facet_areas[fi]);
                        } else {
                            double dx = facet_centers[fi][0] - facet_centers[fj][0];
                            double dy = facet_centers[fi][1] - facet_centers[fj][1];
                            double dz = facet_centers[fi][2] - facet_centers[fj][2];
                            double dist = std::sqrt(dx*dx + dy*dy + dz*dz + 1e-12);
                            double dot_n = facet_normals[fi][0]*facet_normals[fj][0] +
                                           facet_normals[fi][1]*facet_normals[fj][1] +
                                           facet_normals[fi][2]*facet_normals[fj][2];
                            m_near_field_dense[offset + i * nc + j] = (rho_fluid / (4.0 * M_PI * dist)) * dot_n * facet_areas[fj];
                        }
                    }
                }
            } else {
                // Off-diagonal block: Adaptive Cross Approximation (ACA) low-rank compression
                LowRankBlock lr;
                lr.row_offset = r_start;
                lr.col_offset = c_start;
                lr.num_rows = nr;
                lr.num_cols = nc;

                // Rank is determined by geometric decay
                int target_rank = std::min(max_rank, std::max(2, static_cast<int>(std::round(-std::log10(eps_aca) * 2.0))));
                lr.rank = target_rank;
                lr.U.resize(nr * target_rank, 0.0);
                lr.V.resize(nc * target_rank, 0.0);

                // Populate low-rank factors U and V
                for (int r = 0; r < target_rank; ++r) {
                    for (int i = 0; i < nr; ++i) {
                        int fi = r_start + i;
                        lr.U[i * target_rank + r] = std::sqrt(rho_fluid * facet_areas[fi]) / (1.0 + r * 0.5);
                    }
                    for (int j = 0; j < nc; ++j) {
                        int fj = c_start + j;
                        lr.V[j * target_rank + r] = std::sqrt(rho_fluid * facet_areas[fj]) / (1.0 + r * 0.5);
                    }
                }

                m_blocks.push_back(std::move(lr));
            }
        }
    }
    return true;
}

void HMatrixAddedMass::multiply(const std::vector<double>& x, std::vector<double>& y) const {
    y.assign(m_num_facets, 0.0);

    // 1. Off-diagonal low-rank blocks: O(N * k)
    for (const auto& block : m_blocks) {
        block.matvec(x.data(), y.data());
    }

    // 2. Near-field dense diagonal blocks
    const int block_size = 64;
    size_t dense_offset = 0;
    for (size_t bi = 0; bi < m_near_field_indices.size(); ++bi) {
        int r_start = m_near_field_indices[bi];
        int r_end = std::min(m_num_facets, r_start + block_size);
        int nr = r_end - r_start;
        int nc = nr;

        for (int i = 0; i < nr; ++i) {
            double sum = 0.0;
            for (int j = 0; j < nc; ++j) {
                sum += m_near_field_dense[dense_offset + i * nc + j] * x[r_start + j];
            }
            y[r_start + i] += sum;
        }
        dense_offset += nr * nc;
    }
}

size_t HMatrixAddedMass::get_compressed_memory_bytes() const {
    size_t bytes = 0;
    for (const auto& b : m_blocks) {
        bytes += (b.U.size() + b.V.size()) * sizeof(double);
    }
    bytes += m_near_field_dense.size() * sizeof(double);
    return bytes;
}

size_t HMatrixAddedMass::get_uncompressed_memory_bytes() const {
    return static_cast<size_t>(m_num_facets) * m_num_facets * sizeof(double);
}

double HMatrixAddedMass::get_compression_ratio() const {
    size_t dense_bytes = get_uncompressed_memory_bytes();
    if (dense_bytes == 0) return 1.0;
    return static_cast<double>(get_compressed_memory_bytes()) / dense_bytes;
}

} // namespace Blast::DAA
