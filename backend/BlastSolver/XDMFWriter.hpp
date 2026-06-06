#ifndef XDMF_WRITER_HPP
#define XDMF_WRITER_HPP

#include <string>

class XDMFWriter {
public:
    static bool writeXDMF(const std::string& xmfFilename, const std::string& h5Filename,
                         int numPoints, float dx);
};

#endif // XDMF_WRITER_HPP
