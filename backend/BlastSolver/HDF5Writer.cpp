#include "HDF5Writer.hpp"
#ifndef NO_HDF5
#include <hdf5.h>
#endif
#include <algorithm>
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

bool HDF5Writer::writeMPMSnapshot3D(const std::string& filename, const MPMVTKSnapshot3D& snap) {
#ifdef NO_HDF5
    (void)filename; (void)snap;
    return false;
#else
    if (snap.num_particles <= 0) return false;

    MPMVTKSnapshot3D local_groomed;
    const MPMVTKSnapshot3D* src_ptr = &snap;
    if (!snap.is_groomed && snap.float_precision.find("23") == std::string::npos && snap.float_precision.find("Full") == std::string::npos) {
        local_groomed = snap;
        apply_mpm_bit_grooming(local_groomed);
        src_ptr = &local_groomed;
    }
    const MPMVTKSnapshot3D& src = *src_ptr;

    hid_t file_id = H5Fcreate(filename.c_str(), H5F_ACC_TRUNC, H5P_DEFAULT, H5P_DEFAULT);
    if (file_id < 0) {
        std::cerr << "[ERROR] Failed to create MPM HDF5 file (check directory permissions and available disk space): " << filename << std::endl;
        return false;
    }

    const hsize_t N = static_cast<hsize_t>(src.num_particles);
    const int z_level = std::clamp(src.compression_level, 1, 9);
    const hsize_t chunk_len = std::min<hsize_t>(N, 65536);
    bool write_ok = true;

    auto writeFloatVec3 = [&](const char* dset_name, const std::vector<float>& vec) {
        if (vec.size() < 3 * N) return;
        hsize_t dims[2] = { N, 3 };
        hid_t space_id = H5Screate_simple(2, dims, NULL);
        hid_t dcpl = H5Pcreate(H5P_DATASET_CREATE);
        hsize_t chunk_dims[2] = { chunk_len, 3 };
        H5Pset_chunk(dcpl, 2, chunk_dims);
        H5Pset_shuffle(dcpl);
        H5Pset_deflate(dcpl, z_level);
        hid_t dset_id = H5Dcreate2(file_id, dset_name, H5T_NATIVE_FLOAT, space_id, H5P_DEFAULT, dcpl, H5P_DEFAULT);
        if (dset_id >= 0) {
            if (H5Dwrite(dset_id, H5T_NATIVE_FLOAT, H5S_ALL, H5S_ALL, H5P_DEFAULT, vec.data()) < 0) {
                write_ok = false;
            }
            H5Dclose(dset_id);
        } else {
            write_ok = false;
        }
        H5Pclose(dcpl);
        H5Sclose(space_id);
    };

    auto writeFloatScalar = [&](const char* dset_name, const std::vector<float>& vec) {
        if (vec.size() < N) return;
        hsize_t dims[1] = { N };
        hid_t space_id = H5Screate_simple(1, dims, NULL);
        hid_t dcpl = H5Pcreate(H5P_DATASET_CREATE);
        hsize_t chunk_dims[1] = { chunk_len };
        H5Pset_chunk(dcpl, 1, chunk_dims);
        H5Pset_shuffle(dcpl);
        H5Pset_deflate(dcpl, z_level);
        hid_t dset_id = H5Dcreate2(file_id, dset_name, H5T_NATIVE_FLOAT, space_id, H5P_DEFAULT, dcpl, H5P_DEFAULT);
        if (dset_id >= 0) {
            if (H5Dwrite(dset_id, H5T_NATIVE_FLOAT, H5S_ALL, H5S_ALL, H5P_DEFAULT, vec.data()) < 0) {
                write_ok = false;
            }
            H5Dclose(dset_id);
        } else {
            write_ok = false;
        }
        H5Pclose(dcpl);
        H5Sclose(space_id);
    };

    auto writeUInt8Scalar = [&](const char* dset_name, const std::vector<uint8_t>& vec) {
        if (vec.size() < N) return;
        hsize_t dims[1] = { N };
        hid_t space_id = H5Screate_simple(1, dims, NULL);
        hid_t dcpl = H5Pcreate(H5P_DATASET_CREATE);
        hsize_t chunk_dims[1] = { chunk_len };
        H5Pset_chunk(dcpl, 1, chunk_dims);
        H5Pset_shuffle(dcpl);
        H5Pset_deflate(dcpl, z_level);
        hid_t dset_id = H5Dcreate2(file_id, dset_name, H5T_NATIVE_UINT8, space_id, H5P_DEFAULT, dcpl, H5P_DEFAULT);
        if (dset_id >= 0) {
            if (H5Dwrite(dset_id, H5T_NATIVE_UINT8, H5S_ALL, H5S_ALL, H5P_DEFAULT, vec.data()) < 0) {
                write_ok = false;
            }
            H5Dclose(dset_id);
        } else {
            write_ok = false;
        }
        H5Pclose(dcpl);
        H5Sclose(space_id);
    };

    writeFloatVec3("/Points", src.points);
    if (src.has_vel && !src.vel.empty()) writeFloatVec3("/Velocity", src.vel);
    if (src.has_stress && !src.von_mises.empty()) writeFloatScalar("/von_Mises_Stress", src.von_mises);
    if (src.has_pressure && !src.pressure.empty()) writeFloatScalar("/Pressure", src.pressure);
    if (src.has_strain && !src.ep_bar.empty()) writeFloatScalar("/Plastic_Strain", src.ep_bar);
    if (src.has_damage && !src.damage.empty()) writeFloatScalar("/Damage", src.damage);
    if (src.has_temp && !src.temp.empty()) writeFloatScalar("/Temperature", src.temp);
    if (src.has_object_id && !src.obj_id.empty()) writeUInt8Scalar("/ObjectID", src.obj_id);
    if (src.has_material_id && !src.material_id.empty()) writeUInt8Scalar("/Material_ID", src.material_id);

    if (H5Fclose(file_id) < 0) {
        write_ok = false;
    }
    if (!write_ok) {
        std::cerr << "[ERROR] Failed to write MPM HDF5 datasets to " << filename << " (check available disk space)" << std::endl;
    }
    return write_ok;
#endif
}
