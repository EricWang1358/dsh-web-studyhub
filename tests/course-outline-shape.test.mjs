/* #462: how fine a course outline is cut. `granularity` (coarse | medium | fine) says how big a knowledge point is asked to be; `maxPoints` caps the knowledge
   points: the model is asked for at most that many and the program merges neighbouring points until it holds (outline/fit.js; never an item or an anchor
   dropped, the merged point named after both). Without them a build asks and makes exactly what it did before; what a build was given is remembered on the
   outline, so a rebuild (also the review book's) keeps the same cut until it is changed. A fake model: no real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';
import { isCourseOutlineSource } from '../lib/exam-point-list.js';
import { fitOutline } from '../lib/contexts/generation/outline/fit.js';
import { clusterBatches, clusterPrompt } from '../lib/contexts/generation/outline/cluster.js';
import { orderKey, orderPrompt } from '../lib/contexts/generation/outline/order.js';
import { mapPrompt, reducePrompt } from '../lib/contexts/generation/outline/prompts.js';
import { planOutline } from '../lib/contexts/generation/outline/plan.js';
import { OUTLINE_LIMITS } from '../lib/course-outline-book.js';

const leafOf = (title, items) => ({ title, intro: '', items });
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));

test('fitOutline with `leaves` merges the lightest neighbouring points until the cap holds: every item kept, the merged point named after both', () => {
  const chapters = [{ title: 'One', intro: '', children: [leafOf('A', ['i1']), leafOf('B', ['i2', 'i3']), leafOf('C', ['i4'])] },
    { title: 'Two', intro: '', children: [{ title: 'S', intro: '', children: [leafOf('D', ['i5']), leafOf('E', ['i6', 'i7', 'i8'])] }] }];
  fitOutline(chapters, { leaves: 3 });
  const leaves = leavesOf(chapters);
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves.flatMap(leaf => leaf.items).sort(), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8']);
  assert.ok(leaves.some(leaf => /A \/ B|B \/ C|D \/ E/.test(leaf.title)), leaves.map(leaf => leaf.title).join(' | '));
  // Without the option nothing changes (the record's own caps only).
  const same = [{ title: 'One', intro: '', children: [leafOf('A', ['i1']), leafOf('B', ['i2'])] }];
  assert.deepEqual(fitOutline(structuredClone(same)), same);
  // The quick outline's leaves hold anchors, not items: the same merge, by anchors.
  const quick = [{ title: 'One', intro: '', children: [{ id: 'a', title: 'A', anchors: ['x'] }, { id: 'b', title: 'B', anchors: ['y', 'z'] }] }];
  fitOutline(quick, { leaves: 1 });
  assert.deepEqual(leavesOf(quick).map(leaf => [leaf.title, leaf.anchors]), [['A / B', ['x', 'y', 'z']]]);
});

test('granularity changes how big a point is asked to be; the default (and medium) asks exactly as before, so the kept answers stay valid', () => {
  const inventory = { documents: [{ key: 'd', title: 'Doc' }], items: [{ id: 'i00000000001', kind: 'term', name: 'CIA', gist: 'g', places: [{ doc: 'd', page: 1 }] }] };
  const [plain] = clusterBatches(inventory, 'zh'), [medium] = clusterBatches(inventory, 'zh', 'medium'), [coarse] = clusterBatches(inventory, 'zh', 'coarse');
  assert.equal(medium.key, plain.key, 'medium is today\'s cut: the same key, the inventory cache still answers');
  assert.notEqual(coarse.key, plain.key);
  const asked = granularity => clusterPrompt(plain, { language: 'zh', ...(granularity ? { granularity } : {}) }).prompt;
  assert.match(asked(), /typically a handful to fifteen items that belong together/);
  assert.equal(asked('medium'), asked());
  assert.match(asked('coarse'), /typically ten to forty items/);
  assert.match(asked('fine'), /typically two to six items/);
  const batch = { number: 1, descriptors: [] };
  assert.match(mapPrompt(batch, { language: 'zh' }).prompt, /knowledge points \(at most 60\)/);
  assert.match(mapPrompt(batch, { language: 'zh', granularity: 'coarse' }).prompt, /knowledge points \(at most 20\)/);
});

test('maxPoints is said to the order and reduce calls only when given (their keys change with it), and checked at stage 0 naming the field', () => {
  const plan = { language: 'zh', syllabus: null };
  assert.doesNotMatch(orderPrompt([], plan).prompt, /at most \d+ knowledge points/);
  assert.match(orderPrompt([], { ...plan, maxPoints: 80 }).prompt, /at most 80 knowledge points/);
  assert.equal(orderKey([], plan), orderKey([], { ...plan }));
  assert.notEqual(orderKey([], plan), orderKey([], { ...plan, maxPoints: 80 }));
  assert.match(reducePrompt([], { ...plan, maxPoints: 40 }).prompt, /at most 40 knowledge points/);
  const { sources, decks } = outlineLibrary();
  const state = { sources, decks, documents: [], drafts: [], attempts: [], courses: [] };
  for (const [request, pattern] of [[{ maxPoints: 0 }, /maxPoints/], [{ maxPoints: 2.5 }, /maxPoints/], [{ maxPoints: OUTLINE_LIMITS.nodes + 1 }, new RegExp(`${OUTLINE_LIMITS.nodes}`)],
    [{ maxPoints: '80' }, /maxPoints/], [{ granularity: 'huge' }, /granularity.*coarse.*medium.*fine/]])
    assert.throws(() => planOutline(state, { course: COURSE, ...request }), error => error.code === 'course-outline-shape-invalid' && pattern.test(error.message));
  assert.deepEqual(planOutline(state, { course: COURSE, maxPoints: 80, granularity: 'coarse' }).shape, { granularity: 'coarse', maxPoints: 80 });
  assert.deepEqual(planOutline(state, { course: COURSE }).shape, {});
});

test('a build with maxPoints holds at most that many points, remembered on the outline; a rebuild without it keeps it, one with a new value changes it', async t => {
  const fake = outlineModel({ inventory: 'none' }), root = await privateRoot(t, 'course-outline-shape-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); });
  const build = async extra => {
    const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...extra })).jobId);
    assert.equal(job.status, 'complete');
    return (await service.store.read()).sources.find(source => isCourseOutlineSource(source) && !source.archived).courseOutline;
  };
  const free = await build({});
  const all = leavesOf(free.nodes).length;
  assert.ok(all > 6, `${all} points without a cap`);
  assert.equal(free.shape, undefined, 'nothing asked, nothing remembered');
  const capped = await build({ maxPoints: 6 });
  assert.ok(leavesOf(capped.nodes).length <= 6);
  assert.deepEqual(capped.shape, { maxPoints: 6 });
  const anchors = outline => [...leavesOf(outline.nodes).flatMap(leaf => leaf.anchors), ...outline.other.anchors].sort();
  assert.deepEqual(anchors(capped), anchors(free), 'every row is still held once');
  assert.match(fake.of('reduce').at(-1).prompt, /at most 6 knowledge points/);
  const again = await build({});
  assert.deepEqual([leavesOf(again.nodes).length <= 6, again.shape], [true, { maxPoints: 6 }], 'a rebuild keeps the cut');
  const wider = await build({ maxPoints: 12, granularity: 'fine' });
  assert.deepEqual(wider.shape, { granularity: 'fine', maxPoints: 12 });
});
