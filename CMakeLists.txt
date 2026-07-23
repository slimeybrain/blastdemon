cmake_minimum_required(VERSION 3.20)
project(BlastDaemon CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)
# Target the best available GPU architecture automatically
set(CMAKE_CUDA_ARCHITECTURES native)

# Apply strict compiler warnings and high optimizations
if(MSVC)
    add_compile_options(/W4 /O2)
else()
    add_compile_options(-Wall -Wextra -O3 -g -march=native)
endif()

# OpenMP for CPU 2D solver parallelism
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

# Solver (Worker) — CPU + CUDA 2D sources
add_executable(BlastSolver
    backend/BlastSolver/main.cpp
    backend/BlastSolver/cfd_solver.cpp
    backend/BlastSolver/HDF5Writer.cpp
    backend/BlastSolver/XDMFWriter.cpp
    # 2D CPU solver
    backend/BlastSolver/cfd_solver_2d_init.cpp
    backend/BlastSolver/cfd_solver_2d_step.cpp
    backend/BlastSolver/cfd_solver_2d_fluxes.cpp
    backend/BlastSolver/cfd_solver_2d_amr.cpp
    # 2D MPM solver
    backend/BlastSolver/mpm_solver_2d.cpp
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

target_include_directories(BlastSolver PRIVATE
    backend/BlastSolver/include
)

# CUDA-specific properties for BlastSolver
set_target_properties(BlastSolver PROPERTIES
    CUDA_SEPARABLE_COMPILATION ON
)
target_compile_options(BlastSolver PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3>
)

# OpenMP linkage
if(OpenMP_CXX_FOUND)
    target_link_libraries(BlastSolver PRIVATE OpenMP::OpenMP_CXX)
    target_compile_options(BlastSolver PRIVATE
        $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler -fopenmp>
    )
    message(STATUS "OpenMP found and enabled for BlastSolver.")
endif()

target_link_libraries(BlastSolver PRIVATE ${CMAKE_DL_LIBS} ZLIB::ZLIB)


if(HDF5_FOUND)
    target_include_directories(BlastSolver PRIVATE ${HDF5_INCLUDE_DIRS})
    target_link_libraries(BlastSolver PRIVATE ${HDF5_LIBRARIES})
    message(STATUS "Building BlastSolver with HDF5 support.")
else()
    target_compile_definitions(BlastSolver PRIVATE NO_HDF5)
    message(WARNING "HDF5 not found. Building BlastSolver without HDF5 support (NO_HDF5 defined).")
endif()

# test_cuda_solver binary
add_executable(test_cuda_solver
    backend/BlastSolver/test_cuda_solver.cu
    backend/BlastSolver/ImmersedBoundary.cpp
    backend/BlastSolver/cfd_solver_3d.cpp
    backend/BlastSolver/cfd_solver_3d_cuda.cu
    backend/BlastSolver/remapper_3d.cpp
)
target_include_directories(test_cuda_solver PRIVATE backend/BlastSolver/include)
set_target_properties(test_cuda_solver PROPERTIES CUDA_SEPARABLE_COMPILATION ON)
target_compile_options(test_cuda_solver PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3>)
if(OpenMP_CXX_FOUND)
    target_link_libraries(test_cuda_solver PRIVATE OpenMP::OpenMP_CXX)
    target_compile_options(test_cuda_solver PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler -fopenmp>)
endif()
target_link_libraries(test_cuda_solver PRIVATE ${CMAKE_DL_LIBS} ZLIB::ZLIB)
# Optional test binaries (built only if source files exist)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/backend/BlastSolver/test_amr_2d_debug.cpp")
    add_executable(test_amr_2d_debug
        backend/BlastSolver/test_amr_2d_debug.cpp
        backend/BlastSolver/cfd_solver_2d_init.cpp
        backend/BlastSolver/cfd_solver_2d_step.cpp
        backend/BlastSolver/cfd_solver_2d_fluxes.cpp
        backend/BlastSolver/cfd_solver_2d_amr.cpp
        backend/BlastSolver/cfd_solver_2d_cuda.cu
        backend/BlastSolver/cfd_solver_2d_amr_cuda.cu
        backend/BlastSolver/VTKWriter.cpp
    )
    target_include_directories(test_amr_2d_debug PRIVATE backend/BlastSolver/include)
    set_target_properties(test_amr_2d_debug PROPERTIES CUDA_SEPARABLE_COMPILATION ON)
    target_compile_options(test_amr_2d_debug PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3>)
    if(OpenMP_CXX_FOUND)
        target_link_libraries(test_amr_2d_debug PRIVATE OpenMP::OpenMP_CXX)
        target_compile_options(test_amr_2d_debug PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler -fopenmp>)
    endif()
    target_link_libraries(test_amr_2d_debug PRIVATE ${CMAKE_DL_LIBS} ZLIB::ZLIB)
    if(HDF5_FOUND)
        target_include_directories(test_amr_2d_debug PRIVATE ${HDF5_INCLUDE_DIRS})
        target_link_libraries(test_amr_2d_debug PRIVATE ${HDF5_LIBRARIES})
    else()
        target_compile_definitions(test_amr_2d_debug PRIVATE NO_HDF5)
    endif()
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/backend/BlastSolver/test_amr_2d_compare.cpp")
    add_executable(test_amr_2d_compare
        backend/BlastSolver/test_amr_2d_compare.cpp
        backend/BlastSolver/cfd_solver_2d_init.cpp
        backend/BlastSolver/cfd_solver_2d_step.cpp
        backend/BlastSolver/cfd_solver_2d_fluxes.cpp
        backend/BlastSolver/cfd_solver_2d_amr.cpp
        backend/BlastSolver/cfd_solver_2d_cuda.cu
        backend/BlastSolver/cfd_solver_2d_amr_cuda.cu
        backend/BlastSolver/VTKWriter.cpp
    )
    target_include_directories(test_amr_2d_compare PRIVATE backend/BlastSolver/include)
    set_target_properties(test_amr_2d_compare PROPERTIES CUDA_SEPARABLE_COMPILATION ON)
    target_compile_options(test_amr_2d_compare PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr -O3>)
    if(OpenMP_CXX_FOUND)
        target_link_libraries(test_amr_2d_compare PRIVATE OpenMP::OpenMP_CXX)
        target_compile_options(test_amr_2d_compare PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler -fopenmp>)
    endif()
    target_link_libraries(test_amr_2d_compare PRIVATE ${CMAKE_DL_LIBS} ZLIB::ZLIB)
    if(HDF5_FOUND)
        target_include_directories(test_amr_2d_compare PRIVATE ${HDF5_INCLUDE_DIRS})
        target_link_libraries(test_amr_2d_compare PRIVATE ${HDF5_LIBRARIES})
    else()
        target_compile_definitions(test_amr_2d_compare PRIVATE NO_HDF5)
    endif()
endif()



