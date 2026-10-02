import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dom, fakeRoot, fakeTimers, loadUsageModules } from './helpers/usage-dom.mjs';

/* The capture side of the usage frequency record: one delegated listener resolves a control to a stable, language-independent key
   (data-usage, then its own stable hook, then area/role/canonical name taken from the app's own copy), and a collector batches the counts.
   Nothing the learner typed, read or named can become a key; nothing is installed or scheduled while the record is off. */

const m = await loadUsageModules();
const han = /[㐀-鿿]/;
const withLanguage = (language, fn) => { m.setUiLanguage(language); try { return fn(); } finally { m.setUiLanguage('zh'); } };
const tree = (html, options) => dom(`<main data-usage-area="settings">${html}</main>`, options);
const keyOf = (page, tag = 'button') => m.resolveUsageControl(page.byTag(tag)[0])?.key;

test('names: numbers and dynamic data are stripped, and only the app\'s own copy is ever a name', () => {
  assert.equal(m.canonicalName('开始做这 12 道题'), '开始做这 N 道题');
  assert.equal(m.canonicalName('开始做这 3 道题'), '开始做这 N 道题');
  assert.equal(m.canonicalName('保存复习设置'), '保存复习设置');
  assert.equal(m.canonicalName('我的操作系统课 2026 期末笔记'), null, 'text that is not the app\'s copy is not a name');
  assert.equal(m.canonicalName('Databases'), null);
  assert.equal(m.canonicalName(''), null);
  assert.equal(m.canonicalName('   '), null);
});

test('names: the English copy maps back to the same canonical Chinese source, so both languages key alike', () => {
  const zh = m.ui('保存复习设置');
  const en = withLanguage('en', () => m.ui('保存复习设置'));
  assert.notEqual(zh, en);
  assert.equal(m.canonicalName(en), m.canonicalName(zh));
  const many = withLanguage('en', () => m.uiFormat('开始做这 {0} 道题', [12]));
  assert.equal(m.canonicalName(many), m.canonicalName('开始做这 12 道题'));
  assert.equal(m.canonicalName(many), '开始做这 N 道题');
  // A shown name comes back in the language of the page, never the other one.
  assert.ok(han.test(m.displayName('开始做这 N 道题', 'zh')));
  const shown = m.displayName('开始做这 N 道题', 'en');
  assert.ok(!han.test(shown), shown);
  assert.match(shown, /\bN\b/);
});

test('names: every UI string with the same English meaning shares one canonical key in both directions', () => {
  // Pick a few real controls of the app and check both languages against each other.
  for (const source of ['保存复习设置', '导出学习库', '清空陪学画像', '下一题', '上一题', '提交答案', '添加资料', '设置', '统计', '显示实验性功能']) {
    const english = withLanguage('en', () => m.ui(source));
    assert.equal(m.canonicalName(english), m.canonicalName(source), source);
  }
});

test('key priority: data-usage first, whatever else the control carries', () => {
  const page = tree('<button data-usage="nav.library" data-tour="nav-library" data-testid="x" id="lib" class="reader-peek" aria-label="下一题">下一题</button>');
  assert.deepEqual(m.resolveUsageControl(page.byTag('button')[0]), { key: 'nav.library', area: 'settings', source: 'usage' });
});

test('a click on something inside a control resolves to the control, and data-usage on the control wins over a wrapper', () => {
  const page = tree('<div data-usage="wrapper.thing"><button data-usage="review.next"><span><svg><path></path></svg></span></button></div>');
  const inner = page.byTag('path')[0] || page.byTag('span')[0];
  assert.equal(m.resolveUsageControl(inner).key, 'review.next');
});

