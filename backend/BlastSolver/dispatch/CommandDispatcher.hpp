#pragma once

#include <string>
#include <memory>
#include <vector>
#include <unordered_map>
#include <functional>
#include "nlohmann/json.hpp"

namespace Blast {

class ICommandHandler {
public:
    virtual ~ICommandHandler() = default;
    virtual const char* name() const = 0;
    virtual bool can_handle(const std::string& command) const = 0;
    virtual bool handle(const std::string& command, const nlohmann::json& msg) = 0;
};

class CommandDispatcher {
public:
    static CommandDispatcher& instance();

    void register_handler(std::shared_ptr<ICommandHandler> handler);

    bool dispatch(const std::string& command, const nlohmann::json& msg);

    bool has_handler(const std::string& command) const;

    void register_custom_callback(const std::string& command, 
                                  std::function<bool(const std::string&, const nlohmann::json&)> cb);

private:
    CommandDispatcher();
    ~CommandDispatcher() = default;

    std::vector<std::shared_ptr<ICommandHandler>> m_handlers;
    std::unordered_map<std::string, std::function<bool(const std::string&, const nlohmann::json&)>> m_callbacks;
};

} // namespace Blast
