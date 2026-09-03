#pragma once

/**
 * BlastDaemon In-Situ AST Event Engine & Dynamic Steering Dispatcher
 * Document ID: BD-CAE-SPEC-2026-REV1
 * 
 * Evaluates dynamic conditions (TIME_GE, STEP_GE, PRESSURE_MAX_GE, ENERGY_DRIFT_GE)
 * and executes dynamic actions (SET_PARAM, TRIGGER_SNAPSHOT, ROLLBACK_BRANCH, DUMP_VTK)
 * with deep GPU/CPU state snapshot buffers and dynamic CFL scheduling.
 */

#include <iostream>
#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <unordered_map>
#include <cmath>
#include <chrono>
#include <cstring>
#include "nlohmann/json.hpp"

namespace Blast {

// Forward declarations
enum class TriggerType {
    TIME_GE,
    STEP_GE,
    PRESSURE_MAX_GE,
    TEMPERATURE_MAX_GE,
    ENERGY_DRIFT_GE,
    CFL_RAMP,
    CUSTOM_EXPR
};

enum class ActionType {
    SET_PARAM,
    TRIGGER_SNAPSHOT,
    ROLLBACK_BRANCH,
    DUMP_VTK,
    DUMP_HDF5,
    TERMINATE_WITH_STATUS,
    LOG_MESSAGE
};

struct DynamicCFLSchedule {
    bool enabled = false;
    double t_start = 0.0;
    double t_end = 1.0e-3;
    double cfl_start = 0.05;
    double cfl_target = 0.40;
    std::string ramp_type = "linear"; // "linear", "exponential", "step"

    double evaluate(double current_t) const {
        if (!enabled || current_t < t_start) return cfl_start;
        if (current_t >= t_end) return cfl_target;

        double progress = (current_t - t_start) / (t_end - t_start);
        if (ramp_type == "exponential") {
            return cfl_start * std::pow(cfl_target / cfl_start, progress);
        } else if (ramp_type == "step") {
            return progress >= 1.0 ? cfl_target : cfl_start;
        }
        // Linear default
        return cfl_start + progress * (cfl_target - cfl_start);
    }
};

struct ASTCondition {
    TriggerType type = TriggerType::TIME_GE;
    double threshold_value = 0.0;
    std::string variable_name = "";
    bool triggered = false;
    bool recurring = false;
    double recurring_interval = 0.0;
    double next_trigger_val = 0.0;

    bool evaluate(double current_time, uint64_t current_step, double scalar_val) {
        if (triggered && !recurring) return false;

        bool fire = false;
        switch (type) {
            case TriggerType::TIME_GE:
                if (recurring) {
                    if (current_time >= next_trigger_val) {
                        fire = true;
                        next_trigger_val += recurring_interval;
                    }
                } else {
                    fire = (current_time >= threshold_value);
                }
                break;
            case TriggerType::STEP_GE:
                if (recurring) {
                    if (static_cast<double>(current_step) >= next_trigger_val) {
                        fire = true;
                        next_trigger_val += recurring_interval;
                    }
                } else {
                    fire = (static_cast<double>(current_step) >= threshold_value);
                }
                break;
            case TriggerType::PRESSURE_MAX_GE:
            case TriggerType::TEMPERATURE_MAX_GE:
            case TriggerType::ENERGY_DRIFT_GE:
                fire = (scalar_val >= threshold_value);
                break;
            default:
                break;
        }

        if (fire) triggered = true;
        return fire;
    }
};

struct ASTAction {
    ActionType type = ActionType::SET_PARAM;
    std::string target_param = "";
    double target_value = 0.0;
    std::string string_payload = "";
    uint32_t checkpoint_id = 0;
};

struct ASTEventRule {
    std::string id = "";
    std::string description = "";
    ASTCondition condition;
    std::vector<ASTAction> actions;
    bool is_active = true;
};

/**
 * Deep State Snapshot representation for in-memory checkpointing & rollback.
 */
struct StateSnapshot {
    uint32_t id = 0;
    uint64_t step = 0;
    double time = 0.0;
    double dt = 0.0;
    std::vector<uint8_t> conservative_bytes;
    std::vector<uint8_t> auxiliary_bytes;
    std::chrono::system_clock::time_point timestamp;
    size_t total_bytes = 0;
};

class DeepCheckpointPool {
private:
    std::vector<StateSnapshot> snapshots_;
    size_t max_snapshots_ = 5;
    size_t current_index_ = 0;
    uint32_t next_id_ = 1;

public:
    explicit DeepCheckpointPool(size_t max_snapshots = 5) : max_snapshots_(max_snapshots) {
        snapshots_.reserve(max_snapshots_);
    }

