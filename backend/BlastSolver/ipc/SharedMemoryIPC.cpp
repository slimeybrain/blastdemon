#include "SharedMemoryIPC.hpp"
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <iostream>

namespace Blast {

SharedMemoryIPC::SharedMemoryIPC() = default;

SharedMemoryIPC::~SharedMemoryIPC() {
    cleanup();
}

SharedMemoryIPC& SharedMemoryIPC::instance() {
    static SharedMemoryIPC s_inst;
    return s_inst;
}

bool SharedMemoryIPC::init_producer(const std::string& name, size_t num_slots, size_t slot_size) {
    cleanup();
    m_shm_name = name.empty() ? "/blast_shm_ring" : name;
    if (m_shm_name.front() != '/') {
        m_shm_name = "/" + m_shm_name;
    }
    m_is_producer = true;

    size_t meta_size = sizeof(ShmRingBufferHeader) + num_slots * sizeof(ShmSlotHeader);
    size_t data_size = num_slots * slot_size;
    m_total_mapped_size = meta_size + data_size;

    // Unlink old segment if present
    shm_unlink(m_shm_name.c_str());

    m_shm_fd = shm_open(m_shm_name.c_str(), O_CREAT | O_RDWR | O_TRUNC, 0666);
    if (m_shm_fd < 0) {
        std::cerr << "[SharedMemoryIPC] Failed to create shm object: " << m_shm_name << std::endl;
        return false;
    }

    if (ftruncate(m_shm_fd, static_cast<off_t>(m_total_mapped_size)) != 0) {
        std::cerr << "[SharedMemoryIPC] Failed to ftruncate shm to " << m_total_mapped_size << " bytes" << std::endl;
        ::close(m_shm_fd);
        m_shm_fd = -1;
        shm_unlink(m_shm_name.c_str());
        return false;
    }

    m_mapped_addr = mmap(nullptr, m_total_mapped_size, PROT_READ | PROT_WRITE, MAP_SHARED, m_shm_fd, 0);
    if (m_mapped_addr == MAP_FAILED) {
        std::cerr << "[SharedMemoryIPC] Failed to mmap shm object" << std::endl;
        ::close(m_shm_fd);
        m_shm_fd = -1;
        shm_unlink(m_shm_name.c_str());
        m_mapped_addr = nullptr;
        return false;
    }

    std::memset(m_mapped_addr, 0, m_total_mapped_size);

    m_header = static_cast<ShmRingBufferHeader*>(m_mapped_addr);
    m_header->magic = MAGIC_ID;
    m_header->version = VERSION;
    m_header->num_slots = static_cast<uint32_t>(num_slots);
    m_header->slot_size = static_cast<uint32_t>(slot_size);
    m_header->latest_written_seq.store(0, std::memory_order_release);
    m_header->last_read_seq.store(0, std::memory_order_release);

    m_slots_meta_base = static_cast<uint8_t*>(m_mapped_addr) + sizeof(ShmRingBufferHeader);
    m_slots_data_base = static_cast<uint8_t*>(m_mapped_addr) + meta_size;

    m_initialized = true;
    std::cout << "[SharedMemoryIPC] Initialized producer ring at " << m_shm_name 
              << " (" << num_slots << " slots x " << (slot_size / (1024 * 1024)) << " MB, total "
              << (m_total_mapped_size / (1024 * 1024)) << " MB)" << std::endl;
    return true;
}

bool SharedMemoryIPC::init_consumer(const std::string& name) {
    cleanup();
    m_shm_name = name.empty() ? "/blast_shm_ring" : name;
    if (m_shm_name.front() != '/') {
        m_shm_name = "/" + m_shm_name;
    }
    m_is_producer = false;

    m_shm_fd = shm_open(m_shm_name.c_str(), O_RDONLY, 0666);
    if (m_shm_fd < 0) {
        return false;
    }

    struct stat sb;
    if (fstat(m_shm_fd, &sb) != 0 || sb.st_size < static_cast<off_t>(sizeof(ShmRingBufferHeader))) {
        ::close(m_shm_fd);
        m_shm_fd = -1;
        return false;
    }
    m_total_mapped_size = static_cast<size_t>(sb.st_size);

    m_mapped_addr = mmap(nullptr, m_total_mapped_size, PROT_READ, MAP_SHARED, m_shm_fd, 0);
    if (m_mapped_addr == MAP_FAILED) {
        ::close(m_shm_fd);
        m_shm_fd = -1;
        m_mapped_addr = nullptr;
        return false;
    }

    m_header = static_cast<ShmRingBufferHeader*>(m_mapped_addr);
    if (m_header->magic != MAGIC_ID || m_header->version != VERSION) {
        cleanup();
        return false;
    }

    size_t meta_size = sizeof(ShmRingBufferHeader) + m_header->num_slots * sizeof(ShmSlotHeader);
    m_slots_meta_base = static_cast<uint8_t*>(m_mapped_addr) + sizeof(ShmRingBufferHeader);
    m_slots_data_base = static_cast<uint8_t*>(m_mapped_addr) + meta_size;

    m_initialized = true;
    return true;
}

bool SharedMemoryIPC::write_frame(uint32_t frame_type, double timestamp, const void* data, size_t size,
                                  uint32_t dim_x, uint32_t dim_y, uint32_t dim_z) {
    if (!m_initialized || !m_header || !m_is_producer) {
        return false;
    }

    if (size > m_header->slot_size) {
        std::cerr << "[SharedMemoryIPC] Frame size " << size << " exceeds slot capacity " << m_header->slot_size << std::endl;
        return false;
    }

    uint64_t next_seq = m_header->latest_written_seq.load(std::memory_order_relaxed) + 1;
    uint32_t slot_idx = static_cast<uint32_t>((next_seq - 1) % m_header->num_slots);

    ShmSlotHeader* slot_hdr = reinterpret_cast<ShmSlotHeader*>(m_slots_meta_base + slot_idx * sizeof(ShmSlotHeader));
    uint8_t* slot_data = m_slots_data_base + slot_idx * m_header->slot_size;

    // Zero-out sequence while writing to signal in-progress update
    slot_hdr->sequence.store(0, std::memory_order_relaxed);
    slot_hdr->timestamp = timestamp;
    slot_hdr->frame_type = frame_type;
    slot_hdr->data_size = static_cast<uint32_t>(size);
    slot_hdr->dim_x = dim_x;
    slot_hdr->dim_y = dim_y;
    slot_hdr->dim_z = dim_z;

    if (data && size > 0) {
        std::memcpy(slot_data, data, size);
    }

    // Publish slot sequence and ring header
    slot_hdr->sequence.store(next_seq, std::memory_order_release);
    m_header->latest_written_seq.store(next_seq, std::memory_order_release);
    return true;
}

bool SharedMemoryIPC::read_latest(void* out_buffer, size_t max_size, size_t& out_size,
                                  uint32_t& out_frame_type, double& out_timestamp,
                                  uint32_t* out_dx, uint32_t* out_dy, uint32_t* out_dz) {
    if (!m_initialized || !m_header) {
        return false;
    }

    uint64_t latest_seq = m_header->latest_written_seq.load(std::memory_order_acquire);
    if (latest_seq == 0) {
        return false; // No frames written yet
    }

    uint32_t slot_idx = static_cast<uint32_t>((latest_seq - 1) % m_header->num_slots);
    const ShmSlotHeader* slot_hdr = reinterpret_cast<const ShmSlotHeader*>(m_slots_meta_base + slot_idx * sizeof(ShmSlotHeader));
    const uint8_t* slot_data = m_slots_data_base + slot_idx * m_header->slot_size;

    uint64_t slot_seq = slot_hdr->sequence.load(std::memory_order_acquire);
    if (slot_seq != latest_seq) {
        return false; // Slot is mid-write or torn
    }

    out_size = slot_hdr->data_size;
    if (out_size > max_size) {
        return false; // Destination too small
    }

    out_frame_type = slot_hdr->frame_type;
    out_timestamp = slot_hdr->timestamp;
    if (out_dx) *out_dx = slot_hdr->dim_x;
    if (out_dy) *out_dy = slot_hdr->dim_y;
    if (out_dz) *out_dz = slot_hdr->dim_z;

    if (out_buffer && out_size > 0) {
        std::memcpy(out_buffer, slot_data, out_size);
    }

    m_header->last_read_seq.store(latest_seq, std::memory_order_release);
    return true;
}

void SharedMemoryIPC::cleanup() {
    if (m_mapped_addr && m_mapped_addr != MAP_FAILED) {
        munmap(m_mapped_addr, m_total_mapped_size);
        m_mapped_addr = nullptr;
    }
    if (m_shm_fd >= 0) {
        ::close(m_shm_fd);
        m_shm_fd = -1;
    }
    if (m_is_producer && !m_shm_name.empty()) {
        shm_unlink(m_shm_name.c_str());
    }
    m_initialized = false;
    m_header = nullptr;
    m_slots_meta_base = nullptr;
    m_slots_data_base = nullptr;
}

} // namespace Blast
