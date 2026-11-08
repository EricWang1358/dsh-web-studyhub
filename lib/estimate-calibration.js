import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FOLLOW_MODEL, modelOfKey } from './job-model.js';
import { withStoreLock } from './store-lock.js';
import { isLightStageStep, observedByStage, outputByStage, stageOfStep, stampStepModel } from './stage-usage.js';
export { isLightStageStep, observedByStage, outputByStage, stageOfStep, stampStepModel };

/* The estimate learns from this machine's own runs (#218, #772). A finished generation job records, per stage, what it used next to what its
   (uncalibrated) estimate said; the median ratio of the last runs is the stage's correction. One small file for the whole machine, beside the usage
   ledger and jev-usage.json (<DSH home>/study): a new library, or the second book of a course, is calibrated from the first run that finished. Written
   atomically under the folder's lock (lib/store-lock.js, shared with the board: two StudyHub processes do not lose each other's runs). Numbers only: a
   library carried in from its old file is remembered as a short hash of its folder, never its path. A damaged file is put aside and started afresh; a
   file that cannot be read right now is not overwritten; a failed write never breaks a job. */

/** Where the machine keeps what its runs taught it: the same folder as the usage ledger (lib/audio-dashboard.js) and jev-usage.json. */
export const calibrationDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study');

const FILE = 'estimate-calibration.json';
const KEEP = 30, MIN_RUNS = 3, CLAMP = { min: 0.4, max: 4 };

/** A library folder as a short hash: the same folder in another case or spelling (Windows) is the same library (lib/store-lock.js keyOf), and the file
    names no user, course or path. */
const libraryKey = (library) => createHash('sha256').update(process.platform === 'win32' ? resolve(library).toLowerCase() : resolve(library)).digest('hex').slice(0, 16);

/** The model id the calibration keys a run by (`provider/model` when a route or a model key names both, else the trimmed id), or undefined when none is known
    (`'follow'`, blank, missing): an unknown model reads and writes as unkeyed so every run still counts. */