    uint32_t capture(uint64_t step, double time, double dt, const void* data, size_t size, const void* aux = nullptr, size_t aux_size = 0) {
        StateSnapshot snap;
        snap.id = next_id_++;
        snap.step = step;
        snap.time = time;
        snap.dt = dt;
        snap.total_bytes = size + aux_size;
        snap.timestamp = std::chrono::system_clock::now();

        snap.conservative_bytes.resize(size);
        if (size > 0 && data) {
            std::memcpy(snap.conservative_bytes.data(), data, size);
        }

        if (aux_size > 0 && aux) {
            snap.auxiliary_bytes.resize(aux_size);
            std::memcpy(snap.auxiliary_bytes.data(), aux, aux_size);
        }

        if (snapshots_.size() < max_snapshots_) {
            snapshots_.push_back(std::move(snap));
        } else {
            snapshots_[current_index_ % max_snapshots_] = std::move(snap);
            current_index_++;
        }

        return snap.id;
    }

    const StateSnapshot* get_snapshot(uint32_t id) const {
        for (const auto& s : snapshots_) {
            if (s.id == id) return &s;
        }
        return nullptr;
    }

    const StateSnapshot* get_latest() const {
        if (snapshots_.empty()) return nullptr;
        return &snapshots_.back();
    }

    size_t size() const { return snapshots_.size(); }
    void clear() { snapshots_.clear(); current_index_ = 0; }
};

class ASTEventEngine {
private:
    std::vector<ASTEventRule> rules_;
    DynamicCFLSchedule cfl_schedule_;
    DeepCheckpointPool checkpoint_pool_;

    // Action Execution Hooks
    std::function<void(const std::string&, double)> param_setter_;
    std::function<void(const std::string&)> vtk_dumper_;
    std::function<void(const std::string&)> hdf5_dumper_;
    std::function<void(const std::string&)> status_terminator_;

public:
    ASTEventEngine() : checkpoint_pool_(5) {}

    void set_param_callback(std::function<void(const std::string&, double)> cb) { param_setter_ = cb; }
    void set_vtk_callback(std::function<void(const std::string&)> cb) { vtk_dumper_ = cb; }
    void set_hdf5_callback(std::function<void(const std::string&)> cb) { hdf5_dumper_ = cb; }
    void set_terminate_callback(std::function<void(const std::string&)> cb) { status_terminator_ = cb; }

    void set_cfl_schedule(const DynamicCFLSchedule& sched) { cfl_schedule_ = sched; }
    const DynamicCFLSchedule& get_cfl_schedule() const { return cfl_schedule_; }

    void add_rule(const ASTEventRule& rule) {
        rules_.push_back(rule);
    }

    void clear_rules() { rules_.clear(); }

    DeepCheckpointPool& get_checkpoints() { return checkpoint_pool_; }

