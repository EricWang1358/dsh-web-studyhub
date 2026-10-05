import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionWeights, weightsPrompts, lengthWeights, WEIGHT_CHUNK, HEAD_CHARS } from '../lib/section-weights.js';
import { sectionKey } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The importance of each section, asked once per chunk of about 20 sections from a light model over titles, positions, sizes and the first 300 characters of each section, never the whole
   text. A reply that cannot be read is asked again (the exact format on the last re-ask), a reply that was cut off keeps what it has and only the missing sections are asked for again,
   and without a model (or when it fails) the weights are the lengths, said as such. */

const fx = transcriptFixture();
const leaves = fx.leaves.map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const sources = fx.sources;
/** The sections listed in the evidence of a prompt (its first paragraph is a JSON value, the instructions come after it). */
const evidenceOf = prompt => JSON.parse(prompt.split('\n\n')[0]).sections;
const reply = (items, { cut = 0 } = {}) => { const text = JSON.stringify({ sections: items }); return cut ? text.slice(0, text.length - cut) : text; };
const rate = (item, at = 0) => ({ id: item.id, importance: 1 + (at % 5), kind: ['definition', 'method', 'example', 'summary', 'chatter'][at % 5], reason: `because section ${item.id}` });
/** A light model that rates every section it is given; `script(call, evidence)` may return another reply. */
function lightModel(script = () => null) {
  const calls = [];
  const complete = async (system, prompt) => {
    const evidence = evidenceOf(prompt), call = { system, prompt, evidence, n: calls.length };
    calls.push(call);
    const scripted = await script(call, evidence);
    return scripted ?? reply(evidence.map(rate));
  };
  return { complete, calls };
}

test('one call per chunk of about 20 sections, over titles, positions, sizes and the first 300 characters only', async () => {
  const model = lightModel();
  const result = await sectionWeights({ sections: leaves, sources, light: model.complete, language: 'zh' });
  assert.equal(WEIGHT_CHUNK, 20);
  assert.equal(model.calls.length, Math.ceil(leaves.length / 20), `${model.calls.length} calls for ${leaves.length} sections`);
  assert.deepEqual(model.calls.map(call => call.evidence.length), [20, 20, 20, 20, 1]);
  const first = model.calls[0];
  for (const item of first.evidence) {
    assert.ok(typeof item.id === 'string' && item.title && Number.isInteger(item.chars) && item.position, JSON.stringify(item));
    assert.ok(item.head.length <= HEAD_CHARS + 1, `the head is at most ${HEAD_CHARS} characters`);
  }
  assert.ok(first.prompt.length < 20 * (HEAD_CHARS + 260) + 2500, `a prompt is small: ${first.prompt.length} characters for chunks of ${leaves.length > 0 ? 20 : 0} sections of about 7 000`);
  assert.ok(!first.prompt.includes(fx.textOf(leaves[0].sourceId).slice(leaves[0].start + 1500, leaves[0].start + 1900)), 'the text of a section past its head is never sent');
  assert.equal(result.source, 'model');
  assert.equal(result.calls, model.calls.length);
  assert.equal(result.weights.length, leaves.length);
  assert.deepEqual(result.weights.map(item => item.sectionId), leaves.map(item => item.key), 'reading order, section keys');
});

test('the prompt puts the system text and the evidence first and the instructions after (a stable, cache-friendly prefix)', () => {
  const { system, prompt } = weightsPrompts(leaves.slice(0, 3).map((section, index) => ({ id: `s${index + 1}`, title: section.title || `Part ${index + 1}`, position: `${index + 1}/81`, chars: section.chars, head: 'x' })), { language: 'zh' });
  assert.match(system, /untrusted/i, 'the sections are data, not instructions');
  assert.ok(prompt.startsWith('{"sections":['), 'the evidence is the first thing in the prompt');
  const instructions = prompt.slice(prompt.indexOf('\n\n') + 2);
  assert.match(instructions, /importance/);
  assert.match(instructions, /definition/);
  assert.match(instructions, /JSON/);
  const again = weightsPrompts([{ id: 's1', title: 'Other', position: '1/1', chars: 5, head: 'y' }], { language: 'zh' });
  assert.equal(again.system, system, 'the system text does not depend on the chunk');
  assert.equal(again.prompt.slice(again.prompt.indexOf('\n\n')), prompt.slice(prompt.indexOf('\n\n')), 'nor do the instructions');
});

test('a model reply gives importance, kind and a one-line reason for each section; invalid values are made safe', async () => {
  const model = lightModel((call, evidence) => reply(evidence.map((item, at) => at === 0 ? { id: item.id, importance: 9, kind: 'weird', reason: 'r'.repeat(400) }
    : at === 1 ? { id: item.id, importance: '4', kind: 'DEFINITION', reason: ' tidy ' } : rate(item, at))));
  const result = await sectionWeights({ sections: leaves.slice(0, 5), sources, light: model.complete });
  const [a, b, c] = result.weights;
  assert.deepEqual([a.importance, a.kind], [5, 'other'], 'importance is clamped to 1..5 and an unknown kind is other');
  assert.ok(a.reason.length <= 120);
  assert.deepEqual([b.importance, b.kind, b.reason], [4, 'definition', 'tidy']);
  assert.ok([1, 2, 3, 4, 5].includes(c.importance));
  assert.ok(result.weights.every(item => item.source === 'model'));
});

