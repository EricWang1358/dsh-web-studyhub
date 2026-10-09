import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 为啥有题目没有覆盖率: a 资料 row that says 「N 题」 also says how much of the material has a question. The questions of a re-imported lecture sit on its older version, and
   the questions of a recording made of 2 parts sit on the two single recordings it was merged from; both rows used to have no coverage figure. A material with no question
   says 还没出题 and has no figure. Seeded through the real store, looked at through the real page at 1280 and 420 px. */

const at = '2026-10-01T08:00:00.000Z', HASH = { 1: '1'.repeat(64), 2: '2'.repeat(64) };
const statement = (n, i) => `Statement ${n}.${i}: the platform team owns the interface contract and every consumer must negotiate changes through it.`;
const body = n => Array.from({ length: 6 }, (_, i) => statement(n, i)).join(' ');
const outline = (topics = [1, 2, 3, 4]) => topics.map(n => `# Topic ${n}\n\n${body(n)}\n`).join('\n');
const card = (id, sourceId, n) => ({ id, kind: 'flashcard', topic: 'Platform', prompt: `Question ${id}`, answer: 'The platform team.', explanation: 'See the source.', citations: [{ sourceId, quote: statement(n, 2) }] });
const lecture = id => ({ id, title: 'Platform lecture', text: outline(), createdAt: at, courses: [], document: { materialId: 'document-lecture', format: 'md', filename: 'platform-lecture.md' } });
const single = (n) => ({ id: `audio-${HASH[n].slice(0, 16)}-k1`, title: `Recording ${n}`, text: `Speech of recording ${n}. ${body(n)}`, createdAt: at, courses: [], audio: { hash: HASH[n], filename: `rec${n}.mp3` } });
const volume = v => ({ id: `audio-batch-b1${v > 1 ? '-p2' : ''}`, title: `Training (${v}/2)`, text: `Merged volume ${v}. ${body(v)}`, createdAt: at, courses: [],
  audio: { batch: { id: 'b1', title: 'Training', volume: v, volumes: 2, sourceIds: ['audio-batch-b1', 'audio-batch-b1-p2'], members: [1, 2].map(n => ({ order: n, filename: `rec${n}.mp3`, hash: HASH[n] })) } } });

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(lecture('lecture-old'), lecture('lecture-new'), single(1), single(2), volume(1), volume(2),
      { id: 'note-1', title: 'Revision note', text: 'Trade-offs are the first law of software architecture.', createdAt: at, courses: [] });
    state.documents = [{ id: 'document-lecture', title: 'Platform lecture', format: 'md', currentRevision: 'r2', versions: [{ revision: 'r1', sourceIds: ['lecture-old'] }, { revision: 'r2', sourceIds: ['lecture-new'] }] }];
    state.decks.push({ id: 'deck-lecture', title: 'Lecture questions', cards: [card('l1', 'lecture-old', 1), card('l2', 'lecture-old', 2), card('l3', 'lecture-old', 3)] },
      { id: 'deck-rec', title: 'Recording questions', cards: [card('r1', single(1).id, 1), card('r2', single(2).id, 2)] });
  });
  return { ids: [] };
}

test('every material with questions shows its coverage in the chip\'s one wording, the one without says it has none (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-rowcov-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 1100 });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      const nav = page.locator('[data-tour="nav-sources"]').first();
      await nav.waitFor({ state: 'visible' });
      await nav.dispatchEvent('click');
      await page.locator('.sources-page .source-doc').first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const rows = await page.locator('.sources-page .source-doc').evaluateAll(list => list.map(row => ({
        key: row.getAttribute('data-document-key'), title: row.querySelector('.source-main strong, .source-main b, .source-main')?.innerText.split('\n')[0] ?? '',
        quality: row.querySelector('.source-doc__quality')?.innerText ?? '', chip: row.querySelector('[data-coverage-chip]')?.innerText ?? null })));
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      const by = (pattern) => rows.find(row => pattern.test(row.title) || pattern.test(row.key || ''));
      const lectureRow = by(/lecture/i), recording = by(/b1|Training/i), none = by(/note-1|Revision/i);
      assert.ok(lectureRow && recording && none, `${width}px: the three materials are listed: ${JSON.stringify(rows)}`);
      assert.match(lectureRow.quality, /3 题/);
      assert.equal(lectureRow.chip, '覆盖 75%', `${width}px: the lecture's questions sit on its older version: 3 of 4 sections`);
      assert.match(recording.quality, /2 题/);
      assert.equal(recording.chip, '覆盖 100%', `${width}px: the recording of 2 parts is counted over both parts`);
      assert.equal(none.chip, null, `${width}px: a material with no question has no figure`);
      assert.match(none.quality, /还没出题/);
      if (process.env.ROW_COVERAGE_SHOTS) {
        await mkdir(process.env.ROW_COVERAGE_SHOTS, { recursive: true });
        await page.screenshot({ path: join(process.env.ROW_COVERAGE_SHOTS, `sources-${width}.png`) });
        await page.locator('.sources-page .source-doc').last().screenshot({ path: join(process.env.ROW_COVERAGE_SHOTS, `training-${width}.png`) });
      }
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
