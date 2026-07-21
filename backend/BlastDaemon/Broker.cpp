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
#include <fstream>
#include <filesystem>
#include "ProcessManager.hpp"
#include "PrimitiveGeometry.hpp"

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
    #include <fcntl.h>
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

#include <mutex>

// --- Client Connection Context for thread safety ---
struct ClientConnection {
    SOCKET_TYPE fd = INVALID_SOCKET_HANDLE;
    std::mutex send_mutex;
};

// --- WebSocket Handshake ---
std::string get_websocket_accept(const std::string& key) {
    const std::string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    return base64_encode(sha1::compute(key + magic));
}

void send_websocket_frame(std::shared_ptr<ClientConnection> client, const void* data, size_t len, uint8_t opcode = 0x01) {
    std::lock_guard<std::mutex> lock(client->send_mutex);
    if (client->fd == INVALID_SOCKET_HANDLE) return;

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

    size_t total_sent = 0;
    while (total_sent < frame.size()) {
#ifdef _WIN32
        int n = send(client->fd, (const char*)frame.data() + total_sent, (int)(frame.size() - total_sent), 0);
#else
        ssize_t n = send(client->fd, (const char*)frame.data() + total_sent, frame.size() - total_sent, MSG_NOSIGNAL);
#endif
        if (n <= 0) {
            break; // Socket error or closed
        }
        total_sent += n;
    }
}

void send_websocket_text(std::shared_ptr<ClientConnection> client, const std::string& message) {
    send_websocket_frame(client, message.data(), message.length(), 0x01);
}

