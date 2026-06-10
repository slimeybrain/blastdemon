#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>
#include <memory>
#include <thread>
#include <atomic>
#include <future>
#include <mutex>
#include <chrono>

#include <nlohmann/json.hpp>
#include "cfd_solver.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

// Global shared state
std::atomic<bool> cancel_flag{false};
std::atomic<int> step_progress{0};
std::atomic<bool> is_running{false};
std::atomic<int> target_steps_remaining{0};
std::atomic<bool> exec_until_end{false};
std::atomic<int> global_num_cells{0};
std::mutex cout_mutex;

// Forward declaration of telemetry helpers
void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);

void emit_kernel_log(const std::string& level, const std::string& msg, double t) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    std::cout << "[" << std::fixed << std::setprecision(4) << t << "s] [" << level << "] " << msg << std::endl;
}

void emit_resource_pulse() {
    std::lock_guard<std::mutex> lock(cout_mutex);
    int n = global_num_cells.load();
    nlohmann::json pulse;
    pulse["type"] = "resource_pulse";

    // Mathematical mock data calculated against active mesh cell count
    double load_factor = std::min(100.0, (double)n / 5000.0 * 100.0);
    pulse["cpu"] = 15.0 + (load_factor * 0.2);
    pulse["ram"] = 512 * 1024 * 1024 + (n * 1024ULL);
    pulse["gpu_util"] = 20.0 + (load_factor * 0.7);
    pulse["vram_util"] = 10.0 + (load_factor * 0.5);
    pulse["gpu_temp"] = 35 + (int)(load_factor * 0.4);

    std::cout << pulse.dump() << std::endl;
}

// Robust JSON value extraction helpers
float get_robust_float(const nlohmann::json& j, const std::string& key, float default_val) {
    if (!j.contains(key)) return default_val;
    if (j[key].is_number()) return j[key].get<float>();
    if (j[key].is_string()) {
        try {
            return std::stof(j[key].get<std::string>());
        } catch (...) {
            return default_val;
        }
    }
    return default_val;
}

int get_robust_int(const nlohmann::json& j, const std::string& key, int default_val) {
    if (!j.contains(key)) return default_val;
    if (j[key].is_number()) return j[key].get<int>();
    if (j[key].is_string()) {
        try {
            return std::stoi(j[key].get<std::string>());
        } catch (...) {
            return default_val;
        }
    }
    return default_val;
}

void worker_thread_func(CFDSolver* solver, double cfl, double* t_ptr) {
    is_running = true;
    cancel_flag = false;
    step_progress = 0;

    int initial_steps = target_steps_remaining.load();
    int initial_idx = solver->getActiveIndex();
    int total_range = solver->getNumCells() - initial_idx;

    auto last_telemetry_time = std::chrono::steady_clock::now();

    emit_kernel_log("INFO", "Solver step initialized.", *t_ptr);

    while (true) {
        if (cancel_flag.load()) break;

        bool done = false;
        if (exec_until_end.load()) {
            if (solver->getActiveIndex() >= solver->getNumCells()) {
                done = true;
            }
        } else {
            if (target_steps_remaining.load() <= 0) {
                done = true;
            }
        }

        if (done) break;

        double dt = solver->computeStepSize(cfl);
        solver->step(dt);
        *t_ptr += dt;

        // 30Hz Telemetry Throttle
        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        if (elapsed_ms >= 33) {
            emit_telemetry(*solver, *t_ptr, false);
            last_telemetry_time = now;
        }

        if (exec_until_end.load()) {
            if (total_range > 0) {
                int current_range = solver->getActiveIndex() - initial_idx;
                int p = std::clamp((int)((current_range * 100) / total_range), 0, 100);
                if (p != step_progress.load()) {
                    step_progress = p;
                    if (p % 10 == 0) {
                        std::stringstream ss;
                        ss << p << "% complete...";
                        emit_kernel_log("PROGRESS", ss.str(), *t_ptr);
                    }
                }
            }
        } else {
            target_steps_remaining--;
            int current_target = target_steps_remaining.load();
            if (initial_steps > 0) {
                int completed = initial_steps - current_target;
                step_progress = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
            } else {
                step_progress = 100;
            }
        }
    }

    // Guarantee Frame: Final precise telemetry bypasses throttle
    if (!cancel_flag.load()) {
        step_progress = 100;
        bool term = exec_until_end.load() && solver->getActiveIndex() >= solver->getNumCells();
        emit_telemetry(*solver, *t_ptr, term);
        emit_kernel_log("INFO", "Execution block completed.", *t_ptr);
    }

    target_steps_remaining = 0;
    exec_until_end = false;
    is_running = false;
}