test('then the control\'s own stable hooks: data-tour, data-testid, a stable id, a unique class hook; never from a container', () => {
  assert.equal(keyOf(tree('<button data-tour="generate-submit">x</button>')), 'tour.generate-submit');
  assert.equal(keyOf(tree('<button data-testid="export-all">x</button>')), 'testid.export-all');
  assert.equal(keyOf(tree('<button id="backup-restore">x</button>')), 'id.backup-restore');
  assert.equal(keyOf(tree('<button class="pill reader-peek">看原页</button>')), 'reader.peek');
  assert.equal(keyOf(tree('<button id=":r4:">x</button>')), 'settings/button', 'a generated id is not stable and is never used');
  assert.equal(keyOf(tree('<button id="item-12345">x</button>')), 'settings/button', 'an id with a number in it is data, not a hook');
  // A data-tour on a container is a tour anchor for the whole section, not the control.
  assert.equal(keyOf(tree('<section data-tour="settings-model"><button>某个按钮</button></section>')), 'settings/button');
});

test('then area/role/name from the app\'s own copy: the same key in Chinese and in English', () => {
  const zh = tree(`<button>${m.ui('保存复习设置')}</button>`);
  const key = keyOf(zh);
  assert.equal(key, 'settings/button/保存复习设置');
  const en = withLanguage('en', () => tree(`<button>${m.ui('保存复习设置')}</button>`));
  assert.equal(keyOf(en), key);
  // aria-label counts as the accessible name, the visible text is the fallback.
  const labelled = withLanguage('en', () => tree(`<button aria-label="${m.ui('收起侧边栏')}">«</button>`));
  assert.equal(keyOf(labelled), 'settings/button/收起侧边栏');
  // links, disclosures, tabs, switches have roles of their own
  assert.equal(keyOf(tree(`<a href="#x">${m.ui('统计')}</a>`), 'a'), 'settings/link/统计');
  assert.equal(keyOf(tree(`<details><summary>${m.ui('高级')}</summary></details>`), 'summary'), 'settings/disclosure/高级');
  assert.equal(m.resolveUsageControl(tree(`<div role="tab" tabindex="0">${m.ui('统计')}</div>`).byTag('div')[0]).key, 'settings/tab/统计');
});

test('numbers in a name are stripped: a button labelled with a count keys as the template', () => {
  const zh = tree(`<button>${m.uiFormat('开始做这 {0} 道题', [12])}</button>`);
  const en = withLanguage('en', () => tree(`<button>${m.uiFormat('开始做这 {0} 道题', [12])}</button>`));
  assert.equal(keyOf(zh), 'settings/button/开始做这 N 道题');
  assert.equal(keyOf(en), 'settings/button/开始做这 N 道题');
  assert.equal(keyOf(tree(`<button>${m.uiFormat('开始做这 {0} 道题', [3])}</button>`)), 'settings/button/开始做这 N 道题');
});

test('no user data in a key: names that are not the app\'s copy fall back to area/role, never the text', () => {
  const seeded = ['我的操作系统期末笔记', 'Databases 2026 final notes.pdf', 'alice@example.com', 'https://school.example/secret?token=1', '第3章 事务与锁（张老师）', 'CS3219 Lecture 7'];
  for (const text of seeded) {
    const area = '<main data-usage-area="library">';
    for (const html of [`<button>${text}</button>`, `<button aria-label="${text}">x</button>`, `<a href="#">${text}</a>`, `<button title="${text}">x</button>`, `<div role="button">${text}</div>`]) {
      const page = dom(`${area}${html}</main>`);
      const tag = page.all.find(item => ['BUTTON', 'A', 'DIV'].includes(item.tagName) && item.tagName !== 'MAIN');
      const resolved = m.resolveUsageControl(tag);
      assert.ok(/^library\/(button|link)$/.test(resolved.key), `${html} -> ${resolved.key}`);
      assert.ok(!resolved.key.includes(text.slice(0, 6)), resolved.key);
    }
  }
});

