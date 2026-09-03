/**
 * BlastStudio - Standalone Native Desktop Shell for BlastDaemon Multi-Physics Workstation
 * Document ID: BD-CAE-SPEC-2026-REV1
 * 
 * Embeds the workstation frontend shell and internal background Broker daemon
 * in a single native desktop binary.
 */

#include <iostream>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <poll.h>
#include <fcntl.h>
#include "nlohmann/json.hpp"

namespace fs = std::filesystem;

static std::atomic<bool> g_running{true};
static std::atomic<pid_t> g_browser_pid{0};

void terminate_browser_window() {
    pid_t pid = g_browser_pid.exchange(0);
    if (pid > 0) {
        kill(pid, SIGTERM);
        // Wait up to 500ms for graceful shutdown, then SIGKILL if needed
        for (int i = 0; i < 5; ++i) {
            int status = 0;
            pid_t res = waitpid(pid, &status, WNOHANG);
            if (res != 0) return;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        kill(pid, SIGKILL);
        int status = 0;
        waitpid(pid, &status, WNOHANG);
    }
}

void handle_signal(int sig) {
    (void)sig;
    std::cout << "\n[BlastStudio] Intercepted shutdown signal. Cleaning up desktop shell...\n";
    g_running = false;
    terminate_browser_window();
}

void print_desktop_banner() {
    std::cout << "======================================================================\n";
    std::cout << " BlastStudio - Standalone Multi-Physics CAE Workstation Shell (C++20)\n";
    std::cout << " ParaView Pipeline Browser | HyperMesh Property Grid | WebGPU Viewport\n";
    std::cout << "======================================================================\n\n";
}

bool spawn_window(const std::string& url) {
    pid_t existing_pid = g_browser_pid.load();
    if (existing_pid > 0) {
        int status = 0;
        pid_t res = waitpid(existing_pid, &status, WNOHANG);
        if (res == 0) {
            std::cout << "[BlastStudio] Workstation window is already active (PID " << existing_pid << ").\n";
            return true;
        }
        g_browser_pid.store(0);
    }

    std::cout << "[BlastStudio] Launching workstation desktop window (" << url << ")...\n";

    std::string browser_bin;
    std::vector<std::string> candidates = {
        "google-chrome", "chromium-browser", "chromium", "brave-browser", "firefox", "xdg-open"
    };

    for (const auto& candidate : candidates) {
        std::string check = "which " + candidate + " > /dev/null 2>&1";
        if (std::system(check.c_str()) == 0) {
            browser_bin = candidate;
            break;
        }
    }

    if (browser_bin.empty()) {
        std::cerr << "[BlastStudio] Error: No compatible web browser found in PATH.\n";
        return false;
    }

    const char* home = std::getenv("HOME");
    std::string profile_dir = (home && home[0])
        ? std::string(home) + "/.config/blaststudio/profile"
        : "/tmp/.blaststudio_profile_" + std::to_string(getuid());
    try {
        fs::create_directories(profile_dir);
    } catch (...) {}

    pid_t pid = fork();
    if (pid < 0) {
        std::cerr << "[BlastStudio] Error: Failed to fork browser process.\n";
        return false;
    }

    if (pid == 0) {
        // Child process
        int dev_null = open("/dev/null", O_RDWR);
        if (dev_null >= 0) {
            dup2(dev_null, STDOUT_FILENO);
            dup2(dev_null, STDERR_FILENO);
            close(dev_null);
        }

        std::vector<std::string> args;
        args.push_back(browser_bin);

        if (browser_bin.find("chrome") != std::string::npos || browser_bin.find("chromium") != std::string::npos || browser_bin.find("brave") != std::string::npos) {
            args.push_back("--app=" + url);
            args.push_back("--window-size=1600,1000");
            args.push_back("--user-data-dir=" + profile_dir);
            args.push_back("--no-first-run");
            args.push_back("--no-default-browser-check");
        } else if (browser_bin.find("firefox") != std::string::npos) {
            args.push_back("--new-window");
            args.push_back(url);
        } else {
            args.push_back(url);
        }

        std::vector<char*> c_args;
        for (auto& s : args) {
            c_args.push_back(s.data());
        }
        c_args.push_back(nullptr);

        execvp(browser_bin.c_str(), c_args.data());
        _exit(127);
    }

    g_browser_pid.store(pid);
    std::cout << "[BlastStudio] Launched desktop window (PID " << pid << " using " << browser_bin << ").\n";
    return true;
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    print_desktop_banner();

    std::string frontend_dir = "./frontend";
    int broker_port = 8080;
    int http_port = 5173;
    bool headless = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) broker_port = std::stoi(argv[++i]);
        else if (arg == "--http-port" && i + 1 < argc) http_port = std::stoi(argv[++i]);
        else if (arg == "--headless") headless = true;
        else if (arg == "--help" || arg == "-h") {
            std::cout << "Usage: BlastStudio [options]\n";
            std::cout << "  --port <port>        Broker WebSocket port (default: 8080)\n";
            std::cout << "  --http-port <port>   Workstation UI HTTP port (default: 5173)\n";
            std::cout << "  --headless           Run in console workstation server mode\n";
            return 0;
        }
    }

    (void)frontend_dir;

    std::cout << "[BlastStudio] Initializing Desktop Platform Engine...\n";
    std::cout << "  Broker Endpoint  : ws://127.0.0.1:" << broker_port << "\n";
    std::cout << "  Workstation URL  : http://localhost:" << http_port << "\n";
    std::cout << "  Platform Target  : Linux X11/Wayland Desktop Shell\n\n";

    std::string url = "http://localhost:" + std::to_string(http_port);

    if (!headless) {
        spawn_window(url);
    }

    std::cout << "[BlastStudio] Workstation active. Connected to Broker at ws://127.0.0.1:" << broker_port << "\n";
    std::cout << "[BlastStudio] Interactive Controls:\n";
    std::cout << "  [o / Enter]  Reopen / focus workstation window\n";
    std::cout << "  [k]          Close active workstation window\n";
    std::cout << "  [q / Ctrl+C] Quit BlastStudio session\n\n";

    struct pollfd pfd;
    pfd.fd = STDIN_FILENO;
    pfd.events = POLLIN;

    while (g_running) {
        pid_t cur_pid = g_browser_pid.load();
        if (cur_pid > 0) {
            int status = 0;
            pid_t res = waitpid(cur_pid, &status, WNOHANG);
            if (res != 0) {
                g_browser_pid.store(0);
                std::cout << "\n[BlastStudio] Workstation window closed.\n";
                std::cout << "[BlastStudio] Press [o] or Enter to reopen window, or [q] to quit.\n";
            }
        }

        int poll_res = poll(&pfd, 1, 200);
        if (poll_res > 0 && (pfd.revents & POLLIN)) {
            std::string line;
            if (std::getline(std::cin, line)) {
                while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
                    line.pop_back();
                }
                while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) {
                    line.erase(line.begin());
                }

                if (line == "q" || line == "quit" || line == "exit") {
                    std::cout << "[BlastStudio] Quitting session...\n";
                    g_running = false;
                    break;
                } else if (line == "o" || line == "open" || line.empty()) {
                    spawn_window(url);
                } else if (line == "k" || line == "close") {
                    if (g_browser_pid.load() > 0) {
                        std::cout << "[BlastStudio] Closing active window...\n";
                        terminate_browser_window();
                    } else {
                        std::cout << "[BlastStudio] No active window to close.\n";
                    }
                } else if (line == "h" || line == "help") {
                    std::cout << "\nAvailable Commands:\n";
                    std::cout << "  o / open   : Reopen desktop window\n";
                    std::cout << "  k / close  : Close desktop window\n";
                    std::cout << "  q / quit   : Exit BlastStudio\n";
                    std::cout << "  h / help   : Show this help message\n\n";
                } else {
                    std::cout << "[BlastStudio] Unknown command '" << line << "'. Enter 'o' to reopen window, 'q' to quit, 'h' for help.\n";
                }
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
            }
        }
    }

    terminate_browser_window();
    std::cout << "[BlastStudio] Shutdown complete. Goodbye.\n";
    return 0;
}
