import { createHash } from 'node:crypto';
import { inventoryMaterial, short16 } from '../../../../course-book-inventory.js';
import { outlineLeaves } from '../../../../course-book-inputs.js';
import { parseJson } from '../../../../generation.js';
import { locateQuote } from '../../blueprint/quote.js';
import { keepInventory } from '../../inventory/stage.js';
import { QUOTE_CHARS } from '../../outline/constants.js';
import { FAILURES, WHERE } from '../../outline/jobs/messages.js';
import { paperPrompt } from '../../outline/prompts.js';
import { readPaper } from '../../outline/read.js';
import { leavesOf, markPapers } from '../../outline/tree.js';

/* Incremental sample-paper placement for a build BY CHAPTERS (custom plan S2, #739 item 7): each paper chunk's verified questions are cached on the course
   inventory by the chunk's content digest. When a chapter is added and a paper's fingerprint matches the kept outline's, the paper marks on kept chapters stay
   as they are; chunks whose questions are all already placed on kept chapters ask 0 calls, and chunks with unplaced questions ask only those questions against
   only the added/redone chapters' points. A new or changed paper (or one not yet in the cache) runs over the whole outline once and fills the cache. */

const coded = (code, message) => Object.assign(new Error(message), { code });
const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const kept = async read => read;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ids = value => (Array.isArray(value) ? value : [value]).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
const shownOf = leaves => leaves.map(item => ({ id: item.alias, title: item.node.title, ...(item.path.length ? { under: item.path.join(' › ') } : {}) }));
const chunkDigest = chunk => short16(['paper', chunk.paper, chunk.sources.map(source => [source.id, source.text])]);

function readAndExtractPaper(text, chunk) {
  let value = null;
  try { const parsed = parseJson(String(text)); if (object(parsed)) value = parsed; } catch { return null; }
  if (!value || !Array.isArray(value.questions)) return null;
  const questions = [], verified = [];
  let unverified = 0;
  for (const raw of value.questions.filter(object)) {
    const quote = clean(raw.quote, QUOTE_CHARS), points = ids(raw.points).slice(0, 3);
    let found = null;
    for (const source of chunk.sources) {
      const at = quote ? locateQuote(source.text, quote) : null;
      if (at) { found = { sourceId: source.id, ...at }; break; }
    }
    if (found) {
      verified.push({ ...(clean(raw.label, 40) ? { label: clean(raw.label, 40) } : {}), ...found });
      if (points.length) questions.push({ ...found, points });
    } else if (points.length) unverified++;
  }
  const bySource = new Map(chunk.sources.map(source => [source.id, source.text])), extracted = [], seen = new Set();
  for (const source of chunk.sources) {
    const own = verified.filter(q => q.sourceId === source.id).sort((a, b) => a.start - b.start);
    const full = bySource.get(source.id) || '';
    own.forEach((q, at) => {
      const key = `${q.sourceId}\u0000${q.quote}`;
      if (seen.has(key)) return;
      seen.add(key);
      const from = full.lastIndexOf('\n', q.start) + 1;
      const nextLine = at + 1 < own.length ? full.lastIndexOf('\n', own[at + 1].start) : full.length;
      const to = Math.min(Math.max(q.end, nextLine > from ? nextLine : full.length), from + 1600);
      extracted.push({ ...(q.label ? { label: q.label } : {}), sourceId: q.sourceId, quote: q.quote, start: q.start, end: q.end,
        text: full.slice(from, to).trim() || q.quote });
    });
  }
  return { questions, extracted, unverified };
}

