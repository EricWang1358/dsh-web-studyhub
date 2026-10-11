/* A fake model for the 复习全书 build: the outline stages are answered by the course outline's fake (tests/helpers/course-outline-library.mjs), the notes and
   考情 stages here, the way a plausible model would: a key point and an explanation per knowledge point, each resting on a quote copied from its first material.
   No real model, no network. */
import { reportUsage } from '../../lib/usage-scope.js';
import { outlineModel } from './course-outline-library.mjs';

const requestData = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nYour previous reply')[0]);
export const INVENTED = 'This sentence is not written in any of the materials at all.';

/** The first words of a text, cut at a word: what a model copies as a quote. */
const opening = text => { const words = text.replace(/\s+/g, ' ').trim().split(' '); let quote = ''; for (const word of words) { if ((`${quote} ${word}`).length > 60) break; quote = `${quote} ${word}`.trim(); } return quote; };

function notesAnswer(data, { invent, skip = [], takeaway = false }) {
  return { leaves: data.leaves.filter(leaf => !skip.includes(leaf.title)).map(leaf => {
    const [first] = leaf.materials, example = leaf.materials.find(material => /Example:/.test(material.text));
    // `takeaway`: the explanation opens with 一句话 drawn from the material itself, so a changed material is a changed one-line summary.
    const lead = takeaway ? `一句话：${opening(first.text)}。` : '';
    return { id: leaf.id, points: [`${leaf.title}: what it is and why it matters [1]`, 'The steps to remember'],
      explain: `${lead}${leaf.title}, explained for a beginner with $x^2$.${invent ? ' A claim that rests on nothing [2].' : ''}`,
      example: example ? 'Example: one worked step after another [1]' : '', extra: ['A general intuition the materials do not give [1]'],
      quotes: [{ n: 1, ref: 'S1', quote: opening(first.text) }, ...(invent ? [{ n: 2, ref: 'S1', quote: INVENTED }] : [])] };
  }) };
}

/** Bridges as a plausible model writes them: from the point before (or the chapter), on to the next (or the chapter's wrap-up). */
const bridgeAnswer = data => ({ points: data.points.map(point => ({ id: point.id, in: point.before ? `After ${point.before.title} comes ${point.title}.` : `${data.chapter} opens with ${point.title}.`,
  out: point.after ? `That leads on to ${point.after.title}.` : '', wrap: point.after ? '' : `That closes ${data.chapter}.` })) });

const examAnswer = data => ({ leaves: data.leaves.map(leaf => ({ id: leaf.id, note: `Asked as: ${String(leaf.questions[0] ?? '').slice(0, 40)}` })) });

/**
 * The fake model. Outline options as outlineModel; `invent`: each explanation also cites a quote that is in no material; `skip`: leaf titles the notes answer
 * leaves out; `takeaway`: each explanation opens with 一句话 taken from its first material; `renameMap`: the reduce stage gives every leaf a new title (an outline rebuilt with other names, so other node ids); `junk(call, calls)`;
 * `held`: { at, gate } holds that call; `fail(call, calls)`: throw.
 */
export function bookModel({ invent = false, skip, renameMap = false, takeaway = false, junk, held, fail, ...outline } = {}) {
  const base = outlineModel(outline), calls = [], opts = { invent, skip, renameMap, takeaway };
  const complete = async (system, prompt, request) => {
    const data = requestData(prompt), call = { stage: data.stage, data, request, system, prompt };
    calls.push(call);
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail?.(call, calls)) throw new Error('provider down');
    if (junk?.(call, calls)) { reportUsage({ uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }); return 'Not JSON at all.'; }
    if (data.stage === 'notes' || data.stage === 'exam' || data.stage === 'bridge') {
      reportUsage({ uncachedInputTokens: 100, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return JSON.stringify(data.stage === 'notes' ? notesAnswer(data, opts) : data.stage === 'bridge' ? bridgeAnswer(data) : examAnswer(data));
    }
    let text = await base.complete(system, prompt, request);
    if (data.stage !== 'reduce') return text;
    const value = JSON.parse(text.replace(/^```json\n|\n```$/g, '')), known = new Map(data.points.map(point => [point.id, point.title]));
    // A course whose points no chapter of the outline fake names (one short material): one chapter holds them all.
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
