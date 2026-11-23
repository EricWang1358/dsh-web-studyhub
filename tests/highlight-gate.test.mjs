/* Opening a material beside a question, and every chapter after it, stalled (a reader's report, 2026-11-19: 「链接原文资料库的时候卡」). Measured on a book
   of 800 pages at 1440 px: each element of the chapter resolved 18 styles, its own and one for each of the reader's 17 ::highlight() rules, whether or
   not that highlight existed: 14,000 resolutions, about 200 ms, to draw 800 elements. Each rule now also asks for its own name on its holder
   (`data-highlights`), and ui/highlight-gate.js keeps that attribute equal to the names the registry holds. Two halves must hold for a highlight to be
   drawn at all, and both are pinned here: every rule is gated by its own name, and every write to the registry goes through the gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, walk } from '../scripts/qa/guardrail-baseline.mjs';
import { HIGHLIGHT_GATE, HIGHLIGHT_HOLDERS, UNGATED_HIGHLIGHTS, gateValue, gatedRegistry, syncHighlightGate } from '../ui/highlight-gate.js';

/** A holder as the gate sees it: an attribute, and how many times it was written. */
function holder(initial) {
  const attrs = new Map(initial === undefined ? [] : [[HIGHLIGHT_GATE, initial]]);
  return { writes: 0, getAttribute: name => attrs.get(name) ?? null,
    setAttribute(name, value) { this.writes++; attrs.set(name, value); }, removeAttribute(name) { this.writes++; attrs.delete(name); } };
}
/** A page with these holders by selector; a selector it was not given has none. */
const page = (bySelector) => ({ asked: [], querySelectorAll(selector) { this.asked.push(selector); return bySelector[selector] || []; } });
const READER = '.reader-page', BOOK = '.book-page', QUESTION = '.review-body';
const gate = item => item.getAttribute(HIGHLIGHT_GATE);

test('a holder lists the registry\'s names of its own families, sorted, and nothing else', () => {
  const registry = new Map([['study-mark-bold', {}], ['study-find', {}], ['study-find-current', {}], ['study-finder', {}], ['study-term-seen', {}],
    ['someone-elses', {}], ['study-source-quote', {}]]);
  assert.equal(gateValue(registry, HIGHLIGHT_HOLDERS[READER]), 'study-find study-find-current study-mark-bold');
  assert.equal(gateValue(registry, HIGHLIGHT_HOLDERS[BOOK]), 'study-find study-find-current', 'a family is its name and what follows it after a dash');
  assert.equal(gateValue(registry, HIGHLIGHT_HOLDERS[QUESTION]), 'study-term-seen');
  assert.equal(gateValue(new Map(), HIGHLIGHT_HOLDERS[READER]), '');
  assert.ok(Object.hasOwn(UNGATED_HIGHLIGHTS, 'study-source-quote'), 'the quote is always on under the viewer');
  for (const families of Object.values(HIGHLIGHT_HOLDERS)) assert.equal(gateValue(new Map([['study-source-quote', {}]]), families), '', 'so no holder lists it');
});

test('a sync writes every holder that differs and leaves the others alone (a written attribute restyles what is under it)', () => {
  const registry = new Map([['study-find', {}]]);
  const fresh = holder(), same = holder('study-find'), stale = holder('study-find study-mark-bold'), question = holder();
  const doc = page({ [READER]: [fresh, same, stale], [QUESTION]: [question] });
  syncHighlightGate(registry, doc);
  assert.deepEqual(doc.asked, Object.keys(HIGHLIGHT_HOLDERS));
  assert.deepEqual([fresh, same, stale].map(gate), ['study-find', 'study-find', 'study-find']);
  assert.deepEqual([fresh.writes, same.writes, stale.writes, question.writes], [1, 0, 1, 0]);
  registry.clear();
  syncHighlightGate(registry, doc);
  assert.deepEqual([fresh, same, stale].map(gate), [null, null, null], 'no highlight left: the attribute goes');
  syncHighlightGate(null, doc);
  syncHighlightGate(registry, null);
});

/* The material beside a question is a chapter of hundreds of elements, and a change of the attribute on its holder restyles them all. A word marked in
   the question, and the words the course already knows painted on every question, are the question's own highlights: they must not touch the reader's
   holder (a gate reviewer's finding on the first cut, which listed every name on every holder). */
test('a highlight of the question is not written on the reader beside it, nor the reader\'s on the question', () => {
  const reader = holder(), book = holder(), question = holder();
  const doc = page({ [READER]: [reader], [BOOK]: [book], [QUESTION]: [question] });
  const registry = new Map([['study-term-seen', {}], ['study-term-candidate', {}]]);
  syncHighlightGate(registry, doc);
  assert.deepEqual([gate(reader), gate(book), gate(question)], [null, null, 'study-term-candidate study-term-seen']);
  assert.deepEqual([reader.writes, book.writes, question.writes], [0, 0, 1]);
  registry.set('study-link-question', {});
  registry.set('study-find', {});
  syncHighlightGate(registry, doc);
  assert.deepEqual([gate(reader), gate(book), gate(question)], ['study-find study-link-question', 'study-find', 'study-term-candidate study-term-seen']);
  assert.equal(question.writes, 1, 'the reader\'s links and the find leave the question alone');
});

