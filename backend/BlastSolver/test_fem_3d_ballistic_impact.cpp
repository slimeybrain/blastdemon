#include "fem_solver_3d.hpp"
#include "VTKWriter.hpp"
#include <iostream>
#include <cassert>
#include <cmath>
#include <vector>

using namespace Blast;

int main() {
    std::cout << "==========================================================================" << std::endl;
    std::cout << "[V&V TEST] Running 3D FEM Ballistic Impact & Penetration Validation..." << std::endl;
    std::cout << "==========================================================================" << std::endl;

    FEMSolver3D<float> solver;

    // 1. Configure High-Strength Steel Target Plate Material (Johnson-Cook + Mie-Grüneisen EOS)
    MaterialTable3D target_mat{};
    target_mat.density = 7850.0f;           // 7850 kg/m^3
    target_mat.youngs_modulus = 210.0e9f;   // 210 GPa
    target_mat.poissons_ratio = 0.30f;
    target_mat.yield_stress = 792.0e6f;      // Baseline yield (792 MPa)
    target_mat.hardening_modulus = 510.0e9f;

    // Johnson-Cook Plasticity & Thermal Softening (4340 Steel)
    target_mat.jc_A = 792.0e6f;
    target_mat.jc_B = 510.0e6f;
    target_mat.jc_n = 0.26f;
    target_mat.jc_C = 0.014f;
    target_mat.jc_m = 1.03f;
    target_mat.T_melt = 1793.0f;
    target_mat.T_room = 293.0f;
    target_mat.Cp = 477.0f;

    // Mie-Grüneisen Shock EOS Parameters
    target_mat.mg_gamma0 = 1.81f;
    target_mat.mg_c0 = 4570.0f;            // 4570 m/s bulk sound speed
    target_mat.mg_s = 1.49f;

    target_mat.bulk_viscosity_b1 = 0.06f;
    target_mat.bulk_viscosity_b2 = 1.20f;
    target_mat.failure_strain = 0.40f;
    target_mat.tensile_failure_stress = 1200.0e6f;

    // 2. Configure High-Velocity Projectile Material (Tungsten Alloy / Hardened Steel)
    MaterialTable3D proj_mat{};
    proj_mat.density = 17800.0f;           // 17,800 kg/m^3 heavy tungsten penetrator
    proj_mat.youngs_modulus = 360.0e9f;   // 360 GPa
    proj_mat.poissons_ratio = 0.28f;
    proj_mat.yield_stress = 1500.0e6f;    // High initial yield (1500 MPa)
    proj_mat.hardening_modulus = 800.0e6f;

    proj_mat.jc_A = 1500.0e6f;
    proj_mat.jc_B = 800.0e6f;
    proj_mat.jc_n = 0.12f;
    proj_mat.jc_C = 0.016f;
    proj_mat.jc_m = 1.00f;
    proj_mat.T_melt = 3695.0f;
    proj_mat.T_room = 293.0f;
    proj_mat.Cp = 134.0f;

    proj_mat.mg_gamma0 = 1.54f;
    proj_mat.mg_c0 = 4030.0f;
    proj_mat.mg_s = 1.23f;

    // 3. Build Mesh: Target Plate (Box) + High-Speed Projectile (Cylinder)
    // Target Plate: 8x8x4 elements (0.04m x 0.04m x 0.02m)
    solver.createStructuredBoxMesh(8, 8, 4, 0.04f, 0.04f, 0.02f, -0.02f, -0.02f, 0.0f, target_mat, "Fixed Base");

    // Projectile: High-Velocity Cylindrical Penetrator traveling at -800 m/s downwards
    solver.addStructuredCylinderMesh(3, 4, 0.008f, 0.02f, 0.0f, 0.0f, 0.025f, proj_mat, 0.0f, 0.0f, -800.0f, 0.0f, "Free");

    // 4. Configure Hydrocode Settings: Viscous Hourglass Control + Damped Contact Penalty
    solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    solver.setHourglassCoeff(0.10f);
    solver.setContactPenaltyScale(1.5f);
    solver.setContactDamping(0.20f);
    solver.setFrictionCoefficients(0.3f, 0.2f);

    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.failure_strain = 0.45f;
    solver.setErosionCriteria(erosion);

    std::cout << "  Mesh setup complete:" << std::endl;
    std::cout << "    - Nodes: " << solver.getNodes().size() << std::endl;
    std::cout << "    - Elements: " << solver.getElements().size() << std::endl;
    std::cout << "    - Boundary Facets: " << solver.getSurfaceFacets().size() << std::endl;
    std::cout << "    - Initial Projectile Velocity: -800.0 m/s" << std::endl;

    const auto& energy_0 = solver.getEnergyTracker();
    std::cout << "    - Baseline Energy E_0: " << energy_0.E_0 << " J, E_kin: " << energy_0.E_kin << " J" << std::endl;

    // 5. Run 200 Explicit Hydrocode Sub-Steps
    float max_temp_recorded = 293.0f;
    float max_plastic_strain_recorded = 0.0f;
    float max_von_mises_recorded = 0.0f;
    float max_v_recorded = 0.0f;

    for (int step = 1; step <= 200; ++step) {
        float dt = solver.computeStepSize(0.3f);
        solver.stepWithDt(dt);

        float max_v = solver.getMaxVelocity();
        float max_ep = solver.getMaxPlasticStrain();
        float max_vm = solver.getMaxVonMisesStress();

        if (max_v > max_v_recorded) max_v_recorded = max_v;
        if (max_ep > max_plastic_strain_recorded) max_plastic_strain_recorded = max_ep;
        if (max_vm > max_von_mises_recorded) max_von_mises_recorded = max_vm;

        for (const auto& elem : solver.getElements()) {
            if (!elem.is_eroded && elem.temperature > max_temp_recorded) {
                max_temp_recorded = elem.temperature;
            }
        }

        if (step == 1 || step % 40 == 0 || step == 200) {
            const auto& e = solver.getEnergyTracker();
            std::cout << "  [Step " << step << "] t = " << (solver.getSimTime() * 1.0e6f) << " us"
                      << " | dt = " << (dt * 1.0e9f) << " ns"
                      << " | Max V = " << max_v << " m/s"
                      << " | Max Ep = " << max_ep
                      << " | Max VM = " << (max_vm / 1.0e6f) << " MPa"
                      << " | Max T = " << max_temp_recorded << " K"
                      << " | E_ratio = " << e.getEnergyRatio()
                      << std::endl;
        }
    }

    std::cout << "==========================================================================" << std::endl;
    std::cout << "[V&V RESULTS SUMMARY]" << std::endl;
    std::cout << "  - Peak Velocity: " << max_v_recorded << " m/s (bounded, no explosive NaN)" << std::endl;
    std::cout << "  - Peak Equivalent Plastic Strain: " << max_plastic_strain_recorded << std::endl;
    std::cout << "  - Peak Von Mises Stress: " << (max_von_mises_recorded / 1.0e6f) << " MPa" << std::endl;
    std::cout << "  - Peak Thermal Softening Temp: " << max_temp_recorded << " K (Thermal rise: +" << (max_temp_recorded - 293.0f) << " K)" << std::endl;
    std::cout << "  - Final Energy Ratio: " << solver.getEnergyTracker().getEnergyRatio() << std::endl;

    // 6. Empirical Verification Assertions
    assert(max_v_recorded < 5000.0f); // Non-explosive velocity check
    assert(max_temp_recorded > 295.0f); // Thermal softening active (plastic work converted to heat)
    assert(max_plastic_strain_recorded > 0.01f); // Plastic deformation occurred
    assert(solver.getEnergyTracker().getEnergyRatio() > 0.05f && solver.getEnergyTracker().getEnergyRatio() < 1.30f);

    std::cout << "[PASS] test_fem_3d_ballistic_impact PASSED all V&V assertions!" << std::endl;
    std::cout << "==========================================================================" << std::endl;
    return 0;
}
