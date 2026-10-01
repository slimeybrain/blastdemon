#include "DispatchCFD.hpp"
#include <iostream>

namespace Blast {

bool DispatchCFD::is_cfd_command(const std::string& command) {
    return (command == "INIT" || command == "STEP" || command == "EXEC_ALL" || command == "EXEC_END" ||
            command == "PAUSE" || command == "RESUME" || command == "TERMINATE" ||
            command == "INIT_2D" || command == "STEP_2D" || command == "EXEC_ALL_2D" ||
            command == "PAUSE_2D" || command == "RESUME_2D" || command == "TERMINATE_2D" ||
            command == "INIT_3D" || command == "STEP_3D" || command == "EXEC_ALL_3D" ||
            command == "PAUSE_3D" || command == "RESUME_3D" || command == "TERMINATE_3D" ||
            command == "GET_SLICE" || command == "GET_SNAPSHOT" || command == "EXTRACT_SLICE");
}

bool DispatchCFD::can_handle(const std::string& command) const {
    return is_cfd_command(command);
}

bool DispatchCFD::handle(const std::string& command, const nlohmann::json& msg) {
    (void)msg;
    // Handled in main solver loop or delegated subroutines
    return is_cfd_command(command);
}

} // namespace Blast
