#include "constitutive_crest_davis.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>

using namespace Blast;

int main(int argc, char** argv) {
    float det_r = (argc > 1) ? std::stof(argv[1]) : 0.02f;
    float det_x = (argc > 2) ? std::stof(argv[2]) : 0.05f;
    bool proj_is_explosive = (argc > 3 && std::string(argv[3]) == "exp");

    std::cout << "=======================================================" << std::endl;
    std::cout << "TEST USER SC3: det_x=" << det_x << ", det_r=" << det_r 
              << ", proj_is_explosive=" << (proj_is_explosive ? "TRUE" : "FALSE") << std::endl;
    std::cout << "=======================================================" << std::endl;

    float xmin = -0.2f, xmax = 0.6f;
    float ymin = -0.5f, ymax = 0.5f;
    float zmin = -0.5f, zmax = 0.5f;
    float dx = 0.004f;
    int nx = std::round((xmax - xmin) / dx);
    int ny = std::round((ymax - ymin) / dx);
    int nz = std::round((zmax - zmin) / dx);

    MPMSolver3DCUDA solver;
    solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
    solver.setBoundaryConditions(MPMBoundaryCondition3D::Terminate, MPMBoundaryCondition3D::Terminate,
                                 MPMBoundaryCondition3D::Terminate, MPMBoundaryCondition3D::Terminate,
                                 MPMBoundaryCondition3D::Terminate, MPMBoundaryCondition3D::Terminate);
    solver.setTransferScheme(MPMTransferScheme::BSpline);
    solver.setVelocityScheme(MPMVelocityScheme::APIC);
    solver.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);

    std::string path_exp = "/home/chris/blastdemon_tests/sc3/sc3-WeaponExplosive.stl";
    std::string path_case = "/home/chris/blastdemon_tests/sc3/sc3-WeaponCasing.stl";
    std::string path_proj = "/home/chris/blastdemon_tests/sc3/sc3-WeaponProjectile.stl";

    std::cout << "Adding Object 1: Explosive..." << std::endl;
    solver.addSTLObject(1, path_exp, 0, 0, 0, 0.001f, 0.001f, 0.001f, 0,0,0, 0,0,0, 1849.0f, 10.0e9f, 0.35f, 50.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped, "watertight_raycast", 0,0,0, "CAD Origin");

    std::cout << "Adding Object 2: Casing..." << std::endl;
    solver.addSTLObject(2, path_case, 0, 0, 0, 0.001f, 0.001f, 0.001f, 0,0,0, 0,0,0, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped, "watertight_raycast", 0,0,0, "CAD Origin");

    std::cout << "Adding Object 3: Projectile..." << std::endl;
    solver.addSTLObject(3, path_proj, 0, 0, 0, 0.001f, 0.001f, 0.001f, 0,0,0, 0,0,0, 8960.0f, 117.0e9f, 0.34f, 70.0e6f, 100.0e6f, 0.54f, 300.0e6f, 8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped, "watertight_raycast", 0,0,0, "CAD Origin");

    bool use_bardenhagen = (argc > 4 ? (std::string(argv[4]) != "none") : true);
    if (use_bardenhagen) {
        solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
    } else {
        solver.setContactMethod(MPMContactMethod::SingleVelocity);
    }

    bool use_dem = (argc > 6 && (std::string(argv[6]) == "dem" || std::string(argv[6]) == "DEM"));
    float dem_scale = (argc > 8) ? std::stof(argv[8]) : 1.5f;
    if (use_dem) {
        std::cout << "[INFO] Enabling DEM Contact: scale=" << dem_scale << ", rest=0.3, mode=GasSolidOnly, v_thresh=1.0\n";
        solver.setDemContact(true, 0.0f, 0.3f, dem_scale, MPMDEMContactMode::GasSolidOnly, 1.0f);
    }

    std::vector<int> obj_to_mat = {0, 1, 2, 3};
    solver.setObjectMaterialMapping(obj_to_mat, 4);

    auto& mat_tables = solver.getMaterialTables();
    mat_tables.resize(4);

    for (int oid = 1; oid <= 3; ++oid) {
        float min_x = 1e9, max_x = -1e9;
        float min_y = 1e9, max_y = -1e9;
        float min_z = 1e9, max_z = -1e9;
        for (const auto& p : solver.getParticles()) {
            if (p.object_id == oid) {
                min_x = std::min(min_x, p.x[0]); max_x = std::max(max_x, p.x[0]);
                min_y = std::min(min_y, p.x[1]); max_y = std::max(max_y, p.x[1]);
                min_z = std::min(min_z, p.x[2]); max_z = std::max(max_z, p.x[2]);
            }
        }
        std::cout << "  Object " << oid << " Bounds: X=[" << min_x << ", " << max_x << "]"
                  << " Y=[" << min_y << ", " << max_y << "]"
                  << " Z=[" << min_z << ", " << max_z << "]\n";
    }

    // Object 1: LX-14 CREST Reactive Burn
    mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
    mat_tables[1].density = 1849.0f;
    mat_tables[1].davis_c0 = 2440.0f; mat_tables[1].davis_s1 = 2.12f; mat_tables[1].davis_gamma0 = 0.65f; mat_tables[1].davis_cv = 1000.0f; mat_tables[1].davis_t0 = 293.0f; mat_tables[1].davis_rho0 = 1849.0f;
    mat_tables[1].davis_a = 2.85f; mat_tables[1].davis_b = 1.10f; mat_tables[1].davis_k = 1.35f; mat_tables[1].davis_vc = 0.65f; mat_tables[1].davis_pc = 12.5e9f; mat_tables[1].davis_q_det = 5.95e6f;
    mat_tables[1].crest_b1 = 2.0e7f; mat_tables[1].crest_c1 = 0.67f; mat_tables[1].crest_m1 = 2.2f; mat_tables[1].crest_b2 = 5.5e6f; mat_tables[1].crest_c2 = 0.50f; mat_tables[1].crest_c3 = 0.67f; mat_tables[1].crest_m2 = 1.3f;
    mat_tables[1].crest_s0 = 14.0f;
    mat_tables[1].crest_s_threshold = 2.0f;

    // Object 2: Steel Johnson-Cook
    mat_tables[2].material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
    mat_tables[2].density = 7850.0f;
    mat_tables[2].youngs_modulus = 210.0e9f; mat_tables[2].poissons_ratio = 0.3f;
    mat_tables[2].jc_A = 792.0e6f; mat_tables[2].jc_B = 510.0e6f; mat_tables[2].jc_n = 0.26f;
    mat_tables[2].mg_c0 = 4570.0f; mat_tables[2].mg_s = 1.49f; mat_tables[2].mg_gamma0 = 1.93f;

    // Object 3: Copper Johnson-Cook (or Explosive if flag set)
    if (proj_is_explosive) {
        mat_tables[3] = mat_tables[1];
    } else {
        mat_tables[3].material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
        mat_tables[3].density = 8960.0f;
        mat_tables[3].youngs_modulus = 117.0e9f; mat_tables[3].poissons_ratio = 0.34f;
        mat_tables[3].jc_A = 90.0e6f; mat_tables[3].jc_B = 292.0e6f; mat_tables[3].jc_n = 0.31f;
        mat_tables[3].mg_c0 = 3940.0f; mat_tables[3].mg_s = 1.48f; mat_tables[3].mg_gamma0 = 2.02f;
    }

    // Detonator initiation (matching main.cpp lines 8225-8264)
    float effective_init_rad = std::max(det_r, 2.5f * dx);
    int ignited_1 = 0, ignited_2 = 0, ignited_3 = 0;

    for (auto& p : solver.getParticles()) {
        bool is_exp = (mat_tables[p.object_id].material_model == MPMMaterialModel::CRESTReactiveBurn);
        if (is_exp) {
            float d_x = p.x[0] - det_x;
            float d_y = p.x[1] - 0.0f;
            float d_z = p.x[2] - 0.0f;
            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
            if (dist <= effective_init_rad) {
                if (p.object_id == 1) ignited_1++;
                if (p.object_id == 2) ignited_2++;
                if (p.object_id == 3) ignited_3++;
                p.s_shock = 1.5f * mat_tables[p.object_id].crest_s_threshold;
                p.lambda = 1.0f;
                p.e_int = mat_tables[p.object_id].davis_q_det;
                p.v_min = (mat_tables[p.object_id].davis_vc > 0.1f) ? mat_tables[p.object_id].davis_vc : 0.70f;
                p.V = p.v_min * p.V0;
                float p_init = ((mat_tables[p.object_id].davis_pc > 1.0e6f) ? mat_tables[p.object_id].davis_pc : 15.0e9f);
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
            }
        }
    }

    std::cout << "Ignition Results:" << std::endl;
    std::cout << "  effective_init_rad = " << effective_init_rad << std::endl;
    std::cout << "  Object 1 (Explosive): " << ignited_1 << " particles ignited" << std::endl;
    std::cout << "  Object 2 (Casing):    " << ignited_2 << " particles ignited" << std::endl;
    std::cout << "  Object 3 (Projectile): " << ignited_3 << " particles ignited" << std::endl;

    solver.syncToDevice();

    float t_target = (argc > 5) ? std::stof(argv[5]) : 100.0e-6f;

    float cfl_val = (argc > 7) ? std::stof(argv[7]) : 0.6f;
    std::cout << "\nStepping until t = " << (t_target * 1e6f) << " us (CFL=" << cfl_val << ")..." << std::endl;
    float next_report_t = 5.0e-6f;
    int step_num = 0;

    while (solver.getSimTime() < t_target) {
        solver.step(cfl_val);
        step_num++;

        float cur_t = static_cast<float>(solver.getSimTime());
        if (cur_t >= next_report_t || cur_t >= t_target) {
            solver.syncParticlesToHost();
            const auto& all_p = solver.getParticles();

            float v1_max = 0, v2_max = 0, v3_max = 0;
            float v1_avg = 0, v2_avg = 0, v3_avg = 0;
            int n1 = 0, n2 = 0, n3 = 0;
            int failed_case = 0;
            float proj_min_x = 1e9f, proj_max_x = -1e9f;
            float proj_apex_x = 1e9f; // lowest X in projectile
            float exp_front_x = -1e9f; // highest X in explosive behind or near apex

            for (const auto& p : all_p) {
                float v = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                if (p.object_id == 1) {
                    v1_max = std::max(v1_max, v);
                    v1_avg += v;
                    n1++;
                    // Find highest X of ignited explosive
                    if (p.lambda > 0.5f) {
                        exp_front_x = std::max(exp_front_x, p.x[0]);
                    }
                } else if (p.object_id == 2) {
                    v2_max = std::max(v2_max, v);
                    v2_avg += v;
                    n2++;
                    if (p.has_failed || p.damage >= 1.0f) failed_case++;
                } else if (p.object_id == 3) {
                    v3_max = std::max(v3_max, v);
                    v3_avg += v;
                    n3++;
                    proj_min_x = std::min(proj_min_x, p.x[0]);
                    proj_max_x = std::max(proj_max_x, p.x[0]);
                }
            }
            if (n1 > 0) v1_avg /= n1;
            if (n2 > 0) v2_avg /= n2;
            if (n3 > 0) v3_avg /= n3;

            // Check if any explosive gas has penetrated IN FRONT OF the projectile
            int penetrated_gas_particles = 0;
            for (const auto& p : all_p) {
                if (p.object_id == 1 && p.lambda > 0.5f) {
                    // Check if gas is near the axis (r < 0.05) and has x > proj_max_x
                    float r = std::sqrt(p.x[1]*p.x[1] + p.x[2]*p.x[2]);
                    if (r < 0.03f && p.x[0] > proj_max_x) {
                        penetrated_gas_particles++;
                    }
                }
            }

            float ke1 = 0, ke2 = 0, ke3 = 0;
            float px1 = 0, px2 = 0, px3 = 0;
            for (const auto& p : all_p) {
                float v2 = p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2];
                if (p.object_id == 1) { ke1 += 0.5f * p.m * v2; px1 += p.m * p.v[0]; }
                else if (p.object_id == 2) { ke2 += 0.5f * p.m * v2; px2 += p.m * p.v[0]; }
                else if (p.object_id == 3) { ke3 += 0.5f * p.m * v2; px3 += p.m * p.v[0]; }
            }

            std::cout << "  Time " << std::fixed << std::setprecision(2) << (cur_t * 1e6f) << " us (Step " << step_num << ")"
                      << " | Exp vMax=" << std::setprecision(1) << v1_max << " vAvg=" << v1_avg << " KE=" << (ke1 * 1e-6f) << "MJ"
                      << " | Case vMax=" << v2_max << " vAvg=" << v2_avg << " KE=" << (ke2 * 1e-6f) << "MJ Fail=" << failed_case << "/" << n2
                      << " | Proj vMax=" << v3_max << " vAvg=" << v3_avg << " KE=" << (ke3 * 1e-6f) << "MJ X=[" << std::setprecision(4) << proj_min_x << ", " << proj_max_x << "]"
                      << " | GasAhead=" << penetrated_gas_particles << std::endl;

            if (penetrated_gas_particles > 0 && cur_t <= 45.0e-6f) {
                std::cout << "    --> DIAGNOSTIC: GasAhead Particles:" << std::endl;
                int printed = 0;
                for (size_t pi = 0; pi < all_p.size() && printed < 5; ++pi) {
                    const auto& p = all_p[pi];
                    if (p.object_id == 1 && p.lambda > 0.5f) {
                        float r = std::sqrt(p.x[1]*p.x[1] + p.x[2]*p.x[2]);
                        if (r < 0.03f && p.x[0] > proj_max_x) {
                            std::cout << "      Gas P" << pi << ": pos=(" << p.x[0] << ", " << p.x[1] << ", " << p.x[2] << ")"
                                      << " r=" << r << " v=(" << p.v[0] << ", " << p.v[1] << ", " << p.v[2] << ") |v|=" << std::sqrt(p.v[0]*p.v[0]+p.v[1]*p.v[1]+p.v[2]*p.v[2]) << std::endl;
                            printed++;
                        }
                    }
                }
            }

            if (cur_t >= t_target) {
                std::cout << "\n=== FINAL DIAGNOSTIC: Fastest Particles ===" << std::endl;
                for (int oid = 1; oid <= 3; ++oid) {
                    std::vector<std::pair<float, size_t>> sorted_p;
                    for (size_t pi = 0; pi < all_p.size(); ++pi) {
                        if (all_p[pi].object_id == oid) {
                            float v = std::sqrt(all_p[pi].v[0]*all_p[pi].v[0] + all_p[pi].v[1]*all_p[pi].v[1] + all_p[pi].v[2]*all_p[pi].v[2]);
                            sorted_p.push_back({v, pi});
                        }
                    }
                    std::sort(sorted_p.rbegin(), sorted_p.rend());
                    std::cout << "  Top 3 for Object " << oid << ":" << std::endl;
                    for (size_t i = 0; i < std::min((size_t)3, sorted_p.size()); ++i) {
                        const auto& p = all_p[sorted_p[i].second];
                        std::cout << "    P" << sorted_p[i].second << " v=" << sorted_p[i].first
                                  << " pos=(" << p.x[0] << ", " << p.x[1] << ", " << p.x[2] << ")"
                                  << " m=" << p.m << " V=" << p.V << " fail=" << (int)p.has_failed << std::endl;
                    }
                }
            }

            if (next_report_t < 20.0e-6f) next_report_t += 5.0e-6f;
            else next_report_t += 10.0e-6f;
        }
    }
    return 0;
}
