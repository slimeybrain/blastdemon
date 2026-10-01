#pragma once

#include "CommandDispatcher.hpp"

namespace Blast {

class DispatchCFD : public ICommandHandler {
public:
    const char* name() const override { return "DispatchCFD"; }
    bool can_handle(const std::string& command) const override;
    bool handle(const std::string& command, const nlohmann::json& msg) override;

    static bool is_cfd_command(const std::string& command);
};

} // namespace Blast
