import { observeLocalWith } from '../local-process-job.js';

/** The Job of one install (docs/plans/unified-job-runtime/s5-3-marker-install.md), whichever tool. The stages, the sentinel and the folder ownership are the
 * install engine's (lib/tool-install.js): `binding.installer` runs them, this definition only admits, observes and presents. The learner starts it in Settings
 * (the assistant cannot, lib/assistant-boundary.js); the Job offers no retry, pause or recovery, so the console cannot start an install again either: a second
 * install is a second, confirmed start. `config`: { kind, title, feature, error(code, message), messages, resolveFolder(folder), present(run) }. */
export function installDefinition({ kind, title, feature, error, messages, resolveFolder, present }) {
  return {
    kind, version: 1, title,
    capabilities: { cancel: true, retry: false },

    async admit(context, input, { installer }) {
      if (input.confirm !== true) throw error('need-confirm', messages.needConfirm);
      // The folder must still be one the installer may use (new, empty or carrying its own sentinel), whoever asked.
      const where = await resolveFolder(input.folder);
      if (where.problem || where.folder !== input.folder) throw error('folder-in-use', messages.folderInUse);
      const run = installer.claim(input, { signal: context.signal });
      context.present(present(run));
      return { state: run, finish: () => installer.release(run) };
    },

    async run(context, input, { installer, admitted }) {
      const run = context.admission.state;
      await installer.begin(input, run, observeLocalWith(context.gateway, 'install', feature));
      admitted?.();
      await run.promise;
      const { status, error: failure } = run.state;
      if (status === 'failed') throw Object.assign(new Error(failure.message), { code: failure.code });
      if (status === 'cancelled') throw context.signal.reason ?? new Error(failure.message);
      return { refs: [], completeness: 'complete' };
    },
  };
}
