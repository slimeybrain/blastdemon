#include "DispatchRemap.hpp"
#include <iostream>

namespace Blast {

bool DispatchRemap::is_remap_command(const std::string& command) {
    return (command == "REMAP" || command == "REMAP_2D" ||
            command == "REMAP_1D_TO_3D" || command == "REMAP_2D_TO_3D");
}

bool DispatchRemap::can_handle(const std::string& command) const {
    return is_remap_command(command);
}

bool DispatchRemap::handle(const std::string& command, const nlohmann::json& msg) {
    (void)msg;
    return is_remap_command(command);
}

} // namespace Blast
