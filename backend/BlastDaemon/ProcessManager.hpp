#pragma once

#include <string>
#include <vector>
#include <iostream>
#include <thread>
#include <atomic>

#ifdef _WIN32
    #include <windows.h>
#else
    #include <unistd.h>
    #include <sys/types.h>
    #include <sys/wait.h>
    #include <signal.h>
    #include <fcntl.h>
#endif

class Process {
public:
    Process() :
#ifdef _WIN32
        hProcess(nullptr), hThread(nullptr), hStdInWrite(nullptr), hStdOutRead(nullptr),
        hStdInRead(nullptr), hStdOutWrite(nullptr)
#else
        pid(-1)
#endif
    {
#ifndef _WIN32
        stdin_pipe[0] = stdin_pipe[1] = -1;
        stdout_pipe[0] = stdout_pipe[1] = -1;
#endif
    }

    ~Process() {
        terminate();
    }

    bool start(const std::string& command, const std::vector<std::string>& args = {}) {
#ifdef _WIN32
        SECURITY_ATTRIBUTES saAttr;
        saAttr.nLength = sizeof(SECURITY_ATTRIBUTES);
        saAttr.bInheritHandle = TRUE;
        saAttr.lpSecurityDescriptor = NULL;

        if (!CreatePipe(&hStdOutRead, &hStdOutWrite, &saAttr, 0)) return false;
        if (!SetHandleInformation(hStdOutRead, HANDLE_FLAG_INHERIT, 0)) return false;

        if (!CreatePipe(&hStdInRead, &hStdInWrite, &saAttr, 0)) return false;
        if (!SetHandleInformation(hStdInWrite, HANDLE_FLAG_INHERIT, 0)) return false;

        STARTUPINFOA siStartInfo;
        PROCESS_INFORMATION piProcInfo;
        ZeroMemory(&piProcInfo, sizeof(PROCESS_INFORMATION));
        ZeroMemory(&siStartInfo, sizeof(STARTUPINFOA));
        siStartInfo.cb = sizeof(STARTUPINFOA);
        siStartInfo.hStdError = hStdOutWrite;
        siStartInfo.hStdOutput = hStdOutWrite;
        siStartInfo.hStdInput = hStdInRead;
        siStartInfo.dwFlags |= STARTF_USESTDHANDLES;

        std::string cmdLine = "\"" + command + "\"";
        for (const auto& arg : args) cmdLine += " \"" + arg + "\"";

        BOOL bSuccess = CreateProcessA(NULL, (LPSTR)cmdLine.c_str(), NULL, NULL, TRUE, 0, NULL, NULL, &siStartInfo, &piProcInfo);

        if (!bSuccess) {
            CloseHandle(hStdOutRead); CloseHandle(hStdOutWrite);
            CloseHandle(hStdInRead); CloseHandle(hStdInWrite);
            return false;
        }

        hProcess = piProcInfo.hProcess;
        hThread = piProcInfo.hThread;
        CloseHandle(hStdOutWrite); hStdOutWrite = nullptr;
        CloseHandle(hStdInRead); hStdInRead = nullptr;
        return true;
#else
        if (pipe(stdin_pipe) == -1) return false;
        if (pipe(stdout_pipe) == -1) {
            close(stdin_pipe[0]);
            close(stdin_pipe[1]);
            stdin_pipe[0] = stdin_pipe[1] = -1;
            return false;
        }

        pid = fork();
        if (pid == -1) {
            close(stdin_pipe[0]); close(stdin_pipe[1]);
            close(stdout_pipe[0]); close(stdout_pipe[1]);
            return false;
        }

        if (pid == 0) {
            dup2(stdin_pipe[0], STDIN_FILENO);
            dup2(stdout_pipe[1], STDOUT_FILENO);
            dup2(stdout_pipe[1], STDERR_FILENO);

            close(stdin_pipe[0]); close(stdin_pipe[1]);
            close(stdout_pipe[0]); close(stdout_pipe[1]);

            std::vector<char*> argv;
            argv.push_back(const_cast<char*>(command.c_str()));
            for (const auto& arg : args) {
                argv.push_back(const_cast<char*>(arg.c_str()));
            }
            argv.push_back(nullptr);

            execvp(command.c_str(), argv.data());
            _exit(1);
        } else {
            close(stdin_pipe[0]); stdin_pipe[0] = -1;
            close(stdout_pipe[1]); stdout_pipe[1] = -1;
            return true;
        }
#endif
    }

