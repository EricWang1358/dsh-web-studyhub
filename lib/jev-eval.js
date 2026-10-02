import { JEV_FEATURES } from './jev-settings.js';
import { mapLimit } from './jev-runtime.js';
import { NONE_KEY, buildCourseRequest, pickCourse } from './jev-course-suggest.js';
import { TRIAGE_CHECKS, buildTriageRequest } from './jev-triage.js';
import { OUTLINE_LABELS, classifyOutline } from './jev-outline.js';
import { LEVEL_LABELS, checkLevels } from './jev-levels.js';
import { sourcesWithCourses } from './source-courses.js';

/* EXPERIMENTAL. The evaluation harness behind scripts/eval-jev.mjs: what makes the Jev experiments measurable instead of anecdotal.

   A dataset is a JSON file of labelled items per experiment (see tests/fixtures/jev-eval/README.md). `evaluate` runs the REAL feature code
   (the same requests lib/jev-course-suggest.js, jev-triage.js, jev-outline.js and jev-levels.js send) through a runtime, and scores what comes back:
   accuracy, precision and recall, F1, and calibration (expected calibration error: does "90% sure" mean right about 90% of the time?), plus what
   it cost in TOKENS (never money). The metric code is pure and tested against hand-computed values; nothing here says anything about how good
   real Jev is: that is what running the script on labelled data answers. */

const round = (value, places = 4) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places);
const ratio = (num, den) => (den === 0 ? null : num / den);
const f1Of = (precision, recall) => (precision === null || recall === null || precision + recall === 0 ? (precision === null || recall === null ? null : 0) : 2 * precision * recall / (precision + recall));

/** Expected calibration error over equal-width bins of confidence. samples: [{ confidence in 0..1, correct: boolean }]. */
export function calibration(samples, binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, index) => ({ from: round(index / binCount, 6), to: round((index + 1) / binCount, 6), n: 0, confidence: 0, accuracy: 0 }));
  for (const sample of samples) {
    const bin = bins[Math.min(binCount - 1, Math.floor(sample.confidence * binCount))];
    bin.n++; bin.confidence += sample.confidence; bin.accuracy += sample.correct ? 1 : 0;
  }
  let ece = 0;
  for (const bin of bins) if (bin.n) { bin.confidence /= bin.n; bin.accuracy /= bin.n; ece += Math.abs(bin.accuracy - bin.confidence) * bin.n / samples.length; }
  return { ece: round(ece, 6) ?? 0, bins: bins.filter(bin => bin.n).map(bin => ({ ...bin, confidence: round(bin.confidence), accuracy: round(bin.accuracy) })) };
}

/** Multi-class scoring. rows: [{ truth, predicted, probability (of the predicted class) }]. */
export function scoreChoice(rows, { classes }) {
  const n = rows.length;
  if (!n) return { n: 0, accuracy: null, perClass: {}, macroF1: null, ece: null, bins: [] };
  const perClass = {};
  for (const name of classes) {
    const tp = rows.filter(row => row.truth === name && row.predicted === name).length, predicted = rows.filter(row => row.predicted === name).length, support = rows.filter(row => row.truth === name).length;
    const precision = ratio(tp, predicted), recall = ratio(tp, support);
    perClass[name] = { precision: round(precision), recall: round(recall), f1: round(f1Of(precision, recall)), support };
  }
  const scored = Object.values(perClass).filter(entry => entry.support > 0);
  const calibrated = calibration(rows.map(row => ({ confidence: row.probability, correct: row.truth === row.predicted })));
  return { n, accuracy: round(rows.filter(row => row.truth === row.predicted).length / n), perClass,
    macroF1: round(scored.length ? scored.reduce((sum, entry) => sum + (entry.f1 ?? 0), 0) / scored.length : null), ece: round(calibrated.ece), bins: calibrated.bins };
}

