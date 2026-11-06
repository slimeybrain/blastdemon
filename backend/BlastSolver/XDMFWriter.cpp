#include "XDMFWriter.hpp"
#include <fstream>
#include <iostream>

bool XDMFWriter::writeXDMF(const std::string& xmfFilename, const std::string& h5Filename,
                          int numPoints, double dx) {
#ifdef NO_HDF5
    (void)xmfFilename; (void)h5Filename; (void)numPoints; (void)dx;
    return true;
#else
    std::ofstream xmf(xmfFilename);
    if (!xmf.is_open()) {
        std::cerr << "Failed to open XDMF file for writing: " << xmfFilename << std::endl;
        return false;
    }

    xmf << "<?xml version=\"1.0\" ?>\n";
    xmf << "<!DOCTYPE Xdmf SYSTEM \"Xdmf.dtd\" []>\n";
    xmf << "<Xdmf Version=\"2.0\">\n";
    xmf << " <Domain>\n";
    xmf << "   <Grid Name=\"Grid\" GridType=\"Uniform\">\n";
    xmf << "     <Topology TopologyType=\"1DCoRectMesh\" Dimensions=\"" << numPoints << "\"/>\n";
    xmf << "     <Geometry GeometryType=\"ORIGIN_DX\">\n";
    xmf << "       <DataItem Name=\"Origin\" Dimensions=\"1\" NumberType=\"Float\" Precision=\"8\" Format=\"XML\">\n";
    xmf << "         0\n";
    xmf << "       </DataItem>\n";
    xmf << "       <DataItem Name=\"Spacing\" Dimensions=\"1\" NumberType=\"Float\" Precision=\"8\" Format=\"XML\">\n";
    xmf << "         " << dx << "\n";
    xmf << "       </DataItem>\n";
    xmf << "     </Geometry>\n";

    auto writeAttribute = [&](const char* name, const char* dataset) {
        xmf << "     <Attribute Name=\"" << name << "\" AttributeType=\"Scalar\" Center=\"Node\">\n";
        xmf << "       <DataItem Dimensions=\"" << numPoints << "\" NumberType=\"Float\" Precision=\"8\" Format=\"HDF\">\n";
        xmf << "         " << h5Filename << ":" << dataset << "\n";
        xmf << "       </DataItem>\n";
        xmf << "     </Attribute>\n";
    };

    writeAttribute("Density", "/Density");
    writeAttribute("Pressure", "/Pressure");
    writeAttribute("Velocity", "/Velocity");
    writeAttribute("Alpha1", "/Alpha1");
    writeAttribute("Alpha2", "/Alpha2");

    xmf << "   </Grid>\n";
    xmf << " </Domain>\n";
    xmf << "</Xdmf>\n";

    xmf.close();
    return true;
#endif
}

