/* node scripts/qa/usage-frequency.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>] [--all]
   The usage frequency record in the real app (browser preview; build dist/ first). One journey per language/theme/width, on a temporary
   library and a temporary home, with the fake model, every key/token/base-url variable removed from the environment and no network:

     1. OFF (the default): no capture listener on the app root, no usage request, no file, even after clicking around;
     2. Settings › Advanced › Usage frequency record: the contract is on screen; turn the switch on; the listener appears;
     3. use ~25 different controls across pages (sidebar, theme, folding, home, practice with the keys, a text field with a secret typed
        into it, the add-source dialog, the reader's display / practise / translate buttons, the experimental switch) with a tally of
        what was done; the report counts equal the tally exactly; using the usage section itself is not counted;
     4. the report (opened, 7 / 30 / all), Markdown and JSON exports (downloaded), copy, layout audit and overflow check;
     5. pause (nothing recorded, listener gone), resume, delete all (confirmation), switch off (no more requests, listener gone);
     6. a scan of the stored file, every export and every usage request body for any string of the seeded user content (course, deck,
        source, typed text), and a check that no request left the machine.
   With --all it runs zh and en x dark and light x 1440 and 420 and checks that both languages recorded the same keys.
   Writes <out>/summary.json and one screenshot per step; exits non-zero when a step fails or the page throws. */
/* global document, window, EventTarget -- page.evaluate callbacks run in the browser */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudyRuntime } from '../../lib/runtime/builtins.js';
import { previewCall } from '../preview-server.mjs';
import { finishCli, overflowProbe, parseQaArgs, runQa } from './harness.mjs';
import { layoutAudit } from './mineru-layout.mjs';

const SECRET = { course: 'ZZPRIVATE-COURSE', deck: 'ZZPRIVATE-DECK', source: 'ZZPRIVATE-SOURCE', typed: 'ZZPRIVATE-TYPED-TEXT' };
const NOTES = `# ${SECRET.source}\n\nIntroduction paragraph for the notes.\n\n## Hash indexes\n\nA hash index answers equality lookups quickly but cannot serve range queries.\n\n## Balanced trees\n\nThe most common index structure is a balanced tree which finds a key in logarithmic time.\n`;
const han = /[㐀-鿿]/;
const sleep = ms => new Promise(done => setTimeout(done, ms));

const card = (id, kind, sourceId, extra = {}) => ({ id, kind, topic: 'Indexes', objective: `Objective ${id}`, prompt: `What does question ${id} ask?`, answer: kind === 'quiz' ? 'a' : `Answer ${id}`, hint: 'Think of the definition.',
  explanation: 'Because a hash index answers equality lookups quickly.', misconception: 'The common mistake.', citations: [{ sourceId, quote: 'A hash index answers equality lookups quickly' }],
  ...(kind === 'quiz' ? { options: [{ id: 'a', text: 'Equality lookups', correct: true }, { id: 'b', text: 'Range queries', correct: false }] } : {}), ...extra });

async function seed(library) {
  const runtime = createStudyRuntime(library);
  const notes = await runtime.call('materials.document.import', { filename: `${SECRET.source}.md`, courses: [SECRET.course], dataBase64: Buffer.from(NOTES).toString('base64') });
  runtime.dispose();
  const { Store } = await import('../../lib/store.js');
  const store = new Store(library);
  await store.update(state => {
    state.decks.push({ id: 'zz-deck', title: SECRET.deck, course: SECRET.course, cards: [
      card('f1', 'flashcard', notes.sourceIds[0]), card('f2', 'flashcard', notes.sourceIds[0]), card('q1', 'quiz', notes.sourceIds[0]), card('f3', 'flashcard', notes.sourceIds[0])] });
  });
}

/** Patched in before the app loads: which capture listeners of the app root are installed right now. */
const SPY = () => {
  const active = new Map();
  const key = (target, type, capture) => `${type}:${capture ? 'capture' : 'bubble'}:${target === document ? 'document' : target === window ? 'window' : target?.classList?.contains?.('study-app') ? 'root' : ''}`;
  const names = new Set(['click', 'keydown', 'keyup', 'pagehide', 'visibilitychange']);
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function patched(type, handler, options) {
    const name = key(this, type, options === true || options?.capture === true);
    if (names.has(type) && !name.endsWith(':')) { const set = active.get(name) || new Set(); set.add(handler); active.set(name, set); }
    return add.call(this, type, handler, options);
  };
  EventTarget.prototype.removeEventListener = function patched(type, handler, options) {
    const name = key(this, type, options === true || options?.capture === true);
    active.get(name)?.delete(handler);
    return remove.call(this, type, handler, options);
  };
  window.__usageListeners = () => Object.fromEntries([...active].map(([name, set]) => [name, set.size]).filter(([, size]) => size > 0));
};

