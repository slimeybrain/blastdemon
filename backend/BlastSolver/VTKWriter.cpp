#include "VTKWriter.hpp"
#include "cfd_solver_3d.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>
#include <vector>
#include <zlib.h>
#include <cstdint>
#include <cstring>

static const char base64_table[65] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static inline size_t base64_calc_size(size_t len) {
    return ((len + 2) / 3) * 4;
}

static void base64_encode_append(std::string& ret, const unsigned char* buf, size_t bufLen) {
    if (bufLen == 0) return;
    size_t orig_size = ret.size();
    size_t needed = base64_calc_size(bufLen);
    ret.resize(orig_size + needed);
    char* dest = ret.data() + orig_size;

    size_t i = 0, j = 0;
    while (i + 2 < bufLen) {
        uint32_t triple = (static_cast<uint32_t>(buf[i]) << 16) |
                          (static_cast<uint32_t>(buf[i + 1]) << 8) |
                          (static_cast<uint32_t>(buf[i + 2]));
        dest[j++] = base64_table[(triple >> 18) & 0x3F];
        dest[j++] = base64_table[(triple >> 12) & 0x3F];
        dest[j++] = base64_table[(triple >> 6) & 0x3F];
        dest[j++] = base64_table[triple & 0x3F];
        i += 3;
    }
    if (i < bufLen) {
        uint32_t triple = static_cast<uint32_t>(buf[i++]) << 16;
        if (i < bufLen) triple |= static_cast<uint32_t>(buf[i++]) << 8;
        dest[j++] = base64_table[(triple >> 18) & 0x3F];
        dest[j++] = base64_table[(triple >> 12) & 0x3F];
        dest[j++] = (bufLen % 3 == 1) ? '=' : base64_table[(triple >> 6) & 0x3F];
        dest[j++] = '=';
    }
}

static std::string base64_encode(const unsigned char* buf, unsigned int bufLen) {
    std::string ret;
    ret.reserve(base64_calc_size(bufLen));
    base64_encode_append(ret, buf, bufLen);
    return ret;
}

template<typename T>
static std::string binary_encode(const T* data, size_t count) {
    uint32_t num_blocks = 1;
    uint32_t block_size = static_cast<uint32_t>(count * sizeof(T));
    uLongf comp_size = compressBound(block_size);
    std::vector<unsigned char> comp(comp_size);
    if (block_size > 0 && data != nullptr) {
        int z_res = compress2(comp.data(), &comp_size, reinterpret_cast<const unsigned char*>(data), block_size, Z_BEST_SPEED);
        if (z_res != Z_OK) {
            comp_size = block_size;
            std::memcpy(comp.data(), data, block_size);
        }
    } else {
        comp_size = 0;
    }

    uint32_t head[4] = {num_blocks, block_size, block_size, static_cast<uint32_t>(comp_size)};

    std::string ret;
    ret.reserve(base64_calc_size(sizeof(head)) + base64_calc_size(comp_size));
    base64_encode_append(ret, reinterpret_cast<const unsigned char*>(head), sizeof(head));
    base64_encode_append(ret, comp.data(), comp_size);
    return ret;
}

template<typename T>
static std::string binary_encode(const std::vector<T>& data) {
    return binary_encode(data.data(), data.size());
}

template<typename T>
static std::string binary_encode_vector(const std::vector<T>& v1, const std::vector<T>& v2, const std::vector<T>& v3) {
    std::vector<T> data(v1.size() * 3);
    for(size_t i = 0; i < v1.size(); ++i) {
        data[i*3]   = v1[i];
        data[i*3+1] = v2[i];
        data[i*3+2] = v3[i];
    }
    return binary_encode(data);
}

