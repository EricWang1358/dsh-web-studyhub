import test from 'node:test';
import assert from 'node:assert/strict';
import { writePortion } from '../lib/one-pass/portion.js';
import { settledPortion } from '../lib/one-pass/settle.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';
import { onePassModel, material, writeAll, cardFor } from './helpers/one-pass-model.mjs';

/* One portion of a one-pass run (plan §3, §10): one write call for every section of the portion with its own quota, the program checks, the re-ask of an
   empty section, the rewrite of options whose answer stands out, and the review in batches from quote windows. */

const run = (model, world, extra = {}) => writePortion({ complete: model.complete, request: { kind: 'quiz', language: 'English', sources: [world.source], ...extra.request },
  assignments: world.assignments, existing: extra.existing || [], random: () => 0.5 });

test('one write call writes every section of the portion; each section is told its own quota and nothing asks for a total', async () => {
  const world = material({ sections: 3, quota: [2, 1, 2] }), model = onePassModel();
  const result = await run(model, world);
  assert.deepEqual(model.calls.map(call => call.stage), ['write', 'review']);
  const asked = model.calls[0].data;
  assert.deepEqual(asked.sections.map(({ section, quota, title }) => [section, quota, title]), [['S1', 2, 'Topic A'], ['S2', 1, 'Topic B'], ['S3', 2, 'Topic C']]);
  assert.equal(asked.count, undefined, 'no count field');
  assert.doesNotMatch(model.calls[0].prompt, /\b5 (?:cards|questions)\b/, 'the total is never said');
  assert.deepEqual(asked.sources.map(source => source.section), ['S1', 'S2', 'S3']);
  assert.equal(model.calls[0].context.stage, 'Writing and self-checking questions');
  assert.equal(result.deck.cards.length, 5);
  assert.equal(result.targets.length, 5);
  assert.deepEqual(result.short, []);
  const perSection = new Map();
  for (const target of result.targets) perSection.set(target.sectionId, (perSection.get(target.sectionId) || 0) + 1);
  assert.deepEqual([...perSection.values()], [2, 1, 2]);
  for (const card of result.deck.cards) {
    const target = result.targets.find(item => item.targetId === card.targetId);
    assert.equal(world.text.slice(target.start, target.end), card.citations[0].quote, 'every card cites the place its target was verified in');
    assert.equal(card.options.filter(option => option.correct).length, 1);
  }
});

test('more cards than a section\'s quota: the extra one is dropped as over-quota and said in the notes', async () => {
  const world = material({ sections: 2, quota: 1 });
  const model = onePassModel({ write: data => writeAll({ ...data, sections: data.sections.map(item => ({ ...item, quota: 3 })) }) });
  const result = await run(model, world);
  assert.equal(result.deck.cards.length, 2);
  assert.ok(result.notes.some(line => /4 written card\(s\) dropped: over-quota/.test(line)), result.notes.join(' | '));
});

test('a section left with no card is asked again once, alone; still empty, it is recorded as short', async () => {
  const world = material({ sections: 3, quota: 2 });
  const model = onePassModel({ write: (data, number) => number === 1 ? writeAll({ ...data, sections: data.sections.filter(item => item.section !== 'S2' && item.section !== 'S3') })
    : data.sections[0].section === 'S2' ? writeAll(data) : [] });
  const result = await run(model, world);
  const writes = model.calls.filter(call => call.stage === 'write');
  assert.equal(writes.length, 3, 'the first write, then S2 and S3 once each');
  for (const [index, label] of [[1, 'S2'], [2, 'S3']]) {
    assert.deepEqual(writes[index].data.sections.map(item => item.section), [label], 'asked alone');
    assert.deepEqual(writes[index].data.sources.map(source => source.section), [label], 'given only its own text');
    assert.equal(writes[index].context.unit, `section-${label}`);
  }
  assert.equal(result.deck.cards.length, 4);
  assert.deepEqual(result.short.map(item => [item.sectionId, item.quota, item.planned, item.missing]), [['doc#h3', 2, 0, 2]]);
  assert.equal(result.short[0].returned, 0);
});

test('a quote that is not in the material, and a duplicate, are dropped by the program before any review', async () => {
  const world = material({ sections: 1, quota: 3 });
  const model = onePassModel({ write: data => { const [first, second] = writeAll(data);
    return [first, { ...second, quote: 'A sentence that the material never says anywhere at all.' }, { ...second, objective: first.objective }]; } });
  const result = await run(model, world);
  assert.equal(result.deck.cards.length, 1);
  assert.ok(result.notes.some(line => /dropped: quote-not-found/.test(line)));
  assert.ok(result.notes.some(line => /dropped: duplicate/.test(line)));
  assert.equal(model.calls.find(call => call.stage === 'review').data.cards.length, 1, 'only the checked card is reviewed');
});

