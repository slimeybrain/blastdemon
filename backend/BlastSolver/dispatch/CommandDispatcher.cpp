#include "CommandDispatcher.hpp"
#include "DispatchCFD.hpp"
#include "DispatchMPM.hpp"
#include "DispatchFEM.hpp"
#include "DispatchFSI.hpp"
#include "DispatchRemap.hpp"
#include <iostream>

namespace Blast {

CommandDispatcher::CommandDispatcher() {
    register_handler(std::make_shared<DispatchRemap>());
    register_handler(std::make_shared<DispatchFSI>());
    register_handler(std::make_shared<DispatchFEM>());
    register_handler(std::make_shared<DispatchMPM>());
    register_handler(std::make_shared<DispatchCFD>());
}

CommandDispatcher& CommandDispatcher::instance() {
    static CommandDispatcher s_inst;
    return s_inst;
}

void CommandDispatcher::register_handler(std::shared_ptr<ICommandHandler> handler) {
    if (handler) {
        m_handlers.push_back(handler);
    }
}

void CommandDispatcher::register_custom_callback(const std::string& command, 
                                                std::function<bool(const std::string&, const nlohmann::json&)> cb) {
    m_callbacks[command] = cb;
}

bool CommandDispatcher::has_handler(const std::string& command) const {
    if (m_callbacks.find(command) != m_callbacks.end()) {
        return true;
    }
    for (const auto& h : m_handlers) {
        if (h && h->can_handle(command)) {
            return true;
        }
    }
    return false;
}

bool CommandDispatcher::dispatch(const std::string& command, const nlohmann::json& msg) {
    auto cb_it = m_callbacks.find(command);
    if (cb_it != m_callbacks.end() && cb_it->second) {
        return cb_it->second(command, msg);
    }

    for (const auto& h : m_handlers) {
        if (h && h->can_handle(command)) {
            return h->handle(command, msg);
        }
    }
    return false;
}

} // namespace Blast
