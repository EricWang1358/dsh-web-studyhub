/* The order of the 复习全书's write, review and repair requests (#708: 5 % of the input came from the cache). A provider serves a request from its cache only up
   to the longest prefix IDENTICAL to an earlier one's (lib/prompt-order.js), so what is the same for every request of a build leads (one system text, the
   approved sample), then the point's own data, the same for every stage of that point (its checklist and pages), and only then the stage's brief, rules and
   what that stage alone reads (the draft, the review). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairPrompt, reviewPrompt, writePrompt } from '../lib/contexts/generation/book/prompts.js';
import { readReview } from '../lib/contexts/generation/book/read.js';
import { judge } from '../lib/contexts/generation/book/coverage.js';

const page = (tag, n) => Array.from({ length: n }, (_, i) => `Sentence ${i} of ${tag}: the mechanism holds under condition ${i % 7}.`).join(' ');
const unitOf = tag => ({ n: 1, of: 1, segments: [{ material: `${tag} slides`, page: 3, text: page(tag, 60) }],
  checklist: [{ alias: 'c1', id: `${tag}-1`, kind: 'term', name: `Term-${tag}`, gist: 'what it is', priority: 'must', page: 3 }] });
const leafOf = tag => ({ title: `Point ${tag}`, path: ['Chapter 1'], before: 'Earlier point', after: 'Later point', tested: tag === 'b' });
const anchor = { exemplar: 'An approved explanation: what it is, why it matters, how it is used.', band: { low: 180, high: 320 } };
const planOf = (extra = {}) => ({ language: 'zh', pitchLanguage: 'en', ...extra });
const draft = { text: 'A written section [^1].', cites: [{ n: 1, quote: 'Sentence 0 of a' }], claimed: [] };
const verdict = { round: 1, missing: [{ alias: 'c1' }], issues: [{ kind: 'missing', item: 'a-1', alias: 'c1', note: '' }] };
const full = request => `${request.system}\u0000${request.prompt}`;
const common = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

test('two points\' write requests share an identical prefix up to the per-point data, the approved sample included', () => {
  for (const plan of [planOf(), planOf({ anchor })]) {
    const a = full(writePrompt(unitOf('a'), leafOf('a'), plan)), b = full(writePrompt(unitOf('b'), leafOf('b'), plan));
    const shared = a.slice(0, common(a, b));
    const point = a.indexOf('"point":');
    assert.ok(point > 0, 'the point is in the data');
    assert.ok(shared.length >= point, 'everything before the point is the same for both points');
    if (plan.anchor) assert.ok(shared.includes(anchor.exemplar), 'the approved sample is part of the shared start');
    // The term cards' definition (#710 S1) depends only on the build's languages: it is part of the shared start, the pitch language with it.
    assert.ok(shared.includes('TERM CARDS') && shared.includes('"pitch"') && /written in English, "relations"/.test(shared), 'the card rule is in the shared start');
    // Nothing that differs per point comes before the point's data: no title, no checklist, no page.
    assert.ok(!shared.includes('Point a') && !shared.includes('Term-a') && !shared.includes('Sentence 0 of a'));
  }
});

test('the write, review and repair of one point share an identical prefix through its pages; what differs per stage comes after them', () => {
  const plan = planOf({ anchor }), unit = unitOf('a'), leaf = leafOf('a');
  const [write, review, repair] = [writePrompt(unit, leaf, plan), reviewPrompt(unit, leaf, draft, plan), repairPrompt(unit, leaf, draft, verdict, plan)].map(full);
  const pagesEnd = write.indexOf(page('a', 60)) + page('a', 60).length;
  assert.ok(pagesEnd > page('a', 60).length);
  for (const other of [review, repair]) assert.ok(common(write, other) >= pagesEnd, 'the pages are inside the shared prefix');
  assert.ok(review.indexOf(draft.text) > review.indexOf(page('a', 60)), 'the draft follows the pages');
  assert.ok(repair.indexOf('"issues"') > repair.indexOf(page('a', 60)), 'the review follows the pages');
});

test('the approved sample: sent in every write with its length band; the review may flag a drift from it; without one nothing is said of it', () => {
  const unit = unitOf('a'), leaf = leafOf('a');
  const anchored = writePrompt(unit, leaf, planOf({ anchor })).prompt;
  assert.ok(anchored.includes(anchor.exemplar) && anchored.includes('180') && anchored.includes('320'));
  assert.match(reviewPrompt(unit, leaf, draft, planOf({ anchor })).prompt, /"drift"/);
  const plain = [writePrompt(unit, leaf, planOf()), reviewPrompt(unit, leaf, draft, planOf()), repairPrompt(unit, leaf, draft, verdict, planOf())];
  for (const request of plain) assert.ok(!/drift|APPROVED SAMPLE/.test(request.prompt), 'no sample, no word of one');
});

test('a "drift" from the sample is read and repaired when a repair is made, but never fails a section by itself', () => {
  const unit = { checklist: [{ alias: 'c1', id: 'x1', name: 'Threat model', priority: 'must' }] };
  const review = readReview(JSON.stringify({ issues: [{ kind: 'drift', note: 'Much shorter than the sample.' }], checked: ['c1'] }), unit);
  assert.deepEqual(review.issues.map(issue => issue.kind), ['drift']);
  const verdict = judge(unit, { text: 'The threat model is …', claimed: ['x1'] }, review, 0);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.issues.map(issue => issue.kind), ['drift'], 'kept, so a repair made for another reason fixes it too');
});
