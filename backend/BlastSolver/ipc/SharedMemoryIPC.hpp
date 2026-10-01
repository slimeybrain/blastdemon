#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <atomic>
#include <memory>

namespace Blast {

enum FrameType : uint32_t {
    FRAME_TYPE_UNKNOWN = 0,
    FRAME_TYPE_CFD_SLICE = 1,
    FRAME_TYPE_CFD_VOLUME = 2,
    FRAME_TYPE_MPM_PARTICLES = 3,
    FRAME_TYPE_FEM_MESH = 4,
    FRAME_TYPE_FSI_TELEMETRY = 5,
    FRAME_TYPE_GAUGES = 6
};

struct alignas(64) ShmSlotHeader {
    std::atomic<uint64_t> sequence{0};
    double timestamp{0.0};
    uint32_t frame_type{0};
    uint32_t data_size{0};
    uint32_t dim_x{0};
    uint32_t dim_y{0};
    uint32_t dim_z{0};
    uint32_t flags{0};
    uint32_t reserved[8]{0};
};

struct alignas(128) ShmRingBufferHeader {
    uint32_t magic;          // 0x424C5354 ('BLST')
    uint32_t version;        // 1
    uint32_t num_slots;      // e.g. 4
    uint32_t slot_size;      // e.g. 64 MB
    std::atomic<uint64_t> latest_written_seq{0};
    std::atomic<uint64_t> last_read_seq{0};
    uint32_t reserved[16];
};

class SharedMemoryIPC {
public:
    static constexpr uint32_t MAGIC_ID = 0x424C5354;
    static constexpr uint32_t VERSION = 1;
    static constexpr size_t DEFAULT_SLOTS = 4;
    static constexpr size_t DEFAULT_SLOT_SIZE = 32 * 1024 * 1024; // 32 MB per slot

    SharedMemoryIPC();
    ~SharedMemoryIPC();

    static SharedMemoryIPC& instance();

    bool init_producer(const std::string& name = "/blast_shm_ring", 
                       size_t num_slots = DEFAULT_SLOTS, 
                       size_t slot_size = DEFAULT_SLOT_SIZE);
    bool init_consumer(const std::string& name = "/blast_shm_ring");

    bool write_frame(uint32_t frame_type, double timestamp, const void* data, size_t size,
                     uint32_t dim_x = 0, uint32_t dim_y = 0, uint32_t dim_z = 0);

    bool read_latest(void* out_buffer, size_t max_size, size_t& out_size,
                     uint32_t& out_frame_type, double& out_timestamp,
                     uint32_t* out_dx = nullptr, uint32_t* out_dy = nullptr, uint32_t* out_dz = nullptr);

    bool is_initialized() const { return m_initialized; }
    const std::string& get_name() const { return m_shm_name; }
    void cleanup();

private:
    std::string m_shm_name;
    int m_shm_fd{-1};
    void* m_mapped_addr{nullptr};
    size_t m_total_mapped_size{0};
    bool m_is_producer{false};
    bool m_initialized{false};

    ShmRingBufferHeader* m_header{nullptr};
    uint8_t* m_slots_meta_base{nullptr};
    uint8_t* m_slots_data_base{nullptr};
};

} // namespace Blast
