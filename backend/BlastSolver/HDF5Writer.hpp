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
    static bool writeGauges(const std::string& filename,
                            const std::vector<double>& times,
                            const std::vector<std::string>& gauge_ids,
                            const std::vector<std::vector<float>>& p_data,
                            const std::vector<std::vector<float>>& rho_data,
                            const std::vector<std::vector<float>>& vel_data,
                            const std::vector<std::vector<float>>& E_data,
                            const std::vector<std::vector<float>>& reacted_data,
                            const std::vector<std::vector<float>>& unreacted_data,
                            const std::vector<std::vector<float>>& air_data,
                            bool has_p, bool has_rho, bool has_vel, bool has_E,
                            bool has_reacted, bool has_unreacted, bool has_air);
};

#endif // HDF5_WRITER_HPP