test('an answer that stands out by its length is sent back once to have its options rewritten, and dropped if it still does', async () => {
  const world = material({ sections: 1, quota: 3 });
  const long = card => ({ ...card, options: card.options.map(option => option.correct ? { ...option, text: `${option.text}, as the rule for this exact reading and every later reading requires` } : option) });
  const model = onePassModel({
    write: data => { const [a, b, c] = writeAll(data); return [a, long(b), long(c)]; },
    // The rewrite evens the first card it is given and leaves the second as it was.
    rewrite: data => ({ cards: data.cards.map(card => ({ index: card.index, options: card.index === 0 ? card.options.map(option => option.correct ? { ...option, text: 'It keeps the value below its limit' } : option) : card.options })) }),
  });
  const result = await run(model, world);
  const rewrites = model.calls.filter(call => call.stage === 'rewrite');
  assert.equal(rewrites.length, 1, 'one rewrite call for the portion');
  assert.equal(rewrites[0].data.cards.length, 2, 'with both cards whose answer stands out');
  assert.equal(rewrites[0].context.stage, 'Repairing flagged questions within this run');
  assert.equal(result.deck.cards.length, 2);
  assert.ok(result.deck.cards.some(card => card.answer === 'It keeps the value below its limit'), 'the rewritten options are kept');
  const omitted = result.deck.editorial.omitted;
  assert.equal(omitted.length, 1);
  assert.match(omitted[0].reasons.join(' '), /option cue \(length\)/);
  assert.equal(result.targets.length, 3, 'the dropped card was a verified target: the draft says what became of it');
});

test('the review judges at most 7 cards a call, each from its quote and the text around it, never the whole material', async () => {
  const world = material({ sections: 2, sentences: 6, quota: [5, 4] }), model = onePassModel();
  const result = await run(model, world);
  const reviews = model.calls.filter(call => call.stage === 'review');
  assert.deepEqual(reviews.map(call => call.data.cards.length), [ONE_PASS_LIMITS.reviewBatch, 2]);
  assert.deepEqual(reviews.map(call => call.context.unit), ['batch-1', 'batch-2']);
  assert.ok(reviews.every(call => call.context.stage === 'Reviewing ambiguity and source support'));
  for (const call of reviews) {
    assert.ok(!call.prompt.includes(world.text), 'not the whole material');
    for (const card of call.data.cards) {
      assert.ok(card.evidence.around.includes(card.evidence.quote), 'the window holds the quote');
      assert.ok(card.evidence.around.length <= card.evidence.quote.length + 2 * ONE_PASS_LIMITS.windowChars);
      assert.ok(world.text.includes(card.evidence.around), 'cut from the material');
    }
  }
  assert.equal(result.deck.cards.length, 9);
});

test('a card the review fails is dropped (no repair in this slice) with the reviewer\'s words; a batch with no usable verdict is dropped as a review protocol failure', async () => {
  const world = material({ sections: 2, sentences: 6, quota: [5, 4] });
  const model = onePassModel({ raw: { review: (data, number) => (number >= 2 ? 'not json at all' : null) },
    review: data => ({ reviews: data.cards.map(card => ({ index: card.index, verdict: card.index === 1 ? 'fail' : 'pass', blocker: card.index === 1 ? 3 : 0, issue: card.index === 1 ? 'The hint gives the answer away.' : '' })) }) });
  const result = await run(model, world);
  const reviews = model.calls.filter(call => call.stage === 'review');
  assert.deepEqual(reviews.map(call => [call.context.unit, call.context.retry]), [['batch-1', undefined], ['batch-2', undefined], ['batch-2', 1], ['batch-2-again', undefined], ['batch-2-again', 1]],
    'the unreadable batch was asked again, then reviewed once more (also asked again)');
  assert.equal(result.deck.cards.length, 6, '7 reviewed, 1 failed; the 2 of the unreadable batch are not kept');
  const reasons = result.deck.editorial.omitted.map(item => item.reasons.join(' '));
  assert.ok(reasons.some(line => /Editorial review still found issues: .*hint gives the answer away/.test(line)), reasons.join(' | '));
  assert.equal(reasons.filter(line => /Review protocol failed/.test(line)).length, 2);
  assert.equal(Object.keys(result.deck.editorial.reviewedCards).length, 6, 'only the kept cards carry the review fingerprint');
  assert.equal(result.deck.editorial.audit.checks.length, 6);
});

test('an unreadable write reply is asked again once; a reply cut off keeps its complete cards', async () => {
  const world = material({ sections: 1, quota: 2 });
  const cut = data => { const full = JSON.stringify({ cards: writeAll(data) }); return full.slice(0, full.lastIndexOf('{"section"')) + '{"section":"S1","topic":"cut'; };
  const model = onePassModel({ raw: { write: (data, number) => (number === 1 ? 'Sorry, here you go:' : cut(data)) } });
  const result = await run(model, world);
  const writes = model.calls.filter(call => call.stage === 'write');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].context.retry, 1);
  assert.equal(result.deck.cards.length, 1, 'the complete card of the cut-off reply');
});

