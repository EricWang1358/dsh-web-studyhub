/* 为你定制 on a model that thinks before it answers (owner's console, 2026-11-05: qwen3.8-flash, 5 of 6 batches 「模型这次没有返回内容，
   已自动重试 2 次」 after 3–4 minutes each, one 「Unterminated string in JSON」). A batch writes up to four variant cards in one call, and its
   flat 3,600-token output cap was spent on the thinking, or cut the JSON short. Three parts: the cap grows with the cards asked for and leaves
   room for thinking; a reply cut at the cap before any answer says so and is not sent again unchanged (the same request is cut the same way);
   the console's note for a failed 备题 batch points to where variants are made again, not to a draft's 补题. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { writeVariants } from '../lib/coach.js';
import { COACH_PREP } from '../lib/contexts/coach/settings.js';
import { withModelRetry, modelFailureMessage, isTransientModelError } from '../lib/model-retry.js';

const card = (n) => ({ id: `c${n}`, topic: 'Observer', objective: 'notify', prompt: `What does subject ${n} do?`, answer: 'notifies observers', citations: [] });
const target = (n) => ({ card: card(n), kind: 'quiz', reason: 'wrong' });

test('a variants call may write as much as the cards it asks for need, plus room to think', async () => {
  const caps = [];
  const complete = async (_system, _prompt, options) => { caps.push(options.maxTokens); return '{"cards":[]}'; };
  await writeVariants(complete, { targets: [target(1)], sources: [], learner: {} });
  await writeVariants(complete, { targets: [1, 2, 3, 4].map(target), sources: [], learner: {} });
  assert.deepEqual(caps, [COACH_PREP.reasoningTokens + COACH_PREP.cardTokens, COACH_PREP.reasoningTokens + 4 * COACH_PREP.cardTokens]);
  assert.ok(caps[1] > 3600, 'four cards get more than the old flat cap');
});

const thinkingOnly = (finish) => ({
  resolveCallConfig: async (config) => config,
  stream: async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'Let me think about the four cards…' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think about the four cards…' } };
    yield { type: 'finish', reason: finish };
  },
});

test('a reply cut at its output cap before any answer says so and is not sent again unchanged', async (t) => {
  let plugin;
  try { plugin = await import('../lib/index.js'); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai')) return t.skip('Host SDK absent');
    throw error;
  }
  const call = plugin.modelCompletion({ get: () => undefined, llm: thinkingOnly({ kind: 'max-tokens' }) }, () => ({ provider: 'p', model: 'thinker' }), 's');
  let sent = 0;
  const error = await withModelRetry(() => { sent += 1; return call('sys', 'ask', { maxOutputTokens: 100 }); }, { delays: [1, 1] }).catch((e) => e);
  assert.equal(error.code, 'MAX_TOKENS');
  assert.equal(isTransientModelError(error), false);
  assert.equal(sent, 1, 'one request, not three identical ones');
  assert.match(modelFailureMessage(error), /输出上限/);
  assert.doesNotMatch(modelFailureMessage(error), /重试/);

  // An empty reply that ended normally is still the provider's hiccup, retried as before.
  const quiet = plugin.modelCompletion({ get: () => undefined, llm: thinkingOnly({ kind: 'stop' }) }, () => ({ provider: 'p', model: 'thinker' }), 's');
  let tries = 0;
  const empty = await withModelRetry(() => { tries += 1; return quiet('sys', 'ask'); }, { delays: [1, 1] }).catch((e) => e);
  assert.match(empty.message, /Model returned no text/);
  assert.equal(tries, 3);
});

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export * from './ui/i18n.js'; export { retryNote } from './ui/tasks/call-model.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const ui = (() => { const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports); return module.exports; })();

test('a failed 备题 batch points to 生成变式, not to a draft', () => {
  ui.setUiLanguage('zh');
  const failed = { kind: 'prep', status: 'failed', startedAt: '2026-11-05T07:24:00.000Z' };
  const note = ui.retryNote(failed, [failed]);
  assert.doesNotMatch(note, /补题|草稿/);
  assert.match(note, /生成变式/);
  // A question run's batch still says 补题.
  const batch = { kind: 'generate', status: 'failed', startedAt: '2026-11-05T07:24:00.000Z' };
  assert.match(ui.retryNote(batch, [batch]), /补题/);
});