void send_websocket_binary(std::shared_ptr<ClientConnection> client, const void* data, size_t len) {
    send_websocket_frame(client, data, len, 0x02);
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

void process_json(const std::string& json_str, std::shared_ptr<ClientConnection> client, std::map<std::string, std::shared_ptr<Process>>& active_processes) {
    nlohmann::json payload;
    try {
        payload = nlohmann::json::parse(json_str);
    } catch (const std::exception& e) {
        std::cerr << "[JSON PARSE ERROR] " << e.what() << std::endl;
        return;
    }

    std::string command = payload.value("command", "");
    std::string modelId = payload.value("modelId", "default");

    if (command == "BROWSER_LOG") {
        std::string message = payload.value("message", "");
        std::cout << "[BROWSER] " << message << std::endl;
        return;
    }

    if (command == "SAVE_MODEL_FILE") {
        std::string filePath = payload.value("filePath", "");
        std::string fileContent = payload.value("fileContent", "");
        nlohmann::json resp;
        resp["type"] = "save_model_response";
        resp["modelId"] = modelId;
        resp["filePath"] = filePath;

        std::ofstream out(filePath);
        if (out.is_open()) {
            out << fileContent;
            out.close();
            resp["status"] = "success";
            std::cout << "[Broker] Saved model " << modelId << " to local path: " << filePath << std::endl;
        } else {
            resp["status"] = "error";
            resp["error"] = "Failed to open file for writing at: " + filePath;
            std::cerr << "[Broker] [ERROR] Failed to save model to path: " << filePath << std::endl;
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
    }

    if (command == "LIST_DIR") {
        std::string path_str = payload.value("path", "");
        nlohmann::json resp;
        resp["type"] = "list_dir_response";
        resp["modelId"] = modelId;

        try {
            std::filesystem::path p(path_str);
            if (path_str.empty() || path_str == "." || !std::filesystem::exists(p) || !std::filesystem::is_directory(p)) {
                // Try parent path if it existed previously
                if (!path_str.empty()) {
                    p = std::filesystem::path(path_str).parent_path();
                }
                // Fall back to current path
                if (p.empty() || !std::filesystem::exists(p) || !std::filesystem::is_directory(p)) {
                    p = std::filesystem::current_path();
                }
            }
            p = std::filesystem::absolute(p);
            resp["currentPath"] = p.string();

            nlohmann::json entries = nlohmann::json::array();
            for (const auto& entry : std::filesystem::directory_iterator(p)) {
                nlohmann::json ent;
                ent["name"] = entry.path().filename().string();
                ent["isDir"] = entry.is_directory();
                try {
                    ent["size"] = entry.is_regular_file() ? std::filesystem::file_size(entry) : 0;
                } catch (...) {
                    ent["size"] = 0;
                }
                entries.push_back(ent);
            }
            resp["status"] = "success";
            resp["entries"] = entries;
        } catch (const std::exception& e) {
            try {
                std::filesystem::path fallback = std::filesystem::absolute(std::filesystem::current_path());
                resp["currentPath"] = fallback.string();
                nlohmann::json entries = nlohmann::json::array();
                for (const auto& entry : std::filesystem::directory_iterator(fallback)) {
                    nlohmann::json ent;
                    ent["name"] = entry.path().filename().string();
                    ent["isDir"] = entry.is_directory();
                    ent["size"] = 0;
                    entries.push_back(ent);
                }
                resp["status"] = "success";
                resp["entries"] = entries;
                resp["warning"] = e.what();
            } catch (...) {
                resp["status"] = "error";
                resp["error"] = e.what();
            }
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
    }

    if (command == "LOAD_MODEL_FILE") {
        std::string filePath = payload.value("filePath", "");
        nlohmann::json resp;
        resp["type"] = "load_model_response";
        resp["modelId"] = modelId;
        resp["filePath"] = filePath;

        std::ifstream in(filePath);
        if (in.is_open()) {
            std::stringstream ss;
            ss << in.rdbuf();
            in.close();
            resp["status"] = "success";
            resp["fileContent"] = ss.str();
            std::cout << "[Broker] Loaded model from local path: " << filePath << std::endl;
        } else {
            resp["status"] = "error";
            resp["error"] = "Failed to open file for reading at: " + filePath;
            std::cerr << "[Broker] [ERROR] Failed to load model from path: " << filePath << std::endl;
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
    }

    if (command == "LOAD_STL_GEOMETRY") {
        std::string filePath = payload.value("filePath", "");
        nlohmann::json resp;
        resp["type"] = "load_stl_response";
        resp["modelId"] = modelId;
        resp["filePath"] = filePath;

        try {
            std::ifstream file(filePath, std::ios::binary);
            if (!file.is_open()) {
                throw std::runtime_error("Failed to open STL file: " + filePath);
            }

            file.seekg(0, std::ios::end);
            size_t file_size = file.tellg();
            file.seekg(0, std::ios::beg);

            std::vector<float> coords;
            bool parsed = false;

            if (file_size >= 84) {
                char header[80];
                file.read(header, 80);
                uint32_t num_triangles = 0;
                file.read(reinterpret_cast<char*>(&num_triangles), 4);

                size_t expected_binary_size = 84 + static_cast<size_t>(num_triangles) * 50;
                if (file_size == expected_binary_size) {
                    coords.reserve(num_triangles * 9);
                    for (uint32_t i = 0; i < num_triangles; ++i) {
                        float data[12];
                        file.read(reinterpret_cast<char*>(data), 48);
                        uint16_t attr;
                        file.read(reinterpret_cast<char*>(&attr), 2);
                        coords.insert(coords.end(), data + 3, data + 12);
                    }
                    parsed = true;
                }
            }

            if (!parsed) {
                file.clear();
                file.seekg(0, std::ios::beg);
                std::string word;
                float x, y, z;
                while (file >> word) {
                    if (word == "vertex") {
                        if (file >> x >> y >> z) {
                            coords.push_back(x);
                            coords.push_back(y);
                            coords.push_back(z);
                        }
                    }
                }
            }

            resp["status"] = "success";
            resp["vertices"] = coords;
            std::cout << "[Broker] Successfully loaded STL file " << filePath << " with " << (coords.size() / 9) << " triangles." << std::endl;
        } catch (const std::exception& e) {
            resp["status"] = "error";
            resp["error"] = e.what();
            std::cerr << "[Broker] [ERROR] Failed to load STL: " << e.what() << std::endl;
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
     }

    if (command == "LOAD_PRIMITIVE_GEOMETRY") {
        nlohmann::json primitives = payload.value("primitives", nlohmann::json::array());
        nlohmann::json resp;
        resp["type"] = "load_stl_response";
        resp["modelId"] = modelId;
        resp["filePath"] = "";

        try {
            std::vector<float> coords;
            std::vector<float> subtractive_flags;
            
            for (const auto& item : primitives) {
                bool subtractive = item.value("subtractive", false);
                nlohmann::json single_arr = nlohmann::json::array();
                single_arr.push_back(item);
                std::vector<Triangle> triangles = generate_primitives_triangles(single_arr);
                
                for (const auto& tri : triangles) {
                    coords.push_back(tri.v0.x);
                    coords.push_back(tri.v0.y);
                    coords.push_back(tri.v0.z);
                    coords.push_back(tri.v1.x);
                    coords.push_back(tri.v1.y);
                    coords.push_back(tri.v1.z);
                    coords.push_back(tri.v2.x);
                    coords.push_back(tri.v2.y);
                    coords.push_back(tri.v2.z);
                    
                    float flag_val = subtractive ? 1.0f : 0.0f;
                    subtractive_flags.push_back(flag_val);
                    subtractive_flags.push_back(flag_val);
                    subtractive_flags.push_back(flag_val);
                }
            }
            resp["status"] = "success";
            resp["vertices"] = coords;
            resp["subtractive_flags"] = subtractive_flags;
            std::cout << "[Broker] Successfully generated primitive geometry with " << (coords.size() / 9) << " triangles." << std::endl;
        } catch (const std::exception& e) {
            resp["status"] = "error";
            resp["error"] = e.what();
            std::cerr << "[Broker] [ERROR] Failed to generate primitive geometry: " << e.what() << std::endl;
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
    }

    if (command == "CREATE_DIR") {
        std::string path_str = payload.value("path", "");
        nlohmann::json resp;
        resp["type"] = "create_dir_response";
        resp["modelId"] = modelId;
        resp["path"] = path_str;

        try {
            if (!path_str.empty()) {
                std::filesystem::create_directories(path_str);
                resp["status"] = "success";
            } else {
                resp["status"] = "error";
                resp["error"] = "Path is empty.";
            }
        } catch (const std::exception& e) {
            resp["status"] = "error";
            resp["error"] = e.what();
        }

        if (client) {
            send_websocket_text(client, resp.dump());
        }
        return;
    }

    if (command == "INIT" || command == "INIT_2D" || command == "INIT_3D") {
        std::cout << "[DEBUG] RAW BROKER RECEIVE INIT FOR modelId " << modelId << ": " << json_str << std::endl;
    }

    if (command == "STOP") {
        std::cout << "--- STOP COMMAND RECEIVED for modelId " << modelId << " ---" << std::endl;
        if (active_processes.count(modelId) && active_processes[modelId]) {
            active_processes[modelId]->terminate();
            active_processes.erase(modelId);
            std::cout << "Process for modelId " << modelId << " terminated by user." << std::endl;
        }
        return;
    }

    if (command == "INIT" || command == "START" || command == "INIT_2D" || command == "INIT_3D") {
        std::cout << "--- " << command << " COMMAND RECEIVED for modelId " << modelId << " ---" << std::endl;

        // ── Per-model process isolation ─────────────────────────────────────────
        // Each modelId owns exactly one BlastSolver process for its entire
        // lifetime (both 1D and 2D phases).  INIT and INIT_2D for the *same*
        // modelId are sent to that model's existing process; the solver handles
        // both phases internally.  NEVER share processes across different models —
        // doing so contaminates their global state.
        //
        // The previous "reuse any other running process" heuristic was the root
        // cause of cross-model parameter contamination and the Ideal Gas
        // direct-init deadlock, and has been removed.
        // ────────────────────────────────────────────────────────────────────────

        std::string init_mode_val = payload.value("init_mode", "");
        bool is_remap = (command == "INIT_2D" && init_mode_val == "From1D");

        if (active_processes.count(modelId) && active_processes[modelId]) {
            if (is_remap) {
                // Route to existing process for 1D->2D remap pipeline
                auto& existing = active_processes[modelId];
                bool routed = false;
                for (int attempt = 0; attempt < 20; ++attempt) {
                    if (existing->isRunning()) {
                        if (existing->writeStdin(json_str + "\n\n")) {
                            std::cout << "[DEBUG] Routing " << command << " to existing process for modelId "
                                      << modelId << " (attempt " << attempt + 1 << ")" << std::endl;
                            routed = true;
                            break;
                        }
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
                if (routed) return;
                std::cerr << "[WARN] Existing process for " << modelId
                          << " died before " << command << " could be routed — spawning fresh." << std::endl;
                existing->terminate();
                active_processes.erase(modelId);
            } else {
                // Fresh initialization or reset: terminate stale process so new solver process gets clean state
                std::cout << "[INFO] Terminating existing solver process for modelId " << modelId << " to ensure clean re-initialization." << std::endl;
                active_processes[modelId]->terminate();
                active_processes.erase(modelId);
            }
        }

        // Kill any stale process for this model before spawning a fresh one.
        if (active_processes.count(modelId) && active_processes[modelId]) {
            active_processes[modelId]->terminate();
            active_processes.erase(modelId);
        }

        auto active_process = std::make_shared<Process>();
        std::string solver_path = "./BlastSolver";
#ifdef _WIN32
        solver_path = "BlastSolver.exe";
#else
        if (access(solver_path.c_str(), F_OK) != 0) {
            if (access("./build/BlastSolver", F_OK) == 0) {
                solver_path = "./build/BlastSolver";
            }
        }
#endif

        if (active_process->start(solver_path)) {
            std::cout << "Starting BlastSolver for modelId " << modelId << std::endl;
            active_process->writeStdin(json_str + "\n\n");
            active_processes[modelId] = active_process;

            std::thread([client, proc = active_process, modelId]() {
                std::vector<uint8_t> buffer(8192);
                std::vector<uint8_t> accumulator;
                while (true) {
                    int n = proc->readStdout(reinterpret_cast<char*>(buffer.data()), buffer.size());
                    if (n <= 0) break;
                    accumulator.insert(accumulator.end(), buffer.begin(), buffer.begin() + n);

                    while (!accumulator.empty()) {
                        // Check for BIN_FRAME or BIN2D_FRAME marker
                        std::string marker = "";
                        const std::string m1 = "BIN_FRAME ";
                        const std::string m3 = "BIN_FRAME_3D_SLICES ";
                        const std::string m2_a = "BIN2D_FRAME ";
                        const std::string m2_b = "BIN_FRAME_2D ";
                        const std::string m2_amr = "BIN2D_AMR_FRAME ";
                        if (accumulator.size() >= m3.size() &&
                            std::equal(m3.begin(), m3.end(), accumulator.begin())) {
                            marker = m3;
                        } else if (accumulator.size() >= m2_amr.size() &&
                            std::equal(m2_amr.begin(), m2_amr.end(), accumulator.begin())) {
                            marker = m2_amr;
                        } else if (accumulator.size() >= m2_a.size() &&
                            std::equal(m2_a.begin(), m2_a.end(), accumulator.begin())) {
                            marker = m2_a;
                        } else if (accumulator.size() >= m2_b.size() &&
                            std::equal(m2_b.begin(), m2_b.end(), accumulator.begin())) {
                            marker = m2_b;
                        } else if (accumulator.size() >= m1.size() &&
                            std::equal(m1.begin(), m1.end(), accumulator.begin())) {
                            marker = m1;
                        }

                        if (!marker.empty()) {
                            auto nl_it = std::find(accumulator.begin(), accumulator.end(), (uint8_t)'\n');
                            if (nl_it == accumulator.end()) break;

                            try {
                                std::string size_str(reinterpret_cast<char*>(accumulator.data() + marker.size()),
                                                     std::distance(accumulator.begin() + marker.size(), nl_it));
                                size_t payload_size = std::stoul(size_str);
                                size_t header_size = std::distance(accumulator.begin(), nl_it) + 1;

                                if (accumulator.size() < header_size + payload_size) break;

                                std::vector<uint8_t> ws_payload;
                                ws_payload.insert(ws_payload.end(), modelId.begin(), modelId.end());
                                ws_payload.push_back('\0');
                                ws_payload.insert(ws_payload.end(),
                                                  accumulator.begin() + header_size,
                                                  accumulator.begin() + header_size + payload_size);

                                send_websocket_binary(client, ws_payload.data(), ws_payload.size());
                                accumulator.erase(accumulator.begin(),
                                                  accumulator.begin() + header_size + payload_size);
                            } catch (const std::exception&) {
                                std::cout << "Malformed binary frame size" << std::endl;
                                auto nl = std::find(accumulator.begin(), accumulator.end(), (uint8_t)'\n');
                                accumulator.erase(accumulator.begin(), nl + 1);
                                continue;
                            }
                        } else {
                            auto nl_it = std::find(accumulator.begin(), accumulator.end(), (uint8_t)'\n');
                            if (nl_it == accumulator.end()) break;

                            std::string line(reinterpret_cast<char*>(accumulator.data()),
                                             std::distance(accumulator.begin(), nl_it));
                            if (!line.empty() && line.back() == '\r') line.pop_back();
                            if (!line.empty()) {
                                if (line.rfind("{\"type\":\"obstacles_mesh\"", 0) == 0) {
                                    send_websocket_text(client, line);
                                } else {
                                    try {
                                        nlohmann::json log_json = nlohmann::json::parse(line);
                                        log_json["modelId"] = modelId;
                                        send_websocket_text(client, log_json.dump());
                                    } catch (...) {
                                        nlohmann::json log_envelope;
                                        log_envelope["type"] = "log";
                                        log_envelope["modelId"] = modelId;
                                        log_envelope["message"] = line;
                                        send_websocket_text(client, log_envelope.dump());
                                    }
                                }
                            }
                            accumulator.erase(accumulator.begin(), nl_it + 1);
                        }
                    }
                }
                std::cout << "Telemetry relay thread finished for modelId " << modelId << std::endl;
            }).detach();
        } else {
            std::cerr << "Failed to start BlastSolver for modelId " << modelId << std::endl;
        }
    } else if (command == "STEP" || command == "TERMINATE" || command == "EXEC_ALL" || command == "EXEC_END" || command == "PAUSE" || command == "RESUME" ||
               command == "SET_DEVICE" || command == "REMAP" || command == "STEP_2D" || command == "EXEC_ALL_2D" || command == "PAUSE_2D" || command == "RESUME_2D" || command == "TERMINATE_2D" || command == "WRITE_VTK" || command == "CONTOUR_CONFIG" ||
               command == "STEP_3D" || command == "EXEC_ALL_3D" || command == "PAUSE_3D" || command == "TERMINATE_3D" || command == "VIEW3D_CONFIG") {
        if (command == "PAUSE" || command == "PAUSE_2D" || command == "PAUSE_3D") std::cout << "[DEBUG] PAUSE COMMAND RECEIVED for modelId " << modelId << "\n";
        if (command == "TERMINATE" || command == "TERMINATE_2D" || command == "TERMINATE_3D") std::cout << "[DEBUG] TERMINATE COMMAND RECEIVED for modelId " << modelId << "\n";
        
        if (active_processes.count(modelId) && active_processes[modelId]) {
            auto& proc = active_processes[modelId];
            bool routed = false;
            for (int attempt = 0; attempt < 20; ++attempt) {
                if (proc->isRunning()) {
                    if (proc->writeStdin(json_str + "\n\n")) {
                        routed = true;
                        break;
                    }
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }

            if (routed) {
                if (command == "TERMINATE" || command == "TERMINATE_2D" || command == "TERMINATE_3D") {
                    // Erase ALL entries pointing to the same process (shared 1D/2D process).
                    auto target_proc = active_processes[modelId];
                    std::vector<std::string> to_erase;
                    for (auto const& [id, proc_val] : active_processes) {
                        if (proc_val == target_proc) to_erase.push_back(id);
                    }
                    for (const auto& id : to_erase) active_processes.erase(id);
                }
            } else {
                std::cerr << "Command " << command << " ignored: Solver not responsive or running for modelId " << modelId << std::endl;
                nlohmann::json err_env;
                err_env["type"] = "log";
                err_env["modelId"] = modelId;
                err_env["message"] = "[WARNING] Command ignored: Solver process is not running or responsive.";
                send_websocket_text(client, err_env.dump());
            }
        } else {
            std::cerr << "Command " << command << " ignored: Solver not running for modelId " << modelId << std::endl;
            nlohmann::json err_env;
            err_env["type"] = "log";
            err_env["modelId"] = modelId;
            err_env["message"] = "[WARNING] Command ignored: Solver process is not running. Please click 'Initialize' first.";
            send_websocket_text(client, err_env.dump());
        }
    }
}

void handle_client(SOCKET_TYPE client_fd) {
    auto client = std::make_shared<ClientConnection>();
    client->fd = client_fd;

    std::map<std::string, std::shared_ptr<Process>> active_processes;
    char handshake_buffer[8192];
    int bytes_read = recv(client->fd, handshake_buffer, sizeof(handshake_buffer) - 1, 0);
    if (bytes_read <= 0) {
        CLOSE_SOCKET(client->fd);
        client->fd = INVALID_SOCKET_HANDLE;
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
            send(client->fd, response.c_str(), (int)response.length(), 0);
            std::cout << "WebSocket handshake complete" << std::endl;

            std::vector<uint8_t> ws_message_accumulator;
            uint8_t current_msg_opcode = 0;
            while (true) {
                uint8_t header[2];
                if (!read_exactly(client->fd, header, 2)) break;

                uint8_t fin = header[0] & 0x80;
                uint8_t opcode = header[0] & 0x0F;
                bool masked = header[1] & 0x80;
                uint64_t payload_len = header[1] & 0x7F;

                if (opcode == 0x8) break;

                if (payload_len == 126) {
                    uint8_t extended_len[2];
                    if (!read_exactly(client->fd, extended_len, 2)) break;
                    payload_len = (extended_len[0] << 8) | extended_len[1];
                } else if (payload_len == 127) {
                    uint8_t extended_len[8];
                    if (!read_exactly(client->fd, extended_len, 8)) break;
                    payload_len = 0;
                    for (int i = 0; i < 8; ++i) payload_len = (payload_len << 8) | extended_len[i];
                }

                uint8_t mask[4];
                if (masked) {
                    if (!read_exactly(client->fd, mask, 4)) break;
                }

                std::vector<uint8_t> payload(payload_len);
                if (payload_len > 0) {
                    if (!read_exactly(client->fd, payload.data(), (size_t)payload_len)) break;
                }

                if (masked) {
                    for (size_t i = 0; i < payload_len; ++i) payload[i] ^= mask[i % 4];
                }

                if (opcode != 0x0) {
                    current_msg_opcode = opcode;
                    ws_message_accumulator.clear();
                }
                ws_message_accumulator.insert(ws_message_accumulator.end(), payload.begin(), payload.end());

                if (fin) {
                    if (current_msg_opcode == 0x1) {
                        std::string message(ws_message_accumulator.begin(), ws_message_accumulator.end());
                        process_json(message, client, active_processes);
                    }
                    ws_message_accumulator.clear();
                    current_msg_opcode = 0;
                }
            }
        }
    }

    for (auto& pair : active_processes) {
        if (pair.second) {
            pair.second->terminate();
        }
    }

    std::cout << "Client disconnected" << std::endl;

    {
        std::lock_guard<std::mutex> lock(client->send_mutex);
        if (client->fd != INVALID_SOCKET_HANDLE) {
            CLOSE_SOCKET(client->fd);
            client->fd = INVALID_SOCKET_HANDLE;
        }
    }
}

int main() {
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) return 1;
#endif

#ifndef _WIN32
    // Ignore SIGPIPE globally. A dead child process or a disconnected WebSocket
    // client will now yield EPIPE/EBADF from write()/send() instead of killing
    // the Broker process with SIGPIPE (exit code 141).
    signal(SIGPIPE, SIG_IGN);
#endif

    SOCKET_TYPE server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd == INVALID_SOCKET_HANDLE) return 1;

#ifndef _WIN32
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    fcntl(server_fd, F_SETFD, FD_CLOEXEC);
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
#ifndef _WIN32
            fcntl(client_fd, F_SETFD, FD_CLOEXEC);
#endif
            std::thread(handle_client, client_fd).detach();
        } else {
            // Sleep briefly to prevent a 100% CPU spinning loop on persistent accept errors
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
