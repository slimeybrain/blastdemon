#include "constitutive_crest_davis.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>

using namespace Blast;

int main(int argc, char** argv) {
    bool use_bardenhagen = (argc > 1 ? (std::string(argv[1]) != "none") : true);
    float dx = (argc > 2) ? std::stof(argv[2]) : 0.004f;
    float t_target = (argc > 3) ? std::stof(argv[3]) : 30.0e-6f;

    std::cout << "=======================================================" << std::endl;
    std::cout << "TEST USER SC1: Contact=" << (use_bardenhagen ? "Bardenhagen" : "SingleVelocity")
              << ", dx=" << dx << ", t_target=" << (t_target * 1e6f) << " us" << std::endl;
    std::cout << "=======================================================" << std::endl;

    float xmin = -0.15f, xmax = 0.15f;
    float ymin = -0.15f, ymax = 0.15f;
    float zmin = -0.50f, zmax = 0.20f;
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

    std::string path_exp = "/media/chris/D288B0E688B0CA6D/Users/chris/Downloads/sc1_charge.stl";
    std::string path_liner = "/media/chris/D288B0E688B0CA6D/Users/chris/Downloads/sc1_liner.stl";

    std::cout << "Adding Object 1: Explosive..." << std::endl;
    solver.addSTLObject(1, path_exp, 0, 0, 0, 1.0f, 1.0f, 1.0f, 0,0,0, 0,0,0, 1630.0f, 4.5e9f, 0.38f, 15.0e6f, 100.0e6f, 0.15f, 4.0e6f, 8, MPMParticleDistribution::Hexagonal, MPMBoundaryFilling::Partial, "watertight_raycast", 0,0,0, "CAD Origin");

    std::cout << "Adding Object 2: Liner (Copper)..." << std::endl;
    solver.addSTLObject(2, path_liner, 0, 0, 0, 1.0f, 1.0f, 1.0f, 0,0,0, 0,0,0, 8960.0f, 117.0e9f, 0.34f, 90.0e6f, 292.0e6f, 0.31f, 300.0e6f, 8, MPMParticleDistribution::Hexagonal, MPMBoundaryFilling::Partial, "watertight_raycast", 0,0,0, "CAD Origin");

    if (use_bardenhagen) {
        solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
    } else {
        solver.setContactMethod(MPMContactMethod::SingleVelocity);
    }
    std::vector<int> obj_to_mat = {0, 1, 2};
    solver.setObjectMaterialMapping(obj_to_mat, 3);

    auto& mat_tables = solver.getMaterialTables();
    mat_tables.resize(3);

    // Object 1: Explosive CREST Reactive Burn
    mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
    mat_tables[1].density = 1630.0f;
    mat_tables[1].davis_c0 = 2050.0f; mat_tables[1].davis_s1 = 2.12f; mat_tables[1].davis_gamma0 = 0.65f; mat_tables[1].davis_cv = 1000.0f; mat_tables[1].davis_t0 = 293.0f; mat_tables[1].davis_rho0 = 1895.0f;
    mat_tables[1].davis_a = 2.85f; mat_tables[1].davis_b = 1.10f; mat_tables[1].davis_k = 1.35f; mat_tables[1].davis_vc = 0.65f; mat_tables[1].davis_pc = 12.5e9f; mat_tables[1].davis_q_det = 3.90e6f;
    mat_tables[1].crest_b1 = 1.2e7f; mat_tables[1].crest_c1 = 0.67f; mat_tables[1].crest_m1 = 2.5f; mat_tables[1].crest_b2 = 3.5e6f; mat_tables[1].crest_c2 = 0.50f; mat_tables[1].crest_c3 = 0.67f; mat_tables[1].crest_m2 = 1.5f;
    mat_tables[1].crest_s0 = 15.0f; mat_tables[1].crest_s_threshold = 2.0f;
    mat_tables[1].transfer_scheme = 3; // Radial MLS

    // Object 2: Copper Johnson-Cook
    mat_tables[2].material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
    mat_tables[2].density = 8960.0f;
    mat_tables[2].youngs_modulus = 117.0e9f; mat_tables[2].poissons_ratio = 0.34f;
    mat_tables[2].jc_A = 90.0e6f; mat_tables[2].jc_B = 292.0e6f; mat_tables[2].jc_n = 0.31f; mat_tables[2].jc_C = 0.025f; mat_tables[2].jc_m = 1.09f;
    mat_tables[2].mg_c0 = 3940.0f; mat_tables[2].mg_s = 1.49f; mat_tables[2].mg_gamma0 = 2.02f;
    mat_tables[2].transfer_scheme = 2; // BSpline

    // Detonator initiation at (0, 0, 0)
    float det_r = 0.005f;
    float effective_init_rad = std::max(det_r, 2.5f * dx);
    int ignited = 0;
    for (auto& p : solver.getParticles()) {
        if (p.object_id == 1) {
            float dist = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1] + p.x[2]*p.x[2]);
            if (dist <= effective_init_rad) {
                ignited++;
                p.s_shock = 1.5f * mat_tables[1].crest_s_threshold;
                p.lambda = 1.0f;
                p.e_int = mat_tables[1].davis_q_det;
                p.v_min = mat_tables[1].davis_vc;
                p.V = p.v_min * p.V0;
                float p_init = mat_tables[1].davis_pc;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
            }
        }
    }
    std::cout << "Ignited " << ignited << " particles at (0,0,0)" << std::endl;

    for (int oid = 1; oid <= 2; ++oid) {
        float min_z = 1e9, max_z = -1e9;
        int count = 0;
        for (const auto& p : solver.getParticles()) {
            if (p.object_id == oid) {
                min_z = std::min(min_z, p.x[2]);
                max_z = std::max(max_z, p.x[2]);
                count++;
            }
        }
        std::cout << "  Object " << oid << " (" << count << " particles): Z=[" << min_z << ", " << max_z << "]\n";
    }

    solver.syncToDevice();

    std::cout << "\nStepping until t = " << (t_target * 1e6f) << " us..." << std::endl;
    float next_report_t = 2.0e-6f;
    int step_num = 0;

    while (solver.getSimTime() < t_target) {
        solver.step(0.6f);
        step_num++;

        float cur_t = static_cast<float>(solver.getSimTime());
        if (cur_t >= next_report_t || cur_t >= t_target) {
            solver.syncParticlesToHost();
            const auto& all_p = solver.getParticles();

            float v1_max = 0, v2_max = 0;
            float v1_avg = 0, v2_avg = 0;
            int n1 = 0, n2 = 0;
            float liner_min_z = 1e9f, liner_max_z = -1e9f;

            for (const auto& p : all_p) {
                float v = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                if (p.object_id == 1) {
                    v1_max = std::max(v1_max, v);
                    v1_avg += v;
                    n1++;
                } else if (p.object_id == 2) {
                    v2_max = std::max(v2_max, v);
                    v2_avg += v;
                    n2++;
                    liner_min_z = std::min(liner_min_z, p.x[2]);
                    liner_max_z = std::max(liner_max_z, p.x[2]);
                }
            }
            if (n1 > 0) v1_avg /= n1;
            if (n2 > 0) v2_avg /= n2;

            // Check if any gas particle has penetrated past the liner in -Z direction!
            int gas_past_liner_apex = 0;
            int gas_past_liner_front = 0;
            for (const auto& p : all_p) {
                if (p.object_id == 1 && p.lambda > 0.5f) {
                    // Apex of liner is at highest Z of liner (approx -0.132)
                    // The detonation travels in -Z (from 0 to -0.24)
                    // Gas is supposed to stay behind the liner (Z > liner_current_apex)
                    // If gas has Z < liner_min_z (penetrated completely through the liner!)
                    if (p.x[2] < liner_min_z) {
                        gas_past_liner_front++;
                    }
                    // Or if gas is near the axis (r < 0.02) and has Z < liner_max_z
                    float r = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]);
                    if (r < 0.02f && p.x[2] < liner_max_z) {
                        gas_past_liner_apex++;
                    }
                }
            }

            std::cout << "  Time " << std::fixed << std::setprecision(2) << (cur_t * 1e6f) << " us (Step " << step_num << ")"
                      << " | Exp vMax=" << std::setprecision(1) << v1_max << " vAvg=" << v1_avg
                      << " | Liner vMax=" << v2_max << " vAvg=" << v2_avg << " Z=[" << std::setprecision(4) << liner_min_z << ", " << liner_max_z << "]"
                      << " | GasPastApex=" << gas_past_liner_apex << " GasPastFront=" << gas_past_liner_front << std::endl;

            if (gas_past_liner_front > 0 && cur_t <= 34.0e-6f) {
                std::cout << "    --> PENETRATING GAS PARTICLES:" << std::endl;
                int count = 0;
                for (size_t pi = 0; pi < all_p.size() && count < 5; ++pi) {
                    const auto& p = all_p[pi];
                    if (p.object_id == 1 && p.lambda > 0.5f && p.x[2] < liner_min_z) {
                        float r = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]);
                        std::cout << "      Gas P" << pi << " pos=(" << p.x[0] << ", " << p.x[1] << ", " << p.x[2] << ")"
                                  << " r=" << r << " v=(" << p.v[0] << ", " << p.v[1] << ", " << p.v[2] << ") |v|=" << std::sqrt(p.v[0]*p.v[0]+p.v[1]*p.v[1]+p.v[2]*p.v[2]) << std::endl;
                        count++;
                    }
                }
            }

            next_report_t += 2.0e-6f;
        }
    }
    return 0;
}
