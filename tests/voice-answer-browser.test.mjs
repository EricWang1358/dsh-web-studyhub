/* global localStorage, document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* Voice answering (#1031) in a real browser with a fake microphone (Chromium's fake capture device), the fake model and a fake transcription (the page's
   audio.clip.transcribe is answered here; the real upload is cancelled on the server). With the autopilot on: an open question answered by voice is
   submitted for AI grading and the round moves on; the question left is not offered again; its grade lands after the learner left, so it waits under
   「待看订正」; 我看懂了 · 加入重练 puts its retry at the end of the round; a spoken cloze fills its blanks and is graded like typing. Without a
   transcription service, V opens the audio setup guide. At 1280 and 420 px, in Chinese and English. VOICE_SHOTS=<folder> keeps screenshots. */

const RUNS = [['zh', 1280, 800], ['zh', 420, 900], ['en', 1280, 800], ['en', 420, 900]];
const SHOTS = process.env.VOICE_SHOTS || '';
const deckOf = (i) => ({ id: `v${i}`, title: `Voice ${i}`, course: 'Systems', cards: [
  { id: `v${i}-open`, kind: 'open', topic: 'Retries', objective: 'Explain', prompt: `Why must retries be idempotent? (${i})`, answer: '重试必须幂等，并用指数退避，避免把下游压垮。',
    hint: '', explanation: 'Retries repeat a request.', misconception: '', citations: [] },
  { id: `v${i}-cloze`, kind: 'cloze', topic: 'Retries', objective: 'Recall', prompt: 'Fill in', answer: '幂等；指数退避', hint: '', explanation: 'Both keep retries safe.', misconception: '', citations: [],
    cloze: { text: '重试要配合 {{b1}} 和 {{b2}}。', answers: [{ id: 'b1', value: '幂等' }, { id: 'b2', value: '指数退避' }] } },
  ...[1, 2].map((n) => ({ id: `v${i}-quiz${n}`, kind: 'quiz', topic: 'Retries', objective: 'Recall', prompt: `Choice ${n} (${i})?`, hint: '', explanation: 'Yes.', misconception: '',
    citations: [], options: [{ id: 'a', text: 'yes', correct: true, explanation: 'Right.' }, { id: 'b', text: 'no', correct: false, explanation: 'Wrong.' }] })),
] });
const WORDS = {
  zh: { resume: '接着做', grading: /正在批改/, pending: /待看订正 1/, ack: '我看懂了 · 加入重练', setup: /转写服务还没配置/, correction: /更专业的说法/ },
  en: { resume: 'Continue', grading: /Grading/, pending: /Corrections to read 1/, ack: 'Got it · add a retry', setup: /./, correction: /How an examiner would put it/ },
};

