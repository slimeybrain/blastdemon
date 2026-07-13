#include "VTKWriter.hpp"
#include "cfd_solver_3d.hpp"
#include <fstream>
#include <iostream>
#include <algorithm>
#include <cmath>
#include <vector>
#include <zlib.h>
#include <cstdint>
#include <cstring>

static const std::string base64_chars =
             "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "abcdefghijklmnopqrstuvwxyz"
             "0123456789+/";

static std::string base64_encode(const unsigned char* buf, unsigned int bufLen) {
  std::string ret;
  int i = 0;
  int j = 0;
  unsigned char char_array_3[3];
  unsigned char char_array_4[4];

  while (bufLen--) {
    char_array_3[i++] = *(buf++);
    if (i == 3) {
      char_array_4[0] = (char_array_3[0] & 0xfc) >> 2;
      char_array_4[1] = ((char_array_3[0] & 0x03) << 4) + ((char_array_3[1] & 0xf0) >> 4);
      char_array_4[2] = ((char_array_3[1] & 0x0f) << 2) + ((char_array_3[2] & 0xc0) >> 6);
      char_array_4[3] = char_array_3[2] & 0x3f;

      for(i = 0; (i <4) ; i++)
        ret += base64_chars[char_array_4[i]];
      i = 0;
    }
  }

  if (i)
  {
    for(j = i; j < 3; j++)
      char_array_3[j] = '\0';

    char_array_4[0] = (char_array_3[0] & 0xfc) >> 2;
    char_array_4[1] = ((char_array_3[0] & 0x03) << 4) + ((char_array_3[1] & 0xf0) >> 4);
    char_array_4[2] = ((char_array_3[1] & 0x0f) << 2) + ((char_array_3[2] & 0xc0) >> 6);
    char_array_4[3] = char_array_3[2] & 0x3f;

    for (j = 0; (j < i + 1); j++)
      ret += base64_chars[char_array_4[j]];

    while((i++ < 3))
      ret += '=';
  }
  return ret;
}

template<typename T>
static std::string binary_encode(const std::vector<T>& data) {
    uint32_t num_blocks = 1;
    uint32_t block_size = data.size() * sizeof(T);
    uLongf comp_size = compressBound(block_size);
    std::vector<unsigned char> comp(comp_size);
    if (block_size > 0) {
        compress(comp.data(), &comp_size, (const unsigned char*)data.data(), block_size);
    } else {
        comp_size = 0;
    }
    
    uint32_t head[4] = {num_blocks, block_size, block_size, static_cast<uint32_t>(comp_size)};
    
    return base64_encode((const unsigned char*)head, sizeof(head)) + base64_encode(comp.data(), comp_size);
}

