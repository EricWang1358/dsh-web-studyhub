import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export { stageOfStep, observedByStage, outputByStage } from './stage-usage.js';

/* The estimate learns from this machine's own runs (#218, #772). A finished generation job records, per stage, what it used next to what its
   (uncalibrated) estimate said; the median ratio of the last runs is the stage's correction. One small file for the whole machine, beside the usage
   ledger and jev-usage.json (<DSH home>/study): a new library, or the second book of a course, is calibrated from the first run that finished, and a
   run made with one model is not corrected by another model's habits. Written atomically and queued like the ledger: numbers only, a damaged file
   starts afresh and a failed write never breaks a job. */

/** Where the machine keeps what its runs taught it: the same folder as the usage ledger (lib/audio-dashboard.js) and jev-usage.json. */
export const calibrationDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study');

const FILE = 'estimate-calibration.json';
const KEEP = 30, MIN_RUNS = 3, CLAMP = { min: 0.4, max: 4 };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The calibration of one folder (the machine's by default; a test or a caller may name another). */
export function createCalibration(root = calibrationDir(), { keep = KEEP } = {}) {
  const path = join(root, FILE);
  let queue = Promise.resolve();
  const load = async () => {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      return { runs: (Array.isArray(value?.runs) ? value.runs : []).filter((run) => run && typeof run.stages === 'object').slice(-keep) };
    } catch { return { runs: [] }; }
  };
  const turn = (work) => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  return {
    /** Add one finished run: its stage totals (estimate), the tokens it used per stage, and the model it ran on when the learner chose one
        (`control.values.model`: 'follow' or a model key). A run that used nothing teaches nothing. */
    record({ stageTotals, actual, outputs, model } = {}) {
      const stages = {};
      for (const [id, range] of Object.entries(stageTotals || {})) {
        const estimated = (Number(range?.low) + Number(range?.high)) / 2, used = Number(actual?.[id]);
        if (estimated > 0 && used > 0) stages[id] = [Math.round(estimated), Math.round(used)];
      }
      // What each stage WROTE per call, thinking included (#771): the estimate sizes output from sample cards, and a thinking model writes several times
      // what they say. Kept beside the ratio so the next estimate can say so.
      const written = Object.fromEntries(Object.entries(outputs || {}).filter(([, row]) => Number(row?.calls) > 0 && Number(row?.output) > 0)
        .map(([id, row]) => [id, [Number(row.calls), Number(row.output)]]));
      if (!Object.keys(stages).length && !Object.keys(written).length) return Promise.resolve();
      return turn(async () => {
        const state = await load();
        state.runs.push({ at: new Date().toISOString(), stages, ...(Object.keys(written).length ? { outputs: written } : {}), ...(model ? { model } : {}) });
        state.runs = state.runs.slice(-keep);
        await mkdir(root, { recursive: true });
        const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(state), 'utf8');
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      });
    },
    /** `{ stages: { plan: 1.3, ... }, samples, deviates }`: a stage needs three runs before it moves; a ratio is clamped to 0.4-4. With `model`, only that
        model's runs count (a run whose record predates the model field counts for any: it is the same learner's machine and the same pipeline). */
    async factors({ model } = {}) {
      await queue.catch(() => {});
      const loaded = await load(), runs = model ? loaded.runs.filter((run) => !run.model || run.model === model) : loaded.runs, byStage = new Map();
      for (const run of runs) for (const [id, [estimated, used]] of Object.entries(run.stages)) byStage.set(id, [...(byStage.get(id) || []), used / estimated]);
      const stages = Object.fromEntries([...byStage].filter(([, ratios]) => ratios.length >= MIN_RUNS)
        .map(([id, ratios]) => [id, Math.min(CLAMP.max, Math.max(CLAMP.min, median(ratios)))]));
      const whole = runs.map((run) => { const pairs = Object.values(run.stages); return pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.reduce((sum, pair) => sum + pair[0], 0); });
      return { stages, samples: runs.length, deviates: whole.length >= MIN_RUNS && median(whole.map((ratio) => Math.abs(ratio - 1))) > 0.5 };
    },
    /** `{ stages: { author: 8662, ... }, samples }`: the output one call really wrote per stage, thinking included, the median over the runs that recorded
        it (#771). A stage needs MIN_RUNS runs before its figure is used; a model, when given, is measured on its own runs only. */
    async outputPerCall({ model } = {}) {
      await queue.catch(() => {});
      const loaded = await load(), runs = model ? loaded.runs.filter((run) => !run.model || run.model === model) : loaded.runs;
      const byStage = new Map();
      for (const run of runs) for (const [id, [calls, output]] of Object.entries(run.outputs || {})) {
        if (!(calls > 0) || !(output > 0)) continue;
        byStage.set(id, [...(byStage.get(id) || []), output / calls]);
      }
      const stages = Object.fromEntries([...byStage].filter(([, values]) => values.length >= MIN_RUNS).map(([id, values]) => [id, Math.round(median(values))]));
      return { stages, samples: runs.filter((run) => run.outputs).length };
    },
  };
}

/** Tests run many libraries in one process: a machine-wide file would let one test's finished runs change another test's estimate, and the goldens would
    depend on the order the shards ran in. scripts/test.mjs turns learning off for its children; the calibration's own tests name a folder, so they keep
    their behaviour. The app never sets this. */
const OFF = Object.freeze({
  record: async () => {},
  factors: async () => ({ stages: {}, samples: 0, deviates: false }),
  outputPerCall: async () => ({ stages: {}, samples: 0 }),
});
/** Whether this process learns at all (see OFF): true only for a test runner that said so. */
export const learningOff = () => process.env.STUDY_NO_CALIBRATION === '1';

const calibrations = new Map();
/** One calibration per folder: the machine's, unless a caller names another. Keyed by the resolved folder, so the default and an explicit path agree. */
export function calibrationFor(root = calibrationDir()) {
  if (learningOff()) return OFF;
  const folder = root || calibrationDir();
  let calibration = calibrations.get(folder);
  if (!calibration) calibrations.set(folder, calibration = createCalibration(folder));
  return calibration;
}
