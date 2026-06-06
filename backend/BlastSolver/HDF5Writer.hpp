#ifndef HDF5_WRITER_HPP
#define HDF5_WRITER_HPP

#include <string>
#include <vector>

class HDF5Writer {
public:
    static bool writePressure(const std::string& filename, const std::vector<float>& data);
    static bool writeFrame(const std::string& filename,
                          const std::vector<double>& rho,
                          const std::vector<double>& p,
                          const std::vector<double>& u,
                          const std::vector<double>& alpha1,
                          const std::vector<double>& alpha2);
};

#endif // HDF5_WRITER_HPP
