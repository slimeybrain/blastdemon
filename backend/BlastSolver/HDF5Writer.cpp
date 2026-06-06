#include "HDF5Writer.hpp"
#include <hdf5.h>
#include <iostream>

bool HDF5Writer::writePressure(const std::string& filename, const std::vector<float>& data) {
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
}

bool HDF5Writer::writeFrame(const std::string& filename,
                          const std::vector<double>& rho,
                          const std::vector<double>& p,
                          const std::vector<double>& u,
                          const std::vector<double>& alpha1,
                          const std::vector<double>& alpha2) {
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
}