static void writeMPMGridBlock(std::ostream& xmf, const std::string& relH5Filename,
                              int step, double time, const MPMVTKSnapshot3D& snap) {
    const int N = snap.num_particles;
    xmf << "      <Grid Name=\"MPM_Step_" << step << "\" GridType=\"Uniform\">\n";
    xmf << "        <Time Value=\"" << time << "\"/>\n";
    xmf << "        <Topology TopologyType=\"Polyvertex\" NodesPerElement=\"" << N << "\"/>\n";
    xmf << "        <Geometry GeometryType=\"XYZ\">\n";
    xmf << "          <DataItem Dimensions=\"" << N << " 3\" NumberType=\"Float\" Precision=\"4\" Format=\"HDF\">\n";
    xmf << "            " << relH5Filename << ":/Points\n";
    xmf << "          </DataItem>\n";
    xmf << "        </Geometry>\n";

    auto writeFloatAttr = [&](const char* name, const char* dset, int comps) {
        if (comps == 3) {
            xmf << "        <Attribute Name=\"" << name << "\" AttributeType=\"Vector\" Center=\"Node\">\n";
            xmf << "          <DataItem Dimensions=\"" << N << " 3\" NumberType=\"Float\" Precision=\"4\" Format=\"HDF\">\n";
        } else {
            xmf << "        <Attribute Name=\"" << name << "\" AttributeType=\"Scalar\" Center=\"Node\">\n";
            xmf << "          <DataItem Dimensions=\"" << N << "\" NumberType=\"Float\" Precision=\"4\" Format=\"HDF\">\n";
        }
        xmf << "            " << relH5Filename << ":" << dset << "\n";
        xmf << "          </DataItem>\n";
        xmf << "        </Attribute>\n";
    };

    auto writeUInt8Attr = [&](const char* name, const char* dset) {
        xmf << "        <Attribute Name=\"" << name << "\" AttributeType=\"Scalar\" Center=\"Node\">\n";
        xmf << "          <DataItem Dimensions=\"" << N << "\" NumberType=\"UInt\" Precision=\"1\" Format=\"HDF\">\n";
        xmf << "            " << relH5Filename << ":" << dset << "\n";
        xmf << "          </DataItem>\n";
        xmf << "        </Attribute>\n";
    };

    if (snap.has_vel && !snap.vel.empty()) writeFloatAttr("Velocity", "/Velocity", 3);
    if (snap.has_stress && !snap.von_mises.empty()) writeFloatAttr("von_Mises_Stress", "/von_Mises_Stress", 1);
    if (snap.has_pressure && !snap.pressure.empty()) writeFloatAttr("Pressure", "/Pressure", 1);
    if (snap.has_strain && !snap.ep_bar.empty()) writeFloatAttr("Plastic_Strain", "/Plastic_Strain", 1);
    if (snap.has_damage && !snap.damage.empty()) writeFloatAttr("Damage", "/Damage", 1);
    if (snap.has_temp && !snap.temp.empty()) writeFloatAttr("Temperature", "/Temperature", 1);
    if (snap.has_object_id && !snap.obj_id.empty()) writeUInt8Attr("ObjectID", "/ObjectID");
    if (snap.has_material_id && !snap.material_id.empty()) writeUInt8Attr("Material_ID", "/Material_ID");
    if (snap.has_particle_density && !snap.particle_density.empty()) writeUInt8Attr("Particle_Density", "/Particle_Density");

    xmf << "      </Grid>\n";
}

bool XDMFWriter::writeMPMStepXDMF3D(const std::string& xmfFilename, const std::string& relH5Filename,
                                    int step, double time, const MPMVTKSnapshot3D& snap) {
    if (snap.num_particles <= 0) return false;
    std::ofstream xmf(xmfFilename);
    if (!xmf.is_open()) return false;

    xmf << "<?xml version=\"1.0\" ?>\n";
    xmf << "<!DOCTYPE Xdmf SYSTEM \"Xdmf.dtd\" []>\n";
    xmf << "<Xdmf Version=\"2.0\">\n";
    xmf << "  <Domain>\n";
    writeMPMGridBlock(xmf, relH5Filename, step, time, snap);
    xmf << "  </Domain>\n";
    xmf << "</Xdmf>\n";
    xmf.close();
    return true;
}

bool XDMFWriter::appendMPMTimestep3D(const std::string& masterXmfFilename, const std::string& relH5Filename,
                                     int step, double time, const MPMVTKSnapshot3D& snap, bool reset) {
    if (snap.num_particles <= 0) return false;

    std::string existing_content;
    if (!reset) {
        std::ifstream in(masterXmfFilename);
        if (in.is_open()) {
            existing_content.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
            in.close();
        }
    }

    const std::string footer = "    </Grid>\n  </Domain>\n</Xdmf>\n";
    size_t footer_pos = existing_content.rfind("    </Grid>");
    std::ofstream out(masterXmfFilename, std::ios::trunc);
    if (!out.is_open()) return false;

    if (existing_content.empty() || footer_pos == std::string::npos) {
        out << "<?xml version=\"1.0\" ?>\n";
        out << "<!DOCTYPE Xdmf SYSTEM \"Xdmf.dtd\" []>\n";
        out << "<Xdmf Version=\"2.0\">\n";
        out << "  <Domain>\n";
        out << "    <Grid Name=\"MPM_TimeSeries\" GridType=\"Collection\" CollectionType=\"Temporal\">\n";
    } else {
        out << existing_content.substr(0, footer_pos);
    }

    writeMPMGridBlock(out, relH5Filename, step, time, snap);
    out << footer;
    out.close();
    return true;
}

