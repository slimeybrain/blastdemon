cmake_minimum_required(VERSION 3.20)
project(BlastDaemon CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)
# Target the best available GPU architecture automatically
set(CMAKE_CUDA_ARCHITECTURES native)
set(CMAKE_CUDA_FLAGS "${CMAKE_CUDA_FLAGS} --use_fast_math")


# Apply strict compiler warnings and high optimizations
if(MSVC)
    add_compile_options(/W4 /O2)
else()
    add_compile_options(-Wall -Wextra -O3 -lineinfo -g -march=native)
endif()

# OpenMP for CPU solver parallelism
find_package(OpenMP)

# Find ZLIB (needed for VTKWriter)
find_package(ZLIB REQUIRED)

# Find HDF5
set(HDF5_USE_STATIC_LIBRARIES ON)
find_package(HDF5 COMPONENTS C)

# Daemon (Broker)
add_executable(Broker backend/BlastDaemon/Broker.cpp)
target_include_directories(Broker PRIVATE
    backend/BlastSolver/include
)
# Broker is explicitly restricted to C++17
set_target_properties(Broker PROPERTIES CXX_STANDARD 17)

# Core Solver Library — 1D, 2D, and 3D CPU + CUDA solver components compiled once
add_library(BlastSolverCore STATIC
    backend/BlastSolver/cfd_solver.cpp
    backend/BlastSolver/cfd_solver_init.cpp
    backend/BlastSolver/cfd_solver_step.cpp
    backend/BlastSolver/cfd_solver_fluxes.cpp
    backend/BlastSolver/HDF5Writer.cpp
    backend/BlastSolver/XDMFWriter.cpp
    # 2D CPU solver
    backend/BlastSolver/cfd_solver_2d_init.cpp
    backend/BlastSolver/cfd_solver_2d_step.cpp
    backend/BlastSolver/cfd_solver_2d_fluxes.cpp
    backend/BlastSolver/cfd_solver_2d_amr.cpp
    # 2D MPM solver
    backend/BlastSolver/mpm_solver_2d.cpp
    # 3D MPM & FSI solvers
    backend/BlastSolver/mpm_solver_3d.cpp
    backend/BlastSolver/mpm_solver_3d_cuda.cu
    backend/BlastSolver/fsi_coupler_3d.cpp
    # 2D CUDA solver
    backend/BlastSolver/cfd_solver_2d_cuda.cu
    backend/BlastSolver/cfd_solver_2d_amr_cuda.cu
    # 3D Solver
    backend/BlastSolver/ImmersedBoundary.cpp
    backend/BlastSolver/cfd_solver_3d.cpp
    backend/BlastSolver/cfd_solver_3d_cuda.cu
    backend/BlastSolver/remapper_3d.cpp
    # VTK output writer
    backend/BlastSolver/VTKWriter.cpp
)

target_include_directories(BlastSolverCore PUBLIC
    backend/BlastSolver/include
)

set_target_properties(BlastSolverCore PROPERTIES
    CUDA_SEPARABLE_COMPILATION ON
    POSITION_INDEPENDENT_CODE ON
)
target_compile_options(BlastSolverCore PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3 -lineinfo>
)

# OpenMP linkage for BlastSolverCore
if(OpenMP_CXX_FOUND)
    target_link_libraries(BlastSolverCore PUBLIC OpenMP::OpenMP_CXX)
    target_compile_options(BlastSolverCore PRIVATE
        $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler -fopenmp>
    )
    message(STATUS "OpenMP found and enabled for BlastSolverCore.")
endif()

target_link_libraries(BlastSolverCore PUBLIC ${CMAKE_DL_LIBS} ZLIB::ZLIB)

if(HDF5_FOUND)
    target_include_directories(BlastSolverCore PUBLIC ${HDF5_INCLUDE_DIRS})
    target_link_libraries(BlastSolverCore PUBLIC ${HDF5_LIBRARIES})
    message(STATUS "Building BlastSolverCore with HDF5 support.")
else()
    target_compile_definitions(BlastSolverCore PUBLIC NO_HDF5)
    message(WARNING "HDF5 not found. Building BlastSolverCore without HDF5 support (NO_HDF5 defined).")
endif()

# Main Solver (Worker Executable)
add_executable(BlastSolver backend/BlastSolver/main.cpp)
set_target_properties(BlastSolver PROPERTIES CUDA_SEPARABLE_COMPILATION ON)
target_link_libraries(BlastSolver PRIVATE BlastSolverCore)

# Optional standalone test binaries (default: OFF, build with -DBUILD_TESTS=ON)
option(BUILD_TESTS "Build standalone test executables" OFF)

if(BUILD_TESTS)
    message(STATUS "Building standalone test executables.")

    # Helper macro to add test executable if source file exists
    macro(add_test_executable_if_exists target_name source_file)
        if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${source_file}")
            add_executable(${target_name} ${source_file})
            set_target_properties(${target_name} PROPERTIES CUDA_SEPARABLE_COMPILATION ON)
            target_compile_options(${target_name} PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3 -lineinfo>)
            target_link_libraries(${target_name} PRIVATE BlastSolverCore)
        endif()
    endmacro()

    add_test_executable_if_exists(test_cuda_solver backend/BlastSolver/test_cuda_solver.cu)
    add_test_executable_if_exists(test_benchmark_3d backend/BlastSolver/test_benchmark_3d.cu)
    add_test_executable_if_exists(test_amr_2d_debug backend/BlastSolver/test_amr_2d_debug.cpp)
    add_test_executable_if_exists(test_amr_2d_compare backend/BlastSolver/test_amr_2d_compare.cpp)
    add_test_executable_if_exists(test_remap_tnt backend/BlastSolver/test_remap_tnt.cpp)
    add_test_executable_if_exists(test_3d_cpu_gpu_equivalence backend/BlastSolver/test_3d_cpu_gpu_equivalence.cu)
    add_test_executable_if_exists(test_mpm_plasticity backend/BlastSolver/test_mpm_plasticity.cpp)
    add_test_executable_if_exists(test_cylinder_impact backend/BlastSolver/test_cylinder_impact.cpp)
    add_test_executable_if_exists(test_fsi_3d backend/BlastSolver/test_fsi_3d.cu)
endif()



