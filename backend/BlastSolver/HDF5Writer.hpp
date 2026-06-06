#ifndef HDF5_WRITER_HPP
#define HDF5_WRITER_HPP

#include <string>
#include <vector>

class HDF5Writer {
public:
    static bool writePressure(const std::string& filename, const std::vector<float>& data);
};

#endif // HDF5_WRITER_HPP