test('text fields: clicking into one is "text field" and nothing else; no value, placeholder, label or content is read', () => {
  const secret = 'my password is hunter2 and my essay about 区块链';
  const page = tree(`<label for="q">${secret}</label><input id="q" type="text" value="${secret}" placeholder="${secret}" aria-label="${secret}"><textarea aria-label="${secret}">${secret}</textarea>
    <input type="password" value="hunter2"><div contenteditable="true" aria-label="${secret}"><span>${secret}</span></div><div class="cm-editor"><div contenteditable="true" class="cm-content"><p>${secret}</p></div></div>`);
  for (const element of [page.byTag('input')[0], page.byTag('textarea')[0], page.byTag('input')[1], page.byTag('div')[0], page.byTag('span')[0], page.byTag('p')[0]]) {
    const resolved = m.resolveUsageControl(element);
    assert.equal(resolved.key, 'control.text-field', element.tagName);
    assert.ok(!JSON.stringify(resolved).includes('hunter2'));
  }
  // checkboxes and selects take their name from their label, and are keyed only if it is the app's copy
  const on = tree(`<label for="c">${m.ui('显示实验性功能')}</label><input id="c" type="checkbox">`);
  assert.equal(m.resolveUsageControl(on.byTag('input')[0]).key, 'settings/checkbox/显示实验性功能');
  const unknown = tree('<label for="c">Include my "Quantum notes" deck</label><input id="c" type="checkbox"><select aria-label="Quantum notes"><option>Quantum notes</option></select>');
  assert.equal(m.resolveUsageControl(unknown.byTag('input')[0]).key, 'settings/checkbox');
  assert.equal(m.resolveUsageControl(unknown.byTag('select')[0]).key, 'settings/select');
});

test('not a control, not recorded: a click on plain text or a layout box counts for nothing; a click inside the usage section counts for nothing', () => {
  const page = tree('<p>Some text</p><div class="box"><span>inside</span></div>');
  assert.equal(m.resolveUsageControl(page.byTag('p')[0]), null);
  assert.equal(m.resolveUsageControl(page.byTag('span')[0]), null);
  const ignored = tree('<section data-usage-ignore><button data-usage="nav.library">x</button><button>y</button></section>');
  assert.equal(m.resolveUsageControl(ignored.byTag('button')[0]), null);
  assert.equal(m.resolveUsageControl(ignored.byTag('button')[1]), null);
});

test('the area is the nearest page marker above the control; an unknown page is "other"', () => {
  assert.equal(m.resolveUsageControl(dom('<main data-usage-area="review"><div data-usage-area="reader"><button>x</button></div></main>').byTag('button')[0]).area, 'reader');
  assert.equal(m.resolveUsageControl(dom('<main data-usage-area="my private deck"><button>x</button></main>').byTag('button')[0]).area, 'other');
  assert.equal(m.resolveUsageControl(dom('<main><button>x</button></main>').byTag('button')[0], { fallbackArea: 'library' }).area, 'library');
});

