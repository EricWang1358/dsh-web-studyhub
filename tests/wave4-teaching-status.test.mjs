/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { startTeaching, answerTeaching } from '../lib/teaching.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// #184: preparing a guided-learning step is a quiet inline status that can be given up on, fails in place with the right action,
// and the backend gives the model a time limit.
const flash = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '', explanation: 'Because.', misconception: '', citations: [] });
const never = () => new Promise(() => {});

async function answeredRun(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wave4-teaching-'));
  const service = new StudyService(join(root, 'library'), options);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'Flash deck', cards: [flash('c1', 1), flash('c2', 2)] }); });
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd' }], fresh: true });
  await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 4 });
  return { root, service, run };
}

test('a model that never answers ends guided teaching with a plain timeout error, not a hang (#184)', async (t) => {
  const { service, run } = await answeredRun(t);
  const started = Date.now();
  await assert.rejects(startTeaching(service.store, never, { runId: run.id, mode: 'understanding' }, { timeoutMs: 40 }), /timed out.*did not respond/);
  assert.ok(Date.now() - started < 2000);
  assert.equal((await service.call('review.get', { runId: run.id })).teaching, null, 'nothing half-saved');
  // The learner's answer to a step gets the same limit.
  const plan = { diagnosis: 'gap', transfer: 'rule', rungs: [0, 1].map((i) => ({ lesson: `L${i}`, check: 'Why?', answer: 'A' })) };
  const teaching = await startTeaching(service.store, async () => JSON.stringify(plan), { runId: run.id, mode: 'understanding' });
  await assert.rejects(answerTeaching(service.store, never, { id: teaching.id, answer: 'x', stepIndex: 0 }, { timeoutMs: 40 }), /timed out/);
});

test('in the browser: a slow model shows a quiet spinner, then 取消 after 20 s; a failing one fails in place with the right action (#184)', { timeout: 180000 }, async (t) => {
  let behaviour = 'hang';
  const model = async () => {
    if (behaviour === 'hang') return never();
    if (behaviour === 'key') throw new Error('403: {"message":"Authentication failed. Please check your credentials.","type":"permission_error"}');
    if (behaviour === 'busy') throw new Error('429 Too Many Requests: rate limit');
    return JSON.stringify({ diagnosis: 'gap', transfer: 'rule', rungs: [0, 1].map((i) => ({ lesson: `Step ${i}`, check: 'Why?', answer: 'A' })) });
  };
  const { root, service } = await answeredRun(t);
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  await page.getByRole('button', { name: '回到题目' }).first().click().catch(() => {});
  const chip = page.getByRole('button', { name: '逐步理解', exact: true });
  await chip.waitFor();
  const status = page.locator('.teaching-status');

  // Slow: spinner and the muted line first, 取消 only after the threshold.
  await chip.click();
  await status.waitFor();
  assert.match(await status.innerText(), /正在准备当前步骤/);
  assert.equal(await status.locator('.sh-spinner').count(), 1, 'a spinner, not a bare line');
  assert.equal(await status.getByRole('button', { name: '取消' }).count(), 0, 'nothing to cancel yet');
  await page.clock.fastForward(21000);
  assert.match(await status.innerText(), /仍在准备，可以先继续答题/);
  await status.getByRole('button', { name: '取消' }).click();
  await status.waitFor({ state: 'detached' });
  assert.equal(await chip.isEnabled(), true);

  // A key the provider rejects: the cause and the settings, no retry that cannot work.
  behaviour = 'key';
  await chip.click();
  const note = page.locator('.teaching-status-note');
  await note.waitFor();
  assert.match(await note.innerText(), /模型服务拒绝了请求/);
  assert.equal(await note.getByRole('button', { name: '打开模型设置' }).count(), 1);
  assert.equal(await note.getByRole('button', { name: '重试' }).count(), 0);
  assert.equal(await page.locator('.action-feedback [role="alert"]').count(), 0, 'not only in the global error');

  // A busy service: retry, and the retry works.
  behaviour = 'busy';
  await chip.click();
  await note.getByRole('button', { name: '重试' }).waitFor();
  behaviour = 'ok';
  await note.getByRole('button', { name: '重试' }).click();
  await page.locator('.teaching-panel').waitFor();
  assert.equal(await page.locator('.teaching-status-note').count(), 0);
  assert.deepEqual(errors, []);
});
