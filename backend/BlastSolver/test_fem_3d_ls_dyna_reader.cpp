#include "ls_dyna_reader_3d.hpp"
#include <iostream>
#include <fstream>
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_ls_dyna_reader..." << std::endl;

    // Create a temporary keyword file
    std::string test_k_file = "temp_test_model.k";
    std::ofstream out(test_k_file);
    out << "$ Test LS-DYNA Keyword File\n";
    out << "*KEYWORD\n";
    out << "*NODE\n";
    out << "   100001, 0.0, 0.0, 0.0\n";
    out << "   100002, 1.0, 0.0, 0.0\n";
    out << "   100003, 1.0, 1.0, 0.0\n";
    out << "   100004, 0.0, 1.0, 0.0\n";
    out << "   100005, 0.0, 0.0, 1.0\n";
    out << "   100006, 1.0, 0.0, 1.0\n";
    out << "   100007, 1.0, 1.0, 1.0\n";
    out << "   100008, 0.0, 1.0, 1.0\n";
    out << "*ELEMENT_SOLID\n";
    out << "   500001, 1, 100001, 100002, 100003, 100004, 100005, 100006, 100007, 100008\n";
    out << "*MAT_ELASTIC\n";
    out << "$     MID        RHO          E         PR\n";
    out << "        1     7850.0   210.0E9       0.30\n";
    out << "*END\n";
    out.close();

    LSDynaReader3D<float> reader;
    std::vector<FEMNode3D<float>> nodes;
    std::vector<FEMElement3D<float>> elements;
    MaterialTable3D default_mat;
    std::vector<MaterialTable3D> mat_list;

    bool ok = reader.parseFile(test_k_file, nodes, elements, default_mat, mat_list);
    assert(ok);

    std::cout << "  Parsed Node Count = " << nodes.size() << " (Expected: 8)" << std::endl;
    std::cout << "  Parsed Element Count = " << elements.size() << " (Expected: 1)" << std::endl;
    std::cout << "  Parsed Density = " << default_mat.density << " kg/m^3" << std::endl;

    assert(nodes.size() == 8);
    assert(elements.size() == 1);
    assert(default_mat.density == 7850.0f);

    std::remove(test_k_file.c_str());

    // Test Johnson-Cook + EOS + Erosion parsing
    std::string test_jc_k_file = "temp_test_jc_model.k";
    std::ofstream out_jc(test_jc_k_file);
    out_jc << "$ Test Johnson-Cook Keyword File\n";
    out_jc << "*KEYWORD\n";
    out_jc << "*MAT_JOHNSON_COOK\n";
    out_jc << "$     MID        RHO          E         PR          A          B          N          C\n";
    out_jc << "        1     7850.0   210.0E9       0.30   792.0E6    510.0E6       0.26      0.014\n";
    out_jc << "$       M       TM         TR         CP         PC      SPALL\n";
    out_jc << "     1.03   1793.0      293.0      477.0        0.0    600.0E6\n";
    out_jc << "*EOS_GRUNEISEN\n";
    out_jc << "$   EOSID          C         S1         S2         S3      GAMAO\n";
    out_jc << "        1     4570.0       1.49        0.0        0.0       1.81\n";
    out_jc << "*MAT_ADD_EROSION\n";
    out_jc << "$     MID     EXFAIL      MXEPS      EPSTH      SIGP1      SIGVM\n";
    out_jc << "        1       0.45        0.0        0.0    650.0E6        0.0\n";
    out_jc << "*END\n";
    out_jc.close();

    MaterialTable3D jc_mat;
    std::vector<MaterialTable3D> jc_mat_list;
    std::vector<FEMNode3D<float>> jc_nodes;
    std::vector<FEMElement3D<float>> jc_elements;
    bool ok_jc = reader.parseFile(test_jc_k_file, jc_nodes, jc_elements, jc_mat, jc_mat_list);
    assert(ok_jc);
    assert(jc_mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen);
    assert(jc_mat.jc_A == 792.0e6f);
    assert(jc_mat.jc_B == 510.0e6f);
    assert(jc_mat.jc_n == 0.26f);
    assert(jc_mat.jc_C == 0.014f);
    assert(jc_mat.jc_m == 1.03f);
    assert(jc_mat.T_melt == 1793.0f);
    assert(jc_mat.mg_c0 == 4570.0f);
    assert(jc_mat.mg_s == 1.49f);
    assert(jc_mat.mg_gamma0 == 1.81f);
    assert(jc_mat.failure_strain == 0.45f);
    assert(jc_mat.tensile_failure_stress == 650.0e6f);

    std::remove(test_jc_k_file.c_str());

    // Test Shell Element and Section parsing (*SECTION_SHELL, *ELEMENT_SHELL)
    std::string test_shell_k_file = "temp_test_shell_model.k";
    std::ofstream out_shell(test_shell_k_file);
    out_shell << "$ Test Shell Keyword File\n";
    out_shell << "*KEYWORD\n";
    out_shell << "*NODE\n";
    out_shell << "   200001, 0.0, 0.0, 0.0\n";
    out_shell << "   200002, 1.0, 0.0, 0.0\n";
    out_shell << "   200003, 1.0, 1.0, 0.0\n";
    out_shell << "   200004, 0.0, 1.0, 0.0\n";
    out_shell << "*SECTION_SHELL\n";
    out_shell << "$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp\n";
    out_shell << "         1         2       1.0         5         1         0         0         1\n";
    out_shell << "$#      t1        t2        t3        t4      nloc     marea      idof    edgset\n";
    out_shell << "    0.0400    0.0400    0.0400    0.0400       0.0       0.0       0.0         0\n";
    out_shell << "*PART\n";
    out_shell << "Submarine_Hull\n";
    out_shell << "$#     pid     secid      mid     eosid      hgid      grav    adpopt      tmid\n";
    out_shell << "         1         1        1         0         0         0         0         0\n";
    out_shell << "*ELEMENT_SHELL\n";
    out_shell << "$#   eid     pid      n1      n2      n3      n4\n";
    out_shell << "       1       1  200001  200002  200003  200004\n";
    out_shell << "*MAT_PIECEWISE_LINEAR_PLASTICITY\n";
    out_shell << "$#     mid        ro         e        pr      sigy      etan      fail      tdel\n";
    out_shell << "         1    7850.0  2.070e11     0.300  5.500e08  1.200e09     0.250       0.0\n";
    out_shell << "*END\n";
    out_shell.close();

    LSDynaReader3D<float> shell_reader;
    std::vector<FEMNode3D<float>> shell_nodes;
    std::vector<FEMElement3D<float>> shell_solids;
    std::vector<FEMTrussElement3D<float>> shell_trusses;
    std::vector<FEMBeam3DElement<float>> shell_beams;
    std::vector<FEMShell4BTElement<float>> shells;
    MaterialTable3D shell_mat;
    std::vector<MaterialTable3D> shell_mat_list;

    bool ok_shell = shell_reader.parseFile(
        test_shell_k_file, shell_nodes, shell_solids, shell_trusses, shell_beams, shells, shell_mat, shell_mat_list
    );
    assert(ok_shell);
    std::cout << "  Parsed Shell Node Count = " << shell_nodes.size() << " (Expected: 4)" << std::endl;
    std::cout << "  Parsed Shell Count = " << shells.size() << " (Expected: 1)" << std::endl;
    std::cout << "  Parsed Shell Thickness = " << shells[0].thickness << " m (Expected: 0.0400)" << std::endl;
    std::cout << "  Parsed Shell Area = " << shells[0].area0 << " m^2 (Expected: 1.0)" << std::endl;

    assert(shell_nodes.size() == 4);
    assert(shell_solids.empty());
    assert(shells.size() == 1);
    assert(std::abs(shells[0].thickness - 0.0400f) < 1e-6f);
    assert(std::abs(shells[0].area0 - 1.0f) < 1e-4f);
    assert(std::abs(shells[0].e3[2] - 1.0f) < 1e-4f || std::abs(shells[0].e3[2] + 1.0f) < 1e-4f);
    assert(shell_reader.getShellCount() == 1);
    assert(shell_reader.getParts().at(1).num_shells == 1);
    assert(shells[0].mat_id == 0);
    assert(shells[0].part_id == 1);

    // Test 6-argument convenience overload
    std::vector<FEMNode3D<float>> shell_nodes2;
    std::vector<FEMElement3D<float>> shell_solids2;
    std::vector<FEMShell4BTElement<float>> shells2;
    MaterialTable3D shell_mat2;
    std::vector<MaterialTable3D> shell_mat_list2;
    bool ok_shell2 = shell_reader.parseFile(
        test_shell_k_file, shell_nodes2, shell_solids2, shells2, shell_mat2, shell_mat_list2
    );
    assert(ok_shell2);
    assert(shells2.size() == 1);
    assert(std::abs(shells2[0].thickness - 0.0400f) < 1e-6f);

    std::remove(test_shell_k_file.c_str());

    std::cout << "[PASS] test_fem_3d_ls_dyna_reader PASSED successfully." << std::endl;
    return 0;
}
