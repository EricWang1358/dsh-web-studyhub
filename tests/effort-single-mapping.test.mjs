import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceFiles } from './helpers/locale-usage.mjs';
import { EFFORT_PREFERENCES, chooseEffort } from '../lib/model-effort.js';
import * as stageEffort from '../lib/stage-effort.js';
import { GENERATION_SETTINGS_DEFAULTS, validateGenerationPatch } from '../lib/generation-settings.js';

/* #226: one place maps a relative reasoning preference onto the levels a model really offers (lib/model-effort.js). Generation's per-stage
   levels and the audio settings resolve through it, so the same model and the same preference give the same level, tie-break and wording. */

const DEEPSEEK = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'default', name: 'Default' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
const CLASSIC = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const TWO = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }];
const ctxWith = (efforts) => ({ llm: { resolveModelInfo: async () => ({ reasoning: { efforts, defaultEffort: 'default' } }) } });
const session = { provider: 'p', model: 'm', reasoningEffort: 'high' };
const stage = 'Reviewing ambiguity and source support';

test('generation and audio resolve the same preference on the same model to the same level', async () => {
  for (const [name, efforts] of Object.entries({ DEEPSEEK, CLASSIC, TWO, none: [] })) {
    for (const preference of EFFORT_PREFERENCES) {
      const wanted = chooseEffort(efforts, preference);
      const routed = await stageEffort.stageEffortRoute(ctxWith(efforts), session, stage, { review: preference });
      // A model without adjustable levels keeps the route (the session's own level); otherwise the level is exactly the shared mapping's.
      assert.equal(routed.route.reasoningEffort, wanted.reason === 'unsupported' ? session.reasoningEffort : wanted.id, `${name}/${preference}`);
    }
  }
});

test('one vocabulary: default / lowest / low / medium / high / highest, and generation adds follow', () => {
  assert.deepEqual(stageEffort.STAGE_EFFORT_PREFERENCES, ['follow', ...EFFORT_PREFERENCES]);
  assert.deepEqual(EFFORT_PREFERENCES, ['default', 'lowest', 'low', 'medium', 'high', 'highest']);
  for (const key of ['effortPlanning', 'effortReview', 'effortWriting', 'effortRepair']) {
    for (const value of stageEffort.STAGE_EFFORT_PREFERENCES) assert.deepEqual(validateGenerationPatch({ [key]: value }), { [key]: value });
    assert.throws(() => validateGenerationPatch({ [key]: 'banana' }), /Invalid generation setting/);
  }
  assert.equal(GENERATION_SETTINGS_DEFAULTS.effortWriting, 'low');
});

test('"medium" on a model without it maps like the audio settings do, and the step says so', async () => {
  const routed = await stageEffort.stageEffortRoute(ctxWith(DEEPSEEK), session, stage, { review: 'medium' });
  assert.equal(routed.route.reasoningEffort, 'high', 'a tie goes to the stronger level, as in the audio settings');
  assert.deepEqual(routed.choice.reason, 'nearest');
  assert.equal(routed.choice.preference, 'medium');
  const model = await stageEffort.stageEffortRoute(ctxWith(CLASSIC), session, stage, { review: 'medium' });
  assert.equal(model.route.reasoningEffort, 'medium');
  assert.equal(model.choice.exact, true);
});

test('the model default clears the session level instead of keeping it; follow keeps it', async () => {
  const modelDefault = await stageEffort.stageEffortRoute(ctxWith(DEEPSEEK), session, stage, { review: 'default' });
  assert.equal(modelDefault.route.reasoningEffort, undefined, 'default means the model\'s own level, not the session\'s');
  const follow = await stageEffort.stageEffortRoute(ctxWith(DEEPSEEK), session, stage, { review: 'follow' });
  assert.equal(follow.route, session);
});

test('only lib/model-effort.js maps a preference onto model levels', async () => {
  assert.equal(stageEffort.resolveEffort, undefined, 'the second mapping is gone');
  const own = await readFile(new URL('../lib/stage-effort.js', import.meta.url), 'utf8');
  assert.match(own, /from '\.\/model-effort\.js'/, 'the stage module reaches the shared mapping');
  const files = await sourceFiles();
  // The signs of a mapping: the names of the strongest level (xhigh / ultra), a strength rank table, a distance to a target level.
  const signs = [/xhigh|x\[\\s_-\]\?high/i, /\bRANK\b/, /Math\.abs\([^)]*(rank|target|position)/i, /positionOf|NEAREST_LEVEL/];
  const offenders = [];
  for (const file of files) {
    if (file.replaceAll('\\', '/').endsWith('/lib/model-effort.js')) continue;
    const text = await readFile(file, 'utf8');
    if (signs.some((sign) => sign.test(text))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a second preference-to-level mapping crept in');
});
