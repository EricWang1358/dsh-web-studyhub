import { leavesOf } from './prompt.js';

/* The exam answer kit as the notes store it (lib/course-book-exam-kit.js), from the plan (book/kit/plan.js) and what its calls wrote: each type the saved kit
   already had (same print) or a call wrote, in the plan's order, linked by the PROGRAM to the points whose paper places hold its questions. A type no call
   wrote is left out and counted in `missing` (the next build asks only those). Pure. */

const stored = ({ id, paper, title, label, quote, sourceId, start, end }) => ({ id, paper, title, label, quote, sourceId,
  ...(Number.isInteger(start) ? { start, end } : {}) });

/** @param kit planKit's answer; `written`: Map(type print -> { name, signals, asks, template, fills }). -> the kit to store, or null when no type was written. */
export function assembleKit(kit, written) {
  if (kit.reuse) return kit.reuse;
  let missing = 0;
  const types = [];
  for (const type of kit.types) {
    const content = type.kept ?? written.get(type.print);
    if (!content) { missing++; continue; }
    types.push({ print: type.print, name: content.name, family: type.family, signals: content.signals, asks: content.asks, template: content.template,
      questions: type.questions.map(question => question.id), fills: content.fills, leaves: leavesOf(type, kit.order) });
  }
  if (!types.length) return null;
  return { fingerprint: kit.fingerprint, language: kit.language, ...(missing ? { missing } : {}), questions: kit.questions.map(stored), types };
}