    void terminate() {
#ifdef _WIN32
        if (hProcess) {
            TerminateProcess(hProcess, 0);
            WaitForSingleObject(hProcess, INFINITE);
            CloseHandle(hProcess);
            CloseHandle(hThread);
            hProcess = nullptr;
            hThread = nullptr;
        }
        if (hStdInWrite) { CloseHandle(hStdInWrite); hStdInWrite = nullptr; }
        if (hStdOutRead) { CloseHandle(hStdOutRead); hStdOutRead = nullptr; }
#else
        // Close stdin first so the child gets EOF and can shut down cleanly.
        if (stdin_pipe[1] != -1) { close(stdin_pipe[1]); stdin_pipe[1] = -1; }
        if (pid > 0) {
            // Give the child a moment to exit on EOF, then escalate.
            kill(pid, SIGTERM);
            struct timespec ts = { 0, 50000000 }; // 50 ms
            nanosleep(&ts, nullptr);
            int status;
            pid_t r = waitpid(pid, &status, WNOHANG);
            if (r == 0) {
                kill(pid, SIGKILL);
                waitpid(pid, &status, 0);
            }
            pid = -1;
        }
        if (stdout_pipe[0] != -1) { close(stdout_pipe[0]); stdout_pipe[0] = -1; }
#endif
    }

    int readStdout(char* buffer, int size) {
#ifdef _WIN32
        if (!hStdOutRead) return -1;
        DWORD bytesRead;
        if (!ReadFile(hStdOutRead, buffer, size, &bytesRead, NULL) || bytesRead == 0) return -1;
        return (int)bytesRead;
#else
        if (stdout_pipe[0] == -1) return -1;
        int n = read(stdout_pipe[0], buffer, size);
        return n;
#endif
    }

    bool writeStdin(const std::string& data) {
#ifdef _WIN32
        if (!hStdInWrite) return false;
        DWORD bytesWritten;
        return WriteFile(hStdInWrite, data.c_str(), (DWORD)data.length(), &bytesWritten, NULL);
#else
        if (stdin_pipe[1] == -1) return false;
        ssize_t n = write(stdin_pipe[1], data.c_str(), data.length());
        if (n == -1 && errno == EPIPE) {
            close(stdin_pipe[1]); stdin_pipe[1] = -1;
            return false;
        }
        return n != -1;
#endif
    }

    bool isRunning() {
#ifdef _WIN32
        if (!hProcess) return false;
        DWORD exitCode;
        if (GetExitCodeProcess(hProcess, &exitCode)) {
            return exitCode == STILL_ACTIVE;
        }
        return false;
#else
        if (pid <= 0) return false;
        int status;
        pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == 0) {
            // Child still running (most common case).
            return true;
        }
        if (result == pid) {
            // Child has actually exited — confirmed.
            if (WIFEXITED(status)) {
                std::cout << "[DEBUG] Child process " << pid << " exited with status " << WEXITSTATUS(status) << std::endl;
            } else if (WIFSIGNALED(status)) {
                std::cout << "[DEBUG] Child process " << pid << " terminated by signal " << WTERMSIG(status) << std::endl;
            }
            pid = -1;
            return false;
        }
        // result == -1: ECHILD (no child with that pid yet per kernel, race
        // condition right after fork) or EINTR.  Treat as still running.
        return true;
#endif
    }

private:
#ifdef _WIN32
    HANDLE hProcess;
    HANDLE hThread;
    HANDLE hStdInWrite;
    HANDLE hStdInRead;
    HANDLE hStdOutRead;
    HANDLE hStdOutWrite;
#else
    pid_t pid;
    int stdin_pipe[2];
    int stdout_pipe[2];
#endif
};