test('a reply that is not JSON is asked again, with the exact format on the last re-ask; the evidence prefix stays the same', async () => {
  const model = lightModel((call, evidence) => call.n < 2 ? 'Sure! Here are my ratings: a few sections matter more.' : null);
  const result = await sectionWeights({ sections: leaves.slice(0, 20), sources, light: model.complete });
  assert.equal(model.calls.length, 3, 'one call and two re-asks');
  assert.equal(result.source, 'model');
  assert.equal(result.reasked, 2);
  const [first, second, third] = model.calls;
  assert.equal(second.prompt.startsWith(first.prompt), true, 'a re-ask only appends to the prompt');
  assert.match(second.prompt, /could not be read/i);
  assert.match(third.prompt, /\{"sections":\[\{"id":"s1","importance":3/, 'the last re-ask shows the exact format');
  assert.equal(result.weights.length, 20);
});

test('a reply that stays unreadable after the re-asks falls back to the lengths for that chunk, said honestly', async () => {
  const model = lightModel((call) => (call.evidence.length === 20 ? 'no json at all' : null));
  const result = await sectionWeights({ sections: leaves.slice(0, 25), sources, light: model.complete });
  const lengthRows = result.weights.filter(item => item.source === 'length'), modelRows = result.weights.filter(item => item.source === 'model');
  assert.equal(lengthRows.length, 20);
  assert.equal(modelRows.length, 5);
  assert.equal(result.source, 'mixed');
  assert.ok(lengthRows.every(item => item.importance === 3 && item.kind === 'other' && item.reason === ''));
});

test('a reply that was cut off keeps its complete sections and only the missing ones are asked for again', async () => {
  const model = lightModel((call, evidence) => {
    if (call.n === 0) return reply(evidence.map(rate), { cut: 600 }); // cut in the middle of the list
    return null;
  });
  const result = await sectionWeights({ sections: leaves.slice(0, 20), sources, light: model.complete });
  assert.equal(model.calls.length, 2);
  const cutText = reply(model.calls[0].evidence.map(rate), { cut: 600 }), have = [...cutText.matchAll(/"id":"(s\d+)"/g)].map(match => match[1]);
  assert.ok(have.length >= 10 && have.length < 20, `the cut reply holds ${have.length} sections`);
  const ids = /ONLY for these ids: (.+?)\.?$/m.exec(model.calls[1].prompt)?.[1].split(', ') || [];
  assert.ok(model.calls[1].prompt.startsWith(model.calls[0].prompt), 'the evidence prefix is unchanged');
  assert.ok(ids.length >= 1 && ids.length <= 20 - have.length + 1, `asked for ${ids.length} ids: ${ids.join(' ')}`);
  assert.ok(ids.every(id => !have.slice(0, -1).includes(id)), 'a section that was received is not asked for again');
  assert.equal(result.source, 'model');
  assert.equal(result.weights.length, 20);
  assert.ok(result.weights.every(item => item.source === 'model'), 'nothing fell back');
});

test('without a model the weights are the lengths, and it says so', async () => {
  const result = await sectionWeights({ sections: leaves, sources, light: undefined });
  assert.equal(result.source, 'length');
  assert.equal(result.calls, 0);
  assert.equal(result.reason, 'no-model');
  assert.equal(result.weights.length, leaves.length);
  assert.ok(result.weights.every(item => item.source === 'length' && item.importance === 3 && item.kind === 'other'));
  assert.deepEqual(lengthWeights(leaves).map(item => item.sectionId), leaves.map(item => item.key));
});

test('a model that fails stops the asking and the weights are the lengths with the reason', async () => {
  const model = lightModel(() => { throw new Error('401 unauthorized'); });
  const result = await sectionWeights({ sections: leaves, sources, light: model.complete });
  assert.ok(model.calls.length <= 3, `fails fast: ${model.calls.length} calls`);
  assert.equal(result.source, 'length');
  assert.match(result.failed, /401/);
  assert.equal(result.weights.length, leaves.length);
});

test('ids the model invents or repeats are ignored; a stop signal stops the asking', async () => {
  const model = lightModel((call, evidence) => reply([{ id: 's999', importance: 5, kind: 'method', reason: 'x' }, ...evidence.map(rate), { id: evidence[0].id, importance: 1, kind: 'chatter', reason: 'again' }]));
  const result = await sectionWeights({ sections: leaves.slice(0, 20), sources, light: model.complete });
  assert.equal(result.weights.length, 20);
  assert.notEqual(result.weights[0].reason, 'again', 'the first rating of a section stands');
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(sectionWeights({ sections: leaves, sources, light: model.complete, signal: controller.signal }), /stopped/);
});
