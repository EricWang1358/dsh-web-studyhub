/* The pure half of generate.suggest and generate.path.suggest (issue #608): no store, no service, no model and no mock. tests/generation-suggest-golden.test.mjs pins the
   same behaviour from the outside. The last test keeps these modules pure: what they reach never touches the disk, a store or the module that loads the prompts' references. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { MAX_STEPS, applyPathRefinement } from '../lib/generation-path.js';
import { suggestSources, suggestAnswer, modelFailed } from '../lib/contexts/generation/suggest.js';
import { pathSteps, buildPathPrompt, pathRetryPrompt, pathUnavailable, pathFailed, pathAnswer } from '../lib/contexts/generation/path-suggest.js';

const LIST = { id: 'list', provenance: 'exam-blueprint', blueprint: {} };

test('suggestSources takes the first 500 ids that are text, and never a 考点清单', () => {
  const sources = [{ id: 'a' }, { id: 'b' }, LIST];
  assert.deepEqual(suggestSources(sources, ['b', 7, null, 'list', 'gone']), [{ id: 'b' }]);
  assert.deepEqual(suggestSources(sources, [...Array.from({ length: 500 }, (_, index) => `x${index}`), 'a']), []);
  assert.deepEqual(suggestSources(sources, [7, ...Array.from({ length: 499 }, (_, index) => `x${index}`), 'a']), [{ id: 'a' }], 'an id that is not text does not use up the cap');
});

test('suggestAnswer: the model\'s suggestion, or the local answer with a sample of what it said', () => {
  const local = { source: 'local', focus: ['mine'], why: '' }, basis = { sources: 1, weakTopics: 0 };
  assert.equal(JSON.stringify(suggestAnswer({ local, basis, answer: { suggestion: { focus: ['x'], why: 'y' }, raw: '{}' } })),
    '{"source":"model","focus":["x"],"why":"y","basis":{"sources":1,"weakTopics":0}}');
  const unusable = suggestAnswer({ local, basis, answer: { raw: `  a \n\n b ${'z'.repeat(300)}` } });
  assert.deepEqual(unusable.focus, ['mine']);
  assert.equal(unusable.unavailable.reason, 'nothing-usable');
  assert.equal(unusable.unavailable.sample, `a b ${'z'.repeat(196)}`);
});

test('modelFailed says the message, clipped, whatever was thrown', () => {
  assert.deepEqual(modelFailed(new Error('no')), { reason: 'failed', message: 'no' });
  assert.equal(modelFailed(new Error('y'.repeat(500))).message.length, 300);
  assert.equal(modelFailed('a plain string').message, 'a plain string');
  assert.equal(modelFailed(undefined).message, 'undefined');
});

test('pathSteps keeps what the model may see: the first steps, with an id, clipped, sizes as whole numbers', () => {
  assert.deepEqual(pathSteps([null, { id: 7 }, {}]), []);
  assert.deepEqual(pathSteps([{ id: ' a\n b ', title: null, pages: 3.6, chars: '41.5', text: 'SECRET' }, { id: 'c', title: ' t ', pages: -2, chars: 'many' }]),
    [{ id: 'a b', title: '', pages: 4, chars: 42 }, { id: 'c', title: 't', pages: 0, chars: 0 }]);
  assert.equal(pathSteps([{ id: 'i'.repeat(99), title: 't'.repeat(999) }])[0].id.length, 40);
  assert.equal(pathSteps([{ id: 'i', title: 't'.repeat(999) }])[0].title.length, 120);
  assert.equal(pathSteps(Array.from({ length: MAX_STEPS + 5 }, (_, index) => ({ id: `s${index}` }))).length, MAX_STEPS);
  assert.equal(pathSteps([...Array(MAX_STEPS).fill(null), { id: 'late' }]).length, 0, 'the cap counts what was sent, before it is filtered');
});

test('buildPathPrompt: the language of the answer in the system prompt, only the listed fields in the prompt, in the order the cache has seen', () => {
  const steps = [{ id: 's', title: 't', pages: 1, chars: 2 }];
  assert.match(buildPathPrompt({ steps }, { language: 'en' }).system, /Write names, focus and reason in English\.$/);
  assert.match(buildPathPrompt({ steps }).system, /Write names, focus and reason in 中文 \(Chinese\)\.$/);
  assert.equal(buildPathPrompt({ steps, course: ` OS\n${'c'.repeat(200)}`, goal: 'exam' }).prompt, JSON.stringify({ course: `OS ${'c'.repeat(200)}`.slice(0, 120), goal: 'exam', steps }));
  assert.equal(buildPathPrompt({ steps, course: 42, goal: 'world domination' }).prompt, JSON.stringify({ steps }));
});

test('pathRetryPrompt repeats the prompt first and names every id', () => {
  const text = pathRetryPrompt('PROMPT', [{ id: 'a' }, { id: 'b' }]);
  assert.ok(text.startsWith('PROMPT\n\nYour previous reply could not be used'), 'the bytes before the correction are the first prompt, so a cache still hits');
  assert.ok(text.endsWith('in your recommended order: a, b.'));
  assert.ok(!text.includes('\r'), 'a line ending of the source file never reaches the model');
});

test('the path answers: a refinement, or the plan left as it was and why', () => {
  const steps = [{ id: 's', title: 't', pages: 1, chars: 2, count: 6 }];
  assert.deepEqual(pathUnavailable('no-model'), { source: 'local', steps: [], unavailable: { reason: 'no-model' } });
  assert.deepEqual(pathFailed(new Error('no')), { source: 'local', steps: [], unavailable: { reason: 'failed', message: 'no' } });
  const refined = applyPathRefinement(steps, { steps: [{ id: 's', title: 'named' }] });
  assert.equal(pathAnswer(refined, {}).source, 'model');
  assert.equal(pathAnswer(refined, {}).steps[0].title, 'named');
  assert.deepEqual(pathAnswer(applyPathRefinement(steps, { note: 'n'.repeat(400) }), { note: 'n'.repeat(400) }).unavailable,
    { reason: 'nothing-usable', sample: JSON.stringify({ note: 'n'.repeat(400) }).slice(0, 200) });
  assert.equal(pathAnswer({ source: 'local' }, undefined).unavailable.sample, 'null');
});

test('what the pure modules reach touches no disk, no store and no model pipeline', async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const { metafile } = await build({ entryPoints: ['lib/contexts/generation/suggest.js', 'lib/contexts/generation/path-suggest.js', 'lib/generation-path.js'], absWorkingDir: repository, bundle: true, write: false,
    platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent', outdir: join(tmpdir(), 'study-pure-metadata-only') });
  const reached = Object.values(metafile.inputs).flatMap((input) => input.imports.map((imported) => imported.path.replaceAll('\\', '/')));
  assert.deepEqual(reached.filter((path) => /^(?:node:|fs$|path$)/.test(path)), []);
  assert.deepEqual(Object.keys(metafile.inputs).map((path) => path.replaceAll('\\', '/')).filter((path) => /(?:^|\/)(?:store|generation|service)\.js$/.test(path)), []);
});