test('keys are plain: short, no URL, no path, no e-mail, and the same for any one control however often it is asked', () => {
  const page = tree(`<button>${m.ui('保存复习设置')}</button>`);
  const key = m.resolveUsageControl(page.byTag('button')[0]).key;
  for (let i = 0; i < 5; i += 1) assert.equal(m.resolveUsageControl(page.byTag('button')[0]).key, key);
  assert.ok(key.length < 96);
  assert.ok(!/[@\\?=&#%<>"]|\/\//.test(key));
});

/* ---------- shortcuts ---------- */

test('documented shortcuts are keyed from the key and the page, and only where the app would act on them', () => {
  const body = dom('<main data-usage-area="review"><div class="page"></div></main>').byTag('div')[0];
  const press = (key, extra = {}, target = body) => m.shortcutKeyFor({ key, code: extra.code || '', target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...extra });
  assert.equal(press('s'), 'shortcut.resume');
  assert.equal(press('S'), 'shortcut.resume');
  assert.equal(press('a'), 'shortcut.autopilot');
  assert.equal(press('?', { shiftKey: true, code: 'Slash' }), 'shortcut.help');
  assert.equal(press('3'), 'shortcut.digit');
  assert.equal(press('0'), 'shortcut.digit');
  assert.equal(press('Enter'), 'shortcut.next');
  assert.equal(press('ArrowRight'), 'shortcut.next');
  assert.equal(press('ArrowLeft'), 'shortcut.prev');
  assert.equal(press(' ', { code: 'Space' }), 'shortcut.flip');
  assert.equal(press('h'), 'shortcut.hint');
  assert.equal(press('t'), 'shortcut.explain');
  assert.equal(press('x'), null, 'a key with no shortcut');
  assert.equal(press('s', { ctrlKey: true }), null, 'a browser shortcut is not an app shortcut');
  assert.equal(press('s', { metaKey: true }), null);
  assert.equal(press('s', { altKey: true }), null);
  assert.equal(press('s', { repeat: true }), null, 'holding a key down counts once');
  // typing never counts, and Enter or Space on a focused button is a click (counted as the button, not twice)
  const page = dom('<main data-usage-area="review"><input type="text"><textarea></textarea><div contenteditable="true"><span></span></div><select></select><button>下一题</button><dialog open><p>x</p></dialog></main>');
  for (const target of [page.byTag('input')[0], page.byTag('textarea')[0], page.byTag('span')[0], page.byTag('select')[0], page.byTag('p')[0]]) assert.equal(press('s', {}, target), null, target.tagName);
  assert.equal(press('Enter', {}, page.byTag('button')[0]), null);
  assert.equal(press(' ', { code: 'Space' }, page.byTag('button')[0]), null);
  assert.equal(press('s', {}, page.byTag('button')[0]), 'shortcut.resume', 'a letter key with focus on a button still triggers the shortcut');
  // review-only keys outside the practice page are not shortcuts
  const library = dom('<main data-usage-area="library"><div></div></main>').byTag('div')[0];
  for (const key of ['h', 't', '3', 'ArrowLeft', 'Enter']) assert.equal(press(key, {}, library), null, key);
  assert.equal(press('s', {}, library), 'shortcut.resume');
  const reader = dom('<main data-usage-area="reader"><div></div></main>').byTag('div')[0];
  assert.equal(press('p', {}, reader), 'shortcut.practice');
  assert.equal(press('p', {}, library), null);
});

/* ---------- the collector ---------- */

const day = '2026-10-03';
const clock = () => { let at = new Date(`${day}T12:00:00`).getTime(); return { now: () => at, advance: ms => { at += ms; } }; };

test('the collector aggregates in memory by day, area and key, and sends one batch when it flushes', async () => {
  const sent = [], timers = fakeTimers(), c = clock();
  const collector = m.createUsageCollector({ send: batch => { sent.push(batch); return Promise.resolve({ accepted: batch.length, enabled: true }); }, now: c.now, setTimer: timers.set, clearTimer: timers.clear });
  collector.start();
  assert.equal(timers.count(), 0, 'no timer until something is recorded');
  for (let i = 0; i < 5; i += 1) { collector.record('nav.library', 'library'); c.advance(1000); }
  collector.record('review.next', 'review'); c.advance(1000);
  assert.equal(sent.length, 0, 'nothing is sent per click');
  assert.equal(timers.count(), 1, 'one timer, started by the first event');
  assert.deepEqual(timers.delays(), [30000]);
  assert.equal(collector.pending(), 2);
  await collector.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].sort((a, b) => a.key.localeCompare(b.key)), [
    { key: 'nav.library', area: 'library', day, n: 5 }, { key: 'review.next', area: 'review', day, n: 1 }]);
  assert.equal(collector.pending(), 0);
  assert.equal(timers.count(), 0, 'idle again: no timer');
  await collector.flush();
  assert.equal(sent.length, 1, 'an empty flush sends nothing');
});

test('the timer fires the batch every ~30 s while dirty, and an event on another day files under that day (local date)', async () => {
  const sent = [], timers = fakeTimers(), c = clock();
  const collector = m.createUsageCollector({ send: async batch => { sent.push(batch); return { accepted: batch.length, enabled: true }; }, now: c.now, setTimer: timers.set, clearTimer: timers.clear });
  collector.start();
  collector.record('nav.library', 'library');
  timers.fire(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.length, 1);
  c.advance(13 * 3600000); // past midnight, local
  collector.record('nav.library', 'library');
  assert.equal(timers.count(), 1);
  await collector.flush();
  assert.notEqual(sent[1][0].day, sent[0][0].day);
  assert.match(sent[1][0].day, /^\d{4}-\d{2}-\d{2}$/);
});

