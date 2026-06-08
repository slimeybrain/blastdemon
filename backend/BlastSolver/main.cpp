#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>

#include <nlohmann/json.hpp>
#include "cfd_solver.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

int main() {
    std::string input_json;
    std::string line;

    // Read JSON configuration from stdin.
    // The Broker sends the JSON followed by a double newline.
    while (std::getline(std::cin, line)) {
        if (line.empty()) break;
        input_json += line;
    }

    if (input_json.empty()) {
        input_json = "{}";
    }

    nlohmann::json config = nlohmann::json::parse(input_json);

    // --- 1. The JSON Setup Bridge ---

    // Domain & EOS Parameters
    int num_cells = 1000;
    if (config.contains("num_cells")) num_cells = config["num_cells"];
    else if (config.contains("n_cells")) num_cells = config["n_cells"];

    double domain_radius = 10.0;
    if (config.contains("domain_radius")) domain_radius = config["domain_radius"];
    else if (config.contains("radius")) domain_radius = config["radius"];

    double gamma = 1.4;
    if (config.contains("gamma")) gamma = config["gamma"];

    // Instantiate the solver
    CFDSolver solver(num_cells, domain_radius, gamma);

    // Solver configuration
    if (config.contains("flux_scheme")) solver.setFluxScheme(config["flux_scheme"]);
    if (config.contains("spatial_order")) solver.setSpatialOrder(config["spatial_order"]);
    if (config.contains("temporal_order")) solver.setTemporalOrder(config["temporal_order"]);

    // Initial Condition (TNT Blast)
    double explosive_radius = 0.5;
    double high_rho = 1630.0;
    double ambient_rho = 1.225;
    double ambient_p = 101325.0;

    if (config.contains("explosive_radius")) explosive_radius = config["explosive_radius"];
    if (config.contains("high_rho")) high_rho = config["high_rho"];
    if (config.contains("ambient_rho")) ambient_rho = config["ambient_rho"];
    if (config.contains("ambient_p")) ambient_p = config["ambient_p"];

    solver.setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);

    // Global execution params
    double duration = 0.01;
    if (config.contains("duration")) duration = config["duration"];

    // --- 2. Loop Unrolling (Inversion of Control) ---

    double elapsed = 0.0;
    int step_count = 0;
    const int telemetry_interval = 10;
    const int io_interval = 50;

    while (elapsed < duration) {
        // Compute adaptive time step
        double dt = solver.computeStepSize(0.4);
        if (elapsed + dt > duration) dt = duration - elapsed;

        // Take a single solver step
        solver.step(dt);
        elapsed += dt;
        step_count++;

        // --- 3. Live Telemetry Hook ---
        if (step_count % telemetry_interval == 0) {
            const std::vector<State>& states = solver.getStates();
            std::stringstream ss;
            ss << std::fixed << std::setprecision(4);
            for (int i = 0; i < solver.getNumCells(); ++i) {
                ss << (i == 0 ? "" : ",") << states[i].p;
            }

            // Format into compact JSON string envelope
            std::cout << "{\"type\": \"TELEMETRY\", \"time\": " << elapsed
                      << ", \"telemetry\": \"" << ss.str() << "\""
                      << ", \"data\": [" << ss.str() << "]}" << std::endl;
        }

        // --- 4. Heavy I/O Hook ---
        if (step_count % io_interval == 0) {
            const auto& current_states = solver.getStates();
            std::vector<double> rho_vec, p_vec, u_vec, alpha1_vec, alpha2_vec;
            rho_vec.reserve(current_states.size());
            p_vec.reserve(current_states.size());
            u_vec.reserve(current_states.size());
            alpha1_vec.reserve(current_states.size());
            alpha2_vec.reserve(current_states.size());

            for(const auto& s : current_states) {
                rho_vec.push_back(s.rho);
                p_vec.push_back(s.p);
                u_vec.push_back(s.u);
                alpha1_vec.push_back(s.alpha1);
                alpha2_vec.push_back(s.alpha2);
            }

            std::stringstream frame_ss;
            frame_ss << "frame_" << std::setw(4) << std::setfill('0') << (step_count / io_interval);
            std::string base_name = frame_ss.str();
            std::string h5_filename = base_name + ".h5";
            std::string xmf_filename = base_name + ".xmf";

            // Pass vectors to HDF5Writer (Phase 7) and XDMFWriter
            if (HDF5Writer::writeFrame(h5_filename, rho_vec, p_vec, u_vec, alpha1_vec, alpha2_vec)) {
                if (XDMFWriter::writeXDMF(xmf_filename, h5_filename, solver.getNumCells(), solver.getCellSize())) {
                    // Output IO_SUCCESS notification for the Broker
                    std::cout << "{\"type\": \"IO_SUCCESS\", \"time\": " << elapsed << "}" << std::endl;
                }
            }
        }
    }

    // Ensure final state is printed
    std::cout.flush();

    return 0;
}
