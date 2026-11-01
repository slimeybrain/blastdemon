#ifndef XDMF_WRITER_HPP
#define XDMF_WRITER_HPP

#include <string>

#include "VTKWriter.hpp"

class XDMFWriter {
public:
    static bool writeXDMF(const std::string& xmfFilename, const std::string& h5Filename,
                         int numPoints, double dx);
    static bool writeMPMStepXDMF3D(const std::string& xmfFilename, const std::string& relH5Filename,
                                   int step, double time, const MPMVTKSnapshot3D& snap);
    static bool appendMPMTimestep3D(const std::string& masterXmfFilename, const std::string& relH5Filename,
                                    int step, double time, const MPMVTKSnapshot3D& snap, bool reset = false);
};

#endif // XDMF_WRITER_HPP
