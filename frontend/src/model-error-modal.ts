import { StateManager } from './state-manager.js';

/**
 * Returns a concise tooltip string for an ERROR status badge.
 */
export function getErrorBadgeTooltip(stateManager: StateManager, modelIds: string[]): string {
    for (const id of modelIds) {
        const latest = stateManager.getLatestModelError(id);
        if (latest) {
            return `[${latest.errorCode}] ${latest.summary} — Click for diagnosis & fix steps`;
        }
    }
    return 'Solver reported an error — Click for diagnosis & fix steps';
}

/**
 * Opens a structured diagnostic modal displaying:
 * 1. Error Code
 * 2. Single-line summary
 * 3. Detailed multiline root-cause & model fix instructions
 * 4. Raw technical context (message, step, scope, timestamp)
 */
export function showModelErrorModal(stateManager: StateManager, modelIds: string[]): void {
    document.querySelectorAll('.model-error-modal-backdrop').forEach(el => el.remove());

    const allModels = stateManager.getAllModels();
    const targetIds = modelIds.filter(id => stateManager.getModelStatus(id) === 'ERROR' || stateManager.getModelErrors(id).length > 0);
    const effectiveIds = targetIds.length > 0 ? targetIds : modelIds;

    const backdrop = document.createElement('div');
    backdrop.className = 'model-error-modal-backdrop';
    backdrop.style.cssText = [
        'position: fixed',
        'inset: 0',
        'background: rgba(2, 6, 23, 0.74)',
        'backdrop-filter: blur(5px)',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'z-index: 10000',
        'padding: 16px'
    ].join(';');

    const dialog = document.createElement('div');
    dialog.style.cssText = [
        'width: min(700px, 100%)',
        'max-height: 85vh',
        'display: flex',
        'flex-direction: column',
        'background: #0f172a',
        'border: 1px solid rgba(248, 113, 113, 0.5)',
        'border-radius: 10px',
        'box-shadow: 0 24px 64px rgba(0, 0, 0, 0.8), 0 0 28px rgba(239, 68, 68, 0.18)',
        'color: #e2e8f0',
        'font-family: system-ui, -apple-system, sans-serif',
        'overflow: hidden'
    ].join(';');

    // Header
    const header = document.createElement('div');
    header.style.cssText = [
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'padding: 12px 16px',
        'background: rgba(239, 68, 68, 0.14)',
        'border-bottom: 1px solid rgba(248, 113, 113, 0.3)'
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: #fca5a5;';
    title.textContent = '⚠ Solver Error Diagnostics';
    header.appendChild(title);

    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    closeX.title = 'Close';
    closeX.style.cssText = [
        'background: transparent',
        'border: 1px solid rgba(255, 255, 255, 0.15)',
        'border-radius: 4px',
        'color: #cbd5e1',
        'cursor: pointer',
        'padding: 2px 8px',
        'font-size: 12px'
    ].join(';');
    header.appendChild(closeX);
    dialog.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.style.cssText = 'padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 12px;';

    const plainTextParts: string[] = [];

    effectiveIds.forEach(modelId => {
        const model = allModels.find(m => m.id === modelId);
        const modelName = model?.name || modelId;
        const errors = stateManager.getModelErrors(modelId);
        const status = stateManager.getModelStatus(modelId);

        const section = document.createElement('div');
        section.style.cssText = [
            'background: rgba(15, 23, 42, 0.85)',
            'border: 1px solid rgba(255, 255, 255, 0.1)',
            'border-radius: 8px',
            'padding: 12px',
            'display: flex',
            'flex-direction: column',
            'gap: 10px'
        ].join(';');

        const secHeader = document.createElement('div');
        secHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px;';

        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-weight: 700; color: #f8fafc; font-size: 13px;';
        nameEl.textContent = `${modelName}`;
        secHeader.appendChild(nameEl);

        const idEl = document.createElement('span');
        idEl.style.cssText = 'font-family: monospace; font-size: 10.5px; color: #94a3b8;';
        idEl.textContent = `${modelId} • ${status}`;
        secHeader.appendChild(idEl);
        section.appendChild(secHeader);

        if (errors.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'color: #cbd5e1; line-height: 1.55; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(248, 113, 113, 0.25); border-radius: 6px; padding: 10px 12px;';
            emptyMsg.innerHTML =
                '<div style="font-family:monospace;font-size:10.5px;color:#fca5a5;font-weight:700;margin-bottom:4px;">ERR_UNSPECIFIED_STATE</div>' +
                '<div style="font-weight:600;color:#f8fafc;margin-bottom:6px;">Model is in ERROR state without a captured log message.</div>' +
                '<div style="color:#cbd5e1;font-size:11.5px;">Check the solver console / TelemetryText log for details, or click "Reset Error State" and re-initialize the model.</div>';
            section.appendChild(emptyMsg);
            plainTextParts.push(`[${modelName} (${modelId})] ERR_UNSPECIFIED_STATE: No structured error message captured.`);
        } else {
            const ordered = [...errors].reverse();
            ordered.forEach((err, idx) => {
                const isLatest = idx === 0;
                const card = document.createElement('div');
                card.style.cssText = [
                    `background: ${isLatest ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255, 255, 255, 0.03)'}`,
                    `border: 1px solid ${isLatest ? 'rgba(248, 113, 113, 0.42)' : 'rgba(255, 255, 255, 0.08)'}`,
                    'border-radius: 7px',
                    'padding: 10px 12px',
                    'display: flex',
                    'flex-direction: column',
                    'gap: 8px'
                ].join(';');

                // Top row: Error Code badge + Metadata
                const topRow = document.createElement('div');
                topRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;';

                const codeBadge = document.createElement('span');
                codeBadge.style.cssText = [
                    'font-family: var(--font-mono, monospace)',
                    'font-size: 10.5px',
                    'font-weight: 700',
                    'color: #fecaca',
                    'background: rgba(239, 68, 68, 0.25)',
                    'border: 1px solid rgba(248, 113, 113, 0.5)',
                    'border-radius: 4px',
                    'padding: 2px 7px'
                ].join(';');
                codeBadge.textContent = err.errorCode || 'ERR_SOLVER_RUNTIME';
                topRow.appendChild(codeBadge);

                const meta = document.createElement('div');
                meta.style.cssText = 'font-size: 10px; color: #94a3b8; font-family: monospace;';
                const timeStr = new Date(err.timestamp).toLocaleTimeString();
                const isRootCause = err === stateManager.getLatestModelError(modelId);
                const metaBits = [isRootCause ? 'ROOT CAUSE' : (isLatest ? 'LATEST' : `#${ordered.length - idx}`), timeStr];
                if (err.step !== undefined) metaBits.push(`Step ${err.step}`);
                if (err.scope) metaBits.push(`Scope: ${err.scope}`);
                meta.textContent = metaBits.join(' • ');
                topRow.appendChild(meta);
                card.appendChild(topRow);

                // Failure Snapshot bar
                const snapItems: Array<[string, string]> = [];
                if (err.step !== undefined) snapItems.push(['Step', String(err.step)]);
                if (err.simTime !== undefined && Number.isFinite(err.simTime)) {
                    snapItems.push(['Sim Time', `${(err.simTime * 1e6).toFixed(2)} µs (${err.simTime.toExponential(3)} s)`]);
                }
                if (err.dt !== undefined && Number.isFinite(err.dt) && err.dt > 0) {
                    snapItems.push(['dt', `${(err.dt * 1e6).toFixed(3)} µs`]);
                }
                if (err.device || err.precision) {
                    snapItems.push(['Device', `${err.device || '?'} (${err.precision || '?'})`]);
                }
                if (err.kernelPhase) {
                    snapItems.push(['Kernel / Phase', err.kernelPhase]);
                }
                if (err.signal !== undefined && err.signal > 0) {
                    snapItems.push(['Signal', `SIG ${err.signal}`]);
                } else if (err.exitCode !== undefined && err.exitCode >= 0) {
                    snapItems.push(['Exit Code', String(err.exitCode)]);
                }
                if (snapItems.length > 0) {
                    const snapBar = document.createElement('div');
                    snapBar.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 6px 9px; background: rgba(2, 6, 23, 0.55); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 5px; font-size: 11px;';
                    snapItems.forEach(([k, v]) => {
                        const pill = document.createElement('span');
                        pill.style.cssText = 'font-family: var(--font-mono, monospace); color: #cbd5e1;';
                        pill.innerHTML = `<span style="color:#94a3b8;">${k}:</span> <strong style="color:#f8fafc;">${v}</strong>`;
                        snapBar.appendChild(pill);
                    });
                    card.appendChild(snapBar);
                }

                // Single-line summary
                const summaryEl = document.createElement('div');
                summaryEl.style.cssText = 'font-size: 13px; font-weight: 700; color: #f8fafc; line-height: 1.35;';
                summaryEl.textContent = err.summary;
                card.appendChild(summaryEl);

                // Detailed multiline diagnosis & fix guide
                const detailsEl = document.createElement('pre');
                detailsEl.style.cssText = [
                    'margin: 0',
                    'white-space: pre-wrap',
                    'word-break: break-word',
                    'font-family: system-ui, -apple-system, sans-serif',
                    'font-size: 11.5px',
                    'line-height: 1.55',
                    'color: #cbd5e1',
                    'background: rgba(2, 6, 23, 0.38)',
                    'border: 1px solid rgba(255, 255, 255, 0.07)',
                    'border-radius: 6px',
                    'padding: 8px 10px',
                    'user-select: text'
                ].join(';');
                detailsEl.textContent = err.details;
                card.appendChild(detailsEl);

                // Raw technical context
                const rawWrap = document.createElement('div');
                rawWrap.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';

                const rawLabel = document.createElement('div');
                rawLabel.style.cssText = 'font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #94a3b8;';
                rawLabel.textContent = 'Technical Output';
                rawWrap.appendChild(rawLabel);

                const rawMsg = document.createElement('pre');
                rawMsg.style.cssText = [
                    'margin: 0',
                    'white-space: pre-wrap',
                    'word-break: break-word',
                    'font-family: var(--font-mono, monospace)',
                    'font-size: 10.5px',
                    'line-height: 1.4',
                    'color: #fca5a5',
                    'background: rgba(0, 0, 0, 0.3)',
                    'border-radius: 4px',
                    'padding: 6px 8px',
                    'user-select: text'
                ].join(';');
                rawMsg.textContent = err.message;
                rawWrap.appendChild(rawMsg);
                card.appendChild(rawWrap);

                section.appendChild(card);
                plainTextParts.push(
                    `[${modelName} | ${err.errorCode} | ${metaBits.join(' | ')}]\n` +
                    `${err.summary}\n\n${err.details}\n\nTechnical Output:\n${err.message}`
                );
            });
        }

        body.appendChild(section);
    });

    dialog.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = [
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'gap: 8px',
        'padding: 10px 16px',
        'background: rgba(2, 6, 23, 0.45)',
        'border-top: 1px solid rgba(255, 255, 255, 0.08)'
    ].join(';');

    const leftActions = document.createElement('div');
    leftActions.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy Details';
    copyBtn.style.cssText = [
        'background: rgba(255, 255, 255, 0.07)',
        'border: 1px solid rgba(255, 255, 255, 0.16)',
        'border-radius: 5px',
        'color: #e2e8f0',
        'cursor: pointer',
        'padding: 5px 10px',
        'font-size: 11px',
        'font-weight: 600'
    ].join(';');
    copyBtn.onclick = () => {
        navigator.clipboard?.writeText(plainTextParts.join('\n\n')).then(() => {
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => { copyBtn.textContent = '📋 Copy Details'; }, 1500);
        }).catch(() => {});
    };
    leftActions.appendChild(copyBtn);

    const solverTypes = new Set(['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'MarineHarbourDomain', 'MPMDomain3D', 'MPMDomain2D', 'FEMDomain3D']);
    const latestErrors = effectiveIds.map(id => stateManager.getLatestModelError(id)).filter((e): e is NonNullable<typeof e> => !!e);
    const hasGpuError = latestErrors.some(e => e.errorCode === 'ERR_CUDA_ILLEGAL_ACCESS' || e.errorCode === 'ERR_CUDA_OOM' || e.device === 'cuda');
    const hasStabilityOrGpuError = latestErrors.some(e => e.errorCode === 'ERR_NUMERICAL_INSTABILITY' || e.errorCode === 'ERR_CUDA_ILLEGAL_ACCESS');

    const canSwitchCpu = hasGpuError || effectiveIds.some(id => {
        const m = allModels.find(mm => mm.id === id);
        return (m?.nodes || []).some(n => solverTypes.has(n.type) && n.parameters?.device === 'cuda');
    });
    if (canSwitchCpu) {
        const cpuBtn = document.createElement('button');
        cpuBtn.textContent = '🖥️ Switch Device to CPU & Reset';
        cpuBtn.title = 'Set solver device to CPU on affected model(s), clear errors, and reset to UNINITIALIZED';
        cpuBtn.style.cssText = [
            'background: rgba(251, 191, 36, 0.16)',
            'border: 1px solid rgba(251, 191, 36, 0.45)',
            'border-radius: 5px',
            'color: #fde68a',
            'cursor: pointer',
            'padding: 5px 10px',
            'font-size: 11px',
            'font-weight: 600'
        ].join(';');
        cpuBtn.onclick = () => {
            effectiveIds.forEach(id => {
                const m = allModels.find(mm => mm.id === id);
                (m?.nodes || []).forEach(n => {
                    if (solverTypes.has(n.type)) {
                        stateManager.updateNodeParameters(n.id, { device: 'cpu' });
                    }
                });
                stateManager.clearModelErrors(id);
                stateManager.setModelStatus(id, 'UNINITIALIZED');
            });
            cleanup();
        };
        leftActions.appendChild(cpuBtn);
    }

    if (hasStabilityOrGpuError) {
        const cflBtn = document.createElement('button');
        cflBtn.textContent = '⚡ Halve CFL & Reset';
        cflBtn.title = 'Halve the solver CFL number on affected model(s), clear errors, and reset to UNINITIALIZED';
        cflBtn.style.cssText = [
            'background: rgba(168, 85, 247, 0.16)',
            'border: 1px solid rgba(192, 132, 252, 0.45)',
            'border-radius: 5px',
            'color: #e9d5ff',
            'cursor: pointer',
            'padding: 5px 10px',
            'font-size: 11px',
            'font-weight: 600'
        ].join(';');
        cflBtn.onclick = () => {
            effectiveIds.forEach(id => {
                const m = allModels.find(mm => mm.id === id);
                (m?.nodes || []).forEach(n => {
                    if (solverTypes.has(n.type) && typeof n.parameters?.cfl === 'number' && n.parameters.cfl > 0.05) {
                        const nextCfl = Math.max(0.05, Number((n.parameters.cfl * 0.5).toFixed(3)));
                        stateManager.updateNodeParameters(n.id, { cfl: nextCfl });
                    }
                });
                stateManager.clearModelErrors(id);
                stateManager.setModelStatus(id, 'UNINITIALIZED');
            });
            cleanup();
        };
        leftActions.appendChild(cflBtn);
    }

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺ Reset Error State';
    resetBtn.title = 'Clear error state and reset model(s) to UNINITIALIZED';
    resetBtn.style.cssText = [
        'background: rgba(56, 189, 248, 0.15)',
        'border: 1px solid rgba(56, 189, 248, 0.4)',
        'border-radius: 5px',
        'color: #7dd3fc',
        'cursor: pointer',
        'padding: 5px 10px',
        'font-size: 11px',
        'font-weight: 600'
    ].join(';');
    resetBtn.onclick = () => {
        effectiveIds.forEach(id => {
            stateManager.clearModelErrors(id);
            stateManager.setModelStatus(id, 'UNINITIALIZED');
        });
        cleanup();
    };
    leftActions.appendChild(resetBtn);
    footer.appendChild(leftActions);

    const okBtn = document.createElement('button');
    okBtn.textContent = 'Close';
    okBtn.style.cssText = [
        'background: rgba(239, 68, 68, 0.22)',
        'border: 1px solid rgba(248, 113, 113, 0.5)',
        'border-radius: 5px',
        'color: #fecaca',
        'cursor: pointer',
        'padding: 5px 14px',
        'font-size: 11px',
        'font-weight: 600'
    ].join(';');
    footer.appendChild(okBtn);
    dialog.appendChild(footer);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') cleanup();
    };
    const cleanup = () => {
        window.removeEventListener('keydown', onKeyDown);
        backdrop.remove();
    };

    closeX.onclick = cleanup;
    okBtn.onclick = cleanup;
    backdrop.onclick = (e) => {
        if (e.target === backdrop) cleanup();
    };
    window.addEventListener('keydown', onKeyDown);
}
