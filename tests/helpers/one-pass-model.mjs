import { stageSystem } from '../../lib/prompt-order.js';
import { WRITE_SYSTEM, REWRITE_SYSTEM, REVIEW_SYSTEM } from '../../lib/one-pass/prompts.js';
import { requestData } from './request-data.mjs';

/* A recording fake model for one pass (lib/one-pass/). It answers the three prompts from what they carry: a write call gets, for every section it is given,
   as many cards as its quota, each quoting a different sentence of that section; a rewrite evens the options; a review passes every card. Each answer can be
   replaced per test (`write`, `rewrite`, `review`), and every call is kept in `calls` with the stage it was, its data and its context. */

const sentencesOf = text => String(text).split(/(?<=\.)\s+/).map(item => item.trim()).filter(item => item.length >= 20 && !item.startsWith('#'));
const EVEN = ['It keeps the value below the stated limit', 'It doubles the value at every single step', 'It resets the value when a reading fails', 'It ignores the value until the week ends'];

/** The card a write call returns for sentence `quote` of section `label` (the `n`-th card of the reply): four options of equal length, the first correct. */
export function cardFor(label, quote, n) {
  return { section: label, topic: `Limits ${label}`, objective: `Apply rule ${n} of ${label}: ${quote.slice(0, 40)}`, quote,
    prompt: `A technician checks reading ${n} in section ${label}. Which statement describes what must happen?`, hint: 'Compare each option with the rule for that reading.',
    options: EVEN.map((text, index) => ({ text, correct: index === 0, explanation: index === 0 ? 'The rule sets exactly this limit for the reading.' : 'A common confusion with another rule.' })),
    explanation: 'The rule caps the reading below its limit, so the value must stay under it; the other options describe behaviour the rule never states. Reusable rule: read the limit first, then compare.',
    misconception: 'Thinking the rule changes the value instead of capping it.' };
}

/** Every card the sections of a write call ask for, quote by quote in each section's own text. */
export function writeAll(data) {
  let n = 0;
  return (data.sections || []).flatMap(({ section, quota }) => {
    const text = (data.sources || []).filter(source => source.section === section).map(source => source.text).join(' ');
    return sentencesOf(text).slice(0, quota).map(quote => cardFor(section, quote, ++n));
  });
}

const stageOf = system => (system.startsWith(WRITE_SYSTEM) ? 'write' : system.startsWith(REWRITE_SYSTEM) ? 'rewrite' : system.startsWith(REVIEW_SYSTEM) ? 'review' : 'other');

export function onePassModel({ write = writeAll, rewrite = data => ({ cards: data.cards.map(card => ({ index: card.index, options: card.options })) }),
  review = data => ({ reviews: data.cards.map(card => ({ index: card.index, verdict: 'pass', blocker: 0, issue: '' })) }), raw = {} } = {}) {
  const calls = [];
  const complete = async (system, prompt, context = {}) => {
    const stage = stageOf(stageSystem(system, prompt)), data = requestData(prompt), number = calls.filter(call => call.stage === stage).length + 1;
    calls.push({ stage, system, prompt, data, context });
    if (raw[stage]) { const value = raw[stage](data, number); if (typeof value === 'string') return value; }
    if (stage === 'write') return JSON.stringify({ cards: write(data, number) });
    if (stage === 'rewrite') return JSON.stringify(rewrite(data, number));
    if (stage === 'review') return JSON.stringify(review(data, number));
    return '{}';
  };
  return { complete, calls };
}

/** A material of `sections` headed sections ("## Name"), each of `sentences` distinct sentences, with the assignments of a coverage plan over it (quota per section). */
export function material({ sections = 3, sentences = 4, quota = 2, id = 'doc', names } = {}) {
  const titles = names || Array.from({ length: sections }, (_, index) => `Topic ${String.fromCharCode(65 + index)}`);
  const bodies = titles.map(title => `## ${title}\n\n${Array.from({ length: sentences }, (_, index) =>
    `In ${title} the reading number ${index + 1} must stay below ${100 + index} units during the ${['morning', 'noon', 'evening', 'night', 'weekend', 'audit'][index % 6]} check ${index + 1}.`).join(' ')}`);
  const text = bodies.join('\n\n');
  let cursor = 0;
  const assignments = bodies.map((body, index) => {
    const start = text.indexOf(body, cursor), end = start + body.length;
    cursor = end;
    return { key: `${id}#h${index + 1}`, sectionId: `${id}#h${index + 1}`, sourceId: id, start, end, quota: Array.isArray(quota) ? quota[index] : quota, title: titles[index] };
  });
  return { source: { id, title: 'Measurements', text }, text, assignments };
}