export async function partPaperStage(ctx, { baseNodes, builtNodes, merged, previousPapers }) {
  const { plan, state, ask, show, boundary, input } = ctx;
  for (const { node } of outlineLeaves(builtNodes)) delete node.exam;
  if (!plan.paperChunks.length) {
    for (const { node } of outlineLeaves(baseNodes)) delete node.exam;
    return;
  }
  const inv = ctx.inventory.courseInventory;
  const cachedMap = new Map((inv.cache?.papers || []).map(entry => [entry.key, entry.questions]));
  const prevByKey = new Map((previousPapers || []).map(paper => [paper.key, paper.fingerprint]));
  const chunksByPaper = new Map();
  for (const chunk of plan.paperChunks) {
    if (!chunksByPaper.has(chunk.paper)) chunksByPaper.set(chunk.paper, []);
    chunksByPaper.get(chunk.paper).push(chunk);
  }
  const incrementalPapers = new Set(
    plan.papers.filter(paper => prevByKey.get(paper.key) && prevByKey.get(paper.key) === paper.fingerprint
      && (chunksByPaper.get(paper.key) || []).every(chunk => cachedMap.has(chunkDigest(chunk)))).map(paper => paper.key),
  );
  for (const { node } of outlineLeaves(baseNodes)) {
    if (!node.exam?.evidence) continue;
    const keptPlaces = node.exam.evidence.filter(place => incrementalPapers.has(place.paper));
    if (keptPlaces.length) node.exam = { evidence: keptPlaces }; else delete node.exam;
  }
  const placedOnBase = new Set(
    outlineLeaves(baseNodes).flatMap(({ node }) => (node.exam?.evidence || []).map(place => `${place.paper}\u0000${place.sourceId}\u0000${place.quote}`)),
  );
  const allLeaves = leavesOf(merged.nodes), allShown = shownOf(allLeaves);
  const builtLeaves = leavesOf(builtNodes), builtShown = shownOf(builtLeaves);
  const fullResults = [], builtResults = [];
  let cacheDirty = false;
  for (const chunk of plan.paperChunks) {
    boundary(`paper:${chunk.number}`);
    const digest = chunkDigest(chunk);
    if (incrementalPapers.has(chunk.paper)) {
      const pending = (cachedMap.get(digest) || []).filter(q => !placedOnBase.has(`${chunk.paper}\u0000${q.sourceId}\u0000${q.quote}`));
      if (!builtLeaves.length || !pending.length) {
        state.reused++; state.papers.done++; show();
        continue;
      }
      state.stage = 'paper'; show();
      const narrowChunk = { ...chunk, sources: chunk.sources
        .map(source => ({ id: source.id, text: pending.filter(q => q.sourceId === source.id).map(q => q.text).join('\n') }))
        .filter(source => source.text) };
      const key = `${chunk.key}:part:${short([digest, pending.map(q => q.quote), builtShown])}`;
      const answer = await ask(key, { stage: 'paper', part: chunk.number, parts: plan.paperChunks.length },
        paperPrompt(narrowChunk, builtShown, plan), text => readPaper(text, chunk), kept);
      if (!answer) throw coded('course-outline-unreadable', FAILURES.unreadable(input.language, WHERE.paper(input.language)));
      builtResults.push({ paper: chunk.paper, questions: answer.questions });
      state.unverified += answer.unverified;
      state.papers.done++; show();
      continue;
    }
    state.stage = 'paper'; show();
    const answer = await ask(`${chunk.key}:${short(allShown)}`, { stage: 'paper', part: chunk.number, parts: plan.paperChunks.length },
      paperPrompt(chunk, allShown, plan), text => readAndExtractPaper(text, chunk), kept);
    if (!answer) throw coded('course-outline-unreadable', FAILURES.unreadable(input.language, WHERE.paper(input.language)));
    cachedMap.set(digest, answer.extracted); cacheDirty = true;
    fullResults.push({ paper: chunk.paper, questions: answer.questions });
    state.unverified += answer.unverified;
    state.papers.done++; show();
  }
  if (fullResults.length) state.invalid += markPapers(allLeaves, fullResults);
  if (builtResults.length) state.invalid += markPapers(builtLeaves, builtResults);
  if (cacheDirty) {
    const nextCache = { ...ctx.inventory.courseInventory.cache, papers: [...cachedMap].map(([key, questions]) => ({ key, questions })) };
    const updated = inventoryMaterial({ title: ctx.inventory.title, notice: ctx.inventory.text, ...ctx.inventory.courseInventory, cache: nextCache });
    ctx.inventory = await keepInventory({ ...ctx, context: ctx.context }, updated, ctx.inventory);
  }
}
