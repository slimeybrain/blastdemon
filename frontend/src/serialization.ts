import { SimulationState } from './types.js';

export function serializeSimulationState(state: SimulationState): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);
    const dag = {
        nodes: strippedNodes,
        connections: state.connections
    };
    return JSON.stringify({
        command: "EXECUTE",
        dag: dag
    });
}

export function serializeForSolver(state: SimulationState, command: string = "INIT", modelId?: string, modelFilename?: string | null): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    const numericKeys = [
        'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
        'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
        'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl',
        'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
        'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride',
        'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
        // 2D CFD keys
        'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
        'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
        'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
        'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
        // 3D CFD keys
        'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
        'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
        'charge_rot_x', 'charge_rot_y', 'charge_rot_z',
        'detonator_x', 'detonator_y', 'detonator_z', 'xmin', 'ymin', 'zmin',
        'origin_x', 'origin_y', 'origin_z', 'dim_x', 'dim_y', 'dim_z', 'scale_factor',
        'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
        'refinement_opacity', 'charge_opacity',
        'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
        'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'length', 'refinement_level',
        'submesh_x', 'submesh_y', 'submesh_z', 'submesh_size_x', 'submesh_size_y', 'submesh_size_z',
        'offset', 'stride',
        // MPM keys
        'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'radius', 'inner_radius',
        'scale_x', 'scale_y', 'scale_z',
        'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
        'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
        'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress',
        'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp',
        'mg_gamma0', 'mg_c0', 'mg_s',
        'ppc',
        'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
        // FEM keys
        'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping',
        'mpm_particles_per_failed_element', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed', 'rebar_diameter', 'rebar_area', 'rebarRadius', 'rebar_radius', 'beamRadius', 'beam_radius', 'beam_diameter', 'beam_area', 'beamMinVal', 'beamMaxVal',
        'femMinVal', 'femMaxVal', 'femOpacity', 'vacuum_density', 'vacuum_pressure', 'uncovering_tolerance',
        // Concrete Core & Models (RHT, K&C, CSCM)
        'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
        'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
        'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
        'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
        'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
        // VTK ROI & Strides
        'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride'
    ];


    const flattenedParams: Record<string, any> = {};

    // 1. Trace 1D Solver if it exists
    const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
    if (solverNode) {
        Object.entries(solverNode.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        const solverConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'in');
        if (solverConn) {
            const painterNode = state.nodes.find(n => n.id === solverConn.fromNode);
            if (painterNode && painterNode.type === 'ThePainter') {
                const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
                if (meshConn) {
                    const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                    if (meshNode) {
                        Object.entries(meshNode.parameters).forEach(([key, value]) => {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        });
                    }
                }

                const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
                if (airConn) {
                    const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                    if (airNode && airNode.type === 'Material' && airNode.parameters?.material_type === 'Air') {
                        const airKeys = ['atm_pressure', 'atm_temperature', 'gamma'];
                        airKeys.forEach(key => {
                            if (airNode.parameters[key] !== undefined) {
                                flattenedParams[key] = numericKeys.includes(key) ? Number(airNode.parameters[key]) : airNode.parameters[key];
                            }
                        });
                    }
                }

                const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
                if (expConn) {
                    const chargeNode = state.nodes.find(n => n.id === expConn.fromNode);
                    if (chargeNode && chargeNode.type === 'Charge1D') {
                        // Copy all parameters (e.g. charge_mass)
                        Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        });
                        // Radius comes from Charge1D parameter
                        const radius = Number(chargeNode.parameters?.charge_radius ?? 0.05);
                        flattenedParams['charge_radius'] = radius;
                        flattenedParams['explosive_radius'] = radius;

                        // Trace to Material node
                        const matConn = state.connections.find(c => c.toNode === chargeNode.id && c.toPort === 'material');
                        if (matConn) {
                            const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                            if (matNode && matNode.type === 'Material') {
                                const matType = matNode.parameters?.material_type || 'Air';
                                if (matType === 'JWL Charge') {
                                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                                    const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                                    jwlKeys.forEach(key => {
                                        if (matNode.parameters[key] !== undefined) {
                                            flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                        }
                                    });
                                } else if (matType === 'Ideal Gas Charge') {
                                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                    flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                                    flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                    flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                                    if (matNode.parameters?.composition !== undefined) {
                                        flattenedParams['composition'] = matNode.parameters.composition;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Trace 3D Solver if it exists
    const solverNode3D = state.nodes.find(n => n.type === 'CFDSolver3D');
    if (solverNode3D) {
        Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        // Trace STL or Primitive Geometry for CFD Solver 3D
        const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
        if (stlConn) {
            const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
            if (stlNode && stlNode.type === 'STLGeometry') {
                flattenedParams['stl_file'] = stlNode.parameters.stl_file || '';
                flattenedParams['geometry_hash'] = stlNode.parameters.geometry_hash || '';
                flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
            } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                let hash = 5381;
                for (let i = 0; i < primsStr.length; i++) {
                    hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                    hash = hash & hash;
                }
                flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
            }
        } else {
            flattenedParams['stl_file'] = '';
            flattenedParams['primitives'] = [];
            flattenedParams['geometry_hash'] = '';
        }

        // Find the DomainMesh3D connected to CFDSolver3D.mesh
        const meshConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'mesh');
        if (meshConn3D) {
            const rootDomainNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
            if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Fallback: if xmin/xmax is still undefined, check for any DomainMesh3D in the graph
        if (flattenedParams['xmin'] === undefined && flattenedParams['xmax'] === undefined) {
            const rootDomainMesh = state.nodes.find(n => n.type === 'DomainMesh3D');
            if (rootDomainMesh) {
                Object.entries(rootDomainMesh.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        // Trace Air for CFD Solver 3D
        const airConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'air');
        if (airConn3D) {
            const airNode3D = state.nodes.find(n => n.id === airConn3D.fromNode);
            if (airNode3D && airNode3D.type === 'Material' && airNode3D.parameters?.material_type === 'Air') {
                const airKeys = ['atm_pressure', 'atm_temperature', 'gamma'];
                airKeys.forEach(key => {
                    if (airNode3D.parameters[key] !== undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(airNode3D.parameters[key]) : airNode3D.parameters[key];
                    }
                });
            }
        }

        // Trace Charge 3D
        const chargeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge');
        if (chargeConn3D) {
            const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
            if (chargeNode3D) {
                Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });

                // Trace Material for Charge 3D
                const matConn = state.connections.find(c => c.toNode === chargeNode3D.id && c.toPort === 'material');
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode) {
                        const matType = matNode.parameters?.material_type || 'Air';
                        if (matType === 'JWL Charge') {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                            jwlKeys.forEach(key => {
                                if (matNode.parameters[key] !== undefined) {
                                    flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                }
                            });
                        } else if (matType === 'Ideal Gas Charge') {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            if (matNode.parameters?.composition !== undefined) {
                                flattenedParams['composition'] = matNode.parameters.composition;
                            }
                        } else {
                            Object.entries(matNode.parameters).forEach(([key, value]) => {
                                if (key !== 'material_type') {
                                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                                }
                            });
                        }
                    }
                }
            }
        }

        // Trace Detonator for CFD Solver 3D
        const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'detonator');
        if (detConn3D) {
            const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
            if (detNode3D && detNode3D.type === 'DetonatorLocation3D') {
                Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace Remap 3D
        const remapConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap');
        if (remapConn3D) {
            const remapNode3D = state.nodes.find(n => n.id === remapConn3D.fromNode);
            if (remapNode3D) {
                Object.entries(remapNode3D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        const gaugeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'gauges');
        if (gaugeConn3D) {
            const gaugeNode3D = state.nodes.find(n => n.id === gaugeConn3D.fromNode);
            if (gaugeNode3D) {
                flattenedParams['gauges'] = gaugeNode3D.parameters.gauges || [];
            }
        } else {
            flattenedParams['gauges'] = [];
        }

        // Trace Telemetry3DViewport slices and VTK configuration
        const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
        for (const conn of telemetryConns) {
            const viewNode = state.nodes.find(n => n.id === conn.toNode);
            if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                if (viewNode.parameters.slices) {
                    flattenedParams['slices'] = viewNode.parameters.slices;
                }
                // Trace file output options
                Object.entries(viewNode.parameters).forEach(([key, value]) => {
                    if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        // Trace VTKOutput connected to CFDSolver3D
        const vtkConns3D = state.connections.filter(c => c.fromNode === solverNode3D.id || c.toNode === solverNode3D.id);
        for (const conn of vtkConns3D) {
            const otherId = conn.fromNode === solverNode3D.id ? conn.toNode : conn.fromNode;
            const vtkNode = state.nodes.find(n => n.id === otherId);
            if (vtkNode && vtkNode.type === 'VTKOutput') {
                Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }
    }

    // 2. Trace 2D Solver if it exists
    const solverNode2D = state.nodes.find(n => n.type === 'CFDSolver2D');
    if (solverNode2D) {
        // Apply CFDSolver2D parameters
        Object.entries(solverNode2D.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        // Trace mesh input
        const meshConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'mesh');
        if (meshConn2D) {
            const meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
            if (meshNode2D) {
                Object.entries(meshNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace remap input
        const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
        if (remapConn2D) {
            const remapNode2D = state.nodes.find(n => n.id === remapConn2D.fromNode);
            if (remapNode2D) {
                Object.entries(remapNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace detonator input
        const detConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'detonator');
        if (detConn2D) {
            const detNode2D = state.nodes.find(n => n.id === detConn2D.fromNode);
            if (detNode2D && detNode2D.type === 'DetonatorLocation') {
                Object.entries(detNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace hardware config
        const hwConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'hardware');
        if (hwConn2D) {
            const hwNode2D = state.nodes.find(n => n.id === hwConnConnNode(hwConn2D.fromNode));
            function hwConnConnNode(id: string) { return id; } // helper
            const hwNode = state.nodes.find(n => n.id === hwConn2D.fromNode);
            if (hwNode) {
                Object.entries(hwNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace air input
        const airConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'air');
        if (airConn2D) {
            const airNode = state.nodes.find(n => n.id === airConn2D.fromNode);
            if (airNode && airNode.type === 'Material' && airNode.parameters?.material_type === 'Air') {
                const airKeys = ['atm_pressure', 'atm_temperature', 'gamma'];
                airKeys.forEach(key => {
                    if (airNode.parameters[key] !== undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(airNode.parameters[key]) : airNode.parameters[key];
                    }
                });
            }
        }

        // Trace charge input (Charge2D or Charge1D)
        let expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'charge');
        if (!expConn2D) {
            expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'explosive');
        }
        if (expConn2D) {
            const chargeNode = state.nodes.find(n => n.id === expConn2D.fromNode);
            if (chargeNode && (chargeNode.type === 'Charge2D' || chargeNode.type === 'Charge1D')) {
                // Charge geometry parameters
                Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });

                // Trace material node connected to Charge
                const matConn = state.connections.find(c => c.toNode === chargeNode.id && c.toPort === 'material');
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode && matNode.type === 'Material') {
                        const matType = matNode.parameters?.material_type ?? 'JWL Charge';
                        if (matType === 'JWL Charge') {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                            jwlKeys.forEach(key => {
                                if (matNode.parameters[key] !== undefined) {
                                    flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                }
                            });
                        } else if (matType === 'Ideal Gas Charge') {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            if (matNode.parameters?.composition !== undefined) {
                                flattenedParams['composition'] = matNode.parameters.composition;
                            }
                        }
                    }
                }
            }
        }
        // Trace gauges and VTK output connected to CFDSolver2D
        const solver2DConns = state.connections.filter(c => c.fromNode === solverNode2D.id || c.toNode === solverNode2D.id);
        for (const conn of solver2DConns) {
            const otherId = conn.fromNode === solverNode2D.id ? conn.toNode : conn.fromNode;
            const targetNode = state.nodes.find(n => n.id === otherId);
            if (targetNode && targetNode.type === 'VirtualGauges') {
                flattenedParams['gauges'] = targetNode.parameters?.gauges || [];
            }
            if (targetNode && targetNode.type === 'VTKOutput') {
                Object.entries(targetNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }
    }

    // Derived parameters for backend (Zero-Omission Phase)
    if (command === "INIT") {
        const radius = flattenedParams['domain_radius'] || 1.0;
        const dx = flattenedParams['cell_size'] || 0.001;
        flattenedParams['n_cells'] = Math.round(radius / dx);

        // gamma comes from MaterialAir's gamma parameter (default 1.4 if not set)
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['charge_mass'] = mass;
        flattenedParams['rho'] = rho;
        flattenedParams['explosive_radius'] = mass > 0 ? Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0) : 0.0;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Ensure init_mode and composition are present with safe defaults
        if (!flattenedParams['init_mode']) flattenedParams['init_mode'] = 'Multi-Material JWL';
        if (flattenedParams['init_mode'] === 'Multi-Material JWL' && !flattenedParams['composition']) {
            flattenedParams['composition'] = 'TNT';
        }
    } else if (command === "INIT_2D") {
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Map and heal detonator locations if old naming is present
        if (flattenedParams['detonator_r'] === undefined) {
            flattenedParams['detonator_r'] = flattenedParams['explosive_r'] !== undefined ? flattenedParams['explosive_r'] : 0.0;
        }
        if (flattenedParams['detonator_z'] === undefined) {
            flattenedParams['detonator_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['detonator_radius'] === undefined) {
            flattenedParams['detonator_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.001;
        }

        if (flattenedParams['charge_shape'] === undefined) {
            flattenedParams['charge_shape'] = 'Sphere';
        }
        if (flattenedParams['charge_r'] === undefined) {
            flattenedParams['charge_r'] = 0.0;
        }
        if (flattenedParams['charge_z'] === undefined) {
            flattenedParams['charge_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['charge_radius'] === undefined) {
            flattenedParams['charge_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.05;
        }
        if (flattenedParams['charge_height'] === undefined) {
            flattenedParams['charge_height'] = 0.1;
        }

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        flattenedParams['charge_mass'] = mass;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['rho'] = rho;

        if (mass > 0) {
            if (flattenedParams['charge_shape'] === 'Cylinder') {
                const ar = flattenedParams['charge_aspect_ratio'] || (flattenedParams['charge_height'] && flattenedParams['charge_radius'] ? flattenedParams['charge_height'] / (2.0 * flattenedParams['charge_radius']) : 1.0);
                if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                    flattenedParams['charge_radius'] = Math.cbrt(mass / (2.0 * Math.PI * rho * ar));
                }
                flattenedParams['charge_height'] = 2.0 * flattenedParams['charge_radius'] * ar;
                flattenedParams['charge_aspect_ratio'] = ar;
            } else {
                flattenedParams['charge_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0);
            }
        } else if (flattenedParams['charge_radius'] === undefined || flattenedParams['charge_radius'] === 0.0) {
            flattenedParams['charge_radius'] = 0.05;
        }

        // Respect user node setting for init_mode; only default if undefined
        const remapConn2D = solverNode2D ? state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap') : null;
        if (!flattenedParams['init_mode']) {
            if (remapConn2D) {
                flattenedParams['init_mode'] = 'From1D';
            } else if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'JWL';
            }
        }

        if (!flattenedParams['composition']) flattenedParams['composition'] = 'TNT';
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const maxR = flattenedParams['max_r'] || 1.0;
        const maxZ = flattenedParams['max_z'] || 1.0;

        if (flattenedParams['mesh_type'] === 'amr') {
            flattenedParams['nr'] = Math.ceil((Math.round(maxR / cellSize) || 128) / 16) * 16;
            flattenedParams['nz'] = Math.ceil((Math.round(maxZ / cellSize) || 128) / 16) * 16;
        } else {
            flattenedParams['nr'] = Math.round(maxR / cellSize);
            flattenedParams['nz'] = Math.round(maxZ / cellSize);
        }
        flattenedParams['max_r'] = maxR;
        flattenedParams['max_z'] = maxZ;
    } else if (command === "INIT_FSI_2D" || command === "INIT_FSI") {
        // 1. Serialize 2D CFD Solver part
        const solverNode2D = state.nodes.find(n => n.type === 'CFDSolver2D');
        if (solverNode2D) {
            Object.entries(solverNode2D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const meshConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'mesh');
            if (meshConn2D) {
                const meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
                if (meshNode2D) {
                    Object.entries(meshNode2D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'air');
            if (airConn2D) {
                const airNode = state.nodes.find(n => n.id === airConn2D.fromNode);
                if (airNode && airNode.type === 'Material' && airNode.parameters?.material_type === 'Air') {
                    ['atm_pressure', 'atm_temperature', 'gamma'].forEach(key => {
                        if (airNode.parameters[key] !== undefined) {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(airNode.parameters[key]) : airNode.parameters[key];
                        }
                    });
                }
            }
            let expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'charge') || state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'explosive');
            if (expConn2D) {
                const chargeNode = state.nodes.find(n => n.id === expConn2D.fromNode);
                if (chargeNode && (chargeNode.type === 'Charge2D' || chargeNode.type === 'Charge1D')) {
                    Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const matConn = state.connections.find(c => c.toNode === chargeNode.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode && matNode.type === 'Material') {
                            const matType = matNode.parameters?.material_type ?? 'JWL Charge';
                            if (matType === 'JWL Charge') {
                                flattenedParams['explosive_type'] = 'MaterialExplosive';
                                ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].forEach(key => {
                                    if (matNode.parameters[key] !== undefined) {
                                        flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                    }
                                });
                            } else if (matType === 'Ideal Gas Charge') {
                                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                                flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            }
                        }
                    }
                }
            }
        }

        // 2. Serialize MPM Domain part
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain2D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 4);
            flattenedParams['ppc'] = domainPpc;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject2D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            Object.entries(matNode.parameters).forEach(([k, v]) => {
                                objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                            });
                        }
                    }
                    if (objParams['ppc'] === undefined) {
                        objParams['ppc'] = domainPpc;
                    }
                    mpmObjects.push(objParams);
                }
            }
            flattenedParams['mpm_objects'] = mpmObjects;
        }

        // 3. Serialize FSICoupler2D parameters
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler2D');
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
        }

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const maxR = flattenedParams['max_r'] || 1.0;
        const maxZ = flattenedParams['max_z'] || 1.0;
        flattenedParams['nr'] = Math.round(maxR / cellSize);
        flattenedParams['nz'] = Math.round(maxZ / cellSize);
        flattenedParams['max_r'] = maxR;
        flattenedParams['max_z'] = maxZ;
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
    } else if (command === "INIT_FSI_3D") {
        // 1. Serialize 3D CFD Solver part
        const solverNode3D = state.nodes.find(n => n.type === 'CFDSolver3D');
        if (solverNode3D) {
            Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    flattenedParams['stl_file'] = stlNode.parameters.stl_file || '';
                    flattenedParams['geometry_hash'] = stlNode.parameters.geometry_hash || '';
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                    flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                    const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                    let hash = 5381;
                    for (let i = 0; i < primsStr.length; i++) {
                        hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                        hash = hash & hash;
                    }
                    flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                }
            }
            const meshConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'mesh');
            if (meshConn3D) {
                const rootDomainNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'air');
            if (airConn3D) {
                const airNode3D = state.nodes.find(n => n.id === airConn3D.fromNode);
                if (airNode3D && airNode3D.type === 'Material' && airNode3D.parameters?.material_type === 'Air') {
                    ['atm_pressure', 'atm_temperature', 'gamma'].forEach(key => {
                        if (airNode3D.parameters[key] !== undefined) {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(airNode3D.parameters[key]) : airNode3D.parameters[key];
                        }
                    });
                }
            }
            const chargeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge');
            if (chargeConn3D) {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (chargeNode3D) {
                    Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const matConn = state.connections.find(c => c.toNode === chargeNode3D.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType === 'JWL Charge') {
                                flattenedParams['explosive_type'] = 'MaterialExplosive';
                                ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].forEach(key => {
                                    if (matNode.parameters[key] !== undefined) {
                                        flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                    }
                                });
                            } else if (matType === 'Ideal Gas Charge') {
                                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                                flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            }
                        }
                    }
                }
            }
            const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'detonator');
            if (detConn3D) {
                const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
                if (detNode3D && detNode3D.type === 'DetonatorLocation3D') {
                    Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                }
            }
        }

        // 2. Serialize 3D MPM Domain part
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain3D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const meshConn = state.connections.find(c => c.toNode === mpmDomain.id && c.toPort === 'mesh');
            if (meshConn) {
                const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (meshNode) {
                    Object.entries(meshNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 8);
            flattenedParams['ppc'] = domainPpc;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject3D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
                    if (stlConn) {
                        const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            objParams['stl_file'] = stlNode.parameters.stl_file || '';
                            objParams['shape_type'] = 'STL';
                        }
                    }
                    const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            Object.entries(matNode.parameters).forEach(([k, v]) => {
                                objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                            });
                        }
                    }
                    if (objParams['ppc'] === undefined) {
                        objParams['ppc'] = domainPpc;
                    }
                    mpmObjects.push(objParams);
                }
            }
            flattenedParams['mpm_objects'] = mpmObjects;
        }

        // 3. Serialize FSICoupler3D parameters
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler3D');
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const telemetryConns = state.connections.filter(c => c.fromNode === couplerNode.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                    // Trace file output options and other view options
                    Object.entries(viewNode.parameters).forEach(([key, value]) => {
                        if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }

            // Trace VTKOutput connected to FSICoupler3D
            const vtkConns = state.connections.filter(c => c.fromNode === couplerNode.id || c.toNode === couplerNode.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === couplerNode.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }

        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : 0.0;
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : 1.0;
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : 0.0;
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : 1.0;
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : 0.0;
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : 1.0;
        flattenedParams['nx'] = Math.round((xmax - xmin) / cellSize);
        flattenedParams['ny'] = Math.round((ymax - ymin) / cellSize);
        flattenedParams['nz'] = Math.round((zmax - zmin) / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;

        const hasChargeConn3D = solverNode3D ? Boolean(state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge')) : false;
        if (!hasChargeConn3D || flattenedParams['init_mode'] === 'Ideal Gas' || flattenedParams['explosive_type'] === 'MaterialIdealGas') {
            flattenedParams['init_mode'] = 'Ideal Gas';
            flattenedParams['is_ideal_gas'] = true;
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // Re-apply CFD solver's device/precision parameters to ensure they take precedence
        if (solverNode3D) {
            if (solverNode3D.parameters.device !== undefined) {
                flattenedParams['device'] = solverNode3D.parameters.device;
            }
            if (solverNode3D.parameters.precision !== undefined) {
                flattenedParams['precision'] = solverNode3D.parameters.precision;
            }
        }
    } else if (command === "INIT_FEM_FSI_3D") {
        // 1. Serialize 3D CFD Solver part
        const solverNode3D = state.nodes.find(n => n.type === 'CFDSolver3D');
        if (solverNode3D) {
            Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    flattenedParams['stl_file'] = stlNode.parameters.stl_file || '';
                    flattenedParams['geometry_hash'] = stlNode.parameters.geometry_hash || '';
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                    flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                    const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                    let hash = 5381;
                    for (let i = 0; i < primsStr.length; i++) {
                        hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                        hash = hash & hash;
                    }
                    flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                }
            }
            const meshConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'mesh');
            if (meshConn3D) {
                const rootDomainNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'air');
            if (airConn3D) {
                const airNode3D = state.nodes.find(n => n.id === airConn3D.fromNode);
                if (airNode3D && airNode3D.type === 'Material' && airNode3D.parameters?.material_type === 'Air') {
                    ['atm_pressure', 'atm_temperature', 'gamma'].forEach(key => {
                        if (airNode3D.parameters[key] !== undefined) {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(airNode3D.parameters[key]) : airNode3D.parameters[key];
                        }
                    });
                }
            }
            const chargeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge');
            if (chargeConn3D) {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (chargeNode3D) {
                    Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const matConn = state.connections.find(c => c.toNode === chargeNode3D.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            const matType = matNode.parameters?.material_type || 'Air';
                            if (matType === 'JWL Charge') {
                                flattenedParams['explosive_type'] = 'MaterialExplosive';
                                ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].forEach(key => {
                                    if (matNode.parameters[key] !== undefined) {
                                        flattenedParams[key] = numericKeys.includes(key) ? Number(matNode.parameters[key]) : matNode.parameters[key];
                                    }
                                });
                            } else if (matType === 'Ideal Gas Charge') {
                                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                flattenedParams['gamma'] = Number(matNode.parameters?.ideal_gamma ?? 1.4);
                                flattenedParams['rho'] = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                flattenedParams['detonation_energy'] = Number(matNode.parameters?.ideal_e_0 ?? 4290000);
                            }
                        }
                    }
                }
            }
            const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'detonator');
            if (detConn3D) {
                const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
                if (detNode3D && detNode3D.type === 'DetonatorLocation3D') {
                    Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                }
            }
        }

        // 2. Serialize 3D FEM Domain part
        const femDomain = state.nodes.find(n => n.type === 'FEMDomain3D');
        if (femDomain) {
            Object.entries(femDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const femObjects: any[] = [];
            const processedNodeIds = new Set<string>();

            const processObjNode = (objNode: any) => {
                if (!objNode || objNode.type !== 'FEMObject3D' || processedNodeIds.has(objNode.id)) return;
                processedNodeIds.add(objNode.id);

                const objParams: any = {};
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                });
                const impConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'importer');
                if (impConn) {
                    const impNode = state.nodes.find(n => n.id === impConn.fromNode);
                    if (impNode && impNode.type === 'LSDynaImporter3D') {
                        objParams['k_file'] = impNode.parameters.k_file || '';
                        objParams['mesh_source'] = 'LS-DYNA Keyword File';
                        if (impNode.parameters.scale_factor !== undefined) {
                            objParams['scale_factor'] = Number(impNode.parameters.scale_factor);
                        }
                    }
                }
                const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode) {
                        Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                            objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                        });
                    }
                }
                const meshSrc = objParams['mesh_source'] || 'Box Generator';
                if (meshSrc === 'Cylinder Generator') {
                    objParams['shape_type'] = 'Cylinder';
                } else if (meshSrc === 'LS-DYNA Keyword File') {
                    objParams['shape_type'] = 'LS-DYNA File';
                } else {
                    objParams['shape_type'] = 'Box';
                }

                if (objParams['failure_strain'] === undefined) objParams['failure_strain'] = 0.20;
                if (objParams['tensile_failure_stress'] === undefined) objParams['tensile_failure_stress'] = 400.0e6;
                femObjects.push(objParams);
            };

            const objConns = state.connections.filter(c => c.toNode === femDomain.id && c.toPort === 'objects');
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                processObjNode(objNode);
            }

            state.nodes.filter(n => n.type === 'FEMObject3D').forEach(processObjNode);
            flattenedParams['fem_objects'] = femObjects;
        }

        // 3. Serialize FEMFSICoupler3D parameters
        const couplerNode = state.nodes.find(n => n.type === 'FEMFSICoupler3D');
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const telemetryConns = state.connections.filter(c => c.fromNode === couplerNode.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                    // Trace file output options and other view options
                    Object.entries(viewNode.parameters).forEach(([key, value]) => {
                        if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }

            // Trace VTKOutput connected to FEMFSICoupler3D
            const vtkConns = state.connections.filter(c => c.fromNode === couplerNode.id || c.toNode === couplerNode.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === couplerNode.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }

        // Fallback: if slices not found from direct telemetry connections, search any Telemetry3DViewport in the model
        if (!flattenedParams['slices']) {
            const vpNode = state.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (vpNode && vpNode.parameters?.slices) {
                flattenedParams['slices'] = vpNode.parameters.slices;
            }
        }

        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : (flattenedParams['x_min'] !== undefined ? flattenedParams['x_min'] : 0.0);
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : (flattenedParams['x_max'] !== undefined ? flattenedParams['x_max'] : 1.0);
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : (flattenedParams['y_min'] !== undefined ? flattenedParams['y_min'] : 0.0);
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : (flattenedParams['y_max'] !== undefined ? flattenedParams['y_max'] : 1.0);
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : (flattenedParams['z_min'] !== undefined ? flattenedParams['z_min'] : 0.0);
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : (flattenedParams['z_max'] !== undefined ? flattenedParams['z_max'] : 1.0);
        const dimX = xmax - xmin;
        const dimY = ymax - ymin;
        const dimZ = zmax - zmin;
        flattenedParams['nx'] = Math.round(dimX / cellSize);
        flattenedParams['ny'] = Math.round(dimY / cellSize);
        flattenedParams['nz'] = Math.round(dimZ / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;
        flattenedParams['xmax'] = xmax;
        flattenedParams['ymax'] = ymax;
        flattenedParams['zmax'] = zmax;
        flattenedParams['cell_size'] = cellSize;

        const hasChargeConn3D = solverNode3D ? Boolean(state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge')) : false;
        if (!hasChargeConn3D || flattenedParams['init_mode'] === 'Ideal Gas' || flattenedParams['explosive_type'] === 'MaterialIdealGas') {
            flattenedParams['init_mode'] = 'Ideal Gas';
            flattenedParams['is_ideal_gas'] = true;
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // 4. Ensure solver parameters from CFDSolver3D have precedence
        if (solverNode3D) {
            if (solverNode3D.parameters.device !== undefined) {
                flattenedParams['device'] = solverNode3D.parameters.device;
            }
            if (solverNode3D.parameters.precision !== undefined) {
                flattenedParams['precision'] = solverNode3D.parameters.precision;
            }
            if (solverNode3D.parameters.cfl !== undefined) {
                flattenedParams['cfl'] = Number(solverNode3D.parameters.cfl);
            }
        }
    } else if (command === "INIT_MPM" || command === "INIT_2D_MPM") {
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain2D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const meshConn = state.connections.find(c => c.toNode === mpmDomain.id && c.toPort === 'mesh');
            if (meshConn) {
                const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (meshNode) {
                    Object.entries(meshNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const cellSize = Number(meshNode.parameters?.cell_size ?? 0.005);
                    const maxR = Number(meshNode.parameters?.max_r ?? 1.0);
                    const maxZ = Number(meshNode.parameters?.max_z ?? 1.0);
                    flattenedParams['nr'] = Math.round(maxR / cellSize);
                    flattenedParams['nz'] = Math.round(maxZ / cellSize);
                    flattenedParams['max_r'] = maxR;
                    flattenedParams['max_z'] = maxZ;
                }
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 4);
            flattenedParams['ppc'] = domainPpc;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject2D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            Object.entries(matNode.parameters).forEach(([k, v]) => {
                                objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                            });
                        }
                    }
                    if (objParams['ppc'] === undefined) {
                        objParams['ppc'] = domainPpc;
                    }
                    mpmObjects.push(objParams);
                }
            }
            flattenedParams['mpm_objects'] = mpmObjects;
        }
    } else if (command === "INIT_MPM_3D" || command === "INIT_3D_MPM") {
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain3D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const meshConn = state.connections.find(c => c.toNode === mpmDomain.id && c.toPort === 'mesh');
            if (meshConn) {
                const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (meshNode) {
                    Object.entries(meshNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
                    const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
                    const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
                    const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
                    const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
                    const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
                    const zmax = Number(meshNode.parameters?.zmax ?? 1.0);
                    flattenedParams['nx'] = Math.round((xmax - xmin) / cellSize);
                    flattenedParams['ny'] = Math.round((ymax - ymin) / cellSize);
                    flattenedParams['nz'] = Math.round((zmax - zmin) / cellSize);
                }
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 8);
            flattenedParams['ppc'] = domainPpc;
            if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject3D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
                    if (stlConn) {
                        const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            objParams['stl_file'] = stlNode.parameters.stl_file || '';
                            objParams['shape_type'] = 'STL';
                        }
                    }
                    const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                    if (matConn) {
                        const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                        if (matNode) {
                            Object.entries(matNode.parameters).forEach(([k, v]) => {
                                objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                            });
                        }
                    }
                    if (objParams['ppc'] === undefined) {
                        objParams['ppc'] = domainPpc;
                    }
                    mpmObjects.push(objParams);
                }
            }
            flattenedParams['mpm_objects'] = mpmObjects;

            // Trace VTKOutput connected to MPMDomain3D
            const vtkConns = state.connections.filter(c => c.fromNode === mpmDomain.id || c.toNode === mpmDomain.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === mpmDomain.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }
    } else if (command === "INIT_FEM_3D" || command === "INIT_3D_FEM") {
        const femDomain = state.nodes.find(n => n.type === 'FEMDomain3D');
        if (femDomain) {
            Object.entries(femDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const femObjects: any[] = [];
            const processedNodeIds = new Set<string>();

            const processObjNode = (objNode: any) => {
                if (!objNode || objNode.type !== 'FEMObject3D' || processedNodeIds.has(objNode.id)) return;
                processedNodeIds.add(objNode.id);

                const objParams: any = {};
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                });
                const impConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'importer');
                if (impConn) {
                    const impNode = state.nodes.find(n => n.id === impConn.fromNode);
                    if (impNode && impNode.type === 'LSDynaImporter3D') {
                        objParams['k_file'] = impNode.parameters.k_file || '';
                        objParams['mesh_source'] = 'LS-DYNA Keyword File';
                        if (impNode.parameters.scale_factor !== undefined) {
                            objParams['scale_factor'] = Number(impNode.parameters.scale_factor);
                        }
                    }
                }
                const matConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'material');
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode) {
                        Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                            objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                        });
                    }
                }
                const meshSrc = objParams['mesh_source'] || 'Box Generator';
                if (meshSrc === 'Cylinder Generator') {
                    objParams['shape_type'] = 'Cylinder';
                } else if (meshSrc === 'LS-DYNA Keyword File') {
                    objParams['shape_type'] = 'LS-DYNA File';
                } else {
                    objParams['shape_type'] = 'Box';
                }

                if (objParams['failure_strain'] === undefined) objParams['failure_strain'] = 0.20;
                if (objParams['tensile_failure_stress'] === undefined) objParams['tensile_failure_stress'] = 400.0e6;
                femObjects.push(objParams);
            };

            const objConns = state.connections.filter(c => c.toNode === femDomain.id && c.toPort === 'objects');
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                processObjNode(objNode);
            }

            state.nodes.filter(n => n.type === 'FEMObject3D').forEach(processObjNode);

            flattenedParams['fem_objects'] = femObjects;

            // Trace VTKOutput connected to FEMDomain3D
            const vtkConns = state.connections.filter(c => c.fromNode === femDomain.id || c.toNode === femDomain.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === femDomain.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }
    } else if (command === "INIT_3D") {
        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : (flattenedParams['x_min'] !== undefined ? flattenedParams['x_min'] : 0.0);
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : (flattenedParams['x_max'] !== undefined ? flattenedParams['x_max'] : 1.0);
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : (flattenedParams['y_min'] !== undefined ? flattenedParams['y_min'] : 0.0);
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : (flattenedParams['y_max'] !== undefined ? flattenedParams['y_max'] : 1.0);
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : (flattenedParams['z_min'] !== undefined ? flattenedParams['z_min'] : 0.0);
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : (flattenedParams['z_max'] !== undefined ? flattenedParams['z_max'] : 1.0);
        const dimX = xmax - xmin;
        const dimY = ymax - ymin;
        const dimZ = zmax - zmin;

        flattenedParams['nx'] = Math.round(dimX / cellSize);
        flattenedParams['ny'] = Math.round(dimY / cellSize);
        flattenedParams['nz'] = Math.round(dimZ / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;

        const centerX = xmin + dimX * 0.5;
        const centerY = ymin + dimY * 0.5;
        const centerZ = zmin + dimZ * 0.5;
        if (flattenedParams['charge_x'] === undefined) flattenedParams['charge_x'] = centerX;
        if (flattenedParams['charge_y'] === undefined) flattenedParams['charge_y'] = centerY;
        if (flattenedParams['charge_z'] === undefined) flattenedParams['charge_z'] = centerZ;

        const mass3D = flattenedParams['charge_mass'] !== undefined ? Number(flattenedParams['charge_mass']) : 0.0;
        const rho3D = flattenedParams['rho'] || 1630.0;
        if (mass3D > 0) {
            if (flattenedParams['charge_shape'] === 'Cylinder') {
                const ar = flattenedParams['charge_aspect_ratio'] || (flattenedParams['charge_height'] && flattenedParams['charge_radius'] ? flattenedParams['charge_height'] / (2.0 * flattenedParams['charge_radius']) : 1.0);
                if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                    flattenedParams['charge_radius'] = Math.cbrt(mass3D / (2.0 * Math.PI * rho3D * ar));
                }
                flattenedParams['charge_height'] = 2.0 * flattenedParams['charge_radius'] * ar;
                flattenedParams['charge_aspect_ratio'] = ar;
            } else if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                flattenedParams['charge_radius'] = Math.pow((3.0 * mass3D) / (4.0 * Math.PI * rho3D), 1.0 / 3.0);
            }
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // Check if there is a Material node connected locally in the 3D model
        const localMatNode = state.nodes.find(n => n.type === 'Material');
        if (localMatNode && localMatNode.parameters) {
            const localMatType = localMatNode.parameters.material_type || 'JWL Charge';
            if (localMatType === 'Ideal Gas Charge' || localMatType === 'Ideal Gas') {
                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                flattenedParams['material_type'] = 'Ideal Gas Charge';
                flattenedParams['is_ideal_gas'] = true;
                flattenedParams['gamma'] = Number(localMatNode.parameters.ideal_gamma ?? 1.4);
                flattenedParams['rho'] = Number(localMatNode.parameters.ideal_rho_0 ?? 1630.0);
                flattenedParams['detonation_energy'] = Number(localMatNode.parameters.ideal_e_0 ?? 4290000);
            }
        }

        const remapConn3D = solverNode3D ? state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap') : null;
        const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : null;
        if (remapNode3D) {
            // Find incoming connection to remap node (workspace-wide search across models & pipes)
            const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
            const allModels: SimulationState[] = globalSM ? globalSM.getAllModels() : [state];
            const allNodes: any[] = allModels.flatMap(m => m.nodes);
            const allConns: any[] = allModels.flatMap(m => m.connections);

            let remapInConn = allConns.find(c => c.toNode === remapNode3D.id);
            let sourceSolverNode = remapInConn ? allNodes.find(n => n.id === remapInConn.fromNode) : null;

            // If not found in standard connections, check model pipes
            if (!sourceSolverNode && globalSM && globalSM.getAllPipes) {
                const pipes = globalSM.getAllPipes();
                const pipe = pipes.find((p: any) => p.targetModelId === modelId || p.toNodeId === remapNode3D.id);
                if (pipe) {
                    const sourceModel = allModels.find(m => ((m as any).id || (m as any).modelId) === (pipe.sourceModelId || pipe.model2dId || pipe.model1dId));
                    if (sourceModel) {
                        sourceSolverNode = sourceModel.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
                    }
                }
            }

            // Fallback: search all models for any 2D / 1D solver node connected upstream
            if (!sourceSolverNode) {
                sourceSolverNode = allNodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
            }

            let sourceChargeNode: any = null;
            let sourceMatNode: any = null;
            if (sourceSolverNode) {
                const chargeConn = allConns.find(c => c.toNode === sourceSolverNode.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
                sourceChargeNode = chargeConn ? allNodes.find(n => n.id === chargeConn.fromNode) : null;
                if (!sourceChargeNode) {
                    const sourceModel = allModels.find(m => m.nodes.some(n => n.id === sourceSolverNode.id));
                    sourceChargeNode = sourceModel?.nodes.find(n => n.type === 'Charge2D' || n.type === 'Charge1D');
                }

                if (sourceChargeNode) {
                    const matConn = allConns.find(c => c.toNode === sourceChargeNode.id && c.toPort === 'material');
                    sourceMatNode = matConn ? allNodes.find(n => n.id === matConn.fromNode) : null;
                    if (!sourceMatNode) {
                        const sourceModel = allModels.find(m => m.nodes.some(n => n.id === sourceChargeNode.id));
                        sourceMatNode = sourceModel?.nodes.find(n => n.type === 'Material');
                    }
                }
            }

            // Copy over charge parameters from source charge node if present
            if (sourceChargeNode && sourceChargeNode.parameters) {
                Object.entries(sourceChargeNode.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }

            // Copy over material parameters from source material node if present
            if (sourceMatNode && sourceMatNode.parameters) {
                const matType = sourceMatNode.parameters.material_type || 'JWL Charge';
                if (matType === 'Ideal Gas Charge' || matType === 'Ideal Gas') {
                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                    flattenedParams['material_type'] = 'Ideal Gas Charge';
                    flattenedParams['is_ideal_gas'] = true;
                    flattenedParams['gamma'] = Number(sourceMatNode.parameters.ideal_gamma ?? 1.4);
                    flattenedParams['rho'] = Number(sourceMatNode.parameters.ideal_rho_0 ?? 1630.0);
                    flattenedParams['detonation_energy'] = Number(sourceMatNode.parameters.ideal_e_0 ?? 4290000);
                    if (sourceMatNode.parameters.composition !== undefined) {
                        flattenedParams['composition'] = sourceMatNode.parameters.composition;
                    }
                } else if (matType === 'JWL Charge') {
                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                    flattenedParams['material_type'] = 'JWL Charge';
                    flattenedParams['is_ideal_gas'] = false;
                    const jwlKeys = ['composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                    jwlKeys.forEach(key => {
                        if (sourceMatNode.parameters[key] !== undefined) {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(sourceMatNode.parameters[key]) : sourceMatNode.parameters[key];
                        }
                    });
                }
            }

            // Also check source solver parameters as fallback
            const sourceInitMode = sourceSolverNode?.parameters?.init_mode;
            const sourceExpType = sourceSolverNode?.parameters?.explosive_type;
            const isIdealGasSource = (
                sourceInitMode === 'Ideal Gas' ||
                sourceExpType === 'MaterialIdealGas' ||
                flattenedParams['explosive_type'] === 'MaterialIdealGas' ||
                flattenedParams['material_type'] === 'Ideal Gas Charge'
            );

            if (isIdealGasSource) {
                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                flattenedParams['material_type'] = 'Ideal Gas Charge';
                flattenedParams['is_ideal_gas'] = true;
            } else {
                if (!flattenedParams['explosive_type']) flattenedParams['explosive_type'] = 'MaterialExplosive';
            }

            if (remapNode3D.type === 'Remap2DTo3DNode') {
                flattenedParams['init_mode'] = 'From2D';
            } else {
                flattenedParams['init_mode'] = 'From1D';
            }
        } else if (!flattenedParams['init_mode'] || flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D') {
            if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'Multi-Material JWL';
            }
        }
        if (!flattenedParams['flux_scheme']) flattenedParams['flux_scheme'] = 'AUSM+';
        if (flattenedParams['spatial_order'] === undefined) flattenedParams['spatial_order'] = 2;
        if (flattenedParams['temporal_order'] === undefined) flattenedParams['temporal_order'] = 4;
        if (!flattenedParams['precision']) flattenedParams['precision'] = 'single';
    }

    return JSON.stringify({
        command: command,
        modelId: modelId,
        model_filename: modelFilename || null,
        ...flattenedParams,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        connections: state.connections
    });
}