export async function runUsageQa(options) {
  let tally = new Map(), clicks = [];
  const home = join(options.out, 'work', 'home');
  const summaryOf = await runQa({ name: 'usage-frequency', options, seed, async run({ page, browserContext, server, t, step, check, summary }) {
    const requests = [], usageBodies = [], foreign = [], scanned = [], skipped = [];
    const origin = new URL(server.url).origin;
    await browserContext.addInitScript(SPY);
    page.on('request', request => {
      const url = request.url();
      if (!url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin) foreign.push(url);
      if (url.endsWith('/api/call')) { const body = JSON.parse(request.postData() || '{}'); requests.push(body.action); if (/^usage\.frequency\./.test(body.action)) usageBodies.push(request.postData() || ''); }
    });
    await page.reload();
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await sleep(800);
    const file = join(home, 'study', 'usage-frequency.json');
    const readFileSafe = path => readFile(path, 'utf8').then(text => text, () => null);
    const listeners = () => page.evaluate(() => window.__usageListeners());
    const api = (action, args = {}) => previewCall(server, action, args);
    // What was done, so the report can be held to it. A control that is not there or is disabled is skipped, not counted.
    const hit = async (key, locator, { expect = true } = {}) => {
      if (!(await locator.count())) { skipped.push(`${key}: not on the page`); return false; }
      // A control that is still loading (the reader's practice button waits for its question counts) is given a few seconds to become usable.
      let usable = false;
      for (let attempt = 0; attempt < 15 && !usable; attempt += 1) { usable = await locator.first().isEnabled().catch(() => false); if (!usable) await sleep(200); }
      if (!usable) { skipped.push(`${key}: disabled`); return false; }
      try { await locator.first().click({ timeout: 4000 }); } catch (error) {
        // Say what is in the way, so a control that cannot be reached is a finding and not a mystery.
        const cover = await locator.first().evaluate(element => {
          const box = element.getBoundingClientRect(), top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { box: [box.left, box.top, box.width, box.height].map(Math.round), top: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 50)}` : null, viewport: [window.innerWidth, window.innerHeight] };
        }).catch(() => null);
        skipped.push(`${key}: ${String(error.message).split('\n')[0]} ${JSON.stringify(cover)}`);
        return false;
      }
      if (expect) tally.set(key, (tally.get(key) || 0) + 1);
      clicks.push(key);
      await sleep(240); // beyond the 150 ms throttle, so each click is its own use
      return true;
    };
    // The app has listeners of its own (it watches visibility); only what the record adds is measured, against the count before it was switched on.
    let baseline = {};
    const added = async name => ((await listeners())[name] ?? 0) - (baseline[name] ?? 0);
    // The page flips its state when the host answers; the controller takes its listeners away (or installs them) a moment later: wait for that, briefly.
    const listenersAre = async (names, count) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const counts = await Promise.all(names.map(added));
        if (counts.every(value => value === count)) return true;
        await sleep(100);
      }
      return false;
    };
    const press = async (key, tallyKey) => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press(key); tally.set(tallyKey, (tally.get(tallyKey) || 0) + 1); await sleep(240); };
    const nav = id => page.locator(`[data-usage="nav.${id}"]`);
    const openAdvanced = async () => {
      if (!(await page.locator('.usage-settings').count())) await hit('nav.settings', nav('settings'));
      // The usage record is the 使用频率记录 category of Settings (a list on the left, one category on the right).
      const item = page.locator('[data-category="usage"]');
      await item.waitFor({ timeout: 15000 });
      if ((await item.getAttribute('aria-current')) !== 'page') await item.click();
      await page.locator('.usage-settings').waitFor({ timeout: 15000 });
      await page.locator('.usage-settings').scrollIntoViewIfNeeded();
      await sleep(300);
    };
    const section = page.locator('.usage-settings');
    const stateOf = () => section.getAttribute('data-state');
    const fit = async where => {
      const overflow = await page.evaluate(overflowProbe);
      if (overflow.scrollWidth - overflow.clientWidth > 1) throw new Error(`horizontal overflow at ${where}: ${JSON.stringify(overflow)}`);
      const audit = await page.evaluate(layoutAudit, { scopes: ['.usage-settings'], maxGap: 96 });
      // The segmented control's sliding thumb sits under its items by design.
      const problems = audit.problems.filter(problem => !/sh-seg__thumb/.test(problem));
      if (problems.length) throw new Error(`layout problems at ${where}: ${problems.slice(0, 3).join(' | ')}`);
    };

    // ---- 1. off by default ----
    await check('off-by-default', async () => {
      const before = baseline = await listeners();
      if ((before['click:capture:root'] ?? 0) !== 0 || (before['pagehide:bubble:window'] ?? 0) !== 0) throw new Error(`listeners installed while off: ${JSON.stringify(before)}`);
      for (const id of ['sources', 'generate', 'library']) await hit(`nav.${id}`, nav(id), { expect: false });
      if (requests.some(action => action === 'usage.frequency.record')) throw new Error('a usage record was sent while off');
      if (await readFileSafe(file) !== null) throw new Error('a usage file exists while off');
      const status = await api('usage.frequency.status');
      if (status.enabled || status.hasData) throw new Error(`status ${JSON.stringify(status)}`);
      return { listeners: before, statusRequests: requests.filter(action => action === 'usage.frequency.status').length };
    });
    await step('settings-off', async () => {
      await openAdvanced();
      if (await stateOf() !== 'off') throw new Error(`state ${await stateOf()}`);
      const text = await section.innerText();
      for (const needle of [t('只保存在这台电脑上', 'Stays on this computer'), t('不记录你输入、阅读或回答的任何内容', 'Never what you typed, read or answered'), t('随时查看、导出、暂停和删除', 'view, export, pause and delete')])
        if (!text.includes(needle)) throw new Error(`the contract does not say: ${needle}`);
      if (options.lang === 'en' && han.test(text)) throw new Error(`Han in the English section: ${text.match(/.{0,20}[㐀-鿿]+.{0,20}/)?.[0]}`);
      await fit('off');
    });

    // ---- 2. switch on ----
    await step('switch-on', async () => {
      await section.locator('input[name="usage-frequency"]').click();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'empty', null, { timeout: 15000 });
      if (!await listenersAre(['click:capture:root', 'keydown:capture:document', 'keyup:capture:document', 'visibilitychange:bubble:document', 'pagehide:bubble:window'], 1)) throw new Error(`the capture is not installed exactly once: ${JSON.stringify(await listeners())} (before: ${JSON.stringify(baseline)})`);
      if (!(await api('usage.frequency.status')).enabled) throw new Error('the host does not say it is on');
      // From here on every click is counted: start the tally from nothing (what was clicked while it was off was not recorded).
      tally = new Map(); clicks = [];
      await fit('on-empty');
    });

    // ---- 3. use controls ----
    await step('use-controls', async () => {
      for (const id of ['library', 'wrongbook', 'workflows', 'notes', 'board', 'exam', 'dashboard', 'sources', 'generate', 'skeleton', 'audio']) await hit(`nav.${id}`, nav(id));
      await hit('nav.live', nav('live'));
      await hit('nav.theme', page.locator('[data-usage="nav.theme"]')); await hit('nav.theme', page.locator('[data-usage="nav.theme"]')); await hit('nav.theme', page.locator('[data-usage="nav.theme"]'));
      await hit('nav.group', page.locator('[data-usage="nav.group"]').first()); await hit('nav.group', page.locator('[data-usage="nav.group"]').first());
      await hit('nav.collapse', page.locator('[data-usage="nav.collapse"]')); await hit('nav.collapse', page.locator('[data-usage="nav.collapse"]'));
      // practice, with the mouse and with the keys
      await hit('nav.library', nav('library'));
      await hit('home.start', page.locator('[data-usage="home.start"]'));
      await page.locator('.review-page').first().waitFor({ timeout: 20000 });
      await hit('review.flip', page.locator('[data-usage="review.flip"]'));
      await hit('review.grade', page.locator('[data-usage="review.grade"]').nth(4));
      await hit('review.next', page.locator('[data-usage="review.next"]'));
      await press('Space', 'shortcut.flip');
      await press('3', 'shortcut.digit');
      await press('h', 'shortcut.hint');
      await hit('review.prev', page.locator('[data-usage="review.prev"]'));
      await hit('review.option', page.locator('[data-usage="review.option"]'));
      // a text field with a secret typed into it: one use of "text field", nothing of the text
      await hit('nav.generate', nav('generate'));
      const field = page.locator('main textarea:visible, main input[type="text"]:visible').first();
      if (await field.count()) { await field.click(); tally.set('control.text-field', (tally.get('control.text-field') || 0) + 1); await page.keyboard.type(SECRET.typed); await sleep(240); await page.evaluate(() => document.activeElement?.blur?.()); }
      // sources: the add dialog and the reader
      await hit('nav.sources', nav('sources'));
      await hit('import.add', page.locator('[data-usage="import.add"]'));
      await page.keyboard.press('Escape'); await sleep(300);
      await page.getByRole('button', { name: t('全部展开', 'Expand all') }).click({ timeout: 2000 }).catch(() => {});
      const doc = page.locator('.source-doc .source-main').first();
      if (await doc.count()) {
        await doc.click(); await page.locator('.study-document-viewer').waitFor({ timeout: 15000 }); await sleep(600);
        for (const key of ['reader.display', 'reader.practice', 'reader.translate']) { await hit(key, page.locator(`.study-document-viewer [data-usage="${key}"]`)); await hit(key, page.locator(`.study-document-viewer [data-usage="${key}"]`)); }
        await page.keyboard.press('Escape'); await sleep(400);
        if (await page.locator('.study-document-viewer').count()) await page.locator('dialog[open] .sh-dialog__close').first().click().catch(() => {});
        await sleep(300);
      }
      // settings: the experimental switch, on and off
      await openAdvanced();
      const experimental = page.locator('[data-usage="settings.experimental"]');
      await hit('settings.experimental', experimental); await hit('settings.experimental', experimental);
      return { distinct: tally.size, total: [...tally.values()].reduce((a, b) => a + b, 0) };
    });

    // ---- 4. the report ----
    await step('report', async () => {
      await openAdvanced();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'on', null, { timeout: 15000 });
      await section.locator('.usage-report > summary').click();
      await page.locator('.usage-report .usage-rank__row').first().waitFor({ timeout: 15000 });
      const report = await api('usage.frequency.report', { period: 'all', language: options.lang });
      const everything = await api('usage.frequency.export', { format: 'json', period: 'all', language: options.lang });
      const exported = Object.fromEntries(JSON.parse(everything.content).controls.map(row => [row.key, row.count]));
      scanned.push(await readFileSafe(file) ?? '', everything.content);
      const wrong = [...tally].filter(([key, n]) => exported[key] !== n).map(([key, n]) => `${key}: did ${n}, recorded ${exported[key] ?? 0}`);
      if (wrong.length) throw new Error(`the counts differ from what was done: ${wrong.join('; ')}`);
      const noisy = Object.keys(exported).filter(key => /usage-frequency|记录使用频率|Record usage frequency/.test(key));
      if (noisy.length) throw new Error(`the usage section was counted: ${noisy.join(', ')}`);
      if (report.summary.distinctControls < 20) throw new Error(`only ${report.summary.distinctControls} distinct controls`);
      const text = await section.innerText();
      if (options.lang === 'en' && han.test(text.replace(/ZZPRIVATE[\w-]*/g, ''))) throw new Error(`Han in the English report: ${text.match(/.{0,24}[㐀-鿿]+.{0,24}/)?.[0]}`);
      await section.locator('.usage-report').scrollIntoViewIfNeeded();
      await fit('report');
      return { summary: report.summary, observations: report.observations.map(item => item.id), keys: Object.keys(exported).length };
    });
    await step('report-periods', async () => {
      for (const label of [t('最近 7 天', 'Last 7 days'), t('全部时间', 'All time'), t('最近 30 天', 'Last 30 days')]) {
        await section.getByRole('button', { name: label, exact: true }).click(); await sleep(500);
        if (!(await section.locator('.usage-summary dd').first().innerText()).trim()) throw new Error(`no summary for ${label}`);
      }
      await section.locator('.usage-never > summary').click(); await sleep(200);
      await fit('report-open-never');
    });

    // ---- exports ----
    let keysOut = null;
    await check('exports', async () => {
      const exported = [];
      for (const [label, ext] of [[t('导出 Markdown', 'Export Markdown'), 'md'], [t('导出 JSON', 'Export JSON'), 'json']]) {
        const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: label, exact: true }).click()]);
        const path = await download.path();
        const content = await readFile(path, 'utf8');
        if (!download.suggestedFilename().endsWith(`.${ext}`)) throw new Error(`file name ${download.suggestedFilename()}`);
        exported.push(content); scanned.push(content);
        if (options.lang === 'en' && ext === 'md' && han.test(content)) throw new Error(`Han in the English Markdown: ${content.match(/.{0,24}[㐀-鿿]+.{0,24}/)?.[0]}`);
      }
      const data = JSON.parse(exported[1]);
      if (data.app !== 'StudyHub' || !data.version || data.period !== 30 && data.period !== 7 && data.period !== 'all') throw new Error('the JSON export misses app, version or period');
      keysOut = Object.fromEntries(data.controls.filter(row => /^[a-z]+\.[a-z.-]+$/.test(row.key)).map(row => [row.key, row.count]).sort(([a], [b]) => (a < b ? -1 : 1)));
      await writeFile(join(options.out, 'keys.json'), `${JSON.stringify(keysOut, null, 2)}\n`);
      await section.getByRole('button', { name: t('复制报告', 'Copy report'), exact: true }).click(); await sleep(600);
      const after = await section.innerText();
      const copied = after.includes(t('报告已复制', 'Report copied')) ? 'copied' : after.includes(t('不允许复制', 'does not allow copying')) ? 'refused by the window (the message says so)' : 'no message';
      if (copied === 'no message') throw new Error('copy gave neither a confirmation nor an explanation');
      return { exports: exported.map(text => text.length), keys: Object.keys(keysOut).length, copy: copied };
    });
    await step('report-after-export', async () => { await section.scrollIntoViewIfNeeded(); await fit('after export'); });

    // ---- 5. pause, resume, delete, off ----
    await step('pause', async () => {
      await section.getByRole('button', { name: t('暂停记录', 'Pause recording'), exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'paused', null, { timeout: 15000 });
      if (!await listenersAre(['click:capture:root', 'keydown:capture:document', 'pagehide:bubble:window'], 0)) throw new Error(`still listening while paused: ${JSON.stringify(await listeners())}`);
      const before = (await api('usage.frequency.report', { period: 'all', language: options.lang })).ranking.find(row => row.key === 'nav.library')?.count;
      await hit('nav.library', nav('library'), { expect: false }); await hit('nav.library', nav('library'), { expect: false });
      await hit('nav.settings', nav('settings'), { expect: false });
      await openAdvanced();
      const after = (await api('usage.frequency.report', { period: 'all', language: options.lang })).ranking.find(row => row.key === 'nav.library')?.count;
      if (before !== after) throw new Error(`recorded while paused: ${before} -> ${after}`);
      await fit('paused');
    });
    await step('resume', async () => {
      await section.getByRole('button', { name: t('继续记录', 'Resume recording'), exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'on', null, { timeout: 15000 });
      if (!await listenersAre(['click:capture:root', 'pagehide:bubble:window'], 1)) throw new Error('resumed, but the capture is not back');
      const before = (await api('usage.frequency.report', { period: 'all', language: options.lang })).ranking.find(row => row.key === 'nav.library')?.count ?? 0;
      await hit('nav.library', nav('library')); await hit('nav.settings', nav('settings'));
      await openAdvanced();
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await sleep(500);
      const after = (await api('usage.frequency.report', { period: 'all', language: options.lang })).ranking.find(row => row.key === 'nav.library')?.count;
      if (after !== before + 1) throw new Error(`resumed but nav.library went ${before} -> ${after}`);
    });
    await step('delete-all', async () => {
      if (!(await section.locator('.usage-report').evaluate(element => element.open))) await section.locator('.usage-report > summary').click();
      await section.getByRole('button', { name: t('删除全部记录', 'Delete all records'), exact: true }).first().click();
      await page.locator('dialog[open]').waitFor({ timeout: 10000 });
      await page.locator('dialog[open]').getByRole('button', { name: t('取消', 'Cancel'), exact: true }).click(); await sleep(300);
      if ((await api('usage.frequency.status')).hasData !== true) throw new Error('cancel deleted the record');
      await section.getByRole('button', { name: t('删除全部记录', 'Delete all records'), exact: true }).first().click();
      await page.locator('dialog[open]').getByRole('button', { name: t('删除全部记录', 'Delete all records'), exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'empty', null, { timeout: 15000 });
      const status = await api('usage.frequency.status');
      if (status.hasData || !status.enabled) throw new Error(`after deleting: ${JSON.stringify(status)}`);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (Object.keys(stored.controls).length) throw new Error('the file still holds controls');
      await fit('deleted');
    });
    await step('switch-off', async () => {
      const cut = requests.length;
      await section.locator('input[name="usage-frequency"]').click();
      await page.waitForFunction(() => document.querySelector('.usage-settings')?.getAttribute('data-state') === 'off', null, { timeout: 15000 });
      if (!await listenersAre(['click:capture:root', 'keydown:capture:document', 'keyup:capture:document', 'pagehide:bubble:window', 'visibilitychange:bubble:document'], 0)) throw new Error(`still listening after off: ${JSON.stringify(await listeners())}`);
      const settled = requests.length;
      for (const id of ['library', 'sources', 'dashboard', 'settings']) await hit(`nav.${id}`, nav(id), { expect: false });
      await sleep(1500);
      // The one status read the page makes when the switch changes is not recording; a record, report or export after "off" would be.
      const sent = requests.slice(settled).filter(action => /^usage\.frequency\.(record|report|export|clear|set)$/.test(action));
      if (sent.length) throw new Error(`usage requests after off: ${sent.join(', ')}`);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (Object.keys(stored.controls).length) throw new Error('something was recorded after off');
      return { requestsAfterOff: requests.slice(cut).filter(action => /^usage\.frequency\./.test(action)) };
    });

    // ---- 6. privacy ----
    await check('privacy-scan', async () => {
      // The file as it stood when it held the whole journey, every export, every usage request body: none carries what the learner's data said or typed.
      if (scanned.length < 4) throw new Error('nothing was scanned');
      const everything = [...scanned, ...usageBodies].join('\n');
      for (const [name, value] of Object.entries(SECRET)) if (everything.includes(value)) throw new Error(`the ${name} sentinel (${value}) appears in the stored file, an export or a usage request`);
      if (foreign.length) throw new Error(`requests left the machine: ${foreign.slice(0, 3).join(', ')}`);
      return { scannedBytes: everything.length, usageRequests: usageBodies.length, foreign: foreign.length };
    });
    summary.tally = Object.fromEntries(tally);
    summary.skipped = skipped;
    summary.keys = keysOut;
  } });
  return summaryOf;
}

/** Both languages did the same things: the same registered keys with the same counts. */
export async function compareLanguages(outs) {
  const [zh, en] = await Promise.all(outs.map(out => readFile(join(out, 'keys.json'), 'utf8').then(JSON.parse, () => null)));
  if (!zh || !en) return ['keys.json missing'];
  const problems = [];
  // A control the journey could not reach in one language (reported in summary.json `skipped`, with what covers it) is a layout finding, not a key difference.
  const unreachable = new Set((await Promise.all(outs.map(out => readFile(join(out, 'summary.json'), 'utf8').then(text => JSON.parse(text).skipped ?? [], () => [])))).flat().map(line => line.split(':')[0]));
  for (const key of new Set([...Object.keys(zh), ...Object.keys(en)])) if (zh[key] !== en[key] && !unreachable.has(key)) problems.push(`${key}: zh ${zh[key] ?? 'none'} vs en ${en[key] ?? 'none'}`);
  return problems;
}

const argv = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const all = argv.includes('--all');
  const combos = all ? ['dark', 'light'].flatMap(theme => [1440, 420].map(width => ({ theme, width }))) : [null];
  let failed = false;
  for (const combo of combos) {
    const outs = {};
    for (const lang of all ? ['zh', 'en'] : [null]) {
      const options = parseQaArgs(all ? [...argv.filter(arg => arg !== '--all'), '--lang', lang, '--theme', combo.theme, '--width', String(combo.width)] : argv, 'usage-frequency');
      await mkdir(options.out, { recursive: true });
      const summary = await runUsageQa(options);
      finishCli(`usage frequency ${options.lang}/${options.theme}/${options.width}`, options, summary);
      failed ||= !summary.ok;
      outs[options.lang] = options.out;
    }
    if (all) {
      const problems = await compareLanguages([outs.zh, outs.en]);
      console.log(problems.length ? `LANGUAGES DIFFER (${combo.theme}/${combo.width}): ${problems.join('; ')}` : `languages agree (${combo.theme}/${combo.width})`);
      failed ||= problems.length > 0;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
