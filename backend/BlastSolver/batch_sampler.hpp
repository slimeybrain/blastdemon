#pragma once

/**
 * BlastDaemon Design of Experiments (DOE) & Parameter Space Sampler
 * Document ID: BD-CAE-SPEC-2026-REV1
 * 
 * Zero-dependency pure C++20 Latin Hypercube (LHS), Uniform Random,
 * Normal/Gaussian, and Discrete-set parameter space sampler.
 */

#include <iostream>
#include <string>
#include <vector>
#include <unordered_map>
#include <random>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include "nlohmann/json.hpp"

namespace Blast {

enum class DistributionType {
    UNIFORM,
    LOG_UNIFORM,
    NORMAL,
    DISCRETE
};

struct ParamDimension {
    std::string name;
    DistributionType dist = DistributionType::UNIFORM;
    double min_val = 0.0;
    double max_val = 1.0;
    double mean = 0.0;
    double std_dev = 1.0;
    std::vector<double> discrete_values;
};

class DOELatinHypercubeSampler {
private:
    std::vector<ParamDimension> dimensions_;
    uint64_t seed_ = 1337;

public:
    explicit DOELatinHypercubeSampler(uint64_t seed = 1337) : seed_(seed) {}

    void add_dimension(const ParamDimension& dim) {
        dimensions_.push_back(dim);
    }

    void add_uniform(const std::string& name, double min_val, double max_val) {
        ParamDimension dim;
        dim.name = name;
        dim.dist = DistributionType::UNIFORM;
        dim.min_val = min_val;
        dim.max_val = max_val;
        dimensions_.push_back(dim);
    }

    void add_log_uniform(const std::string& name, double min_val, double max_val) {
        ParamDimension dim;
        dim.name = name;
        dim.dist = DistributionType::LOG_UNIFORM;
        dim.min_val = min_val;
        dim.max_val = max_val;
        dimensions_.push_back(dim);
    }

    void add_normal(const std::string& name, double mean, double std_dev, double min_bound = -1e9, double max_bound = 1e9) {
        ParamDimension dim;
        dim.name = name;
        dim.dist = DistributionType::NORMAL;
        dim.mean = mean;
        dim.std_dev = std_dev;
        dim.min_val = min_bound;
        dim.max_val = max_bound;
        dimensions_.push_back(dim);
    }

    void add_discrete(const std::string& name, const std::vector<double>& values) {
        ParamDimension dim;
        dim.name = name;
        dim.dist = DistributionType::DISCRETE;
        dim.discrete_values = values;
        dimensions_.push_back(dim);
    }

    void clear() { dimensions_.clear(); }

    /**
     * Generate N multi-dimensional Latin Hypercube Samples.
     */
    std::vector<std::unordered_map<std::string, double>> sample_lhs(size_t num_samples) {
        if (dimensions_.empty() || num_samples == 0) return {};

        std::mt19937_64 rng(seed_);
        std::uniform_real_distribution<double> uniform_dist(0.0, 1.0);

        size_t num_dims = dimensions_.size();
        std::vector<std::vector<double>> dim_samples(num_dims, std::vector<double>(num_samples));

        for (size_t d = 0; d < num_dims; ++d) {
            const auto& dim = dimensions_[d];

            // Stratified bin indices
            std::vector<size_t> bin_indices(num_samples);
            for (size_t i = 0; i < num_samples; ++i) {
                bin_indices[i] = i;
            }
            std::shuffle(bin_indices.begin(), bin_indices.end(), rng);

            for (size_t i = 0; i < num_samples; ++i) {
                size_t bin = bin_indices[i];
                double u = (static_cast<double>(bin) + uniform_dist(rng)) / static_cast<double>(num_samples);

                double val = 0.0;
                switch (dim.dist) {
                    case DistributionType::UNIFORM:
                        val = dim.min_val + u * (dim.max_val - dim.min_val);
                        break;
                    case DistributionType::LOG_UNIFORM: {
                        double log_min = std::log(std::max(1e-12, dim.min_val));
                        double log_max = std::log(std::max(1e-12, dim.max_val));
                        val = std::exp(log_min + u * (log_max - log_min));
                        break;
                    }
                    case DistributionType::NORMAL: {
                        // Inverse Error Function approximation for normal quantile
                        double erf_inv = approximate_erfinv(2.0 * u - 1.0);
                        val = dim.mean + dim.std_dev * std::sqrt(2.0) * erf_inv;
                        val = std::clamp(val, dim.min_val, dim.max_val);
                        break;
                    }
                    case DistributionType::DISCRETE: {
                        if (!dim.discrete_values.empty()) {
                            size_t idx = std::min(dim.discrete_values.size() - 1, static_cast<size_t>(u * dim.discrete_values.size()));
                            val = dim.discrete_values[idx];
                        }
                        break;
                    }
                }
                dim_samples[d][i] = val;
            }
        }

        // Assemble sample row maps
        std::vector<std::unordered_map<std::string, double>> result(num_samples);
        for (size_t i = 0; i < num_samples; ++i) {
            for (size_t d = 0; d < num_dims; ++d) {
                result[i][dimensions_[d].name] = dim_samples[d][i];
            }
        }

        return result;
    }

    /**
     * Save sampled dataset matrix to CSV file.
     */
    bool export_csv(const std::string& filepath, const std::vector<std::unordered_map<std::string, double>>& samples) const {
        std::ofstream out(filepath);
        if (!out.is_open()) return false;

        // Header
        out << "sample_id";
        for (const auto& dim : dimensions_) {
            out << "," << dim.name;
        }
        out << "\n";

        // Rows
        for (size_t i = 0; i < samples.size(); ++i) {
            out << i;
            for (const auto& dim : dimensions_) {
                auto it = samples[i].find(dim.name);
                double val = (it != samples[i].end()) ? it->second : 0.0;
                out << "," << val;
            }
            out << "\n";
        }

        return true;
    }

private:
    static double approximate_erfinv(double x) {
        double tt1, tt2, lnx, sgn;
        sgn = (x < 0) ? -1.0 : 1.0;
        x = (1 - x) * (1 + x);
        lnx = std::log(std::max(1e-15, x));
        tt1 = 2.0 / (M_PI * 0.147) + 0.5 * lnx;
        tt2 = 1.0 / 0.147 * lnx;
        return sgn * std::sqrt(std::max(0.0, -tt1 + std::sqrt(tt1 * tt1 - tt2)));
    }
};

} // namespace Blast