export function serializeToBinary(state: SimulationState): ArrayBuffer {
    const jsonString = JSON.stringify(state);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonString);
    
    const buffer = new ArrayBuffer(4 + 1 + 1 + 4 + jsonBytes.length + 4);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    
    // Magic: 'BLST'
    view.setUint8(0, 0x42); // B
    view.setUint8(1, 0x4c); // L
    view.setUint8(2, 0x53); // S
    view.setUint8(3, 0x54); // T
    
    // Version: 1
    view.setUint8(4, 1);
    
    // Flags: 0
    view.setUint8(5, 0);
    
    // JSON Length (Big Endian)
    view.setUint32(6, jsonBytes.length, false);
    
    // JSON Bytes
    uint8.set(jsonBytes, 10);
    
    // Simple sum checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    view.setUint32(10 + jsonBytes.length, checksum, false);
    
    return buffer;
}

export function deserializeFromBinary(buffer: ArrayBuffer): SimulationState {
    const view = new DataView(buffer);
    if (buffer.byteLength < 14) {
        throw new Error("Invalid model: buffer too short");
    }
    
    // Verify Magic
    const m0 = view.getUint8(0);
    const m1 = view.getUint8(1);
    const m2 = view.getUint8(2);
    const m3 = view.getUint8(3);
    if (m0 !== 0x42 || m1 !== 0x4c || m2 !== 0x53 || m3 !== 0x54) {
        throw new Error("Invalid model: missing magic header");
    }
    
    const version = view.getUint8(4);
    if (version !== 1) {
        throw new Error(`Unsupported model version: ${version}`);
    }
    
    const jsonLength = view.getUint32(6, false);
    if (buffer.byteLength < 10 + jsonLength + 4) {
        throw new Error("Invalid model: payload truncated");
    }
    
    const uint8 = new Uint8Array(buffer);
    const jsonBytes = uint8.subarray(10, 10 + jsonLength);
    
    // Verify checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    const savedChecksum = view.getUint32(10 + jsonLength, false);
    if (checksum !== savedChecksum) {
        throw new Error("Invalid model: checksum mismatch");
    }
    
    const decoder = new TextDecoder();
    const jsonString = decoder.decode(jsonBytes);
    return JSON.parse(jsonString) as SimulationState;
}
