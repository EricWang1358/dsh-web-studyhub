/* A fake model for the 复习全书 build: the inventory and the outline stages are answered by the course outline's fake (tests/helpers/course-outline-library.mjs),
   the writing, the independent review, the repair, the placing of loose items and 考情 here, the way a plausible model would: the writer explains each
   checklist item by name with a quote copied from its first page; the reviewer flags every must item the text does not name; the repair adds what was flagged.
   No real model, no network. */
import { reportUsage } from '../../lib/usage-scope.js';
import { outlineModel } from './course-outline-library.mjs';

const requestData = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nYour previous reply')[0]);
export const INVENTED = 'This sentence is not written in any of the materials at all.';

/** The first words of a text, cut at a word: what a model copies as a quote. */
const opening = text => { const words = text.replace(/\s+/g, ' ').trim().split(' '); let quote = ''; for (const word of words) { if ((`${quote} ${word}`).length > 60) break; quote = `${quote} ${word}`.trim(); } return quote; };

/** A section that explains the given checklist items, with a lead-in and a lead-on, a mark on the first statement and its quote. */
function section(data, items, { invent }) {
  const point = data.point, lines = [];
  if (point.before) lines.push(`After ${point.before} comes ${point.title}.`);
  lines.push(`${point.title}, explained for a beginner with $x^2$ [1].${invent ? ' A claim that rests on nothing [2].' : ''}`);
  for (const item of items) lines.push(`**${item.name}**: ${item.gist || 'what it means'}; this is how it is used.`);
  lines.push('A general intuition the materials do not give （资料以外）.');
  if (point.after) lines.push(`That leads on to ${point.after}.`);
  return { text: lines.join('\n\n'), covered: items.map(item => ({ id: item.id, where: item.name })),
    quotes: [{ n: 1, ref: 'S1', quote: opening(data.pages[0]?.text ?? '') }, ...(invent ? [{ n: 2, ref: 'S1', quote: INVENTED }] : [])] };
}

/** The reviewer: every must item whose name the text lacks is missing; `unsupported` (a point title) makes it find an unsupported claim in that point. */
function review(data, { unsupported = [] }) {
  const issues = data.checklist.filter(item => item.priority === 'must' && !data.text.includes(item.name)).map(item => ({ kind: 'missing', item: item.id, note: `${item.name} is not explained.` }));
  if (unsupported.includes(data.point.title)) issues.push({ kind: 'unsupported', quote: 'A claim', note: 'Not in the pages.' });
  return { issues };
}

const examAnswer = data => ({ leaves: data.leaves.map(leaf => ({ id: leaf.id, note: `Asked as: ${String(leaf.questions[0] ?? '').slice(0, 40)}` })) });

/**
 * The fake model. Outline options as outlineModel; `invent`: each section also cites a quote that is in no material; `skip`: point titles the writer answers
 * with no text (the point fails); `omit`: how many must items the writer leaves out of each section; `stubborn`: point titles whose repair leaves them out
 * again (the point ends short); `unsupported`: point titles the reviewer always finds an unsupported claim in; `renameMap`: the outline's order gives every
 * leaf a new title; `junk(call, calls)`; `held`: { at | stage, gate }; `fail(call, calls)`: throw.
 */
export function bookModel({ invent = false, skip = [], omit = 0, stubborn = [], unsupported = [], renameMap = false, junk, held, fail, ...outline } = {}) {
  const base = outlineModel(outline), calls = [], opts = { invent, skip, omit, stubborn, unsupported, renameMap };
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt), call = { stage: data.stage, data, request, system, prompt };
    calls.push(call);
    if (held && (held.stage ? call.stage === held.stage && !held.taken && (held.taken = true) : calls.length === held.at)) await held.gate.promise;
    if (fail?.(call, calls)) throw new Error('provider down');
    if (junk?.(call, calls)) { reportUsage({ uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }); return 'Not JSON at all.'; }
    if (['write', 'review', 'repair', 'place', 'exam'].includes(data.stage)) {
      reportUsage({ uncachedInputTokens: 100, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 });
      const must = (data.checklist || []).filter(item => item.priority === 'must'), all = data.checklist || [];
      if (data.stage === 'write') {
        if (opts.skip.includes(data.point.title)) return JSON.stringify({ text: '', covered: [], quotes: [] });
        const left = must.slice(Math.max(0, must.length - opts.omit)).map(item => item.id);
        return JSON.stringify(section(data, all.filter(item => !left.includes(item.id)), opts));
      }
      if (data.stage === 'review') return JSON.stringify(review(data, opts));
      if (data.stage === 'repair') {
        const keep = opts.stubborn.includes(data.point.title) ? all.filter(item => !data.missing.includes(item.id)) : all;
        return JSON.stringify(section(data, keep, { invent: false }));
      }
      if (data.stage === 'place') return JSON.stringify({ places: data.items.map(item => ({ item: item.id, point: 'k1' })) });
      return JSON.stringify(examAnswer(data));
    }
    let text = await base.complete(system, prompt, request);
    if (!['reduce', 'order'].includes(data.stage)) return text;
    const value = JSON.parse(text.replace(/^```json\n|\n```$/g, '')), known = new Map(data.points.map(point => [point.id, point.title]));
    // A course whose points no chapter of the outline fake names (a short course of its own): one chapter holds them all.
    const ids = entry => (Array.isArray(entry) ? entry : [entry]);
    const placed = value.chapters.some(chapter => [...(chapter.points || []), ...(chapter.sections || []).flatMap(section => section.points)].some(entry => ids(entry).some(id => known.has(id))));
    if (!placed) return JSON.stringify({ basis: ['logic'], chapters: [{ title: 'Everything', intro: 'The whole course.', points: data.points.map(point => point.id) }] });
    // The same points under other names: every leaf's title (and so its node id) changes, its anchors do not.
    if (opts.renameMap) {
      const rename = list => list.map(entry => ({ title: `${known.get(ids(entry)[0]) ?? 'Point'} (revised)`, points: ids(entry) }));
      for (const chapter of value.chapters) { if (chapter.points) chapter.points = rename(chapter.points); for (const section of chapter.sections || []) section.points = rename(section.points); }
      return JSON.stringify(value);
    }
    return text;
  };
  // `opts` may be changed between builds (the same model answering differently later).
  return { calls, complete, opts, of: stage => calls.filter(call => call.stage === stage), stages: () => calls.map(call => call.stage) };
}
