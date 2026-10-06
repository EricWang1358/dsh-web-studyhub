import { pumpSlots } from '../../../jobs/scheduler.js';

/** The host's transcription gate follows the learner's "transcription concurrency" (shared by every library of the host). */
export function applyTranscribeLimit(gate, limit) { gate.limit = limit; pumpSlots(gate); }

/**
 * The 任务 console controls of a running audio import, for the pipeline to register its control with: the attempt shows that control's
 * settings (everything but pause, which is the kernel's), applies a patch to it, and remembers its values for the next checkpoint.
 * `saved` is what a resumed attempt puts back; `remember(values)` is told the values in force.
 */
export function consoleControls(context, work, { view, saved = {}, remember = () => {} }) {
  return { outputs: work.jobOutputs,
    setTranscribeLimit: limit => applyTranscribeLimit(work.audioGate, limit),
    register(_job, control) {
      if (Object.keys(saved).length) control.patch(saved);
      const keep = () => remember(Object.fromEntries(Object.entries(control.values).filter(([key]) => key !== 'paused')));
      keep();
      context.controls({
        settings: () => Object.entries(control.spec).filter(([key]) => key !== 'paused').map(([key, rule]) => ({ key, ...rule, value: control.values[key] })),
        patch: patch => { const result = control.patch(patch); keep(); return result; },
        close: () => { control.close(); work.jobOutputs.endJob(view.id); },
      });
    },
  };
}
