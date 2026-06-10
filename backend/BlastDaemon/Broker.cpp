#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <cstdint>
#include <cstring>
#include <thread>
#include <map>
#include <memory>
#include <algorithm>
#include <nlohmann/json.hpp>
#include "ProcessManager.hpp"

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
    typedef int socklen_t;
    #define SOCKET_TYPE SOCKET
    #define CLOSE_SOCKET closesocket
    #define INVALID_SOCKET_HANDLE INVALID_SOCKET
#else
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <unistd.h>
    #include <arpa/inet.h>
    typedef int SOCKET_TYPE;
    #define CLOSE_SOCKET close
    #define INVALID_SOCKET_HANDLE -1
#endif

// --- SHA-1 Implementation ---
namespace sha1 {
    typedef struct {
        uint32_t state[5];
        uint32_t count[2];
        unsigned char buffer[64];
    } SHA1_CTX;

    void SHA1Transform(uint32_t state[5], const unsigned char buffer[64]) {
        uint32_t a, b, c, d, e;
        typedef union {
            unsigned char c[64];
            uint32_t l[16];
        } CHAR64LONG16;
        CHAR64LONG16 block[1];
        memcpy(block, buffer, 64);

        for (int i = 0; i < 16; i++) {
            uint32_t val = block[0].l[i];
            block[0].l[i] = ((val & 0xFF000000) >> 24) |
                            ((val & 0x00FF0000) >> 8) |
                            ((val & 0x0000FF00) << 8) |
                            ((val & 0x000000FF) << 24);
        }

        a = state[0]; b = state[1]; c = state[2]; d = state[3]; e = state[4];
        auto rol = [](uint32_t value, uint32_t bits) { return (value << bits) | (value >> (32 - bits)); };

        uint32_t w[80];
        for (int i = 0; i < 16; i++) w[i] = block[0].l[i];
        for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

        for (int i = 0; i < 20; i++) {
            uint32_t temp = rol(a, 5) + ((b & c) | (~b & d)) + e + w[i] + 0x5A827999;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
        for (int i = 20; i < 40; i++) {
            uint32_t temp = rol(a, 5) + (b ^ c ^ d) + e + w[i] + 0x6ED9EBA1;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
        for (int i = 40; i < 60; i++) {
            uint32_t temp = rol(a, 5) + ((b & c) | (b & d) | (c & d)) + e + w[i] + 0x8F1BBCDC;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
        for (int i = 60; i < 80; i++) {
            uint32_t temp = rol(a, 5) + (b ^ c ^ d) + e + w[i] + 0xCA62C1D6;
            e = d; d = c; c = rol(b, 30); b = a; a = temp;
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
    }

    void SHA1Init(SHA1_CTX* context) {
        context->state[0] = 0x67452301;
        context->state[1] = 0xEFCDAB89;
        context->state[2] = 0x98BADCFE;
        context->state[3] = 0x10325476;
        context->state[4] = 0xC3D2E1F0;
        context->count[0] = context->count[1] = 0;
    }

    void SHA1Update(SHA1_CTX* context, const unsigned char* data, uint32_t len) {
        uint32_t i, j;
        j = (context->count[0] >> 3) & 63;
        if ((context->count[0] += len << 3) < (len << 3)) context->count[1]++;
        context->count[1] += (len >> 29);
        if ((j + len) > 63) {
            memcpy(&context->buffer[j], data, (i = 64 - j));
            SHA1Transform(context->state, context->buffer);
            for (; i + 63 < len; i += 64) SHA1Transform(context->state, &data[i]);
            j = 0;
        } else i = 0;
        memcpy(&context->buffer[j], &data[i], len - i);
    }

    void SHA1Final(unsigned char digest[20], SHA1_CTX* context) {
        unsigned char finalcount[8];
        for (int i = 0; i < 8; i++) finalcount[i] = (unsigned char)((context->count[(i >= 4 ? 0 : 1)] >> ((3 - (i & 3)) * 8)) & 255);
        unsigned char c = 0x80;
        SHA1Update(context, &c, 1);
        while ((context->count[0] & 504) != 448) {
            c = 0x00;
            SHA1Update(context, &c, 1);
        }
        SHA1Update(context, finalcount, 8);
        for (int i = 0; i < 20; i++) digest[i] = (unsigned char)((context->state[i >> 2] >> ((3 - (i & 3)) * 8)) & 255);
    }

    std::vector<uint8_t> compute(const std::string& input) {
        SHA1_CTX ctx;
        SHA1Init(&ctx);
        SHA1Update(&ctx, (const unsigned char*)input.c_str(), (uint32_t)input.length());
        unsigned char digest[20];
        SHA1Final(digest, &ctx);
        return std::vector<uint8_t>(digest, digest + 20);
    }
}

// --- Base64 Implementation ---
std::string base64_encode(const std::vector<uint8_t>& input) {
    static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    int i = 0;
    uint8_t array3[3], array4[4];
    for (uint8_t byte : input) {
        array3[i++] = byte;
        if (i == 3) {
            array4[0] = (array3[0] & 0xfc) >> 2;
            array4[1] = ((array3[0] & 0x03) << 4) + ((array3[1] & 0xf0) >> 4);
            array4[2] = ((array3[1] & 0x0f) << 2) + ((array3[2] & 0xc0) >> 6);
            array4[3] = array3[2] & 0x3f;
            for (i = 0; i < 4; i++) output += chars[array4[i]];
            i = 0;
        }
    }
    if (i) {
        for (int j = i; j < 3; j++) array3[j] = '\0';
        array4[0] = (array3[0] & 0xfc) >> 2;
        array4[1] = ((array3[0] & 0x03) << 4) + ((array3[1] & 0xf0) >> 4);
        array4[2] = ((array3[1] & 0x0f) << 2) + ((array3[2] & 0xc0) >> 6);
        for (int j = 0; j < i + 1; j++) output += chars[array4[j]];
        while (i++ < 3) output += '=';
    }
    return output;
}

// --- WebSocket Handshake ---
std::string get_websocket_accept(const std::string& key) {
    const std::string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    return base64_encode(sha1::compute(key + magic));
}

void send_websocket_frame(SOCKET_TYPE client_fd, const void* data, size_t len, uint8_t opcode = 0x01) {
    std::vector<uint8_t> frame;
    frame.push_back(0x80 | (opcode & 0x0F)); // FIN + opcode

    if (len <= 125) {
        frame.push_back((uint8_t)len);
    } else if (len <= 65535) {
        frame.push_back(126);
        frame.push_back((uint8_t)((len >> 8) & 0xFF));
        frame.push_back((uint8_t)(len & 0xFF));
    } else {
        frame.push_back(127);
        for (int i = 7; i >= 0; --i) {
            frame.push_back((uint8_t)((len >> (8 * i)) & 0xFF));
        }
    }

    const uint8_t* p = reinterpret_cast<const uint8_t*>(data);
    frame.insert(frame.end(), p, p + len);
    send(client_fd, (const char*)frame.data(), (int)frame.size(), 0);
}

void send_websocket_text(SOCKET_TYPE client_fd, const std::string& message) {
    send_websocket_frame(client_fd, message.data(), message.length(), 0x01);
}

void send_websocket_binary(SOCKET_TYPE client_fd, const void* data, size_t len) {
    send_websocket_frame(client_fd, data, len, 0x02);
}

// --- Native Structures ---
struct Node {
    std::string id;
    std::string type;
    std::map<std::string, std::string> parameters;
};

struct Edge {
    std::string fromNode;
    std::string fromPort;
    std::string toNode;
    std::string toPort;
};

struct SimulationState {
    std::vector<Node> nodes;
    std::vector<Edge> edges;
};

// --- Better Robust Socket Read ---
bool read_exactly(SOCKET_TYPE fd, void* buffer, size_t len) {
    size_t total = 0;
    char* p = (char*)buffer;
    while (total < len) {
        int n = recv(fd, p + total, (int)(len - total), 0);
        if (n <= 0) return false;
        total += n;
    }
    return true;
}

// --- Lightweight JSON Parser ---
std::string get_json_value(const std::string& json, const std::string& key) {
    size_t pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) return "";
    pos = json.find(":", pos);
    if (pos == std::string::npos) return "";
    pos = json.find_first_not_of(" \t\n\r", pos + 1);
    if (pos == std::string::npos) return "";
    if (json[pos] == '"') {
        size_t end = json.find("\"", pos + 1);
        if (end == std::string::npos) return "";
        return json.substr(pos + 1, end - pos - 1);
    } else {
        size_t end = json.find_first_of(",}] \t\n\r", pos);
        return json.substr(pos, (end == std::string::npos) ? std::string::npos : end - pos);
    }
}

void process_json(const std::string& json_str, SOCKET_TYPE client_fd, std::shared_ptr<Process>& active_process) {
    nlohmann::json payload;
    try {
        payload = nlohmann::json::parse(json_str);
    } catch (const std::exception& e) {
        std::cerr << "[JSON PARSE ERROR] " << e.what() << std::endl;
        return;
    }

    std::string command = payload.value("command", "");
    if (command == "INIT") {
        std::cout << "[DEBUG] RAW BROKER RECEIVE: " << json_str << std::endl;
    }

    if (command == "STOP") {
        std::cout << "--- STOP COMMAND RECEIVED ---" << std::endl;
        if (active_process) {
            active_process->terminate();
            active_process.reset();
            std::cout << "Process terminated by user." << std::endl;
        }
        return;
    }

    if (command == "INIT" || command == "START") {
        std::cout << "--- " << command << " COMMAND RECEIVED ---" << std::endl;
        if (active_process) {
            active_process->terminate();
            active_process.reset();
        }

        active_process = std::make_shared<Process>();
        std::string solver_path = "./BlastSolver";
#ifdef _WIN32
        solver_path = "BlastSolver.exe";
#endif

        if (active_process->start(solver_path)) {
            std::cout << "Starting BlastSolver for initialization..." << std::endl;
            active_process->writeStdin(json_str + "\n\n");
            std::thread([client_fd, proc = active_process]() {
                std::vector<uint8_t> buffer(8192);
                std::vector<uint8_t> accumulator;
                while (true) {
                    int n = proc->readStdout(reinterpret_cast<char*>(buffer.data()), buffer.size());
                    if (n <= 0) break;
                    accumulator.insert(accumulator.end(), buffer.begin(), buffer.begin() + n);

                    while (!accumulator.empty()) {
                        // Check for BIN_FRAME marker
                        const std::string marker = "BIN_FRAME ";
                        if (accumulator.size() >= marker.size() &&
                            std::equal(marker.begin(), marker.end(), accumulator.begin())) {

                            // Find the newline after the size
                            auto nl_it = std::find(accumulator.begin(), accumulator.end(), (uint8_t)'\n');
                            if (nl_it == accumulator.end()) break; // Need more data

                            try {
                                std::string size_str(reinterpret_cast<char*>(accumulator.data() + marker.size()),
                                                    std::distance(accumulator.begin() + marker.size(), nl_it));
                                size_t payload_size = std::stoul(size_str);
                                size_t header_size = std::distance(accumulator.begin(), nl_it) + 1;

                                if (accumulator.size() < header_size + payload_size) break; // Need more data

                                send_websocket_binary(client_fd, accumulator.data() + header_size, payload_size);
                                accumulator.erase(accumulator.begin(), accumulator.begin() + header_size + payload_size);
                            } catch (const std::exception& e) {
                                std::cout << "Malformed binary frame size" << std::endl;
                                accumulator.erase(accumulator.begin(), nl_it + 1);
                                continue;
                            }
                        } else {
                            // Standard text line
                            auto nl_it = std::find(accumulator.begin(), accumulator.end(), (uint8_t)'\n');
                            if (nl_it == accumulator.end()) break; // Need more data

                            std::string line(reinterpret_cast<char*>(accumulator.data()),
                                             std::distance(accumulator.begin(), nl_it));
                            if (!line.empty() && line.back() == '\r') line.pop_back();
                            if (!line.empty()) {
                                send_websocket_text(client_fd, line);
                            }
                            accumulator.erase(accumulator.begin(), nl_it + 1);
                        }
                    }
                }
                std::cout << "Telemetry relay thread finished." << std::endl;
            }).detach();
        } else {
            std::cerr << "Failed to start BlastSolver" << std::endl;
        }
    } else if (command == "STEP" || command == "TERMINATE" || command == "EXEC_ALL" || command == "EXEC_END") {
        if (active_process && active_process->isRunning()) {
            active_process->writeStdin(json_str + "\n\n");
        } else {
            std::cerr << "Command " << command << " ignored: Solver not running." << std::endl;
        }
    }

    SimulationState state;
    int mapped_count = 0;
    if (payload.contains("nodes") && payload["nodes"].is_array()) {
        for (const auto& node : payload["nodes"]) {
            try {
                Node n;
                n.id = node.value("id", "unknown_" + std::to_string(mapped_count));
                n.type = node.value("type", "Unknown");

                if (node.contains("parameters") && node["parameters"].is_object()) {
                    for (auto it = node["parameters"].begin(); it != node["parameters"].end(); ++it) {
                        if (it.value().is_string()) {
                            n.parameters[it.key()] = it.value().get<std::string>();
                        } else if (it.value().is_number()) {
                            n.parameters[it.key()] = it.value().dump();
                        }
                    }
                }

                if (n.type == "DomainMesh") { /* map mesh */ }
                else if (n.type == "MaterialAir") { /* map air */ }
                else if (n.type == "MaterialExplosive") { /* map explosive */ }
                else if (n.type == "CFDSolver") { /* map solver */ }

                std::cout << "Mapped Node: " << n.id << std::endl;
                state.nodes.push_back(n);
                mapped_count++;
            } catch (const std::exception& e) {
                std::cerr << "[JSON ERROR] Node failed: " << e.what() << std::endl;
            }
        }
    }
    std::cout << "Successfully mapped " << mapped_count << " nodes to native structures." << std::endl;
    std::cout << "--------------------------------" << std::endl;
}

void handle_client(SOCKET_TYPE client_fd) {
    std::shared_ptr<Process> active_process = nullptr;
    char handshake_buffer[8192];
    int bytes_read = recv(client_fd, handshake_buffer, sizeof(handshake_buffer) - 1, 0);
    if (bytes_read <= 0) {
        CLOSE_SOCKET(client_fd);
        return;
    }
    handshake_buffer[bytes_read] = '\0';
    std::string request(handshake_buffer);

    size_t key_pos = request.find("Sec-WebSocket-Key: ");
    if (key_pos != std::string::npos) {
        size_t key_end = request.find("\r\n", key_pos);
        if (key_end != std::string::npos) {
            std::string key = request.substr(key_pos + 19, key_end - (key_pos + 19));
            std::string accept_key = get_websocket_accept(key);

            std::string response = "HTTP/1.1 101 Switching Protocols\r\n"
                                   "Upgrade: websocket\r\n"
                                   "Connection: Upgrade\r\n"
                                   "Sec-WebSocket-Accept: " + accept_key + "\r\n\r\n";
            send(client_fd, response.c_str(), (int)response.length(), 0);
            std::cout << "WebSocket handshake complete" << std::endl;

            while (true) {
                uint8_t header[2];
                if (!read_exactly(client_fd, header, 2)) break;

                uint8_t opcode = header[0] & 0x0F;
                bool masked = header[1] & 0x80;
                uint64_t payload_len = header[1] & 0x7F;

                if (opcode == 0x8) break;

                if (payload_len == 126) {
                    uint8_t extended_len[2];
                    if (!read_exactly(client_fd, extended_len, 2)) break;
                    payload_len = (extended_len[0] << 8) | extended_len[1];
                } else if (payload_len == 127) {
                    uint8_t extended_len[8];
                    if (!read_exactly(client_fd, extended_len, 8)) break;
                    payload_len = 0;
                    for (int i = 0; i < 8; ++i) payload_len = (payload_len << 8) | extended_len[i];
                }

                uint8_t mask[4];
                if (masked) {
                    if (!read_exactly(client_fd, mask, 4)) break;
                }

                std::vector<uint8_t> payload(payload_len);
                if (payload_len > 0) {
                    if (!read_exactly(client_fd, payload.data(), (size_t)payload_len)) break;
                }

                if (masked) {
                    for (size_t i = 0; i < payload_len; ++i) payload[i] ^= mask[i % 4];
                }

                if (opcode == 0x1) {
                    std::string message(payload.begin(), payload.end());
                    process_json(message, client_fd, active_process);
                }
            }
        }
    }

    if (active_process) {
        active_process->terminate();
    }

    std::cout << "Client disconnected" << std::endl;
    CLOSE_SOCKET(client_fd);
}

int main() {
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) return 1;
#endif

    SOCKET_TYPE server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd == INVALID_SOCKET_HANDLE) return 1;

#ifndef _WIN32
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
#endif

    struct sockaddr_in address;
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(8080);

    if (bind(server_fd, (struct sockaddr*)&address, sizeof(address)) < 0) return 1;
    if (listen(server_fd, 3) < 0) return 1;

    std::cout << "Broker listening on 0.0.0.0:8080" << std::endl;

    while (true) {
        struct sockaddr_in client_addr;
        socklen_t addrlen = sizeof(client_addr);
        SOCKET_TYPE client_fd = accept(server_fd, (struct sockaddr*)&client_addr, &addrlen);
        if (client_fd != INVALID_SOCKET_HANDLE) {
            std::thread(handle_client, client_fd).detach();
        }
    }

#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
