#include "DispatchFEM.hpp"
#include <iostream>

namespace Blast {

bool DispatchFEM::is_fem_command(const std::string& command) {
    return (command == "INIT_FEM_3D" || command == "INIT_3D_FEM" ||
            command == "STEP_FEM_3D" || command == "EXEC_ALL_FEM_3D" ||
            command == "PAUSE_FEM_3D" || command == "TERMINATE_FEM_3D");
}

bool DispatchFEM::can_handle(const std::string& command) const {
    return is_fem_command(command);
}

bool DispatchFEM::handle(const std::string& command, const nlohmann::json& msg) {
    (void)msg;
    return is_fem_command(command);
}

} // namespace Blast