test('double events and held keys are throttled: the same key inside the window counts once; a different key is not held back', () => {
  const timers = fakeTimers(), c = clock();
  const collector = m.createUsageCollector({ send: async () => ({}), now: c.now, setTimer: timers.set, clearTimer: timers.clear, throttleMs: 150 });
  collector.start();
  assert.equal(collector.record('review.next', 'review'), true);
  c.advance(20);
  assert.equal(collector.record('review.next', 'review'), false, 'a double event');
  assert.equal(collector.record('review.prev', 'review'), true);
  c.advance(20);
  assert.equal(collector.record('review.next', 'review'), false, 'still inside the window of its own last count');
  c.advance(300);
  assert.equal(collector.record('review.next', 'review'), true);
  assert.equal(collector.pending(), 2);
});

test('a failed flush keeps the counts for the next one; the pending map is bounded; stop() flushes and clears the timer; a stopped collector records nothing', async () => {
  const timers = fakeTimers(), c = clock(); let fail = true; const sent = [];
  const collector = m.createUsageCollector({ send: async batch => { if (fail) throw new Error('offline'); sent.push(batch); return { accepted: batch.length, enabled: true }; }, now: c.now, setTimer: timers.set, clearTimer: timers.clear, maxPending: 50 });
  collector.start();
  collector.record('nav.library', 'library');
  await collector.flush();
  assert.equal(collector.pending(), 1, 'kept');
  fail = false;
  collector.record('nav.library', 'library'); c.advance(1000);
  await collector.flush();
  assert.equal(sent[0][0].n, 2, 'the failed batch and the new one are one');
  for (let i = 0; i < 400; i += 1) { collector.record(`derived/button/k${i}`, 'library'); c.advance(1); }
  assert.ok(collector.pending() <= 51, `${collector.pending()} pending`);
  collector.record('nav.library', 'library');
  await collector.stop();
  assert.equal(timers.count(), 0);
  assert.equal(collector.record('nav.library', 'library'), false, 'stopped');
  assert.equal(collector.pending(), 0);
});

test('when the host says it is off (or paused), the collector drops what it holds and stops', async () => {
  const timers = fakeTimers(), c = clock(); let stopped = 0;
  const collector = m.createUsageCollector({ send: async () => ({ accepted: 0, enabled: false }), now: c.now, setTimer: timers.set, clearTimer: timers.clear, onRefused: () => { stopped += 1; } });
  collector.start(); collector.record('nav.library', 'library');
  await collector.flush();
  assert.equal(stopped, 1);
  assert.equal(collector.pending(), 0);
});

/* ---------- the listener ---------- */

test('one delegated capture-phase listener on the root records clicks of controls, never plain text, and never the usage section itself', () => {
  const root = fakeRoot('settings'), recorded = [];
  const stop = m.installUsageCapture(root, { record: (key, area) => { recorded.push([key, area]); return true; } });
  assert.deepEqual(root.added.sort(), ['click', 'keydown', 'keyup']);
  assert.ok(root.listeners.every(item => item.options === true || item.options?.capture === true), 'capture phase');
  const page = dom('<main data-usage-area="settings"><button data-usage="nav.library">a</button><p>text</p><section data-usage-ignore><button>in the usage section</button></section><input type="text"></main>');
  root.fire('click', { target: page.byTag('button')[0] });
  root.fire('click', { target: page.byTag('p')[0] });
  root.fire('click', { target: page.byTag('button')[1] });
  root.fire('click', { target: page.byTag('input')[0] });
  assert.deepEqual(recorded, [['nav.library', 'settings'], ['control.text-field', 'settings']]);
  stop();
  assert.equal(root.listeners.length, 0, 'uninstalled completely');
});