/** Binary scoring of a defect. rows: [{ truth: boolean (defect present), p: probability of the defect }]. Accuracy at 0.5; precision/recall at `threshold`. */
export function scoreBinary(rows, { threshold = 0.8 } = {}) {
  const n = rows.length, positives = rows.filter(row => row.truth).length;
  if (!n) return { n: 0, positives: 0, accuracy: null, atThreshold: { threshold, flagged: 0, precision: null, recall: null, f1: null }, ece: null, bins: [] };
  const flagged = rows.filter(row => row.p >= threshold), tp = flagged.filter(row => row.truth).length;
  const precision = ratio(tp, flagged.length), recall = ratio(tp, positives);
  const calibrated = calibration(rows.map(row => ({ confidence: Math.max(row.p, 1 - row.p), correct: (row.p >= 0.5) === row.truth })));
  return { n, positives, accuracy: round(rows.filter(row => (row.p >= 0.5) === row.truth).length / n),
    atThreshold: { threshold, flagged: flagged.length, precision: round(precision), recall: round(recall), f1: round(f1Of(precision, recall)) }, ece: round(calibrated.ece), bins: calibrated.bins };
}

/* ---- dataset ------------------------------------------------------------------------------------------------------------- */

const LEVELS = Object.keys(LEVEL_LABELS), OUTLINE = Object.keys(OUTLINE_LABELS);

/**
 * Throws a plain-language Error naming the first problem. `allowBlank` accepts the blank labels of a skeleton (items still to be labelled).
 */
export function validateDataset(dataset, { allowBlank = false } = {}) {
  const fail = text => { throw new Error(text); };
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset) || dataset.version !== 1 || !dataset.features || typeof dataset.features !== 'object') fail('The dataset must be a JSON object { "version": 1, "features": { ... } }');
  const names = Object.keys(dataset.features);
  if (!names.length) fail('The dataset needs at least one feature');
  for (const name of names) {
    if (!JEV_FEATURES.includes(name)) fail(`Unknown feature "${name}" (expected ${JEV_FEATURES.join(', ')})`);
    const section = dataset.features[name], items = section?.items;
    if (!Array.isArray(items)) fail(`${name} needs an "items" list`);
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) fail(`${name}: every item needs an id`);
      if (seen.has(item.id)) fail(`${name}: duplicate id ${item.id}`);
      seen.add(item.id);
      const blank = () => { if (!allowBlank) fail(`${name} item ${item.id} has a blank label: fill it in, or remove the item`); };
      if (name === 'courseSuggest') {
        if (typeof item.title !== 'string' || typeof item.text !== 'string') fail(`courseSuggest item ${item.id} needs a title and text`);
        if (!(item.course === null || (typeof item.course === 'string' && section.courses?.some(course => course.name === item.course)))) fail(`courseSuggest item ${item.id}: course must be null or one of the listed courses`);
      } else if (name === 'preReview') {
        if (!item.card || typeof item.card.prompt !== 'string' || typeof item.card.kind !== 'string') fail(`preReview item ${item.id} needs a card with a kind and a prompt`);
        for (const [check, value] of Object.entries(item.labels || {})) {
          if (!Object.hasOwn(TRIAGE_CHECKS, check)) fail(`preReview item ${item.id}: unknown check ${check}`);
          if (value === null) blank(); else if (typeof value !== 'boolean') fail(`preReview item ${item.id}: ${check} must be true or false`);
        }
      } else if (name === 'outlineNoise') {
        if (typeof item.title !== 'string') fail(`outlineNoise item ${item.id} needs a title`);
        if (!OUTLINE.includes(item.label)) { if (item.label === '') blank(); else fail(`outlineNoise item ${item.id}: label must be one of ${OUTLINE.join(', ')}`); }
      } else if (name === 'levelCheck') {
        if (!item.card || typeof item.card.prompt !== 'string') fail(`levelCheck item ${item.id} needs a card with a prompt`);
        if (!LEVELS.includes(item.level)) { if (item.level === '') blank(); else fail(`levelCheck item ${item.id}: level must be one of ${LEVELS.join(', ')}`); }
      }
    }
    if (name === 'courseSuggest' && (!Array.isArray(section.courses) || !section.courses.length || section.courses.some(course => typeof course?.name !== 'string' || !course.name))) fail('courseSuggest needs a non-empty list of courses: [{ "name", "titles"? }]');
  }
  return dataset;
}

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A starting point for the owner's own labelled data, from a COPY of a library state (lib/store.js `read()`): sources with their current course, questions with blank labels. */
export function skeletonFromLibrary(state, { limit = 200 } = {}) {
  const sources = sourcesWithCourses(state).filter(source => source.courses.length && typeof source.text === 'string').slice(0, limit);
  const names = [...new Set(sources.flatMap(source => source.courses))];
  const cards = (state.decks || []).filter(deck => !deck.archived && !deck.systemKind).flatMap(deck => deck.cards || []).filter(card => card?.prompt).slice(0, limit);
  const view = card => ({ kind: card.kind, prompt: card.prompt, answer: card.answer, ...(card.options ? { options: card.options.map(option => ({ text: option.text, correct: option.correct === true })) } : {}),
    ...(card.citations?.length ? { citations: card.citations.slice(0, 2).map(ref => ({ sourceId: ref.sourceId, quote: ref.quote })) } : {}) });
  return { version: 1, description: 'Skeleton made from a COPY of a library. Courses are the current filing (check them: they may be wrong). Labels set to null or "" are yours to fill in; an item left blank must be removed before the evaluation runs. Delete what you do not want to measure.',
    features: {
      courseSuggest: { courses: names.map(name => ({ name, titles: sources.filter(source => source.courses.includes(name)).slice(0, 3).map(source => clip(source.title, 60)) })),
        items: sources.map(source => ({ id: source.id, title: clip(source.title, 200), text: clip(source.text, 1000), course: source.courses[0] })) },
      preReview: { items: cards.map(card => ({ id: card.id, card: view(card), labels: { stemLeaksAnswer: null, needsSource: null, answerInEvidence: null, ...(card.kind === 'quiz' ? { oneDefensible: null } : {}) } })) },
      levelCheck: { items: cards.map(card => ({ id: card.id, card: view(card), level: '' })) },
    } };
}

