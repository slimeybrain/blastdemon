#pragma once

#include <vector>
#include <cmath>
#include <cstdint>
#include <memory>
#include <functional>

namespace Blast::DAA {

struct LowRankBlock {
    int row_offset{0};
    int col_offset{0};
    int num_rows{0};
    int num_cols{0};
    int rank{0};
    std::vector<double> U; // size: num_rows * rank (column-major)
    std::vector<double> V; // size: num_cols * rank (column-major)

    // Matrix-vector multiplication y += (U * V^T) * x
    void matvec(const double* x, double* y) const {
        if (rank <= 0) return;
        std::vector<double> tmp(rank, 0.0);
        // tmp = V^T * x
        for (int r = 0; r < rank; ++r) {
            double sum = 0.0;
            for (int j = 0; j < num_cols; ++j) {
                sum += V[j * rank + r] * x[col_offset + j];
            }
            tmp[r] = sum;
        }
        // y += U * tmp
        for (int i = 0; i < num_rows; ++i) {
            double sum = 0.0;
            for (int r = 0; r < rank; ++r) {
                sum += U[i * rank + r] * tmp[r];
            }
            y[row_offset + i] += sum;
        }
    }
};

class HMatrixAddedMass {
public:
    HMatrixAddedMass() = default;
    ~HMatrixAddedMass() = default;

    // Build H-matrix ACA representation of kernel 1 / (4 * pi * |x_i - x_j|)
    bool compress_facet_kernel(
        const std::vector<std::array<double, 3>>& facet_centers,
        const std::vector<std::array<double, 3>>& facet_normals,
        const std::vector<double>& facet_areas,
        double rho_fluid = 1000.0,
        double eps_aca = 1.0e-4,
        int max_rank = 32
    );

    // Fast O(N k log N) Added mass matrix-vector product: a_added = M_added * a_fluid
    void multiply(const std::vector<double>& x, std::vector<double>& y) const;

    size_t get_compressed_memory_bytes() const;
    size_t get_uncompressed_memory_bytes() const;
    double get_compression_ratio() const;

private:
    int m_num_facets{0};
    std::vector<LowRankBlock> m_blocks;
    std::vector<double> m_near_field_dense; // Dense blocks along diagonal
    std::vector<int> m_near_field_indices;
};

} // namespace Blast::DAA