test('the writes of one turn reach the holders once, after them; a layer painted again with the same names writes nothing', () => {
  const registry = new Map(), reader = holder(), readers = [reader], doc = page({ [READER]: readers });
  const turns = [];
  const turn = () => { while (turns.length) turns.shift()(); };
  const gated = gatedRegistry(registry, doc, run => turns.push(run));
  const mark = { priority: 0 };
  gated.set('study-mark-highlight', mark);
  gated.set('study-link-qa', {});
  assert.equal(gate(reader), null, 'not before the turn is over');
  assert.equal(turns.length, 1, 'two writes, one sync asked for');
  assert.equal(gated.get('study-mark-highlight'), mark, 'the registry itself is written at once');
  assert.equal(gated.has('study-mark-highlight'), true);
  turn();
  assert.equal(gate(reader), 'study-link-qa study-mark-highlight');
  assert.equal(reader.writes, 1);

  // The link layer after an answer: every name out, then the same names back in.
  assert.equal(gated.delete('study-link-qa'), true);
  assert.equal(gated.delete('study-link-question'), false, 'deleting a name that is not there');
  gated.set('study-link-qa', {});
  turn();
  assert.equal(reader.writes, 1, 'the attribute is as it was: nothing is written, nothing restyled');

  // A holder drawn since the last write is marked by the next one, even one that changes no name.
  const late = holder();
  readers.push(late);
  gated.delete('study-find');
  turn();
  assert.equal(gate(late), 'study-link-qa study-mark-highlight');
  gated.delete('study-mark-highlight');
  gated.delete('study-link-qa');
  turn();
  assert.deepEqual([gate(reader), gate(late)], [null, null]);
});

test('without a turn of its own the gated registry syncs in a microtask: before the browser draws', async () => {
  const registry = new Map(), reader = holder(), doc = page({ [READER]: [reader] });
  gatedRegistry(registry, doc).set('study-find', {});
  assert.equal(gate(reader), null);
  await Promise.resolve();
  assert.equal(gate(reader), 'study-find');
});

const cssFiles = () => walk(join(ROOT, 'ui'), ['.css']).map(file => ({ rel: relative(ROOT, file).split('\\').join('/'), css: readFileSync(file, 'utf8') }));
/** The last selector of a list (commas inside :not(...) and [...] are not the list's). */
function lastOfList(text) {
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '[') depth++;
    else if (text[i] === ')' || text[i] === ']') depth--;
    else if (text[i] === ',' && depth === 0) start = i + 1;
  }
  return text.slice(start).trimStart(); // the space before `::highlight` is the descendant combinator: kept
}
/** Every `<selector>::highlight(name)` of a stylesheet, comments left out: [selector up to the pseudo-element, name]. */
const highlightRules = css => [...css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{};]*)::highlight\(([^)]+)\)/g)].map(match => [lastOfList(match[1]), match[2].trim()]);

test('every ::highlight() rule asks for its own name on a holder, or is one of the always-on ones under its own element', () => {
  assert.deepEqual(highlightRules('.a { x: y; }\n.reader-page[data-highlights~="study-find"] :not(.katex)::highlight(study-find) { color: red; }'),
    [['.reader-page[data-highlights~="study-find"] :not(.katex)', 'study-find']]);
  assert.deepEqual(highlightRules('.x ::highlight(a) {} .y, .x::highlight(b) {}'), [['.x ', 'a'], ['.x', 'b']]);
  const found = [], wrong = [];
  for (const { rel, css } of cssFiles()) for (const [selector, name] of highlightRules(css)) {
    found.push(name);
    const scope = UNGATED_HIGHLIGHTS[name];
    // Gated: on a holder, by this very name, and that holder lists the name's family (or the gate would never write it there and the rule never draw).
    const gatedOn = Object.keys(HIGHLIGHT_HOLDERS).find(holder => selector.startsWith(`${holder}[${HIGHLIGHT_GATE}~="${name}"] `));
    const ok = scope ? selector.startsWith(`${scope} `) : !!gatedOn && gateValue(new Map([[name, {}]]), HIGHLIGHT_HOLDERS[gatedOn]) === name;
    if (!ok) wrong.push(`${rel}: ${selector}::highlight(${name})`);
  }
  assert.ok(found.length >= 20, `the highlight rules are still found (${found.length})`);
  assert.deepEqual(wrong, []);
  assert.ok(found.every(name => name.startsWith('study-')), 'the gate lists study-* names only');
});

test('only the gate touches the highlight registry: a write around it would be registered and never drawn', () => {
  const direct = [];
  for (const file of walk(join(ROOT, 'ui'), ['.js', '.jsx'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel === 'ui/highlight-gate.js') continue;
    if (/CSS\??\.highlights/.test(readFileSync(file, 'utf8'))) direct.push(rel);
  }
  assert.deepEqual(direct, []);
});
