#ifndef ASYNC_MULTIBLOCK_WRITER_HPP
#define ASYNC_MULTIBLOCK_WRITER_HPP

#include "VTKWriter.hpp"
#include <string>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <iostream>

namespace Blast {

struct MarineHarbourMultiBlockJob {
    int timestep_index = 0;
    double sim_time = 0.0;
    std::string base_dir = ".";
    std::string base_prefix = "harbour_step_00000";
    std::string pvd_filename = ""; // e.g. "harbour_simulation.pvd"

    // Block 0 (Eulerian CFD Far-Field): Structured Grid (.vts)
    bool has_cfd_block = false;
    std::string cfd_block_name = "Eulerian CFD Far-Field";
    CFDVolumeSnapshot3D cfd_snap;

    // Block 1 (Lagrangian MPM Core): PolyData (.vtp)
    bool has_mpm_block = false;
    std::string mpm_block_name = "Lagrangian MPM Core";
    MPMVTKSnapshot3D mpm_snap;

    // Block 2 (Geotechnical Seabed): Unstructured Grid (.vtu)
    bool has_fem_block = false;
    std::string fem_block_name = "Geotechnical Seabed";
    FEMVTKSnapshot3D fem_snap;

    std::string format = "Binary";
};

class AsyncMultiBlockWriter {
public:
    static AsyncMultiBlockWriter& getInstance() {
        static AsyncMultiBlockWriter instance;
        return instance;
    }

    void enqueue(MarineHarbourMultiBlockJob job) {
        {
            std::unique_lock<std::mutex> lock(m_mutex);
            ensureRunning();
            // Bound queue depth to prevent unbounded memory growth during heavy I/O
            m_cv_producer.wait(lock, [this]() {
                return m_queue.size() < m_max_queue_size || m_stop.load();
            });
            if (m_stop.load()) return;
            m_queue.push(std::move(job));
        }
        m_cv_worker.notify_one();
    }

    void flush() {
        std::unique_lock<std::mutex> lock(m_mutex);
        m_cv_flush.wait(lock, [this]() {
            return m_queue.empty() && !m_busy;
        });
    }

    void stop() {
        {
            std::unique_lock<std::mutex> lock(m_mutex);
            if (m_stop.load()) return;
            m_stop.store(true);
        }
        m_cv_worker.notify_all();
        m_cv_producer.notify_all();
        if (m_worker_thread.joinable()) {
            m_worker_thread.join();
        }
    }

    ~AsyncMultiBlockWriter() {
        stop();
    }

    AsyncMultiBlockWriter(const AsyncMultiBlockWriter&) = delete;
    AsyncMultiBlockWriter& operator=(const AsyncMultiBlockWriter&) = delete;

private:
    AsyncMultiBlockWriter() : m_stop(false), m_busy(false), m_max_queue_size(16) {
        ensureRunning();
    }

    void ensureRunning() {
        if (!m_worker_thread.joinable() && !m_stop.load()) {
            m_worker_thread = std::thread(&AsyncMultiBlockWriter::workerLoop, this);
        }
    }

    void processJob(const MarineHarbourMultiBlockJob& job) {
        std::vector<MultiBlockEntry> entries;
        std::string dir = job.base_dir;
        if (!dir.empty() && dir.back() != '/' && dir.back() != '\\') {
            dir += "/";
        }

        int block_idx = 0;

        // Block 0: Eulerian CFD Far-Field (.vts Structured Grid)
        if (job.has_cfd_block) {
            std::string rel_file = job.base_prefix + "_block0.vts";
            std::string full_path = dir + rel_file;
            export_vts_cfd_3d_snapshot(full_path, job.cfd_snap, job.format);
            entries.push_back({ block_idx++, job.cfd_block_name, rel_file });
        }

        // Block 1: Lagrangian MPM Core (.vtp PolyData)
        if (job.has_mpm_block) {
            std::string rel_file = job.base_prefix + "_block1.vtp";
            std::string full_path = dir + rel_file;
            export_vtp_mpm_3d_snapshot(full_path, job.mpm_snap, job.format);
            entries.push_back({ block_idx++, job.mpm_block_name, rel_file });
        }

        // Block 2: Geotechnical Seabed (.vtu Unstructured Grid)
        if (job.has_fem_block) {
            std::string rel_file = job.base_prefix + "_block2.vtu";
            std::string full_path = dir + rel_file;
            export_vtu_fem_3d_snapshot(full_path, job.fem_snap, job.format);
            entries.push_back({ block_idx++, job.fem_block_name, rel_file });
        }

        // Master Container: .vtm (vtkMultiBlockDataSet)
        std::string vtm_rel = job.base_prefix + ".vtm";
        std::string vtm_full = dir + vtm_rel;
        export_vtm_multiblock(vtm_full, entries);

        // Optional PVD time-series collection update
        if (!job.pvd_filename.empty()) {
            std::string pvd_full = dir + job.pvd_filename;
            append_pvd_multiblock_timestep(pvd_full, job.sim_time, vtm_rel, "0");
        }
    }

    void workerLoop() {
        while (true) {
            MarineHarbourMultiBlockJob job;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_cv_worker.wait(lock, [this]() {
                    return !m_queue.empty() || m_stop.load();
                });

                if (m_stop.load() && m_queue.empty()) {
                    break;
                }

                if (!m_queue.empty()) {
                    job = std::move(m_queue.front());
                    m_queue.pop();
                    m_busy = true;
                }
            }

            m_cv_producer.notify_one();

            if (job.has_cfd_block || job.has_mpm_block || job.has_fem_block) {
                try {
                    processJob(job);
                } catch (const std::exception& e) {
                    std::cerr << "[ERROR] AsyncMultiBlockWriter job error: " << e.what() << std::endl;
                } catch (...) {
                    std::cerr << "[ERROR] AsyncMultiBlockWriter job unknown error" << std::endl;
                }
            }

            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_busy = false;
            }
            m_cv_flush.notify_all();
        }
    }

    std::queue<MarineHarbourMultiBlockJob> m_queue;
    std::mutex m_mutex;
    std::condition_variable m_cv_worker;
    std::condition_variable m_cv_producer;
    std::condition_variable m_cv_flush;
    std::thread m_worker_thread;
    std::atomic<bool> m_stop;
    bool m_busy;
    size_t m_max_queue_size;
};

} // namespace Blast

#endif // ASYNC_MULTIBLOCK_WRITER_HPP