async function serve(t) {
  const root = await mkdtemp(join(tmpdir(), 'voice-answer-browser-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => { s.decks.push(...RUNS.map((_, i) => deckOf(i)), deckOf('gate')); });
  await service.dispose();
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  // The grade takes longer than the autopilot's 1.5 s, so it lands after the learner has moved on.
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: createFakeModel({ latencyMs: 3500 }), distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  try { browser = await launchChromium({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }); }
  catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return null; }
  return { server, browser };
}

/** The page's transcription: audio.preflight says it is set up, audio.clip.transcribe answers `said.next` and cancels the real upload. */
async function fakeTranscription(page, server, said) {
  await page.route(`${server.url}/api/call`, async (route) => {
    const { action, args } = JSON.parse(route.request().postData() || '{}');
    if (action === 'audio.preflight') return route.fulfill({ json: { ok: true, value: { transcription: true } } });
    if (action === 'audio.clip.transcribe') {
      said.uploads.push(args.uploadId);
      await previewCall(server, 'audio.upload.cancel', { uploadId: args.uploadId });
      return route.fulfill({ json: { ok: true, value: { text: said.next } } });
    }
    return route.continue();
  });
}
async function speak(page, said, text) {
  said.next = text;
  await page.keyboard.press('v');
  await page.locator('.voice-input[data-phase="recording"]').first().waitFor();
  // Long enough that a busy machine's capture has delivered more than the recorder's 0.1 s minimum.
  await page.waitForTimeout(1500);
  await page.keyboard.press('v');
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `voice-${name}.png`) }); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('voice answers: autopilot grades and moves on, 待看订正 → 加入重练 → retry at the end, spoken cloze, the setup guide', { timeout: 600000 }, async (t) => {
  const served = await serve(t);
  if (!served) return;
  const { server, browser } = served;
  if (SHOTS) await mkdir(SHOTS, { recursive: true });

  // No transcription service: V opens the audio setup guide instead of the microphone.
  {
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
    await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'vgate' }] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    const page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
    await page.goto(server.url);
    await page.getByRole('button', { name: WORDS.zh.resume, exact: true }).first().click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    await page.locator('.question-card').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('v');
    await page.getByText(WORDS.zh.setup).first().waitFor({ timeout: 15000 });
    await page.getByText(WORDS.zh.setup).first().scrollIntoViewIfNeeded();
    await shot(page, 'setup-zh-1280');
    await context.close();
    for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
  }

  for (const [i, [lang, width, height]] of RUNS.entries()) {
    const where = `${lang} ${width}px`, words = WORDS[lang], deck = deckOf(i), said = { next: '', uploads: [] };
    for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: true, debrief: false } });
    const run = await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: deck.id }] });
    const context = await browser.newContext({ viewport: { width, height }, permissions: ['microphone'] });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((language) => { localStorage.setItem('study-ui-language', language); }, lang);
    await fakeTranscription(page, server, said);
    await page.goto(server.url);
    await page.getByRole('button', { name: words.resume, exact: true }).first().click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    await page.locator('.question-card').click({ position: { x: 5, y: 5 } });

    const question = () => page.locator('.question-card').first().innerText();
    const onQuestion = (text) => page.waitForFunction((t) => (document.querySelector('.question-card')?.innerText || '').includes(t), text, { timeout: 30000 });

    // 1. A thin spoken answer to the open question: it goes into the answer box, is submitted for AI grading, and the autopilot moves on before the grade is in.
    await speak(page, said, '不知道');
    await page.waitForFunction(() => document.querySelector('.response-label textarea')?.value === '不知道', null, { timeout: 20000 })
      .catch(async () => assert.fail(`${where}: the transcript did not reach the answer box: ${await page.locator('.voice-answer').innerText().catch(() => '')}`));
    await page.getByText(words.grading).first().waitFor({ timeout: 15000 });
    await shot(page, `grading-${lang}-${width}`);
    await page.locator('.cloze').waitFor({ timeout: 15000 });
    const left = (await previewCall(server, 'review.get', { runId: run.id })).navigation[0];
    assert.ok(left.answered && left.grading, `${where}: the question left is answered (its grade on the way), so it is not offered again`);

    // 2. A spoken cloze fills its blanks and is graded like typing: right, so the autopilot moves on.
    await speak(page, said, '第一空幂等，第二空指数退避');
    await page.locator('.cloze .cloze-mark').first().waitFor({ timeout: 15000 });
    assert.deepEqual(await page.locator('.cloze-blank').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['幂等', '指数退避'], `${where}: the blanks hold what was said`);
    assert.equal((await previewCall(server, 'review.get', { runId: run.id })).navigation[1].passed, true, `${where}: the spoken cloze passed`);
    await shot(page, `cloze-${lang}-${width}`);
    await onQuestion(`Choice 1 (${i})`);

    // 3. The open question's grade landed after the learner left it: a miss, so it waits under 待看订正 in the practice header.
    const pending = page.getByRole('button', { name: words.pending }).first();
    await pending.waitFor({ timeout: 30000 });
    await shot(page, `pending-${lang}-${width}`);
    await pending.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(words.correction).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400); // the dialog's fade-in, for the screenshot
    await shot(page, `correction-${lang}-${width}`);
    assert.ok((await overflow(page)) <= 1, `${where}: nothing scrolls sideways`);
    await dialog.getByRole('button', { name: words.ack }).click();
    await page.getByRole('button', { name: words.pending }).waitFor({ state: 'detached', timeout: 15000 });
    await page.keyboard.press('Escape');
    const queued = (await previewCall(server, 'review.get', { runId: run.id })).navigation;
    assert.ok(queued.at(-1).retry && queued.at(-1).cardId === `v${i}-open` && !queued.at(-1).answered, `${where}: 加入重练 queued its retry at the end of the round`);
    assert.ok((await question()).includes(`Choice 1 (${i})`), `${where}: the learner stays on the question in front of them`);

    // 4. The rest of the round, then the retry of the open question comes back last.
    for (const n of [1, 2]) {
      await onQuestion(`Choice ${n} (${i})`);
      await page.locator('.option', { hasText: 'yes' }).click();
    }
    await onQuestion(`Why must retries be idempotent? (${i})`);
    assert.ok((await previewCall(server, 'review.get', { runId: run.id })).retry, `${where}: the question back on screen is the retry`);
    assert.equal(said.uploads.length, 2, `${where}: each spoken answer sent one clip`);
    assert.deepEqual(errors, [], `${where}: no page errors`);
    await context.close();
  }
});
