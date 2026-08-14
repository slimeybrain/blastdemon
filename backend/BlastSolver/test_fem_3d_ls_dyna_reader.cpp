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
    std::cout << "[PASS] test_fem_3d_ls_dyna_reader PASSED successfully." << std::endl;
    return 0;
}
