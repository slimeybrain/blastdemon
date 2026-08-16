#ifndef ASYNC_VTK_WRITER_HPP
#define ASYNC_VTK_WRITER_HPP

#include <functional>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <memory>
#include <iostream>

namespace Blast {

class AsyncVTKWriter {
public:
    static AsyncVTKWriter& getInstance() {
        static AsyncVTKWriter instance;
        return instance;
    }

    void enqueue(std::function<void()> task) {
        {
            std::unique_lock<std::mutex> lock(m_mutex);
            ensureRunning();
            // Bound queue depth to prevent unbounded memory growth during heavy I/O
            m_cv_producer.wait(lock, [this]() {
                return m_queue.size() < m_max_queue_size || m_stop.load();
            });
            if (m_stop.load()) return;
            m_queue.push(std::move(task));
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

    ~AsyncVTKWriter() {
        stop();
    }

    AsyncVTKWriter(const AsyncVTKWriter&) = delete;
    AsyncVTKWriter& operator=(const AsyncVTKWriter&) = delete;

private:
    AsyncVTKWriter() : m_stop(false), m_busy(false), m_max_queue_size(32) {
        ensureRunning();
    }

    void ensureRunning() {
        if (!m_worker_thread.joinable() && !m_stop.load()) {
            m_worker_thread = std::thread(&AsyncVTKWriter::workerLoop, this);
        }
    }

    void workerLoop() {
        while (true) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_cv_worker.wait(lock, [this]() {
                    return !m_queue.empty() || m_stop.load();
                });

                if (m_stop.load() && m_queue.empty()) {
                    break;
                }

                if (!m_queue.empty()) {
                    task = std::move(m_queue.front());
                    m_queue.pop();
                    m_busy = true;
                }
            }

            m_cv_producer.notify_one();

            if (task) {
                try {
                    task();
                } catch (const std::exception& e) {
                    std::cerr << "[ERROR] AsyncVTKWriter task error: " << e.what() << std::endl;
                } catch (...) {
                    std::cerr << "[ERROR] AsyncVTKWriter task unknown error" << std::endl;
                }
            }

            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_busy = false;
            }
            m_cv_flush.notify_all();
        }
    }

    std::queue<std::function<void()>> m_queue;
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

#endif // ASYNC_VTK_WRITER_HPP
