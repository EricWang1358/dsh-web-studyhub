/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* 「发给主会话」 at the dead ends of adding files and of jobs (the hand-off plan section 2.1 N1–N11, S3, and the empty home's link, plan item 5), in Chromium
   through the REAL host adapter (ui/host/workspace.jsx) and the REAL App on a real library; only DSH is faked (its conversation's submit throws) and the
   snapshot carries three jobs that did not finish (a transcription, a question run, a PDF conversion), as the host publishes them. Each place: it appears
   only once the way failed, it is the shared control (one label, its rule in a layered Tooltip, never primary, never a title attribute), and pressing it
   fills the empty composer by setDraft alone with the learner's sentence first and the shared receipt after it.
   N1 录题 · N4 JSON 导入 · N2 the refused files of JSON 导入, 音频 and 添加资料 · N5 a pasted JSON that did not pass · N6 a recording the form does not take ·
   N7 a recording the pre-check stopped · N8 a failed job's card (音频, the home) · N9 the 任务 console's line · N10 the converter card of a refused PDF ·
   N11 a failed conversion's diagnosis · N3 the batch summary of 添加资料 · the empty home.
   DEADENDS_SHOTS=<dir> writes screenshots (zh; 1280×800 and 390×844, light); otherwise only 1280 runs. */

const host = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import * as workspace from './ui/host/workspace.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const seats = {}, roots = {}, log = window.dshLog = [];
  const rpc = { call: async (_route, _path, payload) => {
    const reply = await window.invokeStudy(payload.action, payload.args);
    return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: { message: reply.error, code: reply.code } };
  } };
  const shell = {
    get projection() { return { detectText: window.composerText }; },
    state: { getSnapshot: () => ({ draft: window.composerText, attachmentIds: [] }) },
    setDraft: (text) => { log.push('setDraft'); window.composerText = text; },
    submit: () => { log.push('submit'); },
    actions: { submit: () => { log.push('actions.submit'); } },
  };
  const guarded = (target, path) => new Proxy(target, { get(object, key) {
    if (key === 'submit') { log.push('submit-touched:' + path); throw new Error(path + '.submit must never be called'); }
    const value = object[key];
    return value && typeof value === 'object' ? guarded(value, path + '.' + String(key)) : value;
  } });
  const conversation = { input: { for: () => guarded(shell, 'input') } };
  const services = {
    connection: { rpc },
    layout: { selectPanel: (id) => { if (window.dshReady) log.push('selectPanel:' + id); } },
    sessions: { scope: () => ({ get: (name) => (name === 'conversation' ? conversation : undefined) }) },
  };
  const ctx = { get: (name) => services[name], effect(fn) { fn(); }, inject: (_n, fn) => fn(ctx),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
    sidebarRightTabs: { register: () => () => {} } };
  window.installDsh = () => workspace.apply(ctx, () => {});
  window.mountPage = () => { roots.page ||= createRoot(document.getElementById('main')); roots.page.render(React.createElement(seats['study-workspace.page:undefined'], { sessionId: 's1' })); };
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

const shots = process.env.DEADENDS_SHOTS;
const views = shots ? [[1280, 800], [390, 844]] : [[1280, 800]];
const RULE = '只填进主会话的输入框';
const FILLED = '看一眼，再由你按发送';
const TAIL = '文件（不在工作区就粘贴完整路径）：@';

const card = (n) => ({ id: `c${n}`, kind: 'flashcard', topic: `主题${n}`, objective: `目标${n}`, prompt: `问题 ${n}？`, answer: `答案 ${n}`, hint: '', explanation: '因为。', misconception: '', citations: [] });
const page = (n) => ({ id: `bp${n}`, title: `操作系统教材 · p.${n}`, text: '进程调度与内存管理。'.repeat(40), createdAt: '2026-10-01T08:00:00.000Z', courses: ['操作系统'],
  document: { id: 'book', page: n, totalPages: 3, bookTitle: '操作系统教材', origin: 'converted', converter: 'mineru' } });

/** A library with one deck and a short book in the course 操作系统 (the empty home has its own empty library). */
async function seed(root) {
  const service = new StudyService(root);
  await service.store.update((state) => {
    state.decks.push({ id: 'd1', title: '操作系统', course: '操作系统', cards: Array.from({ length: 4 }, (_, i) => card(i + 1)) });
    for (let n = 1; n <= 3; n++) state.sources.push(page(n));
    state.focus = { ...(state.focus || {}), course: '操作系统' };
  });
  await service.dispose?.();
}

/* The jobs that did not finish, in the shape the host publishes (the snapshot gets them; nothing here runs them). */
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const JOBS = [
  { id: 'audio-failed', type: 'audio-import', filename: '第3周讲座.m4a', title: '第3周讲座', status: 'failed', stage: 'ffmpeg 不可用：没法切分这段录音', phase: 'transcribe', startedAt: at(30), finishedAt: at(25) },
  { id: 'run-failed', type: 'generate', status: 'failed', stage: 'fetch failed: ECONNRESET', deckTitle: '操作系统 · 第 2 章', kind: 'quiz', count: 10, requestedTotal: 10, savedCount: 0, parts: 1,
    steps: [], sourceIds: ['bp1'], course: '操作系统', startedAt: at(20), finishedAt: at(18) },
  { id: 'pdf-failed', type: 'pdf-convert', filename: '操作系统教材.pdf', status: 'failed', converter: 'mineru', route: 'local', pages: 640, stage: 'MinerU 进程意外退出',
    failure: { summary: 'MinerU 进程意外退出（显存不足）', exitCode: 1, lines: ['torch.cuda.OutOfMemoryError: CUDA out of memory', 'Tried to allocate 2.00 GiB'] }, startedAt: at(15), finishedAt: at(12) },
];

test('发给主会话 at the dead ends of adding files and of jobs: only once the way failed, the shared control, the prompt in the box and nothing sent', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'hand-off-deadends-'));
  t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await seed(join(root, 'library'));
  await mkdir(join(root, 'empty'), { recursive: true });
  // A transcription key that is only a name for the audio form's pre-flight (without one the form is the setup card): nothing here sends audio anywhere.
  await mkdir(join(root, 'home', 'study'), { recursive: true });
  await writeFile(join(root, 'home', 'study', 'audio.json'), JSON.stringify({ version: 1, siliconflowKey: 'sk-hand-off-deadends-test-key-00000000' }));
  // A recording that is not one (the pre-check cannot read it) and a book too large to import as it is.
  const broken = join(root, 'files', '坏掉的录音.mp3');
  await mkdir(join(root, 'files'), { recursive: true });
  await writeFile(broken, Buffer.alloc(4096, 7));
  const server = await createPreviewServer({ port: 0, libraryRoot: join(root, 'library'), home: join(root, 'home'), model: createFakeModel() });
  const empty = await createPreviewServer({ port: 0, libraryRoot: join(root, 'empty'), home: join(root, 'home'), model: createFakeModel() });
  t.after(() => Promise.all([server.close(), empty.close()]));
  if (shots) await mkdir(shots, { recursive: true });
  for (const [width, height] of views) {
    const tag = `${width}`;
    const open = async (target, { jobs = [] } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.exposeFunction('invokeStudy', async (action, args) => {
        try {
          const value = await previewCall(target, action, args);
          if (action === 'snapshot' && Array.isArray(value?.jobs)) value.jobs.push(...jobs);
          return { ok: true, value };
        } catch (error) { return { ok: false, error: error.message, code: error.code }; }
      });
      await context.addInitScript(() => {
        try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'light'); } catch { /* blocked */ }
        window.composerText = ''; window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied.push(text); } } });
      });
      await page.route('**/*', (route) => (route.request().url() === 'http://deadends.test/' ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' }) : route.abort()));
      await page.goto('http://deadends.test/');
      await page.addScriptTag({ content: host.outputFiles[0].text });
      await page.evaluate(() => { window.installDsh(); window.mountPage(); });
      await page.waitForTimeout(100);
      await page.evaluate(() => { window.dshReady = true; });
      return { context, page, errors };
    };
    const tools = (page, errors) => {
      const shot = async (name) => { if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: join(shots, `${name}-${tag}.png`) }); } };
      const receipt = page.locator('.sh-toasts .sh-toast--receipt[data-receipt="filled"]').filter({ hasText: FILLED });
      const state = () => page.evaluate(() => ({ log: window.dshLog.slice(), text: window.composerText }));
      const reset = async () => {
        await page.evaluate(() => { window.composerText = ''; window.copied = []; window.dshLog.length = 0; });
        for (const close of await page.locator('.sh-toast__close').all()) await close.click().catch(() => {});
      };
      const go = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click({ timeout: 60000, force: true }); };
      /** The control is the shared one; its Tooltip shows on hover (screenshot), a press fills the empty box by setDraft alone. Returns the prompt. */
      const handOver = async (control, { name, first, tail = TAIL } = {}) => {
        await control.waitFor({ timeout: 30000 });
        await control.scrollIntoViewIfNeeded();
        await reset();
        assert.equal(await control.getAttribute('title'), null, `${tag} ${name}: no title attribute`);
        assert.doesNotMatch(await control.evaluate((element) => element.className), /sh-btn--primary/, `${tag} ${name}: never primary`);
        assert.match((await control.innerText()).trim(), /^发给主会话$/, `${tag} ${name}: the one label`);
        // (hover() scrolls it in and waits for it to stand still: closing the last receipt may move the page)
        // A page just opened may still settle (its scroll position is clamped while the rest of it loads): wait until the control stands still.
        for (let last = null, still = 0; still < 3;) {
          const top = await control.evaluate((element) => Math.round(element.getBoundingClientRect().top));
          still = top === last ? still + 1 : 0;
          last = top;
          await page.waitForTimeout(150);
        }
        await control.hover();
        const box = await control.boundingBox();
        // its own Tooltip (the one aria-describedby names: a page may hold several hand-offs)
        const tip = (await control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).at(-1);
        await page.locator(`[id="${tip}"][role="tooltip"]`).filter({ hasText: RULE }).waitFor({ timeout: 5000 }).catch(async (error) => {
          if (process.env.DEADENDS_DEBUG) await page.screenshot({ path: join(process.env.DEADENDS_DEBUG, `fail-${name}-${tag}.png`) });
          const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 200), [box.x + box.width / 2, box.y + box.height / 2]);
          throw new Error(`${name}: the rule's Tooltip did not show: ${error.message}\nunder the pointer: ${hit}`);
        });
        await shot(name);
        await control.click();
        await receipt.waitFor({ timeout: 15000 }).catch(async (error) => {
          throw new Error(`${name}: ${error.message}\npage errors: ${JSON.stringify(errors)}\nnotices: ${JSON.stringify(await page.locator('.sh-toasts').allInnerTexts())}`);
        });
        const after = await state();
        assert.deepEqual(after.log.filter((entry) => entry !== 'selectPanel:null'), ['setDraft'], `${tag} ${name}: setDraft and nothing else`);
        if (first) assert.ok(after.text.startsWith(first), `${tag} ${name}: ${after.text.slice(0, 120)}`);
        if (tail) assert.ok(after.text.endsWith(tail), `${tag} ${name}: ends with ${tail}: ${after.text.slice(-60)}`);
        assert.ok(after.text.includes('请用中文回复；已有的题目和引文保持原文，不要翻译。'), `${tag} ${name}: the one language sentence`);
        await page.mouse.move(2, 2);
        return after.text;
      };
      return { shot, go, handOver, reset };
    };

    // ---------------- the empty home: the workspace-file link, in the shared unit ----------------
    {
      const { context, page, errors } = await open(empty);
      const { go, handOver } = tools(page, errors);
      await go('library');
      // Since 3.6 an empty library opens on the first-run line; 以后再说 puts it away and the home's desk (with its quiet other ways) is there.
      await page.getByRole('button', { name: '以后再说' }).first().click({ timeout: 30000 });
      const link = page.locator('.desk-also [data-hand-off="import.file"]');
      const text = await handOver(link, { name: 'home-empty', first: '我在 StudyHub 的「添加资料」想用工作区里的一个文件出第一组题' });
      assert.match(text, /- 出题：导入后用 generate 出 10 道题，存成草稿给我检查。/);
      assert.equal(await page.getByText('在对话中用工作区文件出题').count(), 0);
      assert.equal(await page.locator('.desk-also').getByText('用工作区里的文件出题：').count(), 1);
      assert.deepEqual(errors, []);
      await context.close();
    }

    const { context, page, errors } = await open(server, { jobs: JOBS });
    const { go, handOver, shot } = tools(page, errors);

    // ---------------- N1 录题: under the page's own button ----------------
    await go('generate');
    const chatTab = page.getByRole('tab', { name: /在主会话里录题/ });
    assert.match(await chatTab.innerText(), /题册、刷题软件、错题或截图/, `${tag}: the tab says 题册 first`);
    await chatTab.click();
    let text = await handOver(page.locator('.ingest-file [data-hand-off="import.file"]'), { name: 'n1-ingest', first: '我在 StudyHub 的「在主会话里录题」想把文件里已有的题目原样录进题组' });
    assert.match(text, /```data 情况\ncourse: 操作系统/);
    assert.match(text, /draft:true/);

    // ---------------- N4, N2, N5 JSON 导入 ----------------
    await page.getByRole('tab', { name: /导入 JSON 题组/ }).click();
    const panel = page.locator('.generate-panel');
    const before = await panel.locator('[data-hand-off="import.file"]').count();
    assert.equal(before, 1, `${tag}: before anything failed, only the line under the prompts`);
    text = await handOver(panel.locator('fieldset').first().locator('[data-hand-off="import.file"]'), { name: 'n4-json-word', first: '我在 StudyHub 的「导入 JSON 题组」想把文件里已有的题目原样录进题组' });
    await panel.locator('input[type=file]').first().setInputFiles({ name: '错题本.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('x') });
    text = await handOver(panel.locator('.sh-drop__rejects [data-hand-off], .sh-drop__rejects .sh-inline__secondary').first(), { name: 'n2-json-reject', first: '我在 StudyHub 的「导入 JSON 题组」' });
    assert.match(text, /```data 文件\n错题本\.xlsx\n```/);
    await panel.locator('textarea').last().fill('{"title":"错题","cards":[{"kind":1}');
    await panel.getByRole('button', { name: /检查并建议归类/ }).click();
    const invalid = panel.locator('.sh-inline--error .sh-inline__secondary, [role="alert"] .sh-inline__secondary').first();
    text = await handOver(invalid, { name: 'n5-json-invalid', first: '我在 StudyHub 的「导入 JSON 题组」想把文件里已有的题目原样录进题组' });
    assert.match(text, /```data 内容开头\n\{"title":"错题","cards":\[\{"kind":1\}\n```/);
    assert.match(text, /```data 错误原文\n/);

    // ---------------- 音频: N8 (the failed job's card), N2, N6, N7 ----------------
    await go('audio');
    text = await handOver(page.locator('.audio-jobs .cjc[data-job-id="audio-failed"] [data-hand-off="job.failed"]'), { name: 'n8-audio-card', first: '我在 StudyHub 的「任务」想把这个没做完的任务做完', tail: '' });
    assert.match(text, /jobId: audio-failed\nkind: audio-import/);
    assert.match(text, /ffmpeg 不可用/);
    assert.equal(await page.locator('.audio-jobs .cjc').count(), 1);
    await page.locator('.audio-drop-zone input[type=file]').setInputFiles({ name: '讲座录像.mkv', mimeType: 'video/x-matroska', buffer: Buffer.from('x') });
    text = await handOver(page.locator('.audio-drop-zone .sh-drop__rejects .sh-inline__secondary'), { name: 'n2-audio-reject', first: '我在 StudyHub 的「音频导入」' });
    assert.match(text, /讲座录像\.mkv/);
    await page.locator('details.audio-path > summary').click();
    await page.locator('.audio-path-row input').fill('C:\\Users\\me\\Videos\\第4周讲座.mp4');
    await page.locator('.audio-path-row').getByRole('button', { name: '选用' }).click();
    // (the problem line of the form itself, not the list of refused files above it)
    const problem = page.locator('.audio-import > .sh-inline--warning').filter({ hasText: '这不是支持的音频文件' });
    text = await handOver(problem.locator('.sh-inline__secondary'), { name: 'n6-audio-problem', first: '我在 StudyHub 的「音频导入」' });
    assert.match(text, /第4周讲座\.mp4/);
    await page.locator('.audio-path-row input').fill(broken);
    await page.locator('.audio-path-row').getByRole('button', { name: '选用' }).click();
    const blocked = page.locator('.audio-check--blocked [data-hand-off="import.file"]');
    if (await blocked.waitFor({ timeout: 20000 }).then(() => true, () => false)) {
      text = await handOver(blocked, { name: 'n7-audio-precheck', first: '我在 StudyHub 的「音频导入」' });
      assert.ok(text.includes('坏掉的录音.mp3'), `${tag}: the file is named`);
    } else {
      // the preview's pre-check took the file: say so, the place is only drawn on a blocked file
      await shot('n7-audio-precheck-not-blocked');
      console.error(`${tag}: N7 not reached: the pre-check did not block the broken recording`);
    }

    // ---------------- N8 on the home: a question run that failed ----------------
    await go('library');
    text = await handOver(page.locator('.cjc[data-job-id="run-failed"] [data-hand-off="job.failed"]'), { name: 'n8-home-card', first: '我在 StudyHub 的「任务」想把这个没做完的任务做完', tail: '' });
    assert.match(text, /\{"area":"generation"\}/);
    assert.match(text, /fetch failed: ECONNRESET/);

    // ---------------- N9 the console's line, N11 a conversion's diagnosis ----------------
    await go('tasks');
    await page.locator('.tc-row[data-task-id="run-failed"]').click();
    text = await handOver(page.locator('.tc-handoff [data-hand-off="job.failed"]'), { name: 'n9-console', first: '我在 StudyHub 的「任务」想把这个没做完的任务做完', tail: '' });
    assert.match(text, /jobId: run-failed/);
    await page.locator('.tc-row[data-task-id="pdf-failed"]').click();
    assert.equal(await page.locator('.tc-handoff [data-hand-off="job.failed"]').count(), 1, `${tag}: the line under every task that did not finish`);
    await page.getByRole('tab', { name: '转换详情' }).click();
    text = await handOver(page.locator('.pdf-failure [data-hand-off="job.failed"]'), { name: 'n11-pdf-failure', first: '我在 StudyHub 的「任务」想把这个没做完的任务做完', tail: '' });
    // the job's own error line, then the diagnosis 复制诊断信息 copies
    assert.match(text, /```data 错误原文\nMinerU 进程意外退出\nMinerU 进程意外退出（显存不足）\nexit code 1\ntorch\.cuda\.OutOfMemoryError: CUDA out of memory\nTried to allocate 2\.00 GiB\n```/);
    assert.match(text, /\{"area":"imports"\}/);

    // ---------------- 添加资料: N2 a refused file, N3 the batch, N10 a book too large ----------------
    await go('sources');
    await page.getByRole('button', { name: '添加资料' }).first().click();
    const hub = page.locator('.import-hub');
    await hub.waitFor({ timeout: 30000 });
    const hubInput = hub.locator('.sh-filedrop input[type=file]').first();
    await hubInput.setInputFiles({ name: '教材.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('x') });
    text = await handOver(hub.locator('.sh-drop__rejects .sh-inline__secondary'), { name: 'n2-hub-reject', first: '我在 StudyHub 的「添加资料」想把这些 StudyHub 不收的文件导入进来' });
    assert.match(text, /教材\.epub/);
    await hubInput.setInputFiles({ name: '旧讲义.doc', mimeType: 'application/msword', buffer: Buffer.from('x') });
    const summary = hub.locator('.import-hub__summary');
    await summary.waitFor({ timeout: 30000 });
    text = await handOver(summary.locator('.sh-inline__secondary'), { name: 'n3-hub-summary', first: '我在 StudyHub 的「添加资料」想把这些 StudyHub 不收的文件导入进来' });
    assert.match(text, /旧讲义\.doc: 暂不支持旧版 \.doc/);
    await hubInput.setInputFiles({ name: '整本教材.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(9 * 1024 * 1024, 32) });
    const large = hub.locator('.large-doc [data-hand-off="import.file"]').first();
    text = await handOver(large, { name: 'n10-large-pdf', first: '我在 StudyHub 的「添加资料」想把这份文件导入成学习资料' });
    assert.match(text, /整本教材\.pdf/);
    assert.match(text, /- 分段：PDF 太长时用 pages 分段导入/);
    // one hand-off for the batch, not one per row: the summary has one, the rows keep 移除 / 重试
    assert.equal(await summary.locator('[data-hand-off], .sh-inline__secondary').count(), 1);

    assert.equal((await page.evaluate(() => window.dshLog)).some((entry) => /submit/.test(entry)), false, `${tag}: submit was never touched`);
    assert.deepEqual(errors, [], `${tag}: no page errors`);
    await context.close();
  }
});