/* ---- running ------------------------------------------------------------------------------------------------------------- */

const emptyCost = () => ({ calls: 0, inputTokens: 0, outputTokens: 0 });
const addCost = (cost, usage) => { cost.calls++; cost.inputTokens += usage.inputTokens; cost.outputTokens += usage.outputTokens; };
const withCost = (cost, answered) => ({ ...cost, perItem: { inputTokens: answered ? Math.round(cost.inputTokens / answered) : 0, outputTokens: answered ? Math.round(cost.outputTokens / answered * 10) / 10 : 0 } });
function byLang(rows) {
  const groups = {};
  for (const row of rows) if (row.lang) (groups[row.lang] ||= []).push(row);
  return Object.fromEntries(Object.entries(groups).map(([lang, list]) => [lang, { n: list.length, accuracy: round(list.filter(row => row.truth === row.predicted).length / list.length) }]));
}

async function runCourseSuggest(section, { runtime, threshold, language, signal, concurrency }) {
  const candidates = section.courses.map(course => ({ name: course.name, count: course.titles?.length || 0, titles: (course.titles || []).map((title, index) => ({ id: `example-${index}`, title })) }));
  const names = candidates.map(candidate => candidate.name), cost = emptyCost(), rows = [];
  const results = await mapLimit(section.items, concurrency, async item => {
    const request = buildCourseRequest({ id: item.id, title: item.title, text: item.text }, candidates);
    const result = await runtime.run('courseSuggest', request.state, request.questions, { signal, language });
    if (!result.ok) return null;
    addCost(cost, result.usage);
    return { item, probabilities: result.answers.course.probabilities };
  });
  let filled = 0, filledRight = 0;
  for (const entry of results) {
    if (!entry) continue;
    const top = Object.keys(entry.probabilities).sort((a, b) => entry.probabilities[b] - entry.probabilities[a])[0];
    rows.push({ truth: entry.item.course ?? NONE_KEY, predicted: top, probability: entry.probabilities[top], lang: entry.item.lang });
    const picked = pickCourse(entry.probabilities, names, { threshold });
    if (picked) { filled++; if (picked.course === entry.item.course) filledRight++; }
  }
  return { answered: rows.length, failed: section.items.length - rows.length, cost,
    result: { ...scoreChoice(rows, { classes: [...names, NONE_KEY] }), byLang: byLang(rows), filled: { threshold, precision: round(ratio(filledRight, filled)), coverage: round(ratio(filled, rows.length)), filled } } };
}

