#include "XDMFWriter.hpp"
#include <fstream>
#include <iostream>

bool XDMFWriter::writeXDMF(const std::string& xmfFilename, const std::string& h5Filename,
                          int numPoints, double dx) {
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
}
