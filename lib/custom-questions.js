import { LIMITS, goalOfChars, levelOf } from './coverage-strength.js';

/* The questions of a 定制方案 (深度定制, lib/custom-plan.js `questions`), as RUNS: how the chosen chapters are shared out over the generation runs that make them.
   Pure; the estimate (lib/custom-estimate.js) and `course.custom.apply` (lib/custom-apply.js) read the same function, so the number the learner was shown is the number
   the runs are planned with.

   WHY RUNS PER GROUP OF CHAPTERS, NOT ONE RUN OVER ALL OF THEM. A coverage run is planned for at most LIMITS.total questions (lib/coverage-strength.js: the sanity bound of
   one run, GOAL_QUESTIONS_MAX), so one run over a whole big book was silently cut at 500, and its text was one selection. Here the cap is per run and a plan is made of as many
   runs as it needs: the chapters in reading order, a run taking chapters while what the level asks of them (goalOfChars) still fits under the cap, a chapter that alone asks
   for more being cut into runs of its own pages. Nothing is cut: the sum of the runs is what the level asks of the chosen text. A chapter is never split across runs
   unless it is over the cap by itself, so a run is something the learner can read as 「第 3–4 章的题」 in the task console.

   fitUnits(units, level, { cap, charsOf }) -> units, none asking for more than `cap` (a unit over it is cut into parts of its sources by `charsOf(sourceId)`, or, with no
     sources to cut at, into equal parts of its characters).
   packRuns(units, level, { cap }) -> [{ units, goal, chars }]; goal: what the level asks of the run's characters (the sum of its units').
   A unit is { id, title, chars, sourceIds? }. */

/** A run is packed to this share of the cap: its real evidence (lib/sections.js evidenceChars) is a few per cent off the skeleton characters; a run over the cap is cut. */
export const HEADROOM = 0.9;
const wantOf = (unit, level) => goalOfChars(unit.chars, level);
const roomOf = cap => Math.floor(cap * HEADROOM);

function partsBySources(unit, pieces, charsOf) {
  const target = unit.chars / pieces, parts = [];
  let part = [], held = 0;
  for (const id of unit.sourceIds) {
    part.push(id); held += charsOf(id);
    if (held >= target && parts.length < pieces - 1) { parts.push({ sourceIds: part, chars: held }); part = []; held = 0; }
  }
  if (part.length) parts.push({ sourceIds: part, chars: held });
  return parts;
}

export function fitUnits(units, level, { cap = LIMITS.total, charsOf } = {}) {
  const chosen = levelOf(level);
  return units.flatMap(unit => {
    // A unit of one source cannot be cut (two runs of the same text would ask the same questions twice): it stays one run, which the run's own bound caps.
    const pieces = Math.ceil(wantOf(unit, chosen) / roomOf(cap)), sources = unit.sourceIds, cuttable = !sources || (sources.length > 1 && charsOf);
    if (pieces <= 1 || !cuttable) return [unit];
    const parts = sources ? partsBySources(unit, pieces, charsOf) : Array.from({ length: pieces }, () => ({ chars: unit.chars / pieces }));
    return parts.map((part, at) => ({ ...unit, ...part, id: `${unit.id}~${at + 1}`, title: `${unit.title} (${at + 1}/${parts.length})` }));
  });
}

export function packRuns(units, level, { cap = LIMITS.total } = {}) {
  const chosen = levelOf(level), runs = [];
  for (const unit of units) {
    const run = runs.at(-1);
    if (run && goalOfChars(run.chars + unit.chars, chosen) <= roomOf(cap)) { run.units.push(unit); run.chars += unit.chars; run.goal = goalOfChars(run.chars, chosen); }
    else runs.push({ units: [unit], goal: wantOf(unit, chosen), chars: unit.chars });
  }
  return runs;
}