static std::string binary_encode_vector(const std::vector<double>& v1, const std::vector<double>& v2, const std::vector<double>& v3) {
    std::vector<double> data(v1.size() * 3);
    for(size_t i = 0; i < v1.size(); ++i) {
        data[i*3] = v1[i];
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

    std::vector<double> points(num_points * 3, 0.0);
    for (int i = 0; i <= n_cells; ++i) {
        points[i * 3] = i * dr;
    }

    std::vector<int32_t> connectivity(num_cells * 2);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 3); // VTK_LINE

    for (int i = 0; i < num_cells; ++i) {
        connectivity[i * 2] = i;
        connectivity[i * 2 + 1] = i + 1;
        offsets[i] = (i + 1) * 2;
    }

    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
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
    out << "        <DataArray type=\"Float64\" Name=\"Density\" format=\"binary\">\n          " << binary_encode(rho) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Pressure\" format=\"binary\">\n          " << binary_encode(p) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Velocity\" format=\"binary\">\n          " << binary_encode(u) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Energy\" format=\"binary\">\n          " << binary_encode(E) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha1\" format=\"binary\">\n          " << binary_encode(alpha1) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha2\" format=\"binary\">\n          " << binary_encode(alpha2) << "\n        </DataArray>\n";
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

    std::vector<double> points(num_points * 3, 0.0);
    for (int j = 0; j <= nz; ++j) {
        for (int i = 0; i <= nr; ++i) {
            int pt_idx = j * (nr + 1) + i;
            points[pt_idx * 3] = i * dr;     // x (or r)
            points[pt_idx * 3 + 1] = j * dz; // y (or z)
            points[pt_idx * 3 + 2] = 0.0;    // z (or 0)
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

            connectivity[cell_idx * 4] = p0;
            connectivity[cell_idx * 4 + 1] = p1;
            connectivity[cell_idx * 4 + 2] = p2;
            connectivity[cell_idx * 4 + 3] = p3;
            offsets[cell_idx] = (cell_idx + 1) * 4;
            cell_idx++;
        }
    }

    out << "<?xml version=\"1.0\"?>\n";
    out << "<VTKFile type=\"UnstructuredGrid\" version=\"0.1\" byte_order=\"LittleEndian\" header_type=\"UInt32\" compressor=\"vtkZLibDataCompressor\">\n";
    out << "  <UnstructuredGrid>\n";
    out << "    <Piece NumberOfPoints=\"" << num_points << "\" NumberOfCells=\"" << num_cells << "\">\n";

    out << "      <Points>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
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

    // For 2D solver, the state arrays may be stored column-major or row-major.
    // Assuming the C++ wrapper passes them correctly (r fast, z slow or vice versa).
    // This example assumes they are 1D arrays of size nr * nz.
    std::vector<double> zero_vec(rho.size(), 0.0);

    out << "        <DataArray type=\"Float64\" Name=\"Density\" format=\"binary\">\n          " << binary_encode(rho) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Pressure\" format=\"binary\">\n          " << binary_encode(p) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Velocity\" NumberOfComponents=\"3\" format=\"binary\">\n          " << binary_encode_vector(ur, uz, zero_vec) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Energy\" format=\"binary\">\n          " << binary_encode(E) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha1\" format=\"binary\">\n          " << binary_encode(alpha1) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha2\" format=\"binary\">\n          " << binary_encode(alpha2) << "\n        </DataArray>\n";

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtk_particles(const std::string& filename, int num_particles,
                           const double* pos_x, const double* pos_y,
                           const double* init_pos_x, const double* init_pos_y,
                           const double* stress_xx, const double* stress_yy,
                           const double* stress_xy, const double* stress_vm) {
    std::ofstream out(filename);
    if (!out) return;

    out << "# vtk DataFile Version 3.0\n";
    out << "MPM Particle Data\n";
    out << "ASCII\n";
    out << "DATASET POLYDATA\n";

    // Write points (particles)
    out << "POINTS " << num_particles << " double\n";
    for (int i = 0; i < num_particles; ++i) {
        out << pos_x[i] << " " << pos_y[i] << " 0.0\n";
    }

    // Write point data (attributes)
    out << "POINT_DATA " << num_particles << "\n";

    // Displacement (Vector)
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

void export_vtu_slice_3d(const std::string& filename, const CFDSolver3D& solver, const Slice3D& slice, const std::string& format,
                         bool has_p, bool has_rho, bool has_vel, bool has_E,
                         bool has_reacted, bool has_unreacted, bool has_air) {
    std::ofstream out(filename);
    if (!out) return;

    std::string axis = slice.axis;
    double offset = slice.offset;
    int stride = slice.stride > 0 ? slice.stride : 1;

    int nx = solver.getNx();
    int ny = solver.getNy();
    int nz = solver.getNz();
    double dx = solver.getCellSize();
    double xmin = solver.getXMin();
    double ymin = solver.getYMin();
    double zmin = solver.getZMin();

    int w = 0, h = 0;
    if (axis == "xy") { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == "xz") { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    int num_points = (w + 1) * (h + 1);
    int num_cells = w * h;

    std::vector<double> points(num_points * 3, 0.0);
    for (int j = 0; j <= h; ++j) {
        for (int i = 0; i <= w; ++i) {
            int pt_idx = j * (w + 1) + i;
            if (axis == "xy") {
                points[pt_idx * 3] = xmin + i * stride * dx;
                points[pt_idx * 3 + 1] = ymin + j * stride * dx;
                points[pt_idx * 3 + 2] = offset;
            } else if (axis == "xz") {
                points[pt_idx * 3] = xmin + i * stride * dx;
                points[pt_idx * 3 + 1] = offset;
                points[pt_idx * 3 + 2] = zmin + j * stride * dx;
            } else { // "yz"
                points[pt_idx * 3] = offset;
                points[pt_idx * 3 + 1] = ymin + i * stride * dx;
                points[pt_idx * 3 + 2] = zmin + j * stride * dx;
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

            connectivity[cell_idx * 4] = p0;
            connectivity[cell_idx * 4 + 1] = p1;
            connectivity[cell_idx * 4 + 2] = p2;
            connectivity[cell_idx * 4 + 3] = p3;
            offsets[cell_idx] = (cell_idx + 1) * 4;
            cell_idx++;
        }
    }

    std::vector<double> rho, p, vel, E, reacted, unreacted, air;
    if (has_rho) rho.resize(num_cells);
    if (has_p) p.resize(num_cells);
    if (has_vel) vel.resize(num_cells);
    if (has_E) E.resize(num_cells);
    if (has_reacted) reacted.resize(num_cells);
    if (has_unreacted) unreacted.resize(num_cells);
    if (has_air) air.resize(num_cells);

    for (int j = 0; j < h; ++j) {
        for (int i = 0; i < w; ++i) {
            int gx = i * stride;
            int gy = j * stride;
            int gz = 0;
            if (axis == "xy") {
                gz = std::clamp((int)((offset - zmin) / dx), 0, nz - 1);
            } else if (axis == "xz") {
                gz = j * stride;
                gy = std::clamp((int)((offset - ymin) / dx), 0, ny - 1);
            } else { // "yz"
                gz = j * stride;
                gy = i * stride;
                gx = std::clamp((int)((offset - xmin) / dx), 0, nx - 1);
            }

            auto vals = solver.getCellValues(gx, gy, gz);
            int idx = i + j * w;
            if (has_p) p[idx] = vals[0];
            if (has_rho) rho[idx] = vals[1];
            if (has_vel) vel[idx] = vals[2];
            if (has_E) E[idx] = vals[3];
            if (has_reacted) reacted[idx] = vals[4];
            if (has_unreacted) unreacted[idx] = vals[5];
            if (has_air) air[idx] = vals[6];
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
        out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (double v : points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
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
    auto writeData = [&](const std::string& name, const std::vector<double>& data) {
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float64\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (double v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float64\" Name=\"" << name << "\" format=\"binary\">\n          "
                << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    if (has_rho) writeData("Density", rho);
    if (has_p) writeData("Pressure", p);
    if (has_vel) writeData("Velocity", vel);
    if (has_E) writeData("Energy", E);
    if (has_reacted) writeData("Reacted_Explosive", reacted);
    if (has_unreacted) writeData("Unreacted_Explosive", unreacted);
    if (has_air) writeData("Air", air);

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}

void export_vtu_volume_3d(const std::string& filename, const CFDSolver3D& solver, const std::string& format,
                          bool has_p, bool has_rho, bool has_vel, bool has_E,
                          bool has_reacted, bool has_unreacted, bool has_air) {
    std::ofstream out(filename);
    if (!out) return;

    int nx = solver.getNx();
    int ny = solver.getNy();
    int nz = solver.getNz();
    double cellSize = solver.getCellSize();
    double xmin = solver.getXMin();
    double ymin = solver.getYMin();
    double zmin = solver.getZMin();

    int num_points = (nx + 1) * (ny + 1) * (nz + 1);
    int num_cells = nx * ny * nz;

    std::vector<double> points(num_points * 3);
    for (int k = 0; k <= nz; ++k) {
        for (int j = 0; j <= ny; ++j) {
            for (int i = 0; i <= nx; ++i) {
                int pt_idx = i + j * (nx + 1) + k * (nx + 1) * (ny + 1);
                points[pt_idx * 3] = xmin + i * cellSize;
                points[pt_idx * 3 + 1] = ymin + j * cellSize;
                points[pt_idx * 3 + 2] = zmin + k * cellSize;
            }
        }
    }

    std::vector<int32_t> connectivity(num_cells * 8);
    std::vector<int32_t> offsets(num_cells);
    std::vector<uint8_t> types(num_cells, 12); // VTK_HEXAHEDRON (12)

    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                int c_idx = i + j * nx + k * nx * ny;
                int p0 = i + j * (nx + 1) + k * (nx + 1) * (ny + 1);
                int p1 = p0 + 1;
                int p2 = p0 + 1 + (nx + 1);
                int p3 = p0 + (nx + 1);
                int p4 = p0 + (nx + 1) * (ny + 1);
                int p5 = p4 + 1;
                int p6 = p4 + 1 + (nx + 1);
                int p7 = p4 + (nx + 1);

                connectivity[c_idx * 8] = p0;
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

    std::vector<double> rho, p, vel, E, reacted, unreacted, air;
    if (has_rho) rho.resize(num_cells);
    if (has_p) p.resize(num_cells);
    if (has_vel) vel.resize(num_cells);
    if (has_E) E.resize(num_cells);
    if (has_reacted) reacted.resize(num_cells);
    if (has_unreacted) unreacted.resize(num_cells);
    if (has_air) air.resize(num_cells);

    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                int c_idx = i + j * nx + k * nx * ny;
                auto vals = solver.getCellValues(i, j, k);
                if (has_p) p[c_idx] = vals[0];
                if (has_rho) rho[c_idx] = vals[1];
                if (has_vel) vel[c_idx] = vals[2];
                if (has_E) E[c_idx] = vals[3];
                if (has_reacted) reacted[c_idx] = vals[4];
                if (has_unreacted) unreacted[c_idx] = vals[5];
                if (has_air) air[c_idx] = vals[6];
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

    // Write Points
    out << "      <Points>\n";
    if (format == "ASCII") {
        out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"ascii\">\n          ";
        for (double v : points) out << v << " ";
        out << "\n        </DataArray>\n";
    } else {
        out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
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
    auto writeData = [&](const std::string& name, const std::vector<double>& data) {
        if (format == "ASCII") {
            out << "        <DataArray type=\"Float64\" Name=\"" << name << "\" format=\"ascii\">\n          ";
            for (double v : data) out << v << " ";
            out << "\n        </DataArray>\n";
        } else {
            out << "        <DataArray type=\"Float64\" Name=\"" << name << "\" format=\"binary\">\n          "
                << binary_encode(data) << "\n        </DataArray>\n";
        }
    };

    if (has_rho) writeData("Density", rho);
    if (has_p) writeData("Pressure", p);
    if (has_vel) writeData("Velocity", vel);
    if (has_E) writeData("Energy", E);
    if (has_reacted) writeData("Reacted_Explosive", reacted);
    if (has_unreacted) writeData("Unreacted_Explosive", unreacted);
    if (has_air) writeData("Air", air);

    out << "      </CellData>\n";
    out << "    </Piece>\n";
    out << "  </UnstructuredGrid>\n";
    out << "</VTKFile>\n";

    out.close();
}