test('objectives the library holds are not written again: they are given to the writer and dropped when repeated', async () => {
  const world = material({ sections: 1, quota: 2 }), first = cardFor('S1', 'x', 1);
  const model = onePassModel();
  const result = await run(model, world, { existing: [writeAll({ sections: [{ section: 'S1', quota: 1 }], sources: [{ section: 'S1', text: world.text }] })[0].objective, first.objective] });
  assert.ok(Array.isArray(model.calls[0].data.existing) && model.calls[0].data.existing.length === 2);
  assert.equal(result.deck.cards.length, 1);
});

/* A review call that fails for a passing reason (a 5xx, a timeout) costs only its batch: the batch is reviewed once more, and dropped only if that fails too; the
   portion never fails because of one review call, and no call of a portion outlives it (every sibling call has settled before a stop is passed on). */
const transient = () => Object.assign(new Error('503 Service Unavailable'), { status: 503 });
const refused = () => Object.assign(new Error('401 Unauthorized: Invalid API key'), { status: 401 });

test('a review call that fails once is made again for its batch alone, and the portion keeps every card', async () => {
  const world = material({ sections: 2, sentences: 6, quota: [5, 4] });
  const model = onePassModel({ raw: { review: (data, number) => { if (number === 2) throw transient(); return null; } } });
  const result = await run(model, world);
  assert.deepEqual(model.calls.filter(call => call.stage === 'review').map(call => call.context.unit), ['batch-1', 'batch-2', 'batch-2-again']);
  assert.equal(result.deck.cards.length, 9);
  assert.equal(result.reviewLost, 0);
});

test('a review call that fails twice drops only its batch, said as a review call failure; the other batches keep their cards', async () => {
  const world = material({ sections: 2, sentences: 6, quota: [5, 4] });
  const model = onePassModel({ raw: { review: (data, number) => { if (number >= 2) throw transient(); return null; } } });
  const result = await run(model, world);
  assert.equal(result.deck.cards.length, ONE_PASS_LIMITS.reviewBatch);
  assert.equal(result.reviewLost, 2);
  const reasons = result.deck.editorial.omitted.map(item => item.reasons.join(' '));
  assert.equal(reasons.filter(line => /Review call failed after a second try: 503/.test(line)).length, 2, reasons.join(' | '));
});

test('a stop in one review call is passed on only after its sibling calls have settled: no call outlives its portion', async () => {
  const world = material({ sections: 2, sentences: 6, quota: [5, 4] });
  let siblingDone = false;
  const model = onePassModel({ raw: { review: (data, number) => { if (number === 1) throw refused(); return null; } } });
  const complete = async (system, prompt, context = {}) => {
    if (context.unit === 'batch-2') { await new Promise(resolve => setTimeout(resolve, 50)); const value = await model.complete(system, prompt, context); siblingDone = true; return value; }
    return model.complete(system, prompt, context);
  };
  await assert.rejects(writePortion({ complete, request: { kind: 'quiz', language: 'English', sources: [world.source] }, assignments: world.assignments, random: () => 0.5 }), /401/);
  assert.equal(siblingDone, true, 'the sibling review had finished when the portion failed');
});

test('a rewrite that moves which option is correct is not taken: the program checks the correct option stayed where it was', async () => {
  const world = material({ sections: 1, quota: 1 });
  const long = card => ({ ...card, options: card.options.map(option => option.correct ? { ...option, text: `${option.text}, as the rule for this exact reading and every later reading requires` } : option) });
  const model = onePassModel({ write: data => writeAll(data).map(long),
    // Even lengths, but the reply keys the SECOND option as correct.
    rewrite: data => ({ cards: data.cards.map(card => ({ index: card.index, options: card.options.map((option, index) => ({ ...option, text: option.correct ? 'It keeps the value below its limit' : option.text, correct: index === 1 })) })) }) });
  const result = await run(model, world);
  assert.equal(result.deck.cards.length, 0, 'the rewrite is refused, so the answer still stands out and the card is dropped');
  assert.match(result.deck.editorial.omitted[0].reasons.join(' '), /option cue \(length\)/);
});

test('a portion that kept nothing because its review calls failed is written again by a fill round, not a final quality failure', async () => {
  const world = material({ sections: 1, sentences: 4, quota: 3 });
  const model = onePassModel({ raw: { review: () => { throw transient(); } } });
  const result = await run(model, world);
  assert.equal(result.deck.cards.length, 0);
  assert.equal(result.reviewLost, 3);
  const settled = settledPortion(result, [world.source]);
  assert.match(settled.outcome.error, /review could not be had/);
  assert.notEqual(settled.outcome.final, true, 'a fill round writes it again');
  const judged = await run(onePassModel({ review: data => ({ reviews: data.cards.map(card => ({ index: card.index, verdict: 'fail', blocker: 1, issue: 'wrong' })) }) }), world);
  assert.equal(settledPortion(judged, [world.source]).outcome.final, true, 'a portion the review judged and failed stays a final quality failure');
});
