#include "DispatchMPM.hpp"
#include <iostream>

namespace Blast {

bool DispatchMPM::is_mpm_command(const std::string& command) {
    return (command == "INIT_MPM" || command == "INIT_2D_MPM" ||
            command == "STEP_MPM" || command == "STEP_2D_MPM" ||
            command == "EXEC_ALL_MPM" ||
            command == "PAUSE_MPM" || command == "RESUME_MPM" || command == "TERMINATE_MPM" ||
            command == "INIT_MPM_3D" || command == "INIT_3D_MPM" ||
            command == "STEP_MPM_3D" || command == "STEP_3D_MPM" ||
            command == "EXEC_ALL_MPM_3D" ||
            command == "PAUSE_MPM_3D" || command == "RESUME_MPM_3D" || command == "TERMINATE_MPM_3D");
}

bool DispatchMPM::can_handle(const std::string& command) const {
    return is_mpm_command(command);
}

bool DispatchMPM::handle(const std::string& command, const nlohmann::json& msg) {
    (void)msg;
    return is_mpm_command(command);
}

} // namespace Blast
