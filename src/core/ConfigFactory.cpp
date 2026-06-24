#include "../domain/GridParams.hpp"
#include <nlohmann/json.hpp>
#include <cuda_runtime.h>
#include <string>
#include <vector>
#include <iostream>

using json = nlohmann::json;

void parse_init_payload(const std::string& json_str, SimulationState& state) {
    try {
        auto data = json::parse(json_str);

        std::vector<float> h_exp_x;
        std::vector<float> h_exp_y;
        std::vector<float> h_exp_mass;

        if (data.contains("nodes") && data["nodes"].is_array()) {
            for (const auto& node : data["nodes"]) {
                std::string type = node.value("type", "");

                if (type == "DomainMesh") {
                    auto params = node["params"];
                    state.nx = params.value("nx", 128);
                    state.ny = params.value("ny", 128);
                    state.dx = params.value("dx", 0.01f);
                    state.dy = params.value("dy", 0.01f);
                }
                else if (type == "MaterialExplosive") {
                    auto params = node["params"];
                    h_exp_x.push_back(params.value("x", 0.0f));
                    h_exp_y.push_back(params.value("y", 0.0f));
                    h_exp_mass.push_back(params.value("charge_mass", 1.0f));
                }
            }
        }

        state.num_explosives = static_cast<int>(h_exp_x.size());

        // Allocate and copy explosive data to device
        if (state.num_explosives > 0) {
            size_t size = state.num_explosives * sizeof(float);
            cudaMalloc(&state.d_exp_x, size);
            cudaMalloc(&state.d_exp_y, size);
            cudaMalloc(&state.d_exp_mass, size);

            cudaMemcpy(state.d_exp_x, h_exp_x.data(), size, cudaMemcpyHostToDevice);
            cudaMemcpy(state.d_exp_y, h_exp_y.data(), size, cudaMemcpyHostToDevice);
            cudaMemcpy(state.d_exp_mass, h_exp_mass.data(), size, cudaMemcpyHostToDevice);
        }

        // Allocate grid state on device
        if (state.nx > 0 && state.ny > 0) {
            size_t grid_size = static_cast<size_t>(state.nx) * state.ny * sizeof(float);
            cudaMalloc(&state.d_density, grid_size);
            cudaMalloc(&state.d_energy, grid_size);
            cudaMalloc(&state.d_momentum_x, grid_size);
            cudaMalloc(&state.d_momentum_y, grid_size);

            // Initialize with zeros or default values
            cudaMemset(state.d_density, 0, grid_size);
            cudaMemset(state.d_energy, 0, grid_size);
            cudaMemset(state.d_momentum_x, 0, grid_size);
            cudaMemset(state.d_momentum_y, 0, grid_size);
        }

    } catch (const std::exception& e) {
        std::cerr << "Failed to parse init payload: " << e.what() << std::endl;
    }
}
