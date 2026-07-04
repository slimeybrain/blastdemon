#include "VTKWriter.hpp"
#include <fstream>
#include <iostream>
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

static std::string compress_and_encode(const std::vector<double>& data) {
    uint32_t num_blocks = 1;
    uint32_t block_size = data.size() * sizeof(double);
    uint32_t last_block_size = block_size;

    uLongf compressed_size = compressBound(block_size);
    std::vector<unsigned char> compressed_data(compressed_size);

    if (compress(compressed_data.data(), &compressed_size, (const unsigned char*)data.data(), block_size) != Z_OK) {
        return "";
    }

    uint32_t header[4];
    header[0] = num_blocks;
    header[1] = block_size;
    header[2] = last_block_size;
    header[3] = compressed_size;

    std::vector<unsigned char> buffer(sizeof(header) + compressed_size);
    std::memcpy(buffer.data(), header, sizeof(header));
    std::memcpy(buffer.data() + sizeof(header), compressed_data.data(), compressed_size);

    return base64_encode(buffer.data(), buffer.size());
}

static std::string compress_and_encode_vector(const std::vector<double>& v1, const std::vector<double>& v2, const std::vector<double>& v3) {
    std::vector<double> data(v1.size() * 3);
    for(size_t i = 0; i < v1.size(); ++i) {
        data[i*3] = v1[i];
        data[i*3+1] = v2[i];
        data[i*3+2] = v3[i];
    }
    return compress_and_encode(data);
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

    // Points
    uint32_t num_blocks_pts = 1;
    uint32_t block_size_pts = points.size() * sizeof(double);
    uLongf comp_size_pts = compressBound(block_size_pts);
    std::vector<unsigned char> comp_pts(comp_size_pts);
    compress(comp_pts.data(), &comp_size_pts, (const unsigned char*)points.data(), block_size_pts);
    uint32_t head_pts[4] = {num_blocks_pts, block_size_pts, block_size_pts, static_cast<uint32_t>(comp_size_pts)};
    std::vector<unsigned char> buf_pts(sizeof(head_pts) + comp_size_pts);
    std::memcpy(buf_pts.data(), head_pts, sizeof(head_pts));
    std::memcpy(buf_pts.data() + sizeof(head_pts), comp_pts.data(), comp_size_pts);
    out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
    out << "          " << base64_encode(buf_pts.data(), buf_pts.size()) << "\n";
    out << "        </DataArray>\n";
    out << "      </Points>\n";

    out << "      <Cells>\n";

    // Connectivity
    uint32_t bs_conn = connectivity.size() * sizeof(int32_t);
    uLongf cs_conn = compressBound(bs_conn);
    std::vector<unsigned char> cc_conn(cs_conn);
    compress(cc_conn.data(), &cs_conn, (const unsigned char*)connectivity.data(), bs_conn);
    uint32_t h_conn[4] = {1, bs_conn, bs_conn, static_cast<uint32_t>(cs_conn)};
    std::vector<unsigned char> b_conn(sizeof(h_conn) + cs_conn);
    std::memcpy(b_conn.data(), h_conn, sizeof(h_conn));
    std::memcpy(b_conn.data() + sizeof(h_conn), cc_conn.data(), cs_conn);
    out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
    out << "          " << base64_encode(b_conn.data(), b_conn.size()) << "\n";
    out << "        </DataArray>\n";

    // Offsets
    uint32_t bs_off = offsets.size() * sizeof(int32_t);
    uLongf cs_off = compressBound(bs_off);
    std::vector<unsigned char> cc_off(cs_off);
    compress(cc_off.data(), &cs_off, (const unsigned char*)offsets.data(), bs_off);
    uint32_t h_off[4] = {1, bs_off, bs_off, static_cast<uint32_t>(cs_off)};
    std::vector<unsigned char> b_off(sizeof(h_off) + cs_off);
    std::memcpy(b_off.data(), h_off, sizeof(h_off));
    std::memcpy(b_off.data() + sizeof(h_off), cc_off.data(), cs_off);
    out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
    out << "          " << base64_encode(b_off.data(), b_off.size()) << "\n";
    out << "        </DataArray>\n";

    // Types
    uint32_t bs_typ = types.size() * sizeof(uint8_t);
    uLongf cs_typ = compressBound(bs_typ);
    std::vector<unsigned char> cc_typ(cs_typ);
    compress(cc_typ.data(), &cs_typ, (const unsigned char*)types.data(), bs_typ);
    uint32_t h_typ[4] = {1, bs_typ, bs_typ, static_cast<uint32_t>(cs_typ)};
    std::vector<unsigned char> b_typ(sizeof(h_typ) + cs_typ);
    std::memcpy(b_typ.data(), h_typ, sizeof(h_typ));
    std::memcpy(b_typ.data() + sizeof(h_typ), cc_typ.data(), cs_typ);
    out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
    out << "          " << base64_encode(b_typ.data(), b_typ.size()) << "\n";
    out << "        </DataArray>\n";

    out << "      </Cells>\n";
    out << "      <CellData>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Density\" format=\"binary\">\n          " << compress_and_encode(rho) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Pressure\" format=\"binary\">\n          " << compress_and_encode(p) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Velocity\" format=\"binary\">\n          " << compress_and_encode(u) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Energy\" format=\"binary\">\n          " << compress_and_encode(E) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha1\" format=\"binary\">\n          " << compress_and_encode(alpha1) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha2\" format=\"binary\">\n          " << compress_and_encode(alpha2) << "\n        </DataArray>\n";
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
    uint32_t num_blocks_pts = 1;
    uint32_t block_size_pts = points.size() * sizeof(double);
    uLongf comp_size_pts = compressBound(block_size_pts);
    std::vector<unsigned char> comp_pts(comp_size_pts);
    compress(comp_pts.data(), &comp_size_pts, (const unsigned char*)points.data(), block_size_pts);
    uint32_t head_pts[4] = {num_blocks_pts, block_size_pts, block_size_pts, static_cast<uint32_t>(comp_size_pts)};
    std::vector<unsigned char> buf_pts(sizeof(head_pts) + comp_size_pts);
    std::memcpy(buf_pts.data(), head_pts, sizeof(head_pts));
    std::memcpy(buf_pts.data() + sizeof(head_pts), comp_pts.data(), comp_size_pts);
    out << "        <DataArray type=\"Float64\" Name=\"Points\" NumberOfComponents=\"3\" format=\"binary\">\n";
    out << "          " << base64_encode(buf_pts.data(), buf_pts.size()) << "\n";
    out << "        </DataArray>\n";
    out << "      </Points>\n";

    out << "      <Cells>\n";
    uint32_t bs_conn = connectivity.size() * sizeof(int32_t);
    uLongf cs_conn = compressBound(bs_conn);
    std::vector<unsigned char> cc_conn(cs_conn);
    compress(cc_conn.data(), &cs_conn, (const unsigned char*)connectivity.data(), bs_conn);
    uint32_t h_conn[4] = {1, bs_conn, bs_conn, static_cast<uint32_t>(cs_conn)};
    std::vector<unsigned char> b_conn(sizeof(h_conn) + cs_conn);
    std::memcpy(b_conn.data(), h_conn, sizeof(h_conn));
    std::memcpy(b_conn.data() + sizeof(h_conn), cc_conn.data(), cs_conn);
    out << "        <DataArray type=\"Int32\" Name=\"connectivity\" format=\"binary\">\n";
    out << "          " << base64_encode(b_conn.data(), b_conn.size()) << "\n";
    out << "        </DataArray>\n";

    uint32_t bs_off = offsets.size() * sizeof(int32_t);
    uLongf cs_off = compressBound(bs_off);
    std::vector<unsigned char> cc_off(cs_off);
    compress(cc_off.data(), &cs_off, (const unsigned char*)offsets.data(), bs_off);
    uint32_t h_off[4] = {1, bs_off, bs_off, static_cast<uint32_t>(cs_off)};
    std::vector<unsigned char> b_off(sizeof(h_off) + cs_off);
    std::memcpy(b_off.data(), h_off, sizeof(h_off));
    std::memcpy(b_off.data() + sizeof(h_off), cc_off.data(), cs_off);
    out << "        <DataArray type=\"Int32\" Name=\"offsets\" format=\"binary\">\n";
    out << "          " << base64_encode(b_off.data(), b_off.size()) << "\n";
    out << "        </DataArray>\n";

    uint32_t bs_typ = types.size() * sizeof(uint8_t);
    uLongf cs_typ = compressBound(bs_typ);
    std::vector<unsigned char> cc_typ(cs_typ);
    compress(cc_typ.data(), &cs_typ, (const unsigned char*)types.data(), bs_typ);
    uint32_t h_typ[4] = {1, bs_typ, bs_typ, static_cast<uint32_t>(cs_typ)};
    std::vector<unsigned char> b_typ(sizeof(h_typ) + cs_typ);
    std::memcpy(b_typ.data(), h_typ, sizeof(h_typ));
    std::memcpy(b_typ.data() + sizeof(h_typ), cc_typ.data(), cs_typ);
    out << "        <DataArray type=\"UInt8\" Name=\"types\" format=\"binary\">\n";
    out << "          " << base64_encode(b_typ.data(), b_typ.size()) << "\n";
    out << "        </DataArray>\n";
    out << "      </Cells>\n";

    out << "      <CellData>\n";

    // For 2D solver, the state arrays may be stored column-major or row-major.
    // Assuming the C++ wrapper passes them correctly (r fast, z slow or vice versa).
    // This example assumes they are 1D arrays of size nr * nz.
    std::vector<double> zero_vec(rho.size(), 0.0);

    out << "        <DataArray type=\"Float64\" Name=\"Density\" format=\"binary\">\n          " << compress_and_encode(rho) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Pressure\" format=\"binary\">\n          " << compress_and_encode(p) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Velocity\" NumberOfComponents=\"3\" format=\"binary\">\n          " << compress_and_encode_vector(ur, uz, zero_vec) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Energy\" format=\"binary\">\n          " << compress_and_encode(E) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha1\" format=\"binary\">\n          " << compress_and_encode(alpha1) << "\n        </DataArray>\n";
    out << "        <DataArray type=\"Float64\" Name=\"Alpha2\" format=\"binary\">\n          " << compress_and_encode(alpha2) << "\n        </DataArray>\n";

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

    // Stress components as scalars
    out << "SCALARS sigma_xx double 1\nLOOKUP_TABLE default\n";
    for (int i = 0; i < num_particles; ++i) {
        out << stress_xx[i] << "\n";
    }

    out << "SCALARS sigma_yy double 1\nLOOKUP_TABLE default\n";
    for (int i = 0; i < num_particles; ++i) {
        out << stress_yy[i] << "\n";
    }

    out << "SCALARS sigma_xy double 1\nLOOKUP_TABLE default\n";
    for (int i = 0; i < num_particles; ++i) {
        out << stress_xy[i] << "\n";
    }

    out << "SCALARS von_Mises double 1\nLOOKUP_TABLE default\n";
    for (int i = 0; i < num_particles; ++i) {
        out << stress_vm[i] << "\n";
    }

    out.close();
}