test('keyboard activation counts once: Enter on a button is the button\'s click; a held Enter or Space does not repeat; documented shortcuts are counted', () => {
  const root = fakeRoot('review'), recorded = [];
  m.installUsageCapture(root, { record: (key, area) => { recorded.push([key, area]); return true; } });
  const page = dom('<main data-usage-area="review"><button data-usage="review.next">下一题</button><div></div></main>');
  const button = page.byTag('button')[0], body = page.byTag('div')[0];
  // keyboard-made click (detail 0) while the key is not repeating: counted
  root.fire('keydown', { key: 'Enter', target: button }); root.fire('click', { target: button, detail: 0 }); root.fire('keyup', { key: 'Enter', target: button });
  // held down: the keydown repeats and each repeat makes a click
  root.fire('keydown', { key: 'Enter', target: button }); root.fire('click', { target: button, detail: 0 });
  root.fire('keydown', { key: 'Enter', target: button, repeat: true }); root.fire('click', { target: button, detail: 0 });
  root.fire('keydown', { key: 'Enter', target: button, repeat: true }); root.fire('click', { target: button, detail: 0 });
  root.fire('keyup', { key: 'Enter', target: button });
  assert.deepEqual(recorded.map(item => item[0]), ['review.next', 'review.next'], 'two presses, not four clicks');
  recorded.length = 0;
  root.fire('keydown', { key: 'ArrowRight', target: body }); root.fire('keyup', { key: 'ArrowRight', target: body });
  root.fire('keydown', { key: 'h', target: body }); root.fire('keyup', { key: 'h', target: body });
  root.fire('keydown', { key: 'x', target: body });
  assert.deepEqual(recorded.map(item => item[0]), ['shortcut.next', 'shortcut.hint']);
});

/* ---------- off means off ---------- */

test('OFF: no listener is installed, no timer runs, nothing is sent: the controller only asks for the status once', async () => {
  const root = fakeRoot(), timers = fakeTimers(), calls = [], lifecycle = fakeRoot();
  const controller = m.createUsageController({ root, lifecycle, now: Date.now, setTimer: timers.set, clearTimer: timers.clear,
    call: async (action, args) => { calls.push(action); return action === 'usage.frequency.status' ? { enabled: false, paused: false } : {}; } });
  await controller.refresh();
  assert.deepEqual(calls, ['usage.frequency.status']);
  assert.equal(controller.active, false);
  assert.deepEqual(root.added, [], 'no listener on the root');
  assert.deepEqual(lifecycle.added, [], 'no pagehide or visibility listener either');
  assert.equal(timers.count(), 0, 'no timer');
  // a click that happens anyway goes nowhere
  root.fire('click', { target: dom('<button>x</button>').byTag('button')[0] });
  assert.deepEqual(calls, ['usage.frequency.status']);
  controller.dispose();
  // a status that cannot be read is off, never an error
  const broken = m.createUsageController({ root: fakeRoot(), lifecycle: fakeRoot(), setTimer: timers.set, clearTimer: timers.clear, call: async () => { throw new Error('down'); } });
  await broken.refresh();
  assert.equal(broken.active, false);
});

