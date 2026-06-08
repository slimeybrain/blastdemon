#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>

#include "cfd_solver.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

/**
 * Lightweight JSON value extractor for basic simulation configuration.
 * Handles simple key-value pairs in a flat or nested structure.
 */
std::string get_json_value(const std::string& json, const std::string& key) {
    size_t pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) return "";

    pos = json.find(":", pos);
    if (pos == std::string::npos) return "";

    pos = json.find_first_not_of(" \t\n\r", pos + 1);
    if (pos == std::string::npos) return "";

    if (json[pos] == '"') {
        size_t end = json.find("\"", pos + 1);
        if (end == std::string::npos) return "";
        return json.substr(pos + 1, end - pos - 1);
    } else {
        size_t end = json.find_first_of(",}] \t\n\r", pos);
        if (end == std::string::npos) return json.substr(pos);
        return json.substr(pos, end - pos);
    }
}

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

    // --- 1. The JSON Setup Bridge ---

    // Domain & EOS Parameters
    int num_cells = 1000;
    double domain_radius = 10.0;
    double gamma = 1.4;

    std::string s_num_cells = get_json_value(input_json, "num_cells");
    if (s_num_cells.empty()) s_num_cells = get_json_value(input_json, "n_cells");
    if (!s_num_cells.empty()) num_cells = std::stoi(s_num_cells);

    std::string s_radius = get_json_value(input_json, "domain_radius");
    if (s_radius.empty()) s_radius = get_json_value(input_json, "radius");
    if (!s_radius.empty()) domain_radius = std::stod(s_radius);

    std::string s_gamma = get_json_value(input_json, "gamma");
    if (!s_gamma.empty()) gamma = std::stod(s_gamma);

    // Instantiate the solver
    CFDSolver solver(num_cells, domain_radius, gamma);

    // Solver configuration
    std::string flux_scheme = get_json_value(input_json, "flux_scheme");
    if (!flux_scheme.empty()) solver.setFluxScheme(flux_scheme);

    std::string s_spatial = get_json_value(input_json, "spatial_order");
    if (!s_spatial.empty()) solver.setSpatialOrder(std::stoi(s_spatial));

    std::string s_temporal = get_json_value(input_json, "temporal_order");
    if (!s_temporal.empty()) solver.setTemporalOrder(std::stoi(s_temporal));

    // Initial Condition (TNT Blast)
    double explosive_radius = 0.5;
    double high_rho = 1630.0;
    double ambient_rho = 1.225;
    double ambient_p = 101325.0;

    std::string s_exp_rad = get_json_value(input_json, "explosive_radius");
    if (!s_exp_rad.empty()) explosive_radius = std::stod(s_exp_rad);

    std::string s_high_rho = get_json_value(input_json, "high_rho");
    if (!s_high_rho.empty()) high_rho = std::stod(s_high_rho);

    std::string s_amb_rho = get_json_value(input_json, "ambient_rho");
    if (!s_amb_rho.empty()) ambient_rho = std::stod(s_amb_rho);

    std::string s_amb_p = get_json_value(input_json, "ambient_p");
    if (!s_amb_p.empty()) ambient_p = std::stod(s_amb_p);

    solver.setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);

    // Global execution params
    double duration = 0.01;
    std::string s_duration = get_json_value(input_json, "duration");
    if (!s_duration.empty()) duration = std::stod(s_duration);

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
            for (size_t i = 0; i < states.size(); ++i) {
                ss << (i == 0 ? "" : ",") << states[i].p;
            }

            // Format into compact JSON string envelope
            std::cout << "{\"type\": \"TELEMETRY\", \"time\": " << elapsed
                      << ", \"telemetry\": \"" << ss.str() << "\""
                      << ", \"data\": [" << ss.str() << "]}" << std::endl;
        }

        // --- 4. Heavy I/O Hook ---
        if (step_count % io_interval == 0) {
            const std::vector<State>& states = solver.getStates();
            std::vector<double> rho, p, u, alpha1, alpha2;
            rho.reserve(states.size());
            p.reserve(states.size());
            u.reserve(states.size());
            alpha1.reserve(states.size());
            alpha2.reserve(states.size());

            for (const auto& s : states) {
                rho.push_back(s.rho);
                p.push_back(s.p);
                u.push_back(s.u);
                alpha1.push_back(s.alpha1);
                alpha2.push_back(s.alpha2);
            }

            std::stringstream frame_ss;
            frame_ss << "frame_" << std::setw(4) << std::setfill('0') << (step_count / io_interval);
            std::string base_name = frame_ss.str();
            std::string h5_filename = base_name + ".h5";
            std::string xmf_filename = base_name + ".xmf";

            // Pass vectors to HDF5Writer (Phase 7) and XDMFWriter
            if (HDF5Writer::writeFrame(h5_filename, rho, p, u, alpha1, alpha2)) {
                if (XDMFWriter::writeXDMF(xmf_filename, h5_filename, solver.getNumCells(), solver.getCellSize())) {
                    // Output IO_SUCCESS notification for the Broker
                    std::cout << "{\"type\": \"IO_SUCCESS\", \"file\": \"" << xmf_filename << "\"}" << std::endl;
                }
            }
        }
    }

    // Ensure final state is printed
    std::cout.flush();

    return 0;
}
