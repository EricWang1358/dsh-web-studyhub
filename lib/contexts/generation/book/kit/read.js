import { parseJson } from '../../../../generation.js';
import { KIT_LIMITS } from '../../../../course-book-exam-kit.js';

/* Reading the answer of one exam answer kit call. Nothing is trusted: an answer that is not the shape asked for is null (asked once more); a type id that was
   not asked is ignored; a type without a name or a template is not answered (asked again by the next build); a trigger word is kept only when one of the type's
   questions holds it; a fill is kept only for a question of that type, once, and mapped back from its alias to the question's own id. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const squash = value => value.replace(/\s+/g, ' ').toLowerCase();

/** One type's answer, or null. `type`: the type asked; `aliases`: Map(alias -> question id) of the call. */
function typeAnswer(raw, type, aliases) {
  const name = text(raw.name, KIT_LIMITS.nameChars), template = text(raw.template, KIT_LIMITS.templateChars);
  if (!name || !template) return null;
  const words = type.questions.map(question => squash(question.text)), mine = new Set(type.questions.map(question => question.id)), seen = new Set();
  const signals = [...new Set((Array.isArray(raw.signals) ? raw.signals : []).map(signal => text(signal, KIT_LIMITS.signalChars))
    .filter(signal => signal && words.some(question => question.includes(squash(signal)))))].slice(0, KIT_LIMITS.signals);
  const fills = (Array.isArray(raw.fills) ? raw.fills : []).filter(object).map(fill => ({ question: aliases.get(String(fill.question ?? '').trim()),
    fill: text(fill.fill, KIT_LIMITS.fillChars) })).filter(fill => mine.has(fill.question) && fill.fill && !seen.has(fill.question) && seen.add(fill.question));
  return { name, signals, asks: text(raw.asks, KIT_LIMITS.asksChars), template, fills };
}

/** @returns null, or `{ types: Map(index of the type in the call -> { name, signals, asks, template, fills: [{ question, fill }] }) }`. */
export function readKit(answer, batch) {
  let value;
  try { value = parseJson(String(answer)); } catch { return null; }
  if (!object(value) || !Array.isArray(value.types)) return null;
  const aliases = new Map(batch.types.flatMap(type => type.questions).map((question, at) => [`q${at + 1}`, question.id])), types = new Map();
  for (const raw of value.types.filter(object)) {
    const at = Number(/^t(\d+)$/.exec(String(raw.id ?? '').trim())?.[1]) - 1, type = batch.types[at];
    if (!type || types.has(at)) continue;
    const got = typeAnswer(raw, type, aliases);
    if (got) types.set(at, got);
  }
  return { types };
}
