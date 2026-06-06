#include "XDMFWriter.hpp"
#include <fstream>
#include <iostream>

bool XDMFWriter::writeXDMF(const std::string& xmfFilename, const std::string& h5Filename,
                          int numPoints, float dx) {
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
    xmf << "       <DataItem Name=\"Origin\" Dimensions=\"1\" NumberType=\"Float\" Precision=\"4\" Format=\"XML\">\n";
    xmf << "         0\n";
    xmf << "       </DataItem>\n";
    xmf << "       <DataItem Name=\"Spacing\" Dimensions=\"1\" NumberType=\"Float\" Precision=\"4\" Format=\"XML\">\n";
    xmf << "         " << dx << "\n";
    xmf << "       </DataItem>\n";
    xmf << "     </Geometry>\n";
    xmf << "     <Attribute Name=\"Pressure\" AttributeType=\"Scalar\" Center=\"Node\">\n";
    xmf << "       <DataItem Dimensions=\"" << numPoints << "\" NumberType=\"Float\" Precision=\"4\" Format=\"HDF\">\n";
    xmf << "         " << h5Filename << ":/Pressure\n";
    xmf << "       </DataItem>\n";
    xmf << "     </Attribute>\n";
    xmf << "   </Grid>\n";
    xmf << " </Domain>\n";
    xmf << "</Xdmf>\n";

    xmf.close();
    return true;
}
