import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export { stageOfStep, observedByStage } from './stage-usage.js';

/* The estimate learns from this library's own runs (#218). A finished generation job records, per stage, what it used next to what its
   (uncalibrated) estimate said; the median ratio of the last runs is the stage's correction. One small file next to the library, written
   atomically and queued like the usage ledger: it holds numbers only, a damaged file starts afresh and a failed write never breaks a job. */

const FILE = 'estimate-calibration.json';
const KEEP = 30, MIN_RUNS = 3, CLAMP = { min: 0.4, max: 4 };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The calibration of one library root. */
export function createCalibration(root, { keep = KEEP } = {}) {
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
    /** Add one finished run: its stage totals (estimate) and the tokens it used per stage. A run that used nothing teaches nothing. */
    record({ stageTotals, actual } = {}) {
      const stages = {};
      for (const [id, range] of Object.entries(stageTotals || {})) {
        const estimated = (Number(range?.low) + Number(range?.high)) / 2, used = Number(actual?.[id]);
        if (estimated > 0 && used > 0) stages[id] = [Math.round(estimated), Math.round(used)];
      }
      if (!Object.keys(stages).length) return Promise.resolve();
      return turn(async () => {
        const state = await load();
        state.runs.push({ at: new Date().toISOString(), stages });
        state.runs = state.runs.slice(-keep);
        await mkdir(root, { recursive: true });
        const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(state), 'utf8');
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      });
    },
    /** `{ stages: { plan: 1.3, ... }, samples, deviates }`: a stage needs three runs before it moves; a ratio is clamped to 0.4-4. */
    async factors() {
      await queue.catch(() => {});
      const { runs } = await load(), byStage = new Map();
      for (const run of runs) for (const [id, [estimated, used]] of Object.entries(run.stages)) byStage.set(id, [...(byStage.get(id) || []), used / estimated]);
      const stages = Object.fromEntries([...byStage].filter(([, ratios]) => ratios.length >= MIN_RUNS)
        .map(([id, ratios]) => [id, Math.min(CLAMP.max, Math.max(CLAMP.min, median(ratios)))]));
      const whole = runs.map((run) => { const pairs = Object.values(run.stages); return pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.reduce((sum, pair) => sum + pair[0], 0); });
      return { stages, samples: runs.length, deviates: whole.length >= MIN_RUNS && median(whole.map((ratio) => Math.abs(ratio - 1))) > 0.5 };
    },
  };
}

const calibrations = new Map();
/** One calibration per library root. */
export function calibrationFor(root) {
  let calibration = calibrations.get(root);
  if (!calibration) calibrations.set(root, calibration = createCalibration(root));
  return calibration;
}
