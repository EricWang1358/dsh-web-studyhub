import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JEV_FEATURES } from './jev-settings.js';
import { JEV_REPLACE_SITES } from './jev-sites.js';

/* EXPERIMENTAL. What Jev used, in tokens: per day and per experiment, plus a running total. Jev's tokens are counted
   SEPARATELY from the study model's (lib/model-usage.js): they are a different service with a different meter. Tokens only,
   as the vendor reports them in `usage`; no price is ever computed or shown, because StudyHub does not know the learner's plan.

   One small file next to the key (<DSH home>/study/jev-usage.json): at most 90 days of rows, whatever the library does. Nothing
   in it is a prompt, an answer or a key. Writes are queued and replaced atomically; a damaged file starts afresh; a failed
   write is the caller's to ignore: usage is never allowed to break a feature. */

export const jevUsagePath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'study', 'jev-usage.json');
export const JEV_USAGE_FEATURES = Object.freeze([...JEV_FEATURES, ...JEV_REPLACE_SITES, 'test', 'other']);
const RETAIN_DAYS = 90;

const localDate = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const natural = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0 });
const add = (a, b) => ({ calls: (a?.calls || 0) + (b?.calls || 0), inputTokens: (a?.inputTokens || 0) + (b?.inputTokens || 0), outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0) });
const sane = cell => ({ calls: natural(cell?.calls) ?? 0, inputTokens: natural(cell?.inputTokens) ?? 0, outputTokens: natural(cell?.outputTokens) ?? 0 });

function clean(value) {
  const days = {};
  for (const [date, features] of Object.entries(value?.days && typeof value.days === 'object' ? value.days : {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !features || typeof features !== 'object') continue;
    days[date] = Object.fromEntries(Object.entries(features).filter(([id]) => JEV_USAGE_FEATURES.includes(id)).map(([id, cell]) => [id, sane(cell)]));
  }
  return { version: 1, days, total: sane(value?.total), byFeature: Object.fromEntries(Object.entries(value?.byFeature && typeof value.byFeature === 'object' ? value.byFeature : {})
    .filter(([id]) => JEV_USAGE_FEATURES.includes(id)).map(([id, cell]) => [id, sane(cell)])) };
}

/** The meter of this DSH home. Prefer {@link jevUsage}, which shares one queue per file. */
export function createJevUsage({ now = Date.now, retainDays = RETAIN_DAYS } = {}) {
  let queue = Promise.resolve();
  const load = async () => { try { return clean(JSON.parse(await readFile(jevUsagePath(), 'utf8'))); } catch { return clean(null); } };
  const turn = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  return {
    /** Add what one call (or `calls` calls) used to its day and experiment. Unusable usage is ignored. */
    record({ feature, usage, calls = 1, at = now() } = {}) {
      const input = natural(usage?.inputTokens), output = natural(usage?.outputTokens);
      if (input === null || output === null || !(typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number')) return Promise.resolve();
      const id = JEV_USAGE_FEATURES.includes(feature) ? feature : 'other', cell = { calls: natural(calls) ?? 1, inputTokens: input, outputTokens: output };
      return turn(async () => {
        const state = await load();
        const date = localDate(at), cutoff = localDate(now() - retainDays * 86400000);
        for (const old of Object.keys(state.days)) if (old < cutoff) delete state.days[old];
        if (date >= cutoff) {
          const day = state.days[date] ||= {};
          day[id] = add(day[id], cell);
        }
        state.total = add(state.total, cell);
        state.byFeature[id] = add(state.byFeature[id], cell);
        const target = jevUsagePath(), temporary = `${target}.${randomUUID()}.tmp`;
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
        try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
      });
    },
    /** Today, the running total, the total per experiment and one row per remembered day. */
    async summary({ at = now() } = {}) {
      await queue.catch(() => {});
      const state = await load(), today = localDate(at);
      const daily = Object.keys(state.days).sort().map(date => ({ date, ...Object.values(state.days[date]).reduce(add, zero()) }));
      return { today: daily.find(day => day.date === today) ? (({ date, ...rest }) => rest)(daily.find(day => day.date === today)) : zero(), total: state.total, byFeature: state.byFeature, daily };
    },
  };
}

let shared;
/** One meter per process, so every caller queues behind the same writer. */
export const jevUsage = () => (shared ||= createJevUsage());
