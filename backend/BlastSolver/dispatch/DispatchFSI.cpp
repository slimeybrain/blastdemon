#include "DispatchFSI.hpp"
#include <iostream>

namespace Blast {

bool DispatchFSI::is_fsi_command(const std::string& command) {
    return (command == "INIT_FSI_2D" || command == "INIT_FSI" ||
            command == "STEP_FSI_2D" || command == "STEP_FSI" ||
            command == "EXEC_ALL_FSI_2D" || command == "EXEC_ALL_FSI" ||
            command == "PAUSE_FSI_2D" || command == "PAUSE_FSI" ||
            command == "TERMINATE_FSI_2D" || command == "TERMINATE_FSI" ||
            command == "INIT_FSI_3D" || command == "STEP_FSI_3D" ||
            command == "EXEC_ALL_FSI_3D" || command == "PAUSE_FSI_3D" ||
            command == "TERMINATE_FSI_3D" ||
            command == "INIT_FEM_FSI_3D" || command == "STEP_FEM_FSI_3D" ||
            command == "EXEC_ALL_FEM_FSI_3D" || command == "PAUSE_FEM_FSI_3D" ||
            command == "TERMINATE_FEM_FSI_3D");
}

bool DispatchFSI::can_handle(const std::string& command) const {
    return is_fsi_command(command);
}

bool DispatchFSI::handle(const std::string& command, const nlohmann::json& msg) {
    (void)msg;
    return is_fsi_command(command);
}

} // namespace Blast
