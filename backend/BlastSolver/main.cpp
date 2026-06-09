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
std::mutex cout_mutex;

// Forward declaration of telemetry helper
void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);

void worker_thread_func(CFDSolver* solver, int steps, double cfl, double* t_ptr, bool until_end) {
    is_running = true;
    cancel_flag = false;
    step_progress = 0;

    if (until_end) {
        int initial_idx = solver->getActiveIndex();
        int total_range = solver->getNumCells() - initial_idx;

        while (solver->getActiveIndex() < solver->getNumCells()) {
            if (cancel_flag.load()) break;

            double dt = solver->computeStepSize(cfl);
            solver->step(dt);
            *t_ptr += dt;

            if (total_range > 0) {
                int current_range = solver->getActiveIndex() - initial_idx;
                step_progress = std::clamp((int)((current_range * 100) / total_range), 0, 100);
            }
        }
    } else {
        for (int i = 0; i < steps; ++i) {
            if (cancel_flag.load()) break;

            double dt = solver->computeStepSize(cfl);
            solver->step(dt);
            *t_ptr += dt;

            step_progress = (int)(((i + 1) * 100) / steps);
        }
    }

    if (!cancel_flag.load()) {
        step_progress = 100;
        emit_telemetry(*solver, *t_ptr, until_end && solver->getActiveIndex() >= solver->getNumCells());
    }

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

                // Emit initial telemetry
                emit_telemetry(*solver, t);

            } else if (command == "STEP") {
                if (!solver || is_running) continue;
                int steps = msg.value("steps", 1);
                double cfl = msg.value("cfl", 0.4);

                if (worker.joinable()) worker.join();
                worker = std::thread(worker_thread_func, solver.get(), steps, cfl, &t, false);

            } else if (command == "EXEC_END") {
                if (!solver || is_running) continue;
                double cfl = msg.value("cfl", 0.4);

                if (worker.joinable()) worker.join();
                worker = std::thread(worker_thread_func, solver.get(), 0, cfl, &t, true);

            } else if (command == "PAUSE") {
                cancel_flag = true;

            } else if (command == "TERMINATE") {
                cancel_flag = true;
                if (worker.joinable()) worker.join();

                if (solver) {
                    solver.reset();
                }
                t = 0.0;
                // Emit empty/zeroed telemetry frame with termination flag
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "{\"type\": \"TELEMETRY\", \"time\": 0.0, \"telemetry\": \"\", \"data\": [], \"is_terminated\": true}" << std::endl;
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

    std::stringstream ss;
    ss << std::fixed << std::setprecision(4);

    nlohmann::json data_arr = nlohmann::json::array();

    for (int i = 0; i < n; ++i) {
        ss << (i == 0 ? "" : ",") << states[i].p;
        data_arr.push_back(states[i].p);
    }

    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY";
    envelope["time"] = elapsed;
    envelope["telemetry"] = ss.str();
    envelope["data"] = data_arr;
    envelope["is_terminated"] = is_terminated;

    std::cout << envelope.dump() << std::endl;
}
