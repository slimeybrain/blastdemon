#include <poll.h>
#include <unistd.h>
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

// Global shared state for Phase 16.0 - Zero-Omission Architecture
std::atomic<bool> sim_running{false};
std::atomic<bool> sim_paused{false};
std::atomic<bool> sim_terminate{false};
std::atomic<int> step_progress{0};
std::atomic<int> global_num_cells{0};
std::atomic<int> global_target_steps{0};
std::atomic<bool> global_exec_until_end{false};
std::atomic<double> global_cfl{0.4};
std::mutex cout_mutex;

// Global solver pointer and time for background thread access
std::unique_ptr<CFDSolver> global_solver = nullptr;
double global_t = 0.0;

// Forward declarations
void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);
void emit_resource_pulse();

void emit_kernel_log(const std::string& level, const std::string& msg, double t) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    std::cout << "[" << std::fixed << std::setprecision(4) << t << "s] [" << level << "] " << msg << std::endl;
}

void worker_thread_func() {
    if (!global_solver) {
        sim_running = false;
        return;
    }

    auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps.load();
    int initial_idx = global_solver->getActiveIndex();
    int total_range = global_solver->getNumCells() - initial_idx;

    emit_kernel_log("INFO", "Asynchronous worker thread started.", global_t);

    while (sim_running) {
        if (sim_terminate) break;

        if (sim_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        // Check completion conditions
        bool done = false;
        if (global_exec_until_end.load()) {
            if (global_solver->is_terminated()) done = true;
        } else {
            if (global_target_steps.load() <= 0) done = true;
        }

        if (done) break;

        // Perform simulation step
        double dt = global_solver->computeStepSize(global_cfl.load());
        global_solver->step(dt);
        global_t += dt;

        if (!global_exec_until_end.load()) {
            global_target_steps--;
        }

        // 30Hz Telemetry Heartbeat Throttle
        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        if (elapsed_ms >= 33) {
            emit_telemetry(*global_solver, global_t, false);
            last_telemetry_time = now;

            // Update progress metrics
            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t;

            if (global_exec_until_end.load()) {
                if (total_range > 0) {
                    int current_range = global_solver->getActiveIndex() - initial_idx;
                    int percent = std::clamp((int)((current_range * 100) / total_range), 0, 100);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["mode"] = "EXEC_ALL";
                }
            } else {
                if (initial_steps > 0) {
                    int completed = initial_steps - global_target_steps.load();
                    int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["completed"] = completed;
                    progress_msg["total"] = initial_steps;
                    progress_msg["mode"] = "STEP";
                }
            }
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }
    }

    // Guarantee Final Precise Telemetry Frame
    bool term = global_solver->is_terminated();
    emit_telemetry(*global_solver, global_t, term);

    if (term) step_progress = 100;

    emit_kernel_log("INFO", "Worker thread execution cycle ended.", global_t);

    sim_running = false;
    sim_paused = false;
    sim_terminate = false;
    global_target_steps = 0;
    global_exec_until_end = false;
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

void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    const std::vector<State>& states = solver.getStates();
    int n = solver.getNumCells();

    // 1. Emit Metadata JSON envelope
    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY";
    envelope["time"] = elapsed;
    envelope["is_terminated"] = is_terminated;
    std::cout << envelope.dump() << std::endl;

    // 2. Emit structured multi-channel binary frame
    //    Header: [uint32 n_cells][uint32 n_channels=7]
    //    Payload channels (each n floats): [pressure][density][velocity][internal_energy][mass_frac_burned][mass_frac_unburnt][mass_frac_air]
    //    Internal energy: e_int = E/rho - 0.5*u*u  (specific internal energy, J/kg)
    const uint32_t n_cells    = static_cast<uint32_t>(n);
    const uint32_t n_channels = 7;

    std::vector<float> frame;
    frame.reserve(n * n_channels);

    // Channel 0: Pressure
    for (int i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].p));
    // Channel 1: Density
    for (int i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].rho));
    // Channel 2: Velocity
    for (int i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].u));
    // Channel 3: Specific internal energy  e_int = E/rho - 0.5*u^2
    for (int i = 0; i < n; ++i) {
        double rho = states[i].rho;
        double e_int = (rho > 0.0) ? (states[i].E / rho - 0.5 * states[i].u * states[i].u) : 0.0;
        frame.push_back(static_cast<float>(e_int));
    }
    // Channel 4: Volume Fraction (burned products)  alpha1
    for (int i = 0; i < n; ++i) {
        frame.push_back(static_cast<float>(std::clamp(states[i].alpha1, 0.0, 1.0)));
    }
    // Channel 5: Volume Fraction (unburnt reactant)  alpha2
    for (int i = 0; i < n; ++i) {
        frame.push_back(static_cast<float>(std::clamp(states[i].alpha2, 0.0, 1.0)));
    }
    // Channel 6: Volume Fraction (air)  1.0 - alpha1 - alpha2
    for (int i = 0; i < n; ++i) {
        double air_frac = 1.0 - states[i].alpha1 - states[i].alpha2;
        frame.push_back(static_cast<float>(std::clamp(air_frac, 0.0, 1.0)));
    }

    // Prefix with 8-byte header then raw float data
    size_t header_bytes  = sizeof(uint32_t) * 2;
    size_t payload_bytes = frame.size() * sizeof(float);
    size_t total_bytes   = header_bytes + payload_bytes;

    std::cout << "BIN_FRAME " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&n_cells),    sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&n_channels), sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(frame.data()), payload_bytes);
    std::cout.flush();
}


