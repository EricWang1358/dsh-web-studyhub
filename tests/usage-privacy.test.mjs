import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dom, fakeRoot, fakeTimers, loadUsageModules } from './helpers/usage-dom.mjs';
import { StudyService } from '../lib/service.js';
import { usageFrequencyPath } from '../lib/usage-frequency.js';

/* The privacy scan, end to end: every kind of user content is put on the page (in button texts, labels, titles, placeholders, values, links,
   editors) and clicked through the real capture, collector and operations; then the stored file and every export, in both languages, are
   searched for any string of that content. */

const m = await loadUsageModules();
const SEEDED = ['ZZ-Course 数据库系统概论', 'ZZ-Deck 期中冲刺卷', 'ZZ-Source lecture-07-transactions.pdf', 'ZZ-Typed my secret answer 42', 'ZZ-Note private diary entry', 'https://school.example/portal?token=abc', 'student@example.edu', 'C:\\Users\\student\\Desktop\\notes.docx'];

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-usage-privacy-'));
  const before = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); });
}

test('nothing of the learner\'s own content reaches the stored file, the report or any export, in either language', async t => {
  await withHome(t);
  const library = await mkdtemp(join(tmpdir(), 'study-usage-privacy-lib-'));
  const service = new StudyService(library);
  t.after(async () => { service.dispose(); await rm(library, { recursive: true, force: true }); });
  await service.call('usage.frequency.set', { enabled: true });

  const markup = [
    ...SEEDED.map(text => `<button>${text}</button><button aria-label="${text}">x</button><button title="${text}">y</button><a href="${text}">${text}</a><div role="tab">${text}</div>`),
    ...SEEDED.map(text => `<input type="text" value="${text}" placeholder="${text}" aria-label="${text}"><textarea aria-label="${text}">${text}</textarea><div contenteditable="true"><p>${text}</p></div>`),
    ...SEEDED.map(text => `<label for="i${text.length}">${text}</label><input id="i${text.length}" type="checkbox"><select aria-label="${text}"><option>${text}</option></select>`),
    `<button>${m.ui('保存复习设置')}</button><button>${m.uiFormat('开始做这 {0} 道题', [12])}</button><button data-usage="nav.library">${SEEDED[0]}</button>`,
  ].join('\n');
  const page = dom(`<main data-usage-area="library">${markup}</main>`);

  let at = new Date().getTime();
  const root = fakeRoot('library'), timers = fakeTimers();
  const collector = m.createUsageCollector({ send: records => service.call('usage.frequency.record', { records }), now: () => (at += 1000), setTimer: timers.set, clearTimer: timers.clear });
  collector.start();
  m.installUsageCapture(root, { record: (key, area) => collector.record(key, area) });
  for (const element of page.all) if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'P', 'DIV', 'OPTION'].includes(element.tagName)) {
    root.fire('click', { target: element });
    root.fire('keydown', { key: 's', target: element }); root.fire('keyup', { key: 's', target: element });
  }
  await collector.flush();

  const state = await service.call('usage.frequency.status');
  assert.equal(state.hasData, true, 'something was recorded: the app\'s own controls and the text fields');
  const stored = await readFile(usageFrequencyPath(), 'utf8');
  const outputs = [stored];
  for (const language of ['zh', 'en']) for (const period of [7, 30, 'all']) {
    outputs.push(JSON.stringify(await service.call('usage.frequency.report', { period, language })));
    for (const format of ['json', 'markdown']) outputs.push((await service.call('usage.frequency.export', { format, period, language })).content);
  }
  for (const text of SEEDED) for (const output of outputs) assert.ok(!output.includes(text), `"${text}" leaked into: ${output.slice(0, 120)}`);
  // and what was kept is exactly keys of the app's own and "text field"
  const keys = Object.keys(JSON.parse(stored).controls);
  assert.ok(keys.includes('control.text-field'));
  assert.ok(keys.includes('nav.library'));
  assert.ok(keys.includes('library/button/保存复习设置'));
  assert.ok(keys.includes('library/button/开始做这 N 道题'));
  for (const key of keys) assert.ok(/^(?:[a-z]+\.[a-z.-]+|library\/(?:button|link|tab|checkbox|select|input)(?:\/[^/]+)?|shortcut\.[a-z]+)$/.test(key), `an unexpected key: ${key}`);
});
