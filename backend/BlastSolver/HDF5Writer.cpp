#include "HDF5Writer.hpp"
#ifndef NO_HDF5
#include <hdf5.h>
#endif
#include <iostream>

bool HDF5Writer::writePressure(const std::string& filename, const std::vector<float>& data) {
#ifdef NO_HDF5
    (void)filename; (void)data;
    return true;
#else
    hid_t file_id, dataset_id, dataspace_id;
    hsize_t dims[1];
    herr_t status;

    // Create a new file using default properties.
    file_id = H5Fcreate(filename.c_str(), H5F_ACC_TRUNC, H5P_DEFAULT, H5P_DEFAULT);
    if (file_id < 0) {
        std::cerr << "Failed to create HDF5 file: " << filename << std::endl;
        return false;
    }

    // Create the data space for the dataset.
    dims[0] = data.size();
    dataspace_id = H5Screate_simple(1, dims, NULL);
    if (dataspace_id < 0) {
        std::cerr << "Failed to create HDF5 dataspace" << std::endl;
        H5Fclose(file_id);
        return false;
    }

    // Create the dataset.
    dataset_id = H5Dcreate2(file_id, "/Pressure", H5T_NATIVE_FLOAT, dataspace_id,
                          H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);
    if (dataset_id < 0) {
        std::cerr << "Failed to create HDF5 dataset" << std::endl;
        H5Sclose(dataspace_id);
        H5Fclose(file_id);
        return false;
    }

    // Write the dataset.
    status = H5Dwrite(dataset_id, H5T_NATIVE_FLOAT, H5S_ALL, H5S_ALL, H5P_DEFAULT, data.data());
    if (status < 0) {
        std::cerr << "Failed to write HDF5 dataset" << std::endl;
    }

    // Close the dataset, dataspace, and file.
    H5Dclose(dataset_id);
    H5Sclose(dataspace_id);
    H5Fclose(file_id);

    return status >= 0;
#endif
}

bool HDF5Writer::writeFrame(const std::string& filename,
                          const std::vector<double>& rho,
                          const std::vector<double>& p,
                          const std::vector<double>& u,
                          const std::vector<double>& alpha1,
                          const std::vector<double>& alpha2) {
#ifdef NO_HDF5
    (void)filename; (void)rho; (void)p; (void)u; (void)alpha1; (void)alpha2;
    return true;
#else
    hid_t file_id, dataspace_id;
    hsize_t dims[1];
    dims[0] = rho.size();

    file_id = H5Fcreate(filename.c_str(), H5F_ACC_TRUNC, H5P_DEFAULT, H5P_DEFAULT);
    if (file_id < 0) return false;

    dataspace_id = H5Screate_simple(1, dims, NULL);

    auto writeDataset = [&](const char* name, const std::vector<double>& data) {
        hid_t dataset_id = H5Dcreate2(file_id, name, H5T_NATIVE_DOUBLE, dataspace_id,
                                    H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);
        if (dataset_id >= 0) {
            H5Dwrite(dataset_id, H5T_NATIVE_DOUBLE, H5S_ALL, H5S_ALL, H5P_DEFAULT, data.data());
            H5Dclose(dataset_id);
        }
    };

    writeDataset("/Density", rho);
    writeDataset("/Pressure", p);
    writeDataset("/Velocity", u);
    writeDataset("/Alpha1", alpha1);
    writeDataset("/Alpha2", alpha2);

    H5Sclose(dataspace_id);
    H5Fclose(file_id);
    return true;
#endif
}

bool HDF5Writer::writeGauges(const std::string& filename,
                            const std::vector<double>& times,
                            const std::vector<std::string>& gauge_ids,
                            const std::vector<std::vector<float>>& p_data,
                            const std::vector<std::vector<float>>& rho_data,
                            const std::vector<std::vector<float>>& vel_data,
                            const std::vector<std::vector<float>>& E_data,
                            const std::vector<std::vector<float>>& reacted_data,
                            const std::vector<std::vector<float>>& unreacted_data,
                            const std::vector<std::vector<float>>& air_data,
                            const std::vector<std::vector<float>>& op_data,
                            const std::vector<std::vector<float>>& imp_data,
                            bool has_p, bool has_rho, bool has_vel, bool has_E,
                            bool has_reacted, bool has_unreacted, bool has_air,
                            bool has_op, bool has_imp) {
#ifdef NO_HDF5
    (void)filename; (void)times; (void)gauge_ids;
    (void)p_data; (void)rho_data; (void)vel_data; (void)E_data;
    (void)reacted_data; (void)unreacted_data; (void)air_data; (void)op_data; (void)imp_data;
    (void)has_p; (void)has_rho; (void)has_vel; (void)has_E;
    (void)has_reacted; (void)has_unreacted; (void)has_air; (void)has_op; (void)has_imp;
    return true;
#else
    hid_t file_id = H5Fcreate(filename.c_str(), H5F_ACC_TRUNC, H5P_DEFAULT, H5P_DEFAULT);
    if (file_id < 0) return false;

    // Write /Times
    hsize_t times_dims[1] = { times.size() };
    hid_t times_space = H5Screate_simple(1, times_dims, NULL);
    hid_t times_dset = H5Dcreate2(file_id, "/Times", H5T_NATIVE_DOUBLE, times_space, H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);
    if (times_dset >= 0) {
        H5Dwrite(times_dset, H5T_NATIVE_DOUBLE, H5S_ALL, H5S_ALL, H5P_DEFAULT, times.data());
        H5Dclose(times_dset);
    }
    H5Sclose(times_space);

    // Create /Gauges group
    hid_t gauges_grp = H5Gcreate2(file_id, "/Gauges", H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);

    hsize_t data_dims[1] = { times.size() };
    hid_t data_space = H5Screate_simple(1, data_dims, NULL);

    for (size_t g = 0; g < gauge_ids.size(); ++g) {
        std::string g_path = "/Gauges/" + gauge_ids[g];
        hid_t g_grp = H5Gcreate2(file_id, g_path.c_str(), H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);

        auto writeDataset = [&](const std::string& name, const std::vector<float>& data) {
            std::string path = g_path + "/" + name;
            hid_t dataset_id = H5Dcreate2(file_id, path.c_str(), H5T_NATIVE_FLOAT, data_space,
                                        H5P_DEFAULT, H5P_DEFAULT, H5P_DEFAULT);
            if (dataset_id >= 0) {
                H5Dwrite(dataset_id, H5T_NATIVE_FLOAT, H5S_ALL, H5S_ALL, H5P_DEFAULT, data.data());
                H5Dclose(dataset_id);
            }
        };

        if (has_p) writeDataset("Pressure", p_data[g]);
        if (has_rho) writeDataset("Density", rho_data[g]);
        if (has_vel) writeDataset("Velocity", vel_data[g]);
        if (has_E) writeDataset("InternalEnergy", E_data[g]);
        if (has_reacted) writeDataset("Reacted_Explosive", reacted_data[g]);
        if (has_unreacted) writeDataset("Unreacted_Explosive", unreacted_data[g]);
        if (has_air) writeDataset("Air", air_data[g]);
        if (has_op) writeDataset("Overpressure", op_data[g]);
        if (has_imp) writeDataset("Impulse", imp_data[g]);

        if (g_grp >= 0) H5Gclose(g_grp);
    }

    H5Sclose(data_space);
    if (gauges_grp >= 0) H5Gclose(gauges_grp);
    H5Fclose(file_id);
    return true;
#endif
}
