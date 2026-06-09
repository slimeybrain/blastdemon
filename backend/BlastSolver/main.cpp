#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>
#include <memory>

#include <nlohmann/json.hpp>
#include "cfd_solver.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

// Forward declaration of telemetry helper
void emit_telemetry(const CFDSolver& solver, double elapsed);

int main() {
    std::string line;
    std::unique_ptr<CFDSolver> solver = nullptr;
    double t = 0.0;

    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        try {
            nlohmann::json msg = nlohmann::json::parse(line);
            std::string command = msg.value("command", "");

            if (command == "INIT" || command == "START") {
                // Extract parameters
                int num_cells = msg.value("num_cells", msg.value("n_cells", 1000));
                double domain_radius = msg.value("domain_radius", msg.value("radius", 1.0));
                double gamma = msg.value("gamma", 1.4);

                // Instantiate/Reset the solver
                solver = std::make_unique<CFDSolver>(num_cells, domain_radius, gamma);
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
                if (!solver) continue;
                int steps = msg.value("steps", 1);
                double cfl = msg.value("cfl", 0.4);

                for (int i = 0; i < steps; ++i) {
                    double dt = solver->computeStepSize(cfl);
                    solver->step(dt);
                    t += dt;
                }

                // Emit one telemetry frame after the steps
                emit_telemetry(*solver, t);

            } else if (command == "TERMINATE") {
                if (solver) {
                    // Clear solver (implicitly by resetting pointer or explicitly if needed)
                    solver.reset();
                }
                t = 0.0;
                // Emit empty/zeroed telemetry frame
                std::cout << "{\"type\": \"TELEMETRY\", \"time\": 0.0, \"telemetry\": \"\", \"data\": []}" << std::endl;
            }

        } catch (const std::exception& e) {
            // Silently ignore or log error
            // std::cerr << "JSON Error: " << e.what() << std::endl;
        }
    }

    return 0;
}

void emit_telemetry(const CFDSolver& solver, double elapsed) {
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

    std::cout << envelope.dump() << std::endl;
}
