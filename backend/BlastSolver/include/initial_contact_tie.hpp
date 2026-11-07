#pragma once
// Initial-contact tie detection for Multi-Velocity (Bardenhagen) contact, shared by the CPU and CUDA MPM solvers.
//
// Field pair (a, b) is tied iff (1) at least one cross-field particle pair is geometrically touching, i.e. their
// centre distance is below 1.25 x the mean of the two fields nominal particle spacings h = cbrt(max V0), and
// (2) EVERY touching cross-field pair is rigid-body co-moving: the velocity of particle a extrapolated through its
// own affine matrix, v_a + B_a (x_b - x_a), equals v_b to within a floating-point round-off bound. Bodies that
// approach each other, or are separated by more than a particle spacing, are never tied. Ties are closed
// transitively (bodies connected through a chain of touching co-moving bodies form one rigid contact cluster).
// Returns a per-field bit mask (bit b of mask[a] set <=> a and b tied); M must be in [2, 16].
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>

namespace Blast {

template <class Particle>
std::vector<unsigned int> compute_initial_contact_tie_mask(const std::vector<Particle>& parts, int M, int& num_pairs) {
    std::vector<unsigned int> mask(static_cast<size_t>(std::max(1, M)), 0u);
    num_pairs = 0;
    if (M < 2 || M > 16 || parts.empty()) return mask;

    std::vector<float> maxV(M, 0.0f);
    for (const auto& p : parts) {
        if (p.material_id >= 0 && p.material_id < M) maxV[p.material_id] = std::max(maxV[p.material_id], p.V0);
    }
    std::vector<float> h(M, 0.0f);
    float hmax = 0.0f;
    for (int m = 0; m < M; ++m) { h[m] = std::cbrt(std::max(maxV[m], 0.0f)); hmax = std::max(hmax, h[m]); }
    if (!(hmax > 0.0f)) return mask;

    const float inv_cell = 1.0f / hmax;
    struct Key { long long k; int idx; };
    std::vector<Key> keys;
    keys.reserve(parts.size());
    auto cell_of = [&](float x) { return static_cast<long long>(std::floor(x * inv_cell)) + 1048576LL; };
    auto pack = [](long long cx, long long cy, long long cz) { return (cx << 42) ^ (cy << 21) ^ cz; };
    for (size_t i = 0; i < parts.size(); ++i) {
        const auto& p = parts[i];
        if (p.material_id < 0 || p.material_id >= M || p.m <= 0.0f) continue;
        keys.push_back({pack(cell_of(p.x[0]), cell_of(p.x[1]), cell_of(p.x[2])), static_cast<int>(i)});
    }
    std::sort(keys.begin(), keys.end(), [](const Key& a, const Key& b) { return a.k < b.k; });
    std::vector<int> touch(M * M, 0), bad(M * M, 0);
    for (const auto& ka : keys) {
        const auto& a = parts[ka.idx];
        const long long cx = cell_of(a.x[0]), cy = cell_of(a.x[1]), cz = cell_of(a.x[2]);
        for (int dx_ = -1; dx_ <= 1; ++dx_) for (int dy_ = -1; dy_ <= 1; ++dy_) for (int dz_ = -1; dz_ <= 1; ++dz_) {
            const long long key = pack(cx + dx_, cy + dy_, cz + dz_);
            auto it = std::lower_bound(keys.begin(), keys.end(), key, [](const Key& e, long long v) { return e.k < v; });
            for (; it != keys.end() && it->k == key; ++it) {
                if (it->idx <= ka.idx) continue;
                const auto& b = parts[it->idx];
                if (a.material_id == b.material_id) continue;
                const float rx = b.x[0] - a.x[0], ry = b.x[1] - a.x[1], rz = b.x[2] - a.x[2];
                const float d2 = rx * rx + ry * ry + rz * rz;
                const float reach = 1.25f * 0.5f * (h[a.material_id] + h[b.material_id]);
                if (d2 >= reach * reach) continue;
                const int lo = std::min(a.material_id, b.material_id), hi = std::max(a.material_id, b.material_id);
                touch[lo * M + hi]++;
                float e2 = 0.0f, scale = 0.0f;
                for (int c = 0; c < 3; ++c) {
                    const float va = a.v[c] + (a.B[c][0] * rx + a.B[c][1] * ry + a.B[c][2] * rz);
                    e2 += (va - b.v[c]) * (va - b.v[c]);
                    scale = std::max(scale, std::max(std::fabs(a.v[c]), std::fabs(b.v[c])));
                }
                float bnorm = 0.0f;
                for (int r_ = 0; r_ < 3; ++r_) for (int c_ = 0; c_ < 3; ++c_) bnorm = std::max(bnorm, std::fabs(a.B[r_][c_]));
                const float tol = 128.0f * 1.1920929e-7f * std::max(scale, bnorm * std::sqrt(d2));
                if (std::sqrt(e2) > tol) bad[lo * M + hi]++;
            }
        }
    }
    std::vector<int> ok(M * M, 0);
    for (int a = 0; a < M; ++a) for (int b = a + 1; b < M; ++b)
        if (touch[a * M + b] > 0 && bad[a * M + b] == 0) ok[a * M + b] = ok[b * M + a] = 1;
    for (int k = 0; k < M; ++k) for (int a = 0; a < M; ++a) for (int b = 0; b < M; ++b)
        if (a != b && ok[a * M + k] && ok[k * M + b]) ok[a * M + b] = 1;
    for (int a = 0; a < M; ++a) for (int b = a + 1; b < M; ++b) {
        if (!ok[a * M + b]) continue;
        mask[a] |= (1u << b);
        mask[b] |= (1u << a);
        num_pairs++;
        std::cout << "[MPM3D] Initial-contact tie: velocity fields " << a << " <-> " << b
                  << " (" << touch[a * M + b] << " touching co-moving particle pairs)" << std::endl;
    }
    return mask;
}

} // namespace Blast
