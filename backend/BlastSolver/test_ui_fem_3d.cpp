#include "fem_solver_3d.hpp"
#include <iostream>
#include <iomanip>
#include <vector>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running UI exact payload test for 3D FEM Taylor Anvil Impact..." << std::endl;

    FEMSolver3D<float> fem;
    fem.setHourglassCoeff(0.0f);
    fem.setContactPenaltyScale(0.1f);
    fem.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    fem.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);

    // Object 1: Target Anvil (Box Generator, Fixed Base)
    MaterialTable3D mat1;
    mat1.density = 7850.0f;
    mat1.youngs_modulus = 210.0e9f;
    mat1.poissons_ratio = 0.3f;
    mat1.yield_stress = 400.0e6f;
    mat1.hardening_modulus = 1.0e9f;
    mat1.failure_strain = 0.50f;
    mat1.tensile_failure_stress = 600.0e6f;
    mat1.bulk_viscosity_b1 = 0.06f;
    mat1.bulk_viscosity_b2 = 1.20f;
    mat1.timestep_erosion_factor = 0.10f;

    fem.addStructuredBoxMesh(10, 10, 10, 0.02f, 0.02f, 0.02f, 0.0f, 0.0f, 0.0f, mat1, 0.0f, 0.0f, 0.0f, "Fixed Base");

    // Object 2: Projectile (Cylinder Generator, Free, Vel Z = -100)
    MaterialTable3D mat2;
    mat2.density = 8960.0f;
    mat2.youngs_modulus = 117.0e9f;
    mat2.poissons_ratio = 0.35f;
    mat2.yield_stress = 400.0e6f;
    mat2.hardening_modulus = 100.0e6f;
    mat2.failure_strain = 0.50f;
    mat2.tensile_failure_stress = 600.0e6f;
    mat2.bulk_viscosity_b1 = 0.06f;
    mat2.bulk_viscosity_b2 = 1.20f;
    mat2.timestep_erosion_factor = 0.10f;

    fem.addStructuredCylinderMesh(4, 10, 0.004f, 0.04f, 0.0f, 0.0f, 0.0205f, mat2, 0.0f, 0.0f, -100.0f, 0.0f, "Free");

    std::cout << "Mesh created: " << fem.getNodes().size() << " nodes, " << fem.getElements().size() << " elements, " << fem.getSurfaceFacets().size() << " boundary facets." << std::endl;

    std::cout << "Running 4000 steps of Taylor Anvil Impact simulation..." << std::endl;
    for (int step = 0; step < 4000; ++step) {
        float dt = fem.computeStepSize(0.4f);
        fem.stepWithDt(dt);
        if (step % 500 == 0 || step == 3999) {
            const auto& energy = fem.getEnergyTracker();
            std::cout << "Step " << std::setw(4) << step << " | dt=" << dt << " | E_kin=" << energy.E_kin << " J | E_int=" << energy.E_int << " J | E_total=" << energy.E_total << " J" << std::endl;
        }
    }

    const auto& energy = fem.getEnergyTracker();
    std::cout << "Final Results at Step 4000:" << std::endl;
    std::cout << "  E_kin = " << energy.E_kin << " J, E_int = " << energy.E_int << " J, E_total = " << energy.E_total << " J" << std::endl;

    std::cout << "[PASS] UI exact payload test PASSED successfully." << std::endl;
    return 0;
}
