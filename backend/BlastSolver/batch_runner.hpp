#pragma once

/**
 * BlastDaemon Batch Runner & AI Dataset Generation Engine
 * Document ID: BD-CAE-SPEC-2026-REV1
 * 
 * Coordinates multi-run DOE parameter sweeps and writes bit-exact structured
 * datasets for neural surrogate modeling (Fourier Neural Operators, DeepONet, PINNs).
 */

#include <iostream>
#include <string>
#include <vector>
#include <unordered_map>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <chrono>
#include <iomanip>
#include "nlohmann/json.hpp"
#include "batch_sampler.hpp"

namespace Blast {

namespace fs = std::filesystem;

struct RunSummaryRecord {
    uint32_t run_id = 0;
    std::unordered_map<std::string, double> input_params;
    double peak_overpressure_pa = 0.0;
    double peak_impulse_pa_s = 0.0;
    double final_simulation_time_s = 0.0;
    uint64_t total_steps = 0;
    double execution_walltime_s = 0.0;
    bool status_converged = true;
};

class BatchDatasetRunner {
private:
    std::string base_output_dir_ = "./ai_dataset_output";
    nlohmann::json template_config_;
    std::vector<std::unordered_map<std::string, double>> sample_matrix_;
    std::vector<RunSummaryRecord> run_records_;

public:
    BatchDatasetRunner(const std::string& output_dir, const nlohmann::json& template_config)
        : base_output_dir_(output_dir), template_config_(template_config) {}

    void set_samples(const std::vector<std::unordered_map<std::string, double>>& samples) {
        sample_matrix_ = samples;
    }

    /**
     * Prepare directory structure and write individual run configurations.
     */
    bool prepare_batch() {
        try {
            fs::create_directories(base_output_dir_);

            for (size_t i = 0; i < sample_matrix_.size(); ++i) {
                std::stringstream ss;
                ss << base_output_dir_ << "/run_" << std::setw(4) << std::setfill('0') << i;
                std::string run_dir = ss.str();
                fs::create_directories(run_dir);

                // Clone template config and inject sampled parameters
                nlohmann::json run_cfg = template_config_;
                for (const auto& [key, val] : sample_matrix_[i]) {
                    // Update key in JSON root or nested parameters
                    if (run_cfg.contains("parameters")) {
                        run_cfg["parameters"][key] = val;
                    }
                    run_cfg[key] = val;
                }

                run_cfg["batch_run_id"] = i;
                run_cfg["dataset_output_dir"] = run_dir;

                std::ofstream cfg_out(run_dir + "/config.json");
                if (cfg_out.is_open()) {
                    cfg_out << run_cfg.dump(2);
                }
            }
            return true;
        } catch (const std::exception& e) {
            std::cerr << "[BatchDatasetRunner] Error preparing batch: " << e.what() << "\n";
            return false;
        }
    }

    void record_run_result(const RunSummaryRecord& rec) {
        run_records_.push_back(rec);
    }

    /**
     * Write master manifest.json and summary.csv catalog for AI surrogate model training.
     */
    bool finalize_manifest() {
        try {
            std::string summary_csv_path = base_output_dir_ + "/summary.csv";
            std::ofstream csv_out(summary_csv_path);
            if (!csv_out.is_open()) return false;

            // Extract parameter column names
            std::vector<std::string> param_names;
            if (!sample_matrix_.empty()) {
                for (const auto& [k, v] : sample_matrix_[0]) {
                    param_names.push_back(k);
                }
            }

            // CSV Header
            csv_out << "run_id";
            for (const auto& p : param_names) {
                csv_out << "," << p;
            }
            csv_out << ",peak_overpressure_pa,peak_impulse_pa_s,sim_time_s,steps,walltime_s,converged\n";

            // CSV Rows
            for (const auto& rec : run_records_) {
                csv_out << rec.run_id;
                for (const auto& p : param_names) {
                    auto it = rec.input_params.find(p);
                    double v = (it != rec.input_params.end()) ? it->second : 0.0;
                    csv_out << "," << v;
                }
                csv_out << "," << rec.peak_overpressure_pa
                        << "," << rec.peak_impulse_pa_s
                        << "," << rec.final_simulation_time_s
                        << "," << rec.total_steps
                        << "," << rec.execution_walltime_s
                        << "," << (rec.status_converged ? "1" : "0")
                        << "\n";
            }

            // Master manifest.json
            nlohmann::json manifest;
            manifest["dataset_name"] = "BlastDaemon Multi-Physics AI Dataset";
            manifest["total_runs"] = run_records_.size();
            manifest["created_at"] = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            manifest["parameters"] = param_names;
            manifest["runs"] = nlohmann::json::array();

            for (const auto& rec : run_records_) {
                nlohmann::json rj;
                rj["run_id"] = rec.run_id;
                rj["params"] = rec.input_params;
                rj["metrics"] = {
                    {"peak_overpressure_pa", rec.peak_overpressure_pa},
                    {"peak_impulse_pa_s", rec.peak_impulse_pa_s},
                    {"sim_time_s", rec.final_simulation_time_s},
                    {"total_steps", rec.total_steps},
                    {"walltime_s", rec.execution_walltime_s},
                    {"converged", rec.status_converged}
                };
                manifest["runs"].push_back(rj);
            }

            std::ofstream manifest_out(base_output_dir_ + "/manifest.json");
            if (manifest_out.is_open()) {
                manifest_out << manifest.dump(2);
            }

            return true;
        } catch (const std::exception& e) {
            std::cerr << "[BatchDatasetRunner] Error finalizing manifest: " << e.what() << "\n";
            return false;
        }
    }
};

} // namespace Blast