async function runPreReview(section, { runtime, threshold, language, signal, concurrency }) {
  const cost = emptyCost(), perCheck = Object.fromEntries(Object.keys(TRIAGE_CHECKS).map(id => [id, []]));
  let answered = 0;
  await mapLimit(section.items, concurrency, async item => {
    const card = { id: item.id, ...item.card }, request = buildTriageRequest(card);
    const result = await runtime.run('preReview', request.state, request.questions, { signal, language });
    if (!result.ok) return;
    addCost(cost, result.usage); answered++;
    for (const [id, answer] of Object.entries(result.answers)) {
      const label = item.labels?.[id];
      if (typeof label !== 'boolean') continue;
      const defect = TRIAGE_CHECKS[id].fail === 'yes' ? label : !label;
      perCheck[id].push({ truth: defect, p: TRIAGE_CHECKS[id].fail === 'yes' ? answer.noul : 1 - answer.noul, lang: item.lang });
    }
  });
  const checks = Object.fromEntries(Object.entries(perCheck).filter(([, rows]) => rows.length).map(([id, rows]) => [id, scoreBinary(rows, { threshold })]));
  return { answered, failed: section.items.length - answered, cost, result: { n: answered, checks } };
}

async function runOutline(section, { runtime, threshold, language, signal }) {
  const entries = section.items.map(item => ({ id: item.id, level: item.level || 1, title: item.title }));
  const classified = await classifyOutline({ runtime, entries, language, signal });
  const rows = section.items.filter(item => classified.labels[item.id]).map(item => ({ truth: item.label, predicted: classified.labels[item.id].label, probability: classified.labels[item.id].probability, lang: item.lang }));
  const noise = label => label === 'label' || label === 'running';
  const confidentNoise = rows.filter(row => noise(row.predicted) && row.probability >= threshold), truthNoise = rows.filter(row => noise(row.truth));
  const hit = confidentNoise.filter(row => noise(row.truth)).length;
  return { answered: rows.length, failed: section.items.length - rows.length, cost: classified.usage,
    result: { ...scoreChoice(rows, { classes: OUTLINE }), noise: { threshold, precision: round(ratio(hit, confidentNoise.length)), recall: round(ratio(hit, truthNoise.length)), flagged: confidentNoise.length } } };
}

async function runLevels(section, { runtime, threshold, language, signal, concurrency }) {
  const cards = section.items.map(item => ({ id: item.id, ...item.card })), truth = new Map(section.items.map(item => [item.id, item]));
  const checked = await checkLevels({ runtime, cards, threshold, language, signal, concurrency });
  const rows = checked.rows.map(row => ({ truth: truth.get(row.id).level, predicted: row.jev, probability: row.probability, lang: truth.get(row.id).lang }));
  const heuristicRows = section.items.map(item => ({ truth: item.level, predicted: checked.rows.length ? (checked.rows.find(row => row.id === item.id)?.heuristic ?? null) : null })).filter(row => row.predicted);
  const heuristic = { n: heuristicRows.length, accuracy: round(heuristicRows.length ? heuristicRows.filter(row => row.truth === row.predicted).length / heuristicRows.length : null) };
  return { answered: rows.length, failed: section.items.length - rows.length, cost: checked.usage,
    result: { ...scoreChoice(rows, { classes: LEVELS }), byLang: byLang(rows), heuristic } };
}

const RUNNERS = { courseSuggest: runCourseSuggest, preReview: runPreReview, outlineNoise: runOutline, levelCheck: runLevels };

/**
 * Run the experiments of `dataset` through `runtime` (lib/jev-runtime.js; the script builds one on the real client). Resolves
 * { threshold, features: { name: { n, accuracy, ..., cost } }, failed, usage }. A Jev that fails an item counts it in `failed`, never as a wrong answer.
 */
