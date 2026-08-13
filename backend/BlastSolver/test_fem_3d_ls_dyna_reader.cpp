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
    std::cout << "[PASS] test_fem_3d_ls_dyna_reader PASSED successfully." << std::endl;
    return 0;
}
