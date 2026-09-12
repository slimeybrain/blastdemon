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

    float xmin = -0.1f, xmax = 0.5f;
    float ymin = -0.5f, ymax = 0.5f;
    float zmin = -0.5f, zmax = 0.5f;
    float dx = 0.004f;
    int nx = std::round((xmax - xmin) / dx);
    int ny = std::round((ymax - ymin) / dx);
    int nz = std::round((zmax - zmin) / dx);

    MPMSolver3DCUDA solver;
    solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
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

    auto& mat_tables = solver.getMaterialTables();
    mat_tables.resize(4);

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

    std::cout << "\nStepping 10 steps..." << std::endl;
    for (int s = 1; s <= 10; ++s) {
        solver.step(0.6f);
        solver.syncParticlesToHost();

        float max_v = 0.0f;
        float max_p = 0.0f;
        float max_lam = 0.0f;
        for (const auto& p : solver.getParticles()) {
            float v = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
            max_v = std::max(max_v, v);
            float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            max_p = std::max(max_p, press);
            max_lam = std::max(max_lam, p.lambda);
        }
        std::cout << "  Step " << std::setw(2) << s 
                  << " | time=" << std::scientific << std::setprecision(3) << solver.getSimTime()
                  << " | max_v=" << std::fixed << std::setprecision(1) << max_v << " m/s"
                  << " | max_p=" << (max_p * 1e-9f) << " GPa"
                  << " | max_lam=" << max_lam
                  << std::endl;
    }
    return 0;
}
