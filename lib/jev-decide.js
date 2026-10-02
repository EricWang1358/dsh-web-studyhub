import { mapLimit, createBreaker } from './jev-runtime.js';
import { jevFallbackMessage } from './jev-messages.js';

/* EXPERIMENTAL. THE seam for "replace a model decision with Jev" (sites: lib/jev-sites.js).

   A call site that today asks the study model (or a sub-agent) for a decision-shaped answer hands its items to `replaceWithJev` together
   with `fallback`, the CURRENT model path, unchanged. What happens:

     - The site is not switched on (master switch or its own switch off): `fallback(items)` runs once, over all items in their
       original order, before anything else: the model call sequence is exactly what it was. Jev is not contacted, not mentioned.
     - The site is switched on: each item becomes one tiny typed request (`build`), Jev's answer is read back into the shape the site
       needs (`read`). An item Jev answered with at least the learner's confidence (`threshold`) is DECIDED BY JEV. Everything else (low
       confidence, an input Jev cannot take, a failing, rate-limited or unreachable Jev, a missing key or confirmation) goes to
       `fallback`, in ONE call, as one list in the original order: the model path never runs per item.
     - The result says what happened: every entry carries `by` ('jev' or 'model'), and the summary carries the counts, the tokens (Jev's,
       counted apart) and ONE fallback notice for the whole run (reason, count, a plain sentence), never one per item.

   Nothing is ever applied here: the site decides what to do with the values exactly as it did with the model's. A cancelled run (an
   aborted signal) and a failing `fallback` reject as they always did.

   `build(item)` may return null for an item that cannot be put to Jev at all (nothing is sent for it: it goes to the model as 'unsupported').
   `read(answers, item)` resolves `{ value, confidence, detail? }` (confidence 0-1: how sure Jev is about THIS decision) or `null` for an
   input it cannot judge. */

const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0 });
const QUIET = new Set(['off', 'feature-off']);

export async function replaceWithJev({ runtime, site, items, build, read, fallback, threshold = 0.8, language = 'zh', signal, concurrency = 4, provider }) {
  const list = Array.isArray(items) ? items : [];
  const answerAll = async which => {
    if (!which.length) return [];
    const values = await fallback(which);
    if (!Array.isArray(values) || values.length !== which.length) throw new TypeError('The model path must answer every item it was given');
    return values;
  };
  const summary = (extra = {}) => ({ site, enabled: false, jev: 0, model: list.length, usage: zero(), fallback: null, ...extra });

  const gate = await runtime.gate(site), named = provider ?? gate.provider;
  if (!gate.ok) {
    // Closed: the model path, once, exactly as before. Only a switch that IS on but cannot work (no key, no confirmation) is worth saying.
    const values = QUIET.has(gate.reason) ? await fallback(list) : await answerAll(list);
    const results = list.map((item, index) => ({ item, by: 'model', value: values[index] }));
    if (QUIET.has(gate.reason)) return { results, summary: summary() };
    return { results, summary: summary({ enabled: true, fallback: list.length ? note(gate.reason, list.length) : null }) };
  }

  const usage = zero(), breaker = createBreaker(), decided = new Array(list.length).fill(null), reasons = new Array(list.length).fill(null);
  let firstFailure = null;
  await mapLimit(list, concurrency, async (item, index) => {
    const request = build(item);
    if (!request) { reasons[index] = 'unsupported'; return; }
    const result = await runtime.run(site, request.state, request.questions, { signal, language });
    breaker.note(result);
    if (!result.ok) { reasons[index] = result.reason; firstFailure ??= result.reason; return; }
    usage.calls++; usage.inputTokens += result.usage.inputTokens; usage.outputTokens += result.usage.outputTokens;
    let reading = null;
    try { reading = read(result.answers, item); } catch { reading = null; }
    if (!reading || reading.value === undefined) { reasons[index] = 'unsupported'; return; }
    if (!(reading.confidence >= threshold)) { reasons[index] = 'low-confidence'; return; }
    decided[index] = reading;
  }, { stop: () => breaker.open });

  // An item the run never reached (the breaker opened) is undecided for the reason that opened it.
  const rest = [];
  list.forEach((item, index) => { if (!decided[index]) { reasons[index] ??= firstFailure ?? 'unavailable'; rest.push(index); } });
  const values = await answerAll(rest.map(index => list[index]));
  const results = list.map((item, index) => {
    if (decided[index]) return { item, by: 'jev', value: decided[index].value, confidence: decided[index].confidence, ...(decided[index].detail !== undefined ? { detail: decided[index].detail } : {}) };
    return { item, by: 'model', value: values[rest.indexOf(index)] };
  });
  // The single reason of the run: a typed failure first (it explains the rest), then an unsupported input, then low confidence.
  const typed = rest.map(index => reasons[index]).find(reason => reason !== 'unsupported' && reason !== 'low-confidence');
  const reason = typed ?? (rest.some(index => reasons[index] === 'unsupported') ? 'unsupported' : rest.length ? 'low-confidence' : null);
  return { results, summary: summary({ enabled: true, jev: list.length - rest.length, model: rest.length, usage, fallback: rest.length ? note(reason, rest.length) : null }) };

  function note(why, count) { return { reason: why, count, message: jevFallbackMessage(why, { count, threshold, language, provider: named }) }; }
}
