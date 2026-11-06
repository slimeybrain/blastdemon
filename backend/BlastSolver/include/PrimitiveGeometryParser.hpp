#pragma once

#include "PrimitiveGeometry.hpp"
#include <nlohmann/json.hpp>

std::vector<Triangle> generate_primitives_triangles(const nlohmann::json& primitives_json);
