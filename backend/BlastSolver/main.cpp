#include <iostream>
#include <vector>
#include <string>
#include <cmath>
#include <thread>
#include <chrono>
#include <sstream>
#include <iomanip>
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

void run1DSolver() {
    const int num_points = 100;
    const int num_steps = 50;
    const float dx = 1.0f;
    const float dt = 0.1f;
    const float speed = 2.0f;
    const float width = 5.0f;

    for (int step = 0; step < num_steps; ++step) {
        std::vector<float> pressure(num_points);
        float center = step * speed * dt * 10.0f; // Simplified movement

        std::stringstream ss;
        for (int i = 0; i < num_points; ++i) {
            float x = i * dx;
            pressure[i] = std::exp(-0.5f * std::pow((x - center) / width, 2.0f));
            ss << (i == 0 ? "" : ",") << pressure[i];
        }

        std::cout << "{\"telemetry\": \"" << ss.str() << "\"}" << std::endl;

        // Perform I/O every 10 steps
        if (step % 10 == 0) {
            std::stringstream frame_ss;
            frame_ss << "frame_" << std::setw(4) << std::setfill('0') << (step / 10);
            std::string base_name = frame_ss.str();
            std::string h5_filename = base_name + ".h5";
            std::string xmf_filename = base_name + ".xmf";

            if (HDF5Writer::writePressure(h5_filename, pressure)) {
                if (XDMFWriter::writeXDMF(xmf_filename, h5_filename, num_points, dx)) {
                    std::cout << "{\"type\": \"IO_SUCCESS\", \"file\": \"" << xmf_filename << "\"}" << std::endl;
                }
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

int main() {
    run1DSolver();
    return 0;
}