int main() {
    std::string line;
    std::unique_ptr<CFDSolver> solver = nullptr;
    double t = 0.0;

    // Heartbeat & Progress emitter thread
    std::thread progress_emitter([]() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            emit_resource_pulse();
            if (is_running) {
                // We now use kernel logs for progress, but we keep this for the progress bar
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "{\"type\": \"progress\", \"percent\": " << step_progress.load() << "}" << std::endl;
            }
        }
    });
    progress_emitter.detach();

    std::thread worker;

    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        try {
            nlohmann::json msg = nlohmann::json::parse(line);
            std::string command = msg.value("command", "");

            if (command == "INIT" || command == "START") {
                if (is_running) {
                    cancel_flag = true;
                    if (worker.joinable()) worker.join();
                }

                // Explicit reset of execution control variables
                cancel_flag = false;
                target_steps_remaining = 0;
                step_progress = 0;
                exec_until_end = false;

                // Extract parameters
                int num_cells = get_robust_int(msg, "num_cells", get_robust_int(msg, "n_cells", 1000));
                global_num_cells = num_cells;
                double domain_radius = get_robust_float(msg, "domain_radius", get_robust_float(msg, "radius", 1.0));
                double gamma = get_robust_float(msg, "gamma", 1.4);

                // Instantiate/Reset the solver
                solver = std::make_unique<CFDSolver>(num_cells, domain_radius, gamma);
                solver->setCancelFlag(&cancel_flag);
                t = 0.0;

                // Solver configuration
                if (msg.contains("flux_scheme")) solver->setFluxScheme(msg["flux_scheme"]);
                if (msg.contains("spatial_order")) solver->setSpatialOrder(msg["spatial_order"]);
                if (msg.contains("temporal_order")) solver->setTemporalOrder(msg["temporal_order"]);

                // Initial Condition (TNT Blast)
                double explosive_radius = msg.value("explosive_radius", 0.1);
                double high_rho = msg.value("rho", 1630.0);
                double ambient_rho = msg.value("ambient_rho", 1.225);
                double ambient_p = msg.value("atm_pressure", 101325.0);

                solver->setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);

                // Emit initial telemetry frame (explicitly marked as not terminated)
                emit_telemetry(*solver, t, false);

            } else if (command == "STEP") {
                if (!solver) continue;
                int steps = get_robust_int(msg, "steps", 1);
                double cfl = get_robust_float(msg, "cfl", 0.4);

                target_steps_remaining += steps;
                if (!is_running) {
                    if (worker.joinable()) worker.join();
                    worker = std::thread(worker_thread_func, solver.get(), cfl, &t);
                }

            } else if (command == "EXEC_END") {
                if (!solver) continue;
                double cfl = get_robust_float(msg, "cfl", 0.4);

                exec_until_end = true;
                if (!is_running) {
                    if (worker.joinable()) worker.join();
                    worker = std::thread(worker_thread_func, solver.get(), cfl, &t);
                }

            } else if (command == "PAUSE") {
                cancel_flag = true;
                target_steps_remaining = 0;
                exec_until_end = false;

            } else if (command == "TERMINATE") {
                cancel_flag = true;
                target_steps_remaining = 0;
                exec_until_end = false;
                if (worker.joinable()) worker.join();

                if (solver) {
                    solver.reset();
                }
                t = 0.0;
                // Emit empty/zeroed telemetry frame with termination flag
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "{\"type\": \"TELEMETRY\", \"time\": 0.0, \"is_terminated\": true}" << std::endl;
            }

        } catch (const std::exception& e) {
            // Silently ignore or log error
            // std::cerr << "JSON Error: " << e.what() << std::endl;
        }
    }

    return 0;
}

void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    const std::vector<State>& states = solver.getStates();
    int n = solver.getNumCells();

    // 1. Emit Metadata JSON
    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY";
    envelope["time"] = elapsed;
    envelope["is_terminated"] = is_terminated;
    std::cout << envelope.dump() << std::endl;

    // 2. Emit Binary Frame (Pressure only)
    std::vector<float> p_data(n);
    for (int i = 0; i < n; ++i) {
        p_data[i] = (float)states[i].p;
    }

    size_t total_bytes = p_data.size() * sizeof(float);
    std::cout << "BIN_FRAME " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(p_data.data()), total_bytes);
    std::cout.flush();
}