void export_vtu_1d(const std::string& filename, int n_cells, double dr, const std::vector<double>& rho, const std::vector<double>& u, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2) {
    std::ofstream out(filename);
    if (!out) return;

    int num_points = n_cells + 1;
    int num_cells = n_cells;

    std::vector<float> points(num_points * 3, 0.0f);
    for (int i = 0; i <= n_cells; ++i) {
        points[i * 3] = static_cast<float>(i * dr);
    }

    std::vector<int32_t> connectivity(num_cells * 2);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 3); // VTK_LINE

    for (int i = 0; i < num_cells; ++i) {
        connectivity[i * 2] = i;
        connectivity[i * 2 + 1] = i + 1;
        offsets[i] = (i + 1) * 2;
    }

    std::vector<float> rho_f(rho.begin(), rho.end());
    std::vector<float> p_f(p.begin(), p.end());
    std::vector<float> u_f(u.begin(), u.end());
    std::vector<float> E_f(E.begin(), E.end());
    std::vector<float> a1_f(alpha1.begin(), alpha1.end());
    std::vector<float> a2_f(alpha2.begin(), alpha2.end());

    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
    out << "          " << binary_encode(points) << "\n";
    out << "        </DataArray>\n";
    out << "      </Points>\n";

    out << "      <Cells>\n";
    out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
    out << "          " << binary_encode(connectivity) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
    out << "          " << binary_encode(offsets) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
    out << "          " << binary_encode(types) << "\n";
    out << "        </DataArray>\n";
    out << "      </Cells>\n";

    out << "      <CellData>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Density\" format=\"binary\">\n          " << binary_encode(rho_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Pressure\" format=\"binary\">\n          " << binary_encode(p_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Velocity\" format=\"binary\">\n          " << binary_encode(u_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Energy\" format=\"binary\">\n          " << binary_encode(E_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Alpha1\" format=\"binary\">\n          " << binary_encode(a1_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Alpha2\" format=\"binary\">\n          " << binary_encode(a2_f) << "\n        </DataArray>\n";
    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtu_2d(const std::string& filename, int nr, int nz, double dr, double dz, const std::vector<double>& rho, const std::vector<double>& ur, const std::vector<double>& uz, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2) {
    std::ofstream out(filename);
    if (!out) return;

    int num_points = (nr + 1) * (nz + 1);
    int num_cells = nr * nz;

    std::vector<float> points(num_points * 3, 0.0f);
    for (int j = 0; j <= nz; ++j) {
        for (int i = 0; i <= nr; ++i) {
            int pt_idx = j * (nr + 1) + i;
            points[pt_idx * 3]     = static_cast<float>(i * dr);
            points[pt_idx * 3 + 1] = static_cast<float>(j * dz);
            points[pt_idx * 3 + 2] = 0.0f;
        }
    }

    std::vector<int32_t> connectivity(num_cells * 4);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 9); // VTK_QUAD

    int cell_idx = 0;
    for (int j = 0; j < nz; ++j) {
        for (int i = 0; i < nr; ++i) {
            int p0 = j * (nr + 1) + i;
            int p1 = p0 + 1;
            int p2 = (j + 1) * (nr + 1) + i + 1;
            int p3 = (j + 1) * (nr + 1) + i;

            connectivity[cell_idx * 4]     = p0;
            connectivity[cell_idx * 4 + 1] = p1;
            connectivity[cell_idx * 4 + 2] = p2;
            connectivity[cell_idx * 4 + 3] = p3;
            offsets[cell_idx] = (cell_idx + 1) * 4;
            cell_idx++;
        }
    }

    std::vector<float> rho_f(rho.begin(), rho.end());
    std::vector<float> p_f(p.begin(), p.end());
    std::vector<float> ur_f(ur.begin(), ur.end());
    std::vector<float> uz_f(uz.begin(), uz.end());
    std::vector<float> zero_vec(rho.size(), 0.0f);
    std::vector<float> E_f(E.begin(), E.end());
    std::vector<float> a1_f(alpha1.begin(), alpha1.end());
    std::vector<float> a2_f(alpha2.begin(), alpha2.end());

    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
    out << "          " << binary_encode(points) << "\n";
    out << "        </DataArray>\n";
    out << "      </Points>\n";

    out << "      <Cells>\n";
    out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
    out << "          " << binary_encode(connectivity) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
    out << "          " << binary_encode(offsets) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
    out << "          " << binary_encode(types) << "\n";
    out << "        </DataArray>\n";
    out << "      </Cells>\n";

    out << "      <CellData>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Density\" format=\"binary\">\n          " << binary_encode(rho_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Pressure\" format=\"binary\">\n          " << binary_encode(p_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Velocity\" NumberOfComponents=\"3\" format=\"binary\">\n          " << binary_encode_vector(ur_f, uz_f, zero_vec) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Energy\" format=\"binary\">\n          " << binary_encode(E_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Alpha1\" format=\"binary\">\n          " << binary_encode(a1_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Alpha2\" format=\"binary\">\n          " << binary_encode(a2_f) << "\n        </DataArray>\n";
    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtk_particles(const std::string& filename, int num_particles,
                           const double* pos_x, const double* pos_y,
                           const double* init_pos_x, const double* init_pos_y,
                           const double* /*stress_xx*/, const double* /*stress_yy*/,
                           const double* /*stress_xy*/, const double* stress_vm) {
    std::ofstream out(filename);
    if (!out) return;

    out << "# vtk DataFile Version 3.0\n";
    out << "MPM Particle Data\n";
    out << "ASCII\n";
    out << "DATASET POLYDATA\n";

    out << "POINTS " << num_particles << " double\n";
    for (int i = 0; i < num_particles; ++i) {
        out << pos_x[i] << " " << pos_y[i] << " 0.0\n";
    }

    out << "POINT_DATA " << num_particles << "\n";
    out << "VECTORS Displacement double\n";
    for (int i = 0; i < num_particles; ++i) {
        double dx = pos_x[i] - init_pos_x[i];
        double dy = pos_y[i] - init_pos_y[i];
        out << dx << " " << dy << " 0.0\n";
    }

    out << "SCALARS von_Mises double 1\nLOOKUP_TABLE default\n";
    for (int i = 0; i < num_particles; ++i) {
        out << stress_vm[i] << "\n";
    }

    out.close();
}

void export_vtu_slice_3d_snapshot(const std::string& filename, const CFDSliceSnapshot3D& snap, const std::string& format) {
    std::ofstream out(filename);
    if (!out) return;

    std::string axis = snap.axis;
    double offset = snap.offset;
    int stride = (snap.stride > 0) ? snap.stride : 1;

    int nx = snap.nx;
    int ny = snap.ny;
    int nz = snap.nz;
    double dx = snap.dx;
    double xmin = snap.xmin;
    double ymin = snap.ymin;
    double zmin = snap.zmin;

    int w = 0, h = 0;
    if (axis == "xy") { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == "xz") { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    int num_points = (w + 1) * (h + 1);
    int num_cells = w * h;

    std::vector<float> points(num_points * 3, 0.0f);
    for (int j = 0; j <= h; ++j) {
        for (int i = 0; i <= w; ++i) {
            int pt_idx = j * (w + 1) + i;
            if (axis == "xy") {
                points[pt_idx * 3]     = static_cast<float>(xmin + i * stride * dx);
                points[pt_idx * 3 + 1] = static_cast<float>(ymin + j * stride * dx);
                points[pt_idx * 3 + 2] = static_cast<float>(offset);
            } else if (axis == "xz") {
                points[pt_idx * 3]     = static_cast<float>(xmin + i * stride * dx);
                points[pt_idx * 3 + 1] = static_cast<float>(offset);
                points[pt_idx * 3 + 2] = static_cast<float>(zmin + j * stride * dx);
            } else { // "yz"
                points[pt_idx * 3]     = static_cast<float>(offset);
                points[pt_idx * 3 + 1] = static_cast<float>(ymin + i * stride * dx);
                points[pt_idx * 3 + 2] = static_cast<float>(zmin + j * stride * dx);
            }
        }
    }

    std::vector<int32_t> connectivity(num_cells * 4);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 9); // VTK_QUAD

    int cell_idx = 0;
    for (int j = 0; j < h; ++j) {
        for (int i = 0; i < w; ++i) {
            int p0 = j * (w + 1) + i;
            int p1 = p0 + 1;
            int p2 = (j + 1) * (w + 1) + i + 1;
            int p3 = (j + 1) * (w + 1) + i;

            connectivity[cell_idx * 4]     = p0;
            connectivity[cell_idx * 4 + 1] = p1;
            connectivity[cell_idx * 4 + 2] = p2;
            connectivity[cell_idx * 4 + 3] = p3;
            offsets[cell_idx] = (cell_idx + 1) * 4;
            cell_idx++;
        }
    }

    out << "<?xml version=\"1.0\"?>\n";
    if (format == "ASCII") {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    } else {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    }
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    // Write Points
    out << "      <Points>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (float v : points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
        out << "          " << binary_encode(points) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Points>\n";

    // Write Cells
    out << "      <Cells>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"ascii\">\n          ";
        for (int32_t v : connectivity) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"ascii\">\n          ";
        for (int32_t v : offsets) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"ascii\">\n          ";
        for (uint8_t v : types) out << (int)v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
        out << "          " << binary_encode(connectivity) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
        out << "          " << binary_encode(offsets) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
        out << "          " << binary_encode(types) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Cells>\n";

    // Cell Data
    out << "      <CellData>\n";
    auto writeData = [&](const std::string& name, const std::vector<float>& data) {
        if (data.empty()) return;
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (float v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"binary\">\n          "
                << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    if (snap.has_p) writeData("Pressure", snap.p);
    if (snap.has_overpressure) writeData("Peak_Overpressure", snap.overpressure);
    if (snap.has_impulse) writeData("Peak_Impulse", snap.impulse);
    if (snap.has_rho) writeData("Density", snap.rho);
    if (snap.has_vel) writeData("Velocity", snap.vel);
    if (snap.has_E) writeData("Energy", snap.E);
    if (snap.has_reacted) writeData("Reacted_Explosive", snap.reacted);
    if (snap.has_unreacted) writeData("Unreacted_Explosive", snap.unreacted);
    if (snap.has_air) writeData("Air", snap.air);
    if (snap.has_solid) writeData("Solid", snap.solid);

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtu_slice_3d(const std::string& filename, const CFDSolver3D& solver, const Slice3D& slice, const std::string& format,
                         bool has_p, bool has_rho, bool has_vel, bool has_E,
                         bool has_reacted, bool has_unreacted, bool has_air,
                         bool has_solid, bool has_overpressure, bool has_impulse,
                         int slice_stride) {
    solver.invalidateTileCache();

    CFDSliceSnapshot3D snap;
    snap.axis = slice.axis;
    snap.offset = slice.offset;
    snap.stride = (slice_stride > 0) ? slice_stride : (slice.stride > 0 ? slice.stride : 1);
    snap.nx = solver.getNx();
    snap.ny = solver.getNy();
    snap.nz = solver.getNz();
    snap.dx = solver.getCellSize();
    snap.xmin = solver.getXMin();
    snap.ymin = solver.getYMin();
    snap.zmin = solver.getZMin();

    snap.has_p = has_p;
    snap.has_rho = has_rho;
    snap.has_vel = has_vel;
    snap.has_E = has_E;
    snap.has_reacted = has_reacted;
    snap.has_unreacted = has_unreacted;
    snap.has_air = has_air;
    snap.has_solid = has_solid;
    snap.has_overpressure = has_overpressure;
    snap.has_impulse = has_impulse;

    Slice3D slice_query = slice;
    slice_query.stride = snap.stride;

    if (has_rho) { slice_query.quantities = { "density" }; snap.rho = solver.extractSlice(slice_query); }
    if (has_p) { slice_query.quantities = { "pressure" }; snap.p = solver.extractSlice(slice_query); }
    if (has_vel) { slice_query.quantities = { "velocity" }; snap.vel = solver.extractSlice(slice_query); }
    if (has_E) { slice_query.quantities = { "energy" }; snap.E = solver.extractSlice(slice_query); }
    if (has_reacted) { slice_query.quantities = { "species1" }; snap.reacted = solver.extractSlice(slice_query); }
    if (has_unreacted) { slice_query.quantities = { "species2" }; snap.unreacted = solver.extractSlice(slice_query); }
    if (has_air) { slice_query.quantities = { "species3" }; snap.air = solver.extractSlice(slice_query); }
    if (has_solid) { slice_query.quantities = { "solid" }; snap.solid = solver.extractSlice(slice_query); }
    if (has_overpressure) { slice_query.quantities = { "overpressure" }; snap.overpressure = solver.extractSlice(slice_query); }
    if (has_impulse) { slice_query.quantities = { "impulse" }; snap.impulse = solver.extractSlice(slice_query); }

    export_vtu_slice_3d_snapshot(filename, snap, format);
}

void export_vtu_volume_3d_snapshot(const std::string& filename, const CFDVolumeSnapshot3D& snap, const std::string& format) {
    std::ofstream out(filename);
    if (!out) return;

    int nx = snap.nx;
    int ny = snap.ny;
    int nz = snap.nz;
    double cellSize = snap.cellSize;
    double xmin = snap.xmin;
    double ymin = snap.ymin;
    double zmin = snap.zmin;
    int stride = std::max(1, snap.stride);

    int i_start = 0, i_end = nx;
    int j_start = 0, j_end = ny;
    int k_start = 0, k_end = nz;

    if (snap.roi_enabled) {
        i_start = snap.i_start;
        i_end   = snap.i_end;
        j_start = snap.j_start;
        j_end   = snap.j_end;
        k_start = snap.k_start;
        k_end   = snap.k_end;
    }

    int nx_sub = (snap.nx_sub > 0) ? snap.nx_sub : ((i_end - i_start + stride - 1) / stride);
    int ny_sub = (snap.ny_sub > 0) ? snap.ny_sub : ((j_end - j_start + stride - 1) / stride);
    int nz_sub = (snap.nz_sub > 0) ? snap.nz_sub : ((k_end - k_start + stride - 1) / stride);

    if (nx_sub <= 0 || ny_sub <= 0 || nz_sub <= 0) return;

    int num_points = (nx_sub + 1) * (ny_sub + 1) * (nz_sub + 1);
    int num_cells = nx_sub * ny_sub * nz_sub;

    std::vector<float> points(num_points * 3);
    for (int k = 0; k <= nz_sub; ++k) {
        for (int j = 0; j <= ny_sub; ++j) {
            for (int i = 0; i <= nx_sub; ++i) {
                int pt_idx = i + j * (nx_sub + 1) + k * (nx_sub + 1) * (ny_sub + 1);
                points[pt_idx * 3]     = static_cast<float>(xmin + (i_start + i * stride) * cellSize);
                points[pt_idx * 3 + 1] = static_cast<float>(ymin + (j_start + j * stride) * cellSize);
                points[pt_idx * 3 + 2] = static_cast<float>(zmin + (k_start + k * stride) * cellSize);
            }
        }
    }

    std::vector<int32_t> connectivity(num_cells * 8);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 12); // VTK_HEXAHEDRON (12)

    for (int k = 0; k < nz_sub; ++k) {
        for (int j = 0; j < ny_sub; ++j) {
            for (int i = 0; i < nx_sub; ++i) {
                int c_idx = i + j * nx_sub + k * nx_sub * ny_sub;
                int p0 = i + j * (nx_sub + 1) + k * (nx_sub + 1) * (ny_sub + 1);
                int p1 = p0 + 1;
                int p2 = p0 + 1 + (nx_sub + 1);
                int p3 = p0 + (nx_sub + 1);
                int p4 = p0 + (nx_sub + 1) * (ny_sub + 1);
                int p5 = p4 + 1;
                int p6 = p4 + 1 + (nx_sub + 1);
                int p7 = p4 + (nx_sub + 1);

                connectivity[c_idx * 8]     = p0;
                connectivity[c_idx * 8 + 1] = p1;
                connectivity[c_idx * 8 + 2] = p2;
                connectivity[c_idx * 8 + 3] = p3;
                connectivity[c_idx * 8 + 4] = p4;
                connectivity[c_idx * 8 + 5] = p5;
                connectivity[c_idx * 8 + 6] = p6;
                connectivity[c_idx * 8 + 7] = p7;

                offsets[c_idx] = (c_idx + 1) * 8;
            }
        }
    }

    out << "<?xml version=\"1.0\"?>\n";
    if (format == "ASCII") {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    } else {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    }
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (float v : points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
        out << "          " << binary_encode(points) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Points>\n";

    points.clear(); points.shrink_to_fit();

    out << "      <Cells>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"ascii\">\n          ";
        for (int32_t v : connectivity) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"ascii\">\n          ";
        for (int32_t v : offsets) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"ascii\">\n          ";
        for (uint8_t v : types) out << (int)v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
        out << "          " << binary_encode(connectivity) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
        out << "          " << binary_encode(offsets) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
        out << "          " << binary_encode(types) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Cells>\n";

    connectivity.clear(); connectivity.shrink_to_fit();
    offsets.clear(); offsets.shrink_to_fit();
    types.clear(); types.shrink_to_fit();

    out << "      <CellData>\n";
    auto writeData = [&](const std::string& name, const std::vector<float>& data) {
        if (data.empty()) return;
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (float v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"binary\">\n          "
                << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    if (snap.has_p) writeData("Pressure", snap.p);
    if (snap.has_overpressure) writeData("Peak_Overpressure", snap.overpressure);
    if (snap.has_impulse) writeData("Peak_Impulse", snap.impulse);
    if (snap.has_rho) writeData("Density", snap.rho);
    if (snap.has_vel) writeData("Velocity", snap.vel);
    if (snap.has_E) writeData("Energy", snap.E);
    if (snap.has_reacted) writeData("Reacted_Explosive", snap.reacted);
    if (snap.has_unreacted) writeData("Unreacted_Explosive", snap.unreacted);
    if (snap.has_air) writeData("Air", snap.air);
    if (snap.has_solid) writeData("Solid", snap.solid);

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtu_volume_3d(const std::string& filename, const CFDSolver3D& solver, const std::string& format,
                          bool has_p, bool has_rho, bool has_vel, bool has_E,
                          bool has_reacted, bool has_unreacted, bool has_air,
                          bool has_solid, bool has_overpressure, bool has_impulse,
                          bool roi_enabled, double roi_xmin, double roi_xmax,
                          double roi_ymin, double roi_ymax,
                          double roi_zmin, double roi_zmax,
                          int volume_stride) {
    solver.invalidateTileCache();

    CFDVolumeSnapshot3D snap;
    snap.nx = solver.getNx();
    snap.ny = solver.getNy();
    snap.nz = solver.getNz();
    snap.cellSize = solver.getCellSize();
    snap.xmin = solver.getXMin();
    snap.ymin = solver.getYMin();
    snap.zmin = solver.getZMin();
    snap.stride = std::max(1, volume_stride);
    snap.roi_enabled = roi_enabled;
    snap.roi_xmin = roi_xmin; snap.roi_xmax = roi_xmax;
    snap.roi_ymin = roi_ymin; snap.roi_ymax = roi_ymax;
    snap.roi_zmin = roi_zmin; snap.roi_zmax = roi_zmax;

    snap.has_p = has_p;
    snap.has_rho = has_rho;
    snap.has_vel = has_vel;
    snap.has_E = has_E;
    snap.has_reacted = has_reacted;
    snap.has_unreacted = has_unreacted;
    snap.has_air = has_air;
    snap.has_solid = has_solid;
    snap.has_overpressure = has_overpressure;
    snap.has_impulse = has_impulse;

    if (!snap.roi_enabled) {
        Slice3D vol_query;
        vol_query.axis = "volume";
        vol_query.stride = snap.stride;
        if (has_rho) { vol_query.quantities = { "density" }; snap.rho = solver.extractSlice(vol_query); }
        if (has_p) { vol_query.quantities = { "pressure" }; snap.p = solver.extractSlice(vol_query); }
        if (has_vel) { vol_query.quantities = { "velocity" }; snap.vel = solver.extractSlice(vol_query); }
        if (has_E) { vol_query.quantities = { "energy" }; snap.E = solver.extractSlice(vol_query); }
        if (has_reacted) { vol_query.quantities = { "species1" }; snap.reacted = solver.extractSlice(vol_query); }
        if (has_unreacted) { vol_query.quantities = { "species2" }; snap.unreacted = solver.extractSlice(vol_query); }
        if (has_air) { vol_query.quantities = { "species3" }; snap.air = solver.extractSlice(vol_query); }
        if (snap.has_solid) { vol_query.quantities = { "solid" }; snap.solid = solver.extractSlice(vol_query); }
        if (has_overpressure) { vol_query.quantities = { "overpressure" }; snap.overpressure = solver.extractSlice(vol_query); }
        if (has_impulse) { vol_query.quantities = { "impulse" }; snap.impulse = solver.extractSlice(vol_query); }
    } else {
        int i_start = std::clamp(static_cast<int>(std::floor((snap.roi_xmin - snap.xmin) / snap.cellSize)), 0, snap.nx - 1);
        int i_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_xmax - snap.xmin) / snap.cellSize)), i_start + 1, snap.nx);
        int j_start = std::clamp(static_cast<int>(std::floor((snap.roi_ymin - snap.ymin) / snap.cellSize)), 0, snap.ny - 1);
        int j_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_ymax - snap.ymin) / snap.cellSize)), j_start + 1, snap.ny);
        int k_start = std::clamp(static_cast<int>(std::floor((snap.roi_zmin - snap.zmin) / snap.cellSize)), 0, snap.nz - 1);
        int k_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_zmax - snap.zmin) / snap.cellSize)), k_start + 1, snap.nz);

        snap.i_start = i_start; snap.i_end = i_end;
        snap.j_start = j_start; snap.j_end = j_end;
        snap.k_start = k_start; snap.k_end = k_end;
        snap.nx_sub = (i_end - i_start + snap.stride - 1) / snap.stride;
        snap.ny_sub = (j_end - j_start + snap.stride - 1) / snap.stride;
        snap.nz_sub = (k_end - k_start + snap.stride - 1) / snap.stride;
        int num_cells = snap.nx_sub * snap.ny_sub * snap.nz_sub;

        if (has_p) snap.p.resize(num_cells);
        if (has_rho) snap.rho.resize(num_cells);
        if (has_vel) snap.vel.resize(num_cells);
        if (has_E) snap.E.resize(num_cells);
        if (has_reacted) snap.reacted.resize(num_cells);
        if (has_unreacted) snap.unreacted.resize(num_cells);
        if (has_air) snap.air.resize(num_cells);
        if (snap.has_solid) snap.solid.resize(num_cells);
        if (has_overpressure) snap.overpressure.resize(num_cells);
        if (has_impulse) snap.impulse.resize(num_cells);

        for (int k = 0; k < snap.nz_sub; ++k) {
            for (int j = 0; j < snap.ny_sub; ++j) {
                for (int i = 0; i < snap.nx_sub; ++i) {
                    int c_idx = i + j * snap.nx_sub + k * snap.nx_sub * snap.ny_sub;
                    int gx = std::min(snap.nx - 1, i_start + i * snap.stride);
                    int gy = std::min(snap.ny - 1, j_start + j * snap.stride);
                    int gz = std::min(snap.nz - 1, k_start + k * snap.stride);
                    auto vals = solver.getCellValues(gx, gy, gz);
                    if (has_p && vals.size() > 0) snap.p[c_idx] = vals[0];
                    if (has_rho && vals.size() > 1) snap.rho[c_idx] = vals[1];
                    if (has_vel && vals.size() > 2) snap.vel[c_idx] = vals[2];
                    if (has_E && vals.size() > 3) snap.E[c_idx] = vals[3];
                    if (has_reacted && vals.size() > 4) snap.reacted[c_idx] = vals[4];
                    if (has_unreacted && vals.size() > 5) snap.unreacted[c_idx] = vals[5];
                    if (has_air && vals.size() > 6) snap.air[c_idx] = vals[6];
                    if (snap.has_solid && vals.size() > 7) snap.solid[c_idx] = vals[7];
                    if (has_overpressure && vals.size() > 8) snap.overpressure[c_idx] = vals[8];
                    if (has_impulse && vals.size() > 9) snap.impulse[c_idx] = vals[9];
                }
            }
        }
    }

    export_vtu_volume_3d_snapshot(filename, snap, format);
}

void export_vtu_amr_2d(const std::string& filename,
                       const std::vector<double>& points,
                       const std::vector<int32_t>& connectivity,
                       const std::vector<int32_t>& offsets,
                       const std::vector<uint8_t>& types,
                       const std::vector<double>& rho,
                       const std::vector<double>& ur,
                       const std::vector<double>& uz,
                       const std::vector<double>& p,
                       const std::vector<double>& level) {
    std::ofstream out(filename);
    if (!out) return;

    int num_points = static_cast<int>(points.size() / 3);
    int num_cells = static_cast<int>(offsets.size());

    std::vector<float> points_f(points.begin(), points.end());
    std::vector<float> rho_f(rho.begin(), rho.end());
    std::vector<float> ur_f(ur.begin(), ur.end());
    std::vector<float> uz_f(uz.begin(), uz.end());
    std::vector<float> p_f(p.begin(), p.end());
    std::vector<float> level_f(level.begin(), level.end());

    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
    out << "          " << binary_encode(points_f) << "\n";
    out << "        </DataArray>\n";
    out << "      </Points>\n";

    out << "      <Cells>\n";
    out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
    out << "          " << binary_encode(connectivity) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
    out << "          " << binary_encode(offsets) << "\n";
    out << "        </DataArray>\n";
    out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
    out << "          " << binary_encode(types) << "\n";
    out << "        </DataArray>\n";
    out << "      </Cells>\n";

    out << "      <CellData>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Density\" format=\"binary\">\n          " << binary_encode(rho_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"Pressure\" format=\"binary\">\n          " << binary_encode(p_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"VelocityR\" format=\"binary\">\n          " << binary_encode(ur_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"VelocityZ\" format=\"binary\">\n          " << binary_encode(uz_f) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float32\" Name=\"AMRLevel\" format=\"binary\">\n          " << binary_encode(level_f) << "\n        </DataArray>\n";
    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

#include "fem_solver_3d.hpp"
#include "mpm_solver_3d.hpp"

template <typename T>
void export_vtu_fem_3d(const std::string& filename, const Blast::FEMSolver3D<T>& solver, const std::string& format,
                       bool has_stress, bool has_strain, bool has_pressure,
                       bool has_temp, bool has_damage, bool has_vel, bool has_disp) {
    std::ofstream out(filename);
    if (!out) return;

    const auto& nodes = solver.getNodes();
    const auto& elements = solver.getElements();
    const auto& trusses = solver.getTrusses();
    const auto& beams = solver.getBeams();

    int num_points = static_cast<int>(nodes.size());
    int num_cells = 0;

    for (const auto& elem : elements) {
        if (!elem.is_eroded) num_cells++;
    }
    for (const auto& tr : trusses) {
        if (!tr.is_eroded) num_cells++;
    }
    for (const auto& bm : beams) {
        if (!bm.is_eroded) num_cells++;
    }

    std::vector<float> points(num_points * 3);
    std::vector<float> disp(num_points * 3, 0.0f);
    std::vector<float> vel(num_points * 3, 0.0f);

    for (int i = 0; i < num_points; ++i) {
        points[i * 3 + 0] = static_cast<float>(nodes[i].x[0]);
        points[i * 3 + 1] = static_cast<float>(nodes[i].x[1]);
        points[i * 3 + 2] = static_cast<float>(nodes[i].x[2]);

        disp[i * 3 + 0] = static_cast<float>(nodes[i].x[0] - nodes[i].x0[0]);
        disp[i * 3 + 1] = static_cast<float>(nodes[i].x[1] - nodes[i].x0[1]);
        disp[i * 3 + 2] = static_cast<float>(nodes[i].x[2] - nodes[i].x0[2]);

        vel[i * 3 + 0] = static_cast<float>(nodes[i].v[0]);
        vel[i * 3 + 1] = static_cast<float>(nodes[i].v[1]);
        vel[i * 3 + 2] = static_cast<float>(nodes[i].v[2]);
    }

    std::vector<int32_t> connectivity;
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells);

    std::vector<int32_t> material_id(num_cells);
    std::vector<int32_t> part_id(num_cells);
    std::vector<int32_t> element_type(num_cells); // 0 = Solid Hex8, 1 = Truss 1D, 2 = Beam 1D
    std::vector<float> von_mises(num_cells, 0.0f);
    std::vector<float> plastic_strain(num_cells, 0.0f);
    std::vector<float> pressure(num_cells, 0.0f);
    std::vector<float> temperature(num_cells, 0.0f);
    std::vector<float> damage(num_cells, 0.0f);

    connectivity.reserve(num_cells * 8);

    int c_idx = 0;

    // 1. Hex8 Solid Elements (VTK_HEXAHEDRON = 12)
    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;

        for (int n = 0; n < 8; ++n) {
            connectivity.push_back(elem.node_ids[n]);
        }
        offsets[c_idx] = static_cast<int32_t>(connectivity.size());
        types[c_idx] = 12; // VTK_HEXAHEDRON

        material_id[c_idx] = elem.mat_id;
        part_id[c_idx] = elem.part_id;
        element_type[c_idx] = 0; // 0 = Solid Hex8

        double mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / 3.0;
        double s00 = elem.sigma[0][0] - mean_s;
        double s11 = elem.sigma[1][1] - mean_s;
        double s22 = elem.sigma[2][2] - mean_s;
        double s01 = elem.sigma[0][1];
        double s12 = elem.sigma[1][2];
        double s20 = elem.sigma[2][0];

        von_mises[c_idx] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
        plastic_strain[c_idx] = static_cast<float>(elem.ep_bar);
        pressure[c_idx] = static_cast<float>(-mean_s);
        temperature[c_idx] = static_cast<float>(elem.temperature);
        damage[c_idx] = static_cast<float>(elem.damage);
        c_idx++;
    }

    // 2. 1D Rebar Truss Elements (VTK_LINE = 3)
    for (const auto& tr : trusses) {
        if (tr.is_eroded) continue;

        connectivity.push_back(tr.node_ids[0]);
        connectivity.push_back(tr.node_ids[1]);
        offsets[c_idx] = static_cast<int32_t>(connectivity.size());
        types[c_idx] = 3; // VTK_LINE

        material_id[c_idx] = tr.mat_id;
        part_id[c_idx] = tr.part_id;
        element_type[c_idx] = 1; // 1 = 1D Truss

        von_mises[c_idx] = static_cast<float>(std::abs(static_cast<double>(tr.sigma)));
        plastic_strain[c_idx] = static_cast<float>(tr.ep_bar);
        pressure[c_idx] = 0.0f;
        temperature[c_idx] = 300.0f;
        damage[c_idx] = tr.is_eroded ? 1.0f : 0.0f;
        c_idx++;
    }

    // 3. 1D Timoshenko Structural Beam Elements (VTK_LINE = 3)
    const auto& mat_tables = solver.getMaterialTables();
    for (const auto& bm : beams) {
        if (bm.is_eroded) continue;

        connectivity.push_back(bm.node_ids[0]);
        connectivity.push_back(bm.node_ids[1]);
        offsets[c_idx] = static_cast<int32_t>(connectivity.size());
        types[c_idx] = 3; // VTK_LINE

        material_id[c_idx] = bm.mat_id;
        part_id[c_idx] = bm.part_id;
        element_type[c_idx] = 2; // 2 = 1D Beam

        double E = 200.0e9;
        double sigma_y = 500.0e6;
        double E_tan = 2.0e9;
        if (bm.mat_id >= 0 && bm.mat_id < static_cast<int>(mat_tables.size())) {
            if (mat_tables[bm.mat_id].youngs_modulus > 0.0f) E = static_cast<double>(mat_tables[bm.mat_id].youngs_modulus);
            if (mat_tables[bm.mat_id].yield_stress > 0.0f) sigma_y = static_cast<double>(mat_tables[bm.mat_id].yield_stress);
            if (mat_tables[bm.mat_id].hardening_modulus > 0.0f) E_tan = static_cast<double>(mat_tables[bm.mat_id].hardening_modulus);
        }
        double eps_bend = (static_cast<double>(bm.d) * 0.5) * std::sqrt(static_cast<double>(bm.kappa2 * bm.kappa2 + bm.kappa3 * bm.kappa3));
        double sig_eff = E * (std::abs(static_cast<double>(bm.eps_p)) + eps_bend);
        if (bm.ep_bar > 0.0f) {
            sig_eff = sigma_y + E_tan * static_cast<double>(bm.ep_bar);
        }

        von_mises[c_idx] = static_cast<float>(sig_eff);
        plastic_strain[c_idx] = static_cast<float>(bm.ep_bar);
        pressure[c_idx] = 0.0f;
        temperature[c_idx] = 300.0f;
        damage[c_idx] = bm.is_eroded ? 1.0f : 0.0f;
        c_idx++;
    }

    out << "<?xml version=\"1.0\"?>\n";
    if (format == "ASCII") {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    } else {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    }
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (float v : points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
        out << "          " << binary_encode(points) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Points>\n";

    out << "      <Cells>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"ascii\">\n          ";
        for (int32_t v : connectivity) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"ascii\">\n          ";
        for (int32_t v : offsets) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"ascii\">\n          ";
        for (uint8_t v : types) out << (int)v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
        out << "          " << binary_encode(connectivity) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
        out << "          " << binary_encode(offsets) << "\n";
        out << "        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
        out << "          " << binary_encode(types) << "\n";
        out << "        </DataArray>\n";
    }
    out << "      </Cells>\n";

    out << "      <PointData>\n";
    auto writePointData = [&](const std::string& name, const std::vector<float>& data, int num_comp = 3) {
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" NumberOfComponents=\"" << num_comp << "\" format=\"ascii\">\n          ";
            for (float v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" NumberOfComponents=\"" << num_comp << "\" format=\"binary\">\n          " << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    if (has_disp) writePointData("Displacement", disp, 3);
    if (has_vel) writePointData("Velocity", vel, 3);
    out << "      </PointData>\n";

    out << "      <CellData>\n";
    auto writeCellDataInt = [&](const std::string& name, const std::vector<int32_t>& data) {
        if (format == "ASCII") {
            out << "        <DataArray type=\"Int32\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (int32_t v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Int32\" Name=\"" << name << "\" format=\"binary\">\n          " << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    auto writeCellDataFloat = [&](const std::string& name, const std::vector<float>& data) {
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (float v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" format=\"binary\">\n          " << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    writeCellDataInt("Material_ID", material_id);
    writeCellDataInt("Part_ID", part_id);
    writeCellDataInt("Element_Type", element_type);

    if (has_stress) writeCellDataFloat("von_Mises_Stress", von_mises);
    if (has_strain) writeCellDataFloat("Plastic_Strain", plastic_strain);
    if (has_pressure) writeCellDataFloat("Hydrostatic_Pressure", pressure);
    if (has_temp) writeCellDataFloat("Temperature", temperature);
    if (has_damage) writeCellDataFloat("Damage", damage);

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

template void export_vtu_fem_3d<float>(const std::string&, const Blast::FEMSolver3D<float>&, const std::string&, bool, bool, bool, bool, bool, bool, bool);
template void export_vtu_fem_3d<double>(const std::string&, const Blast::FEMSolver3D<double>&, const std::string&, bool, bool, bool, bool, bool, bool, bool);

void export_vtu_mpm_3d_snapshot(const std::string& filename, const MPMVTKSnapshot3D& snap, const std::string& format) {
    std::ofstream out(filename);
    if (!out) return;

    int num_points = snap.num_particles;
    int num_cells = num_points;
    if (num_points <= 0) return;

    std::vector<int32_t> connectivity(num_cells);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 1); // VTK_VERTEX (1)
    for (int i = 0; i < num_cells; ++i) {
        connectivity[i] = i;
        offsets[i] = i + 1;
    }

    std::string points_encoded, conn_encoded, off_encoded, types_encoded;
    std::string vel_encoded, vm_encoded, p_encoded, ep_encoded, dmg_encoded, temp_encoded, obj_encoded;

    if (format != "ASCII") {
        #pragma omp parallel sections
        {
            #pragma omp section
            { points_encoded = binary_encode(snap.points); }
            #pragma omp section
            { conn_encoded = binary_encode(connectivity); }
            #pragma omp section
            { off_encoded = binary_encode(offsets); }
            #pragma omp section
            { types_encoded = binary_encode(types); }
            #pragma omp section
            { if (snap.has_vel && !snap.vel.empty()) vel_encoded = binary_encode(snap.vel); }
            #pragma omp section
            { if (snap.has_stress && !snap.von_mises.empty()) vm_encoded = binary_encode(snap.von_mises); }
            #pragma omp section
            { if (snap.has_stress && !snap.pressure.empty()) p_encoded = binary_encode(snap.pressure); }
            #pragma omp section
            { if (snap.has_strain && !snap.ep_bar.empty()) ep_encoded = binary_encode(snap.ep_bar); }
            #pragma omp section
            { if (snap.has_damage && !snap.damage.empty()) dmg_encoded = binary_encode(snap.damage); }
            #pragma omp section
            { if (snap.has_temp && !snap.temp.empty()) temp_encoded = binary_encode(snap.temp); }
            #pragma omp section
            { if (!snap.obj_id.empty()) obj_encoded = binary_encode(snap.obj_id); }
        }
    }

    out << "<?xml version=\"1.0\"?>\n";
    if (format == "ASCII") {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    } else {
        out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    }
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (float v : snap.points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float32\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n          " << points_encoded << "\n        </DataArray>\n";
    }
    out << "      </Points>\n";

    out << "      <Cells>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"ascii\">\n          ";
        for (int32_t v : connectivity) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"ascii\">\n          ";
        for (int32_t v : offsets) out << v << " ";
        out << "\n        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"ascii\">\n          ";
        for (uint8_t v : types) out << (int)v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n          " << conn_encoded << "\n        </DataArray>\n";
        out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n          " << off_encoded << "\n        </DataArray>\n";
        out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n          " << types_encoded << "\n        </DataArray>\n";
    }
    out << "      </Cells>\n";

    out << "      <PointData>\n";
    auto writePointData = [&](const std::string& name, const std::vector<float>& data, const std::string& encoded, int num_comp = 1) {
        if (data.empty()) return;
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" NumberOfComponents=\"" << num_comp << "\" format=\"ascii\">\n          ";
            for (float v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float32\" Name=\"" << name << "\" NumberOfComponents=\"" << num_comp << "\" format=\"binary\">\n          " << encoded << "\n        </DataArray>\n";
        }
    };

    if (snap.has_vel) writePointData("Velocity", snap.vel, vel_encoded, 3);
    if (snap.has_stress) {
        writePointData("von_Mises_Stress", snap.von_mises, vm_encoded, 1);
        writePointData("Hydrostatic_Pressure", snap.pressure, p_encoded, 1);
    }
    if (snap.has_strain) writePointData("Plastic_Strain", snap.ep_bar, ep_encoded, 1);
    if (snap.has_damage) writePointData("Damage", snap.damage, dmg_encoded, 1);
    if (snap.has_temp) writePointData("Temperature", snap.temp, temp_encoded, 1);
    writePointData("ObjectID", snap.obj_id, obj_encoded, 1);

    out << "      </PointData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtu_mpm_3d(const std::string& filename, const std::vector<Blast::MPMParticle3D>& particles, const std::string& format,
                       bool has_vel, bool has_disp, bool has_stress,
                       bool has_strain, bool has_damage, bool has_temp) {
    MPMVTKSnapshot3D snap;
    snap.num_particles = static_cast<int>(particles.size());
    snap.has_vel = has_vel;
    snap.has_disp = has_disp;
    snap.has_stress = has_stress;
    snap.has_strain = has_strain;
    snap.has_damage = has_damage;
    snap.has_temp = has_temp;

    if (snap.num_particles <= 0) return;

    snap.points.resize(snap.num_particles * 3);
    if (has_vel) snap.vel.resize(snap.num_particles * 3);
    if (has_stress) { snap.von_mises.resize(snap.num_particles); snap.pressure.resize(snap.num_particles); }
    if (has_strain) snap.ep_bar.resize(snap.num_particles);
    if (has_damage) snap.damage.resize(snap.num_particles);
    if (has_temp) snap.temp.resize(snap.num_particles);
    snap.obj_id.resize(snap.num_particles);

    #pragma omp parallel for schedule(static)
    for (int i = 0; i < snap.num_particles; ++i) {
        const auto& p = particles[i];
        snap.points[i * 3 + 0] = static_cast<float>(p.x[0]);
        snap.points[i * 3 + 1] = static_cast<float>(p.x[1]);
        snap.points[i * 3 + 2] = static_cast<float>(p.x[2]);

        if (has_vel) {
            snap.vel[i * 3 + 0] = static_cast<float>(p.v[0]);
            snap.vel[i * 3 + 1] = static_cast<float>(p.v[1]);
            snap.vel[i * 3 + 2] = static_cast<float>(p.v[2]);
        }
        if (has_stress) {
            double mean_s = (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0;
            double s00 = p.sigma[0][0] - mean_s;
            double s11 = p.sigma[1][1] - mean_s;
            double s22 = p.sigma[2][2] - mean_s;
            double s01 = p.sigma[0][1];
            double s12 = p.sigma[1][2];
            double s20 = p.sigma[2][0];
            snap.von_mises[i] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
            snap.pressure[i] = static_cast<float>(-mean_s);
        }
        if (has_strain) snap.ep_bar[i] = static_cast<float>(p.ep_bar);
        if (has_damage) snap.damage[i] = static_cast<float>(p.damage);
        if (has_temp) snap.temp[i] = static_cast<float>(p.temperature);
        snap.obj_id[i] = static_cast<float>(p.object_id);
    }

    export_vtu_mpm_3d_snapshot(filename, snap, format);
}

void append_pvd_timestep(const std::string& pvd_filename, double sim_time, const std::string& relative_vtu_path, const std::string& part) {
    std::vector<std::string> entries;
    if (sim_time > 0.0) {
        std::ifstream in(pvd_filename);
        if (in.good()) {
            std::string line;
            while (std::getline(in, line)) {
                if (line.find("<DataSet") != std::string::npos) {
                    if (line.find("file=\"" + relative_vtu_path + "\"") == std::string::npos) {
                        entries.push_back(line);
                    }
                }
            }
        }
    }

    std::ostringstream time_ss;
    time_ss << std::setprecision(10) << sim_time;
    std::string new_entry = "    <DataSet timestep=\"" + time_ss.str() + "\" group=\"\" part=\"" + part + "\" file=\"" + relative_vtu_path + "\"/>";
    entries.push_back(new_entry);

    std::ofstream out(pvd_filename, std::ios::trunc);
    if (!out) return;
    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"Collection\" version=\"0.1\" byte_order=\"LittleEndian\">\n";
    out << "  <Collection>\n";
    for (const auto& e : entries) {
        out << e << "\n";
    }
    out << "  </Collection>\n";
    out << "</VTKFile>\n";
    out.close();
}
