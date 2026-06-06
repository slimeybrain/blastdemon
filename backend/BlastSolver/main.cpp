#include <iostream>
#include <vector>
#include <string>
#include <cmath>
#include <thread>
#include <chrono>
#include <sstream>

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
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

int main() {
    run1DSolver();
    return 0;
}