int main() {
    std::string line;

    // Heartbeat & Progress Emitter Thread
    std::thread pulse_thread([]() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            emit_resource_pulse();
        }
    });
    pulse_thread.detach();

    // Dedicated stdin listener thread using poll()
    std::thread stdin_listener_thread([]() {
        std::string line;
        struct pollfd pfd;
        pfd.fd = STDIN_FILENO;
        pfd.events = POLLIN;

        while (true) {
            int ret = std::cin.rdbuf()->in_avail() > 0 ? 1 : poll(&pfd, 1, 50);
            if (ret > 0 && (std::cin.rdbuf()->in_avail() > 0 || (pfd.revents & POLLIN))) {
                if (!std::getline(std::cin, line)) {
                    break; // EOF or error
                }
                if (line.empty()) continue;

                try {
                    nlohmann::json msg = nlohmann::json::parse(line);
                    std::string command = msg.value("command", "");

                    if (command == "INIT") {
                        // Signal termination and wait for worker to clear
                        sim_terminate = true;
                        sim_running = false;
                        std::this_thread::sleep_for(std::chrono::milliseconds(50));

                        sim_terminate = false;
                        sim_paused = false;
                        step_progress = 0;

                        // Live Parameter Binding (Zero-Omission)
                        int n_cells = msg.at("n_cells").get<int>();
                        double radius = msg.at("domain_radius").get<double>();
                        double gamma = msg.at("gamma").get<double>();

                        global_num_cells = n_cells;
                        global_solver = std::make_unique<CFDSolver>(n_cells, radius, gamma);
                        global_t = 0.0;

                        global_solver->setFluxScheme(msg.at("flux_scheme").get<std::string>());
                        global_solver->setSpatialOrder(msg.at("spatial_order").get<int>());
                        global_solver->setTemporalOrder(msg.at("temporal_order").get<int>());

                        double explosive_radius = msg.at("explosive_radius").get<double>();
                        double high_rho         = msg.at("rho").get<double>();
                        double ambient_rho      = msg.at("ambient_rho").get<double>();
                        double ambient_p        = msg.at("atm_pressure").get<double>();

                        // --- Initialisation mode selection ---
                        std::string init_mode   = msg.value("init_mode",   "Multi-Material JWL");
                        std::string composition  = msg.value("composition", "TNT");

                        // Select JWL material set from composition string
                        MultiMat::MaterialSet matSet = MultiMat::TNT;
                        if      (composition == "PETN") matSet = MultiMat::PETN;
                        else if (composition == "RDX")  matSet = MultiMat::RDX;
                        else if (composition == "Custom" || composition == "CUSTOM") {
                            double jwl_A     = msg.value("jwl_A",     373.77e9);
                            double jwl_B     = msg.value("jwl_B",     3.747e9);
                            double jwl_R1    = msg.value("jwl_R1",    4.15);
                            double jwl_R2    = msg.value("jwl_R2",    0.90);
                            double jwl_omega = msg.value("jwl_omega", 0.35);
                            double det_vel   = msg.value("det_vel",   6930.0);
                            double det_energy= msg.value("detonation_energy", 4.29e6);

                            matSet.products  = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                            matSet.unreacted = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                            matSet.det_vel   = det_vel;
                            matSet.detonation_energy = det_energy;
                        }
                        global_solver->setMaterialParameters(matSet);

                        if (init_mode == "Ideal Gas") {
                            // Single-material ideal gas burst.
                            // detonation_energy is the specific internal energy (J/kg) of the charge.
                            double det_energy = msg.value("detonation_energy", 4520000.0);
                            global_solver->setInitialConditionIdealGas(
                                explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                            emit_kernel_log("SYSTEM",
                                "Solver Initialized [Ideal Gas mode, gamma=" + std::to_string(gamma) + "].", global_t);
                        } else {
                            // Multi-Material JWL: detonation products + unreacted explosive + air.
                            global_solver->setInitialConditionTNT(
                                explosive_radius, high_rho, ambient_rho, ambient_p);
                            emit_kernel_log("SYSTEM",
                                "Solver Initialized [Multi-Material JWL, composition=" + composition + "].", global_t);
                        }

                        emit_telemetry(*global_solver, global_t, false);
                        emit_kernel_log("SYSTEM", "Solver ready. Zero-Omission binding complete.", global_t);

                    } else if (command == "STEP") {
                        if (!global_solver) {
                            emit_kernel_log("ERROR", "Cannot execute simulation step: Solver is uninitialized. Send INIT first.", global_t);
                            continue;
                        }
                        global_target_steps = msg.at("steps").get<int>();
                        global_cfl = msg.value("cfl", 0.4);
                        global_exec_until_end = false;

                        if (!sim_running) {
                            sim_running = true;
                            sim_paused = false;
                            sim_terminate = false;
                            std::thread(worker_thread_func).detach();
                        } else {
                            sim_paused = false; // Resume if was paused
                        }

                    } else if (command == "EXEC_ALL" || command == "EXEC_END") {
                        if (!global_solver) {
                            emit_kernel_log("ERROR", "Cannot execute simulation: Solver is uninitialized. Send INIT first.", global_t);
                            continue;
                        }
                        global_cfl = msg.value("cfl", 0.4);
                        global_exec_until_end = true;

                        if (!sim_running) {
                            sim_running = true;
                            sim_paused = false;
                            sim_terminate = false;
                            std::thread(worker_thread_func).detach();
                        } else {
                            sim_paused = false;
                        }

                    } else if (command == "EXEC_1K") {
                        if (!global_solver) {
                            emit_kernel_log("ERROR", "Cannot execute 1000 steps: Solver is uninitialized. Send INIT first.", global_t);
                            continue;
                        }
                        global_target_steps = 1000;
                        global_cfl = msg.value("cfl", 0.4);
                        global_exec_until_end = false;

                        if (!sim_running) {
                            sim_running = true;
                            sim_paused = false;
                            sim_terminate = false;
                            std::thread(worker_thread_func).detach();
                        } else {
                            sim_paused = false;
                        }

                    } else if (command == "PAUSE") {
                        sim_paused = true;
                        global_target_steps = 0; // Cancel remaining steps on pause/interrupt
                        emit_kernel_log("SYSTEM", "Execution Paused/Interrupted.", global_t);

                    } else if (command == "RESUME") {
                        sim_paused = false;
                        emit_kernel_log("SYSTEM", "Execution Resumed.", global_t);

                    } else if (command == "TERMINATE") {
                        sim_terminate = true;
                        sim_running = false;

                        // Spin-wait briefly until the worker thread has stopped running
                        int wait_count = 0;
                        while (sim_running.load() && wait_count < 10) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(10));
                            wait_count++;
                        }

                        global_solver.reset(); // Deallocate memory
                        global_num_cells = 0;
                        global_t = 0.0;
                        step_progress = 0;

                        emit_kernel_log("SYSTEM", "Execution Terminated. Memory cleared, ready for new simulation.", 0.0);
                    }

                } catch (const std::exception& e) {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << "[ERROR] JSON/Binding Error: " << e.what() << std::endl;
                }
            }
        }
    });
    stdin_listener_thread.join();

    return 0;
}
