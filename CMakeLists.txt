cmake_minimum_required(VERSION 3.20)
project(BlastDaemon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Apply strict compiler warnings
if(MSVC)
    add_compile_options(/W4)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# Find HDF5
find_package(HDF5 REQUIRED COMPONENTS C)

# Daemon (Broker)
add_executable(Broker backend/BlastDaemon/Broker.cpp)

# Solver (Worker)
add_executable(BlastSolver
    backend/BlastSolver/main.cpp
    backend/BlastSolver/cfd_solver.cpp
    backend/BlastSolver/HDF5Writer.cpp
    backend/BlastSolver/XDMFWriter.cpp
)
target_include_directories(BlastSolver PRIVATE ${HDF5_INCLUDE_DIRS})
target_link_libraries(BlastSolver PRIVATE ${HDF5_LIBRARIES})