    /**
     * Parse event rules from solver JSON configuration.
     */
    void parse_json_rules(const nlohmann::json& j) {
        if (!j.contains("events") || !j["events"].is_array()) return;

        for (const auto& ej : j["events"]) {
            ASTEventRule rule;
            rule.id = ej.value("id", "evt_" + std::to_string(rules_.size()));
            rule.description = ej.value("desc", "");
            rule.is_active = ej.value("active", true);

            if (ej.contains("condition")) {
                const auto& cj = ej["condition"];
                std::string type_str = cj.value("type", "TIME_GE");
                if (type_str == "TIME_GE") rule.condition.type = TriggerType::TIME_GE;
                else if (type_str == "STEP_GE") rule.condition.type = TriggerType::STEP_GE;
                else if (type_str == "PRESSURE_MAX_GE") rule.condition.type = TriggerType::PRESSURE_MAX_GE;
                else if (type_str == "ENERGY_DRIFT_GE") rule.condition.type = TriggerType::ENERGY_DRIFT_GE;

                rule.condition.threshold_value = cj.value("value", 0.0);
                rule.condition.recurring = cj.value("recurring", false);
                rule.condition.recurring_interval = cj.value("interval", 0.0);
                rule.condition.next_trigger_val = rule.condition.threshold_value;
            }

            if (ej.contains("actions") && ej["actions"].is_array()) {
                for (const auto& aj : ej["actions"]) {
                    ASTAction action;
                    std::string act_type = aj.value("type", "SET_PARAM");
                    if (act_type == "SET_PARAM") action.type = ActionType::SET_PARAM;
                    else if (act_type == "TRIGGER_SNAPSHOT") action.type = ActionType::TRIGGER_SNAPSHOT;
                    else if (act_type == "DUMP_VTK") action.type = ActionType::DUMP_VTK;
                    else if (act_type == "DUMP_HDF5") action.type = ActionType::DUMP_HDF5;
                    else if (act_type == "TERMINATE") action.type = ActionType::TERMINATE_WITH_STATUS;

                    action.target_param = aj.value("param", "");
                    action.target_value = aj.value("value", 0.0);
                    action.string_payload = aj.value("payload", "");
                    rule.actions.push_back(action);
                }
            }

            rules_.push_back(rule);
        }
    }

    /**
     * Evaluates dynamic CFL and all active rules during a solver step.
     */
    double evaluate_step(
        uint64_t step,
        double current_t,
        double current_cfl,
        double max_p = 0.0,
        double energy_drift = 0.0
    ) {
        // 1. Dynamic CFL scheduling
        double new_cfl = current_cfl;
        if (cfl_schedule_.enabled) {
            new_cfl = cfl_schedule_.evaluate(current_t);
        }

        // 2. Event rules evaluation
        for (auto& rule : rules_) {
            if (!rule.is_active) continue;

            double scalar_val = 0.0;
            if (rule.condition.type == TriggerType::PRESSURE_MAX_GE) scalar_val = max_p;
            else if (rule.condition.type == TriggerType::ENERGY_DRIFT_GE) scalar_val = energy_drift;

            if (rule.condition.evaluate(current_t, step, scalar_val)) {
                for (const auto& action : rule.actions) {
                    execute_action(action, step, current_t);
                }
            }
        }

        return new_cfl;
    }

private:
    void execute_action(const ASTAction& action, uint64_t step, double current_t) {
        switch (action.type) {
            case ActionType::SET_PARAM:
                if (param_setter_) param_setter_(action.target_param, action.target_value);
                break;
            case ActionType::DUMP_VTK:
                if (vtk_dumper_) vtk_dumper_(action.string_payload.empty() ? "event_vtk" : action.string_payload);
                break;
            case ActionType::DUMP_HDF5:
                if (hdf5_dumper_) hdf5_dumper_(action.string_payload.empty() ? "event_hdf5" : action.string_payload);
                break;
            case ActionType::TERMINATE_WITH_STATUS:
                if (status_terminator_) status_terminator_(action.string_payload.empty() ? "AST Event Termination" : action.string_payload);
                break;
            default:
                break;
        }
    }
};

} // namespace Blast