export async function evaluate({ dataset, runtime, threshold = 0.8, features, language = 'en', signal, concurrency = 4 }) {
  validateDataset(dataset);
  const chosen = (features || Object.keys(dataset.features)).filter(name => dataset.features[name]);
  const out = { threshold, features: {}, failed: 0, usage: emptyCost() };
  for (const name of chosen) {
    const run = await RUNNERS[name](dataset.features[name], { runtime, threshold, language, signal, concurrency });
    out.features[name] = { ...run.result, items: dataset.features[name].items.length, failed: run.failed, cost: withCost(run.cost, run.answered) };
    out.failed += run.failed;
    out.usage.calls += run.cost.calls; out.usage.inputTokens += run.cost.inputTokens; out.usage.outputTokens += run.cost.outputTokens;
  }
  return out;
}

/* ---- report -------------------------------------------------------------------------------------------------------------- */

const pct = value => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const num = value => (value === null || value === undefined ? 'n/a' : value.toFixed(3));

/** The report as plain text: one block per experiment, then the token table. */
export function formatReport(report) {
  const lines = [`Jev evaluation (confidence line ${pct(report.threshold)}; ECE = expected calibration error, lower is better)`, ''];
  for (const [name, entry] of Object.entries(report.features)) {
    lines.push(`${name}: ${entry.items} items, ${entry.items - entry.failed} answered${entry.failed ? `, ${entry.failed} FAILED (not counted as wrong)` : ''}`);
    if (name === 'preReview') {
      for (const [check, score] of Object.entries(entry.checks)) lines.push(`  ${check}: n=${score.n} (defects ${score.positives})  accuracy@0.5 ${pct(score.accuracy)}  precision ${pct(score.atThreshold.precision)}  recall ${pct(score.atThreshold.recall)}  F1 ${num(score.atThreshold.f1)}  flagged ${score.atThreshold.flagged}  ECE ${num(score.ece)}`);
    } else {
      lines.push(`  accuracy ${pct(entry.accuracy)}  macro-F1 ${num(entry.macroF1)}  ECE ${num(entry.ece)}`);
      if (entry.filled) lines.push(`  filled in at the line: precision ${pct(entry.filled.precision)}  coverage ${pct(entry.filled.coverage)} (${entry.filled.filled} sources)`);
      if (entry.noise) lines.push(`  noise (label or running header) at the line: precision ${pct(entry.noise.precision)}  recall ${pct(entry.noise.recall)}  flagged ${entry.noise.flagged}`);
      if (entry.heuristic) lines.push(`  the code's keyword heuristic on the same ${entry.heuristic.n} questions: accuracy ${pct(entry.heuristic.accuracy)}`);
      if (entry.byLang && Object.keys(entry.byLang).length > 1) lines.push(`  by language: ${Object.entries(entry.byLang).map(([lang, score]) => `${lang} n=${score.n} accuracy ${pct(score.accuracy)}`).join('; ')}`);
      for (const [label, score] of Object.entries(entry.perClass || {})) if (score.support) lines.push(`    ${label.padEnd(18)} support ${String(score.support).padStart(3)}  precision ${pct(score.precision)}  recall ${pct(score.recall)}  F1 ${num(score.f1)}`);
    }
    lines.push('');
  }
  lines.push('Tokens used (as reported by the service; counts only)', `  ${'experiment'.padEnd(16)}${'calls'.padStart(7)}${'input'.padStart(10)}${'output'.padStart(9)}   per item (in / out)`);
  for (const [name, entry] of Object.entries(report.features)) lines.push(`  ${name.padEnd(16)}${String(entry.cost.calls).padStart(7)}${String(entry.cost.inputTokens).padStart(10)}${String(entry.cost.outputTokens).padStart(9)}   ${entry.cost.perItem.inputTokens} / ${entry.cost.perItem.outputTokens}`);
  lines.push(`  ${'total'.padEnd(16)}${String(report.usage.calls).padStart(7)}${String(report.usage.inputTokens).padStart(10)}${String(report.usage.outputTokens).padStart(9)}`);
  return lines.join('\n');
}
