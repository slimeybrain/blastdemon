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

# Find HDF5
find_package(HDF5 COMPONENTS C)

# Daemon (Broker)
add_executable(Broker backend/BlastDaemon/Broker.cpp)
target_include_directories(Broker PRIVATE
    backend/BlastSolver/include
)
# Broker is explicitly restricted to C++17
set_target_properties(Broker PROPERTIES CXX_STANDARD 17)

# Solver (Worker)
add_executable(BlastSolver
    backend/BlastSolver/main.cpp
    backend/BlastSolver/cfd_solver.cpp
    backend/BlastSolver/HDF5Writer.cpp
    backend/BlastSolver/XDMFWriter.cpp
)

target_include_directories(BlastSolver PRIVATE
    backend/BlastSolver/include
)

if(HDF5_FOUND)
    target_include_directories(BlastSolver PRIVATE ${HDF5_INCLUDE_DIRS})
    target_link_libraries(BlastSolver PRIVATE ${HDF5_LIBRARIES})
    message(STATUS "Building BlastSolver with HDF5 support.")
else()
    target_compile_definitions(BlastSolver PRIVATE NO_HDF5)
    message(WARNING "HDF5 not found. Building BlastSolver without HDF5 support (NO_HDF5 defined).")
endif()
