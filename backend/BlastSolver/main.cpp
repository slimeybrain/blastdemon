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
std::mutex cout_mutex;

// Forward declaration of telemetry helper
void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);

void worker_thread_func(CFDSolver* solver, double cfl, double* t_ptr) {
    is_running = true;
    cancel_flag = false;
    step_progress = 0;

    int initial_steps = target_steps_remaining.load();
    int initial_idx = solver->getActiveIndex();
    int total_range = solver->getNumCells() - initial_idx;

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

        if (exec_until_end.load()) {
            if (total_range > 0) {
                int current_range = solver->getActiveIndex() - initial_idx;
                step_progress = std::clamp((int)((current_range * 100) / total_range), 0, 100);
            }
        } else {
            target_steps_remaining--;
            int current_target = target_steps_remaining.load();
            if (initial_steps > 0) {
                // This is a bit tricky if steps are added while running, but it's okay for progress bar
                int completed = initial_steps - current_target;
                step_progress = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
            } else {
                step_progress = 100;
            }
        }
    }

    if (!cancel_flag.load()) {
        step_progress = 100;
        bool term = exec_until_end.load() && solver->getActiveIndex() >= solver->getNumCells();
        emit_telemetry(*solver, *t_ptr, term);
    }

    target_steps_remaining = 0;
    exec_until_end = false;
    is_running = false;
}

int main() {
    std::string line;
    std::unique_ptr<CFDSolver> solver = nullptr;
    double t = 0.0;

    // Progress emitter thread
    std::thread progress_emitter([]() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            if (is_running) {
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
                int num_cells = msg.value("num_cells", msg.value("n_cells", 1000));
                double domain_radius = msg.value("domain_radius", msg.value("radius", 1.0));
                double gamma = msg.value("gamma", 1.4);

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
                int steps = msg.value("steps", 1);
                double cfl = msg.value("cfl", 0.4);

                target_steps_remaining += steps;
                if (!is_running) {
                    if (worker.joinable()) worker.join();
                    worker = std::thread(worker_thread_func, solver.get(), cfl, &t);
                }

            } else if (command == "EXEC_END") {
                if (!solver) continue;
                double cfl = msg.value("cfl", 0.4);

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