test('ON: the controller installs the capture and the page-lifecycle flush; recording is batched; turning it off flushes, uninstalls and clears the timer; paused does the same', async () => {
  const root = fakeRoot('library'), lifecycle = fakeRoot(), timers = fakeTimers(), calls = []; let status = { enabled: true, paused: false };
  const controller = m.createUsageController({ root, lifecycle, setTimer: timers.set, clearTimer: timers.clear,
    call: async (action, args) => { calls.push([action, args]); if (action === 'usage.frequency.status') return status; if (action === 'usage.frequency.record') return { accepted: args.records.length, enabled: true }; return {}; } });
  await controller.refresh();
  assert.equal(controller.active, true);
  assert.deepEqual(root.added.sort(), ['click', 'keydown', 'keyup']);
  assert.deepEqual([...new Set(lifecycle.added)].sort(), ['pagehide', 'visibilitychange']);
  assert.equal(timers.count(), 0, 'no timer while idle');
  const button = dom('<main data-usage-area="library"><button data-usage="nav.library">x</button></main>').byTag('button')[0];
  root.fire('click', { target: button });
  assert.equal(timers.count(), 1);
  assert.equal(calls.filter(([action]) => action === 'usage.frequency.record').length, 0, 'nothing sent per click');
  lifecycle.fire('pagehide', {});
  await new Promise(done => setImmediate(done));
  const records = calls.filter(([action]) => action === 'usage.frequency.record');
  assert.equal(records.length, 1, 'the page going away flushes');
  assert.deepEqual(records[0][1].records.map(({ key, area, n }) => [key, area, n]), [['nav.library', 'library', 1]]);
  root.fire('click', { target: button });
  status = { enabled: false, paused: false };
  await controller.refresh();
  assert.equal(controller.active, false);
  assert.equal(root.listeners.length, 0);
  assert.equal(lifecycle.listeners.length, 0);
  assert.equal(timers.count(), 0);
  assert.equal(calls.filter(([action]) => action === 'usage.frequency.record').length, 2, 'what was pending is flushed when it is turned off');
  status = { enabled: true, paused: true };
  await controller.refresh();
  assert.equal(controller.active, false, 'paused records nothing and installs nothing');
  assert.equal(root.listeners.length, 0);
  controller.dispose();
});

test('the page announces a change of the switch to every controller (Settings turning it on starts the capture without a reload)', async () => {
  const root = fakeRoot(), lifecycle = fakeRoot(), timers = fakeTimers(); let status = { enabled: false, paused: false };
  const controller = m.createUsageController({ root, lifecycle, setTimer: timers.set, clearTimer: timers.clear, call: async action => action === 'usage.frequency.status' ? status : { accepted: 0, enabled: true } });
  await controller.refresh();
  assert.equal(controller.active, false);
  status = { enabled: true, paused: false };
  m.notifyUsageChanged();
  await new Promise(done => setImmediate(done));
  assert.equal(controller.active, true);
  controller.dispose();
  status = { enabled: false, paused: false };
  m.notifyUsageChanged();
  await new Promise(done => setImmediate(done));
  assert.equal(root.listeners.length, 0, 'a disposed controller listens to nothing');
});

/* ---------- performance contract ---------- */

test('perf budget: the handler never reads layout, allocates nothing per event beyond a counter, and 50k events cost O(1) each', () => {
  const root = fakeRoot('review'), timers = fakeTimers(); let at = 0;
  const collector = m.createUsageCollector({ send: async () => ({}), now: () => at, setTimer: timers.set, clearTimer: timers.clear });
  collector.start();
  m.installUsageCapture(root, { record: (key, area) => collector.record(key, area) });
  const page = dom('<main data-usage-area="review"><div class="a"><div class="b"><button data-usage="review.next"><span>x</span></button><button>下一题</button></div></div></main>', { strict: true });
  const targets = [page.byTag('span')[0], page.byTag('button')[1]];
  const started = performance.now();
  for (let i = 0; i < 50000; i += 1) { at += 200; root.fire('click', { target: targets[i & 1] }); }
  const elapsed = performance.now() - started;
  assert.equal(collector.pending(), 2, 'aggregation is by key, not by event');
  assert.ok(elapsed < 4000, `${elapsed.toFixed(0)} ms for 50k events`);
  assert.equal(timers.count(), 1, 'one timer in total, however many events');
});

test('perf budget: the capture, key, name and collector modules never touch React, so recording can never re-render anything', async () => {
  for (const file of ['capture.js', 'keys.js', 'names.js', 'collector.js', 'controller.js']) {
    const source = await readFile(join('ui', 'usage', file), 'utf8');
    assert.ok(!/from ['"]react['"]|useState|useEffect|setState/.test(source), `${file} must not use React`);
    assert.ok(!/getBoundingClientRect|offsetWidth|offsetHeight|getComputedStyle|innerText|scrollTop|clientWidth|getClientRects/.test(source), `${file} must not read layout`);
  }
  assert.ok((await readdir(join('ui', 'usage'))).includes('registry.js'));
});
