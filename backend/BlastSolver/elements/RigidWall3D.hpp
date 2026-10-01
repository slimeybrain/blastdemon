#pragma once

#include <cmath>
#include <algorithm>

namespace Blast {

enum class RigidWallType {
    Planar,
    Cylindrical,
    Spherical
};

template <typename T>
struct alignas(64) RigidWall3D {
    RigidWallType type{RigidWallType::Planar};
    
    // Geometry
    T origin[3]{0.0f, 0.0f, 0.0f};  // Center point or plane origin
    T normal[3]{0.0f, 0.0f, 1.0f};  // Outward unit normal (or cylinder axis)
    T radius{1.0f};                 // Radius for cylinder/sphere
    
    // Penalty contact properties
    T penalty_stiffness{1.0e8f};    // Normal contact stiffness (N/m)
    T friction_coeff{0.25f};        // Coulomb friction coefficient mu
    
    // Evaluate penetration and contact force on a node with position x and velocity v
    bool evaluate_contact(const T x[3], const T v[3], T f_contact[3]) const {
        f_contact[0] = f_contact[1] = f_contact[2] = 0.0f;

        if (type == RigidWallType::Planar) {
            // Distance along normal: d = (x - origin) . normal
            T d = (x[0] - origin[0])*normal[0] + (x[1] - origin[1])*normal[1] + (x[2] - origin[2])*normal[2];
            if (d < 0.0f) {
                // Penetration depth = -d
                T delta = -d;
                T fn = penalty_stiffness * delta;

                // Normal force pushes outward along normal
                T f_norm[3] = {fn * normal[0], fn * normal[1], fn * normal[2]};

                // Tangential relative velocity
                T vn = v[0]*normal[0] + v[1]*normal[1] + v[2]*normal[2];
                T vt[3] = {v[0] - vn*normal[0], v[1] - vn*normal[1], v[2] - vn*normal[2]};
                T vt_mag = std::sqrt(vt[0]*vt[0] + vt[1]*vt[1] + vt[2]*vt[2]);

                T f_fric[3] = {0, 0, 0};
                if (vt_mag > static_cast<T>(1e-6)) {
                    T ft_max = friction_coeff * fn;
                    T t_dir[3] = {vt[0] / vt_mag, vt[1] / vt_mag, vt[2] / vt_mag};
                    f_fric[0] = -ft_max * t_dir[0];
                    f_fric[1] = -ft_max * t_dir[1];
                    f_fric[2] = -ft_max * t_dir[2];
                }

                f_contact[0] = f_norm[0] + f_fric[0];
                f_contact[1] = f_norm[1] + f_fric[1];
                f_contact[2] = f_norm[2] + f_fric[2];
                return true;
            }
        }
        return false;
    }
};

} // namespace Blast