export function calibrationModel(value) {
  if (!value || value === FOLLOW_MODEL) return undefined;
  const route = typeof value === 'string' ? modelOfKey(value) : isObject(value) ? value : null;
  if (route) {
    const provider = typeof route.provider === 'string' ? route.provider.trim() : '', model = typeof route.model === 'string' ? route.model.trim() : '';
    if (!model || model === FOLLOW_MODEL) return undefined;
    return provider ? `${provider}/${model}` : model;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== FOLLOW_MODEL ? trimmed : undefined;
}

/** The single model a round's non-light pipeline steps dispatched on (`{ skip: false, model }`), or `{ skip: true }` when steps mixed two or more models
    (including switching between unkeyed `null` and a named model mid-round). Synthetic steps without a stamped `model` property fall back to `fallbackModel`. */
const CALIBRATED_STAGES = new Set(['plan', 'blueprint', 'author', 'review']);
export function roundCalibrationModel(steps, fallbackModel) {
  const stageSteps = (steps || []).filter((step) => CALIBRATED_STAGES.has(stageOfStep(step)) && !isLightStageStep(step) && step?.status !== 'skipped');
  if (!stageSteps.some((step) => Object.hasOwn(step, 'model'))) return { skip: false, model: calibrationModel(fallbackModel) };
  const fallback = calibrationModel(fallbackModel) ?? null;
  const distinct = new Set(stageSteps.map((step) => (Object.hasOwn(step, 'model') ? step.model : fallback)));
  if (distinct.size > 1) return { skip: true, model: undefined };
  const [only] = distinct;
  return { skip: false, model: only ?? undefined };
}

/** A stage's record: [estimated, used], both numbers, the estimate above zero. */
const isPair = (pair) => Array.isArray(pair) && pair.length === 2 && Number(pair[0]) > 0 && Number.isFinite(Number(pair[1])) && Number(pair[1]) >= 0;
/** What a stage wrote: [calls, output], both above zero. */
const isWritten = (pair) => Array.isArray(pair) && pair.length === 2 && Number(pair[0]) > 0 && Number(pair[1]) > 0;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** A run as the file holds it, with what is unreadable in it left out (a partly bad file still calibrates from its good runs), or null when nothing in it is
    usable. */
function cleanRun(run) {
  if (!isObject(run) || !isObject(run.stages)) return null;
  const stages = Object.fromEntries(Object.entries(run.stages).filter(([, pair]) => isPair(pair)));
  const outputs = isObject(run.outputs) ? Object.fromEntries(Object.entries(run.outputs).filter(([, pair]) => isWritten(pair))) : {};
  if (!Object.keys(stages).length && !Object.keys(outputs).length) return null;
  const clean = { ...run, stages };
  if (Object.keys(outputs).length) clean.outputs = outputs; else delete clean.outputs;
  const model = calibrationModel(run.model);
  if (model) clean.model = model; else delete clean.model;
  return clean;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The calibration of one folder (the machine's by default; a test or a caller may name another). */
export function createCalibration(root = calibrationDir(), { keep = KEEP, read = (file) => readFile(file, 'utf8') } = {}) {
  const path = join(root, FILE);
  let queue = Promise.resolve();
  /** A missing file is an empty record; a file that is not JSON is too, and says so (`damaged`); any other error (busy, denied) is thrown: what cannot be
      read now is not an empty history. */
  const readFileRuns = async (file) => {
    let text;
    try { text = await read(file); } catch (error) { if (error?.code === 'ENOENT') return { runs: [], imported: [] }; throw error; }
    let value;
    try { value = JSON.parse(text); } catch { return { runs: [], imported: [], damaged: true }; }
    return { runs: (Array.isArray(value?.runs) ? value.runs : []).map(cleanRun).filter(Boolean).slice(-keep),
      imported: Array.isArray(value?.imported) ? value.imported.filter((entry) => typeof entry === 'string') : [] };
  };
  /** The machine's record. With `library` (a learning library's folder) the runs of that library's own earlier file (the file this one replaced, #772) are
      carried in once: they count for any model, the old file is read and never changed, and `imported` remembers the library (as a hash, only when it
      carried runs) so a later read does not count them again. An old file that cannot be read carries nothing and is tried again next time. Reading writes
      nothing; the next `record` saves what was carried. */
  const load = async (library) => {
    const state = await readFileRuns(path);
    const key = library ? libraryKey(library) : null;
    if (key && !state.imported.includes(key)) {
      const old = await readFileRuns(join(library, FILE)).catch(() => ({ runs: [] }));
      if (old.runs.length) {
        state.runs = [...old.runs, ...state.runs].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-keep);
        state.imported = [...state.imported, key];
      }
    }
    return state;
  };
  /** This process's writers take turns, then the folder's lock arbitrates between processes (the board's lock, lib/store-lock.js). */
  const turn = (work) => { const run = queue.then(() => withStoreLock(root, work)); queue = run.catch(() => {}); return run; };
  return {
    /** Add one finished run: its stage totals (estimate), the tokens it used per stage, what each stage wrote per call (`outputs`), and, when a caller knows
        it, the model it ran on (a route, a model key or an id; `'follow'` and blank stay unkeyed). A run that used nothing teaches nothing. */
    record({ stageTotals, actual, outputs, model, library } = {}) {
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
        const { damaged, ...state } = await load(library);
        // A file that was not JSON is kept beside the new one, so what it held can still be looked at.
        if (damaged) await rename(path, `${path}.damaged-${Date.now()}`).catch(() => {});
        const modelId = calibrationModel(model);
        state.runs.push({ at: new Date().toISOString(), stages, ...(Object.keys(written).length ? { outputs: written } : {}), ...(modelId ? { model: modelId } : {}) });
        state.runs = state.runs.slice(-keep);
        await mkdir(root, { recursive: true });
        const temporary = join(root, `.${FILE}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(state), 'utf8');
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
      });
    },
    /** `{ stages: { plan: 1.3, ... }, samples, deviates }`: a stage needs three runs before it moves; a ratio is clamped to 0.4-4. `samples` counts the runs
        that carry a stage. With `model`, only that model's runs count (a run recorded without one counts for any; `'follow'` and blank read all runs). */
    async factors({ model, library } = {}) {
      await queue.catch(() => {});
      const loaded = await load(library), byStage = new Map();
      const modelId = calibrationModel(model);
      const runs = (modelId ? loaded.runs.filter((run) => !run.model || run.model === modelId) : loaded.runs).filter((run) => Object.keys(run.stages).length);
      for (const run of runs) for (const [id, [estimated, used]] of Object.entries(run.stages)) byStage.set(id, [...(byStage.get(id) || []), used / estimated]);
      const stages = Object.fromEntries([...byStage].filter(([, ratios]) => ratios.length >= MIN_RUNS)
        .map(([id, ratios]) => [id, Math.min(CLAMP.max, Math.max(CLAMP.min, median(ratios)))]));
      const whole = runs.map((run) => { const pairs = Object.values(run.stages); return pairs.reduce((sum, pair) => sum + Number(pair[1]), 0) / pairs.reduce((sum, pair) => sum + Number(pair[0]), 0); });
      return { stages, samples: runs.length, deviates: whole.length >= MIN_RUNS && median(whole.map((ratio) => Math.abs(ratio - 1))) > 0.5 };
    },
    /** `{ stages: { author: 8662, ... }, samples }`: the output one call really wrote per stage, thinking included, the median over the runs that recorded
        it (#771). A stage needs MIN_RUNS runs before its figure is used; a model, when given, is measured on its own runs only. What it learned and nothing
        else: the allowance assumed without a measurement is the estimate's own (lib/token-estimate.js), so a test with learning off and an app whose file
        could not be read price alike. */
    async outputPerCall({ model, library } = {}) {
      await queue.catch(() => {});
      const modelId = calibrationModel(model), loaded = await load(library), runs = modelId ? loaded.runs.filter((run) => !run.model || run.model === modelId) : loaded.runs;
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
/** Whether this process learns at all (see OFF): a test runner said so, or this is a `node --test` process that was not given a DSH home (a test run by hand
    must never write into the real ~/.dsh). A test that names a DSH home, like the calibration's own, learns there. */
export const learningOff = () => process.env.STUDY_NO_CALIBRATION === '1' || (!!process.env.NODE_TEST_CONTEXT && !process.env.DSH_HOME?.trim());

const calibrations = new Map();
/** One calibration per folder: the machine's, unless a caller names another. Keyed by the resolved folder, so the default and an explicit path agree. */
export function calibrationFor(root = calibrationDir()) {
  if (learningOff()) return OFF;
  const folder = root || calibrationDir();
  let calibration = calibrations.get(folder);
  if (!calibration) calibrations.set(folder, calibration = createCalibration(folder));
  return calibration;
}
