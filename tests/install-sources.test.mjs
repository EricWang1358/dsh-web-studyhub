import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE, SOURCES, chooseSource, forgetSourceChoice, probeSources, resolveSource } from '../lib/install-sources.js';

/* The download source of a one-click install: two profiles, chosen by the learner or by probing the hosts once. No real request is made: fetch is a stand-in. */

const probes = ({ mainland = [true, true, true], global = [true, true, true], mainlandMs = 100, globalMs = 100 } = {}) => ({
  mainland: mainland.map((ok, index) => ({ url: `m${index}`, ok, ms: mainlandMs })), global: global.map((ok, index) => ({ url: `g${index}`, ok, ms: globalMs })) });

test('the decision table: overseas fails -> mainland; mainland fails -> global; the faster wins; a tie goes to the mainland', () => {
  assert.deepEqual(chooseSource(probes({ global: [true, false, true] })), { id: 'mainland', reason: 'overseas-unreachable' });
  assert.deepEqual(chooseSource(probes({ mainland: [false, true, true] })), { id: 'global', reason: 'mainland-unreachable' });
  assert.deepEqual(chooseSource(probes({ mainlandMs: 2000, globalMs: 200 })), { id: 'global', reason: 'faster' });
  assert.deepEqual(chooseSource(probes({ mainlandMs: 200, globalMs: 2000 })), { id: 'mainland', reason: 'faster' });
  assert.deepEqual(chooseSource(probes({ mainlandMs: 400, globalMs: 200 })), { id: 'mainland', reason: 'faster' }, `within ${PROBE.tieMs} ms is a tie`);
  // Both unreachable: the mainland (an overseas failure is checked first).
  assert.equal(chooseSource(probes({ mainland: [false, false, false], global: [false, false, false] })).id, 'mainland');
});

test('probes are HEAD requests to the six public hosts, any answer counts as reachable, no answer does not', async () => {
  const asked = [];
  const fetch = async (url, options) => {
    asked.push([options.method, url]);
    if (url.includes('huggingface')) throw new Error('timeout');
    return { status: url.includes('tsinghua') ? 405 : 200 };
  };
  const result = await probeSources({ fetch });
  assert.equal(asked.length, 6);
  assert.ok(asked.every(([method]) => method === 'HEAD'));
  assert.deepEqual(asked.map(([, url]) => url).sort(), [...SOURCES.mainland.probes, ...SOURCES.global.probes].sort());
  assert.ok(result.mainland.every(item => item.ok), 'a 405 still answers');
  assert.equal(result.global.find(item => item.url.includes('huggingface')).ok, false);
  assert.equal(chooseSource(result).id, 'mainland');
});

test('a learner\'s choice is never probed; auto is probed once and remembered for ten minutes', async () => {
  forgetSourceChoice();
  let asked = 0;
  const probe = async () => { asked += 1; return probes({ global: [false, true, true] }); };
  assert.deepEqual(await resolveSource('global', { probe }), { id: 'global', chosenBy: 'learner', reason: 'learner', hosts: [...SOURCES.global.hosts] });
  assert.equal(asked, 0);
  let clock = 1_000_000;
  const first = await resolveSource(undefined, { probe, now: () => clock });
  assert.deepEqual([first.id, first.chosenBy, first.reason], ['mainland', 'auto', 'overseas-unreachable']);
  clock += PROBE.cacheMs - 1;
  await resolveSource('auto', { probe, now: () => clock });
  assert.equal(asked, 1, 'remembered');
  clock += 2;
  await resolveSource('auto', { probe, now: () => clock });
  assert.equal(asked, 2, 'asked again after ten minutes');
  await resolveSource('auto', { probe, remember: false });
  assert.equal(asked, 3);
  forgetSourceChoice();
});

test('each profile names its hosts, its indexes, its Python mirror and its model source', () => {
  assert.equal(SOURCES.mainland.packageIndex, 'https://pypi.tuna.tsinghua.edu.cn/simple');
  assert.equal(SOURCES.mainland.pythonMirror, 'https://registry.npmmirror.com/-/binary/python-build-standalone/');
  assert.equal(SOURCES.mainland.modelSource, 'modelscope');
  assert.equal(SOURCES.global.packageIndex, 'https://pypi.org/simple');
  assert.equal(SOURCES.global.pythonMirror, '');
  assert.equal(SOURCES.global.modelSource, 'huggingface');
});
