cmake_minimum_required(VERSION 3.20)
project(BlastDaemon CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Apply strict compiler warnings
if(MSVC)
    add_compile_options(/W4)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# Daemon (Broker)
add_executable(BlastDaemon backend/BlastDaemon/main.cpp)

# Solver (Worker)
add_executable(BlastSolver backend/BlastSolver/main.cpp)
