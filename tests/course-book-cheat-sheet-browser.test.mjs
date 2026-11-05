/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 S5 (#710) in the real page at 1440 and 420 px: 更多 › 速查表 takes the reading surface's place with a frame of the one page (templates, matrix,
   comparisons, formulas drawn as MathML, term cards with anchors); a point's code in it goes back to reading at that point; 导出… saves the same page as one
   .html file, which opens offline with no request but its own and prints as two-column A4 pages without the contents strip. The cards, the answer kit and the
   comparisons are put into the answer of course.book.open at the network edge (the build that writes them is not what is looked at here). Screenshots and
   a PDF go to COURSE_BOOK_CHEAT_SHOTS. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] }] },
        { id: 'c2', title: 'Requirements', children: [{ id: 'qa', title: 'Quality attribute scenarios with a rather long title that has to wrap on a phone', anchors: [`${lecture(2)}#1`] }] }],
      other: { anchors: [] }, counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`**${leaf.title}**：${leaf.title} in one line [^1].`], explain: `About ${leaf.title} [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
  });
  await service.dispose();
}

/** What the build of #710 S1/S3/S4 would have put on the book, added to the answer of course.book.open (the points are the ones of the seeded book). */
function withSheetParts(value) {
  const leaves = (list => { const out = []; (function walk(items) { for (const node of items || []) { if (node.leaf) out.push(node); else walk(node.children); } })(list); return out; })(value.nodes);
  const [first, second, third] = leaves;
  first.cards = [{ item: 'i00000000001', code: 'K001', hid: first.hid, name: 'Architecture decision', alt: 'ADR', plain: 'A choice that is costly to change, written down with its reason.',
    pitch: 'An architecture decision is a significant choice recorded with context and consequences.', relations: [{ kind: 'related', name: 'Coupling', code: 'K003', hid: second.hid }, { kind: 'opposite', name: 'Ad hoc choice' }] },
  { item: 'i00000000003', code: 'K002', hid: first.hid, name: 'Stakeholder', plain: 'Anyone whose concerns the system must answer.' }];
  second.cards = [{ item: 'i00000000002', code: 'K003', hid: second.hid, name: 'Coupling', alt: 'Dependency', plain: 'How much one module needs to know about another.', relations: [{ kind: 'parallel', name: 'Cohesion' }] }];
  value.glossary = [{ term: 'Availability', item: 'i00000000009', gist: 'A = \\frac{MTBF}{MTBF + MTTR}', kind: 'formula', hid: third.hid, material: 'L2', page: 7 },
    { term: 'Little’s law', item: 'i00000000008', gist: 'L = λW', kind: 'formula', hid: first.hid, material: 'L1', page: 3 },
    { term: 'Throughput', item: 'i00000000007', gist: 'Throughput = WIP / cycle time', kind: 'formula', hid: second.hid, material: 'L1', page: 5 }];
  value.examKit = { language: 'en', types: [{ code: 'T01', name: 'Compare and contrast', family: 'compare', signals: ['compare', 'contrast', 'differences between'], asks: 'Two options side by side on one criterion',
    template: '1. [Option A] gives [benefit A] but costs [cost A].\n2. [Option B] gives [benefit B] but costs [cost B].\n3. Choose [Option] because [criterion].',
    fills: [{ ref: 'PAST2 Q1a', quote: 'Compare monolith and microservices', fill: 'Option A: monolith ｜ Option B: microservices' }], anchors: ['PAST2 Q1a'], hids: [first.hid, third.hid] }] };
  value.confusables = [{ id: 'C001', items: ['K001', 'K002'], names: ['Architecture decision', 'Stakeholder'], rows: [{ aspect: 'what', cells: ['A recorded choice', 'A person with concerns'] },
    { aspect: 'difference', cells: ['It is about the system', 'It is about people'] }, { aspect: 'mistake', cells: ['Writing it without a reason', 'Listing only users'] }] }];
}

test('复习全书: 更多 › 速查表 shows the one page, a code goes back to the book, 导出 saves it as an offline .html that prints in two columns (1440 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-cheat-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const work = await mkdtemp(join(tmpdir(), 'study-book-cheat-files-'));
  const shots = process.env.COURSE_BOOK_CHEAT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1440, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.route('**/api/call', async route => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action !== 'course.book.open') return route.continue();
        const response = await route.fetch(), body = await response.json();
        if (body.ok && body.value?.status === 'ok') withSheetParts(body.value);
        return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-step').waitFor({ timeout: 30000 });

      assert.equal(await page.locator('[data-tour="book-more"]').count(), 1, `${width}px: 更多 is where the finder's 速查表 entry points`);
      // 更多 › 速查表: the view takes the page's place.
      await page.locator('.book-bar__more').click();
      assert.match(await page.getByRole('menuitem', { name: /^速查表/ }).innerText(), /可打印/);
      await page.getByRole('menuitem', { name: /^速查表/ }).click();
      const frame = page.locator('.book-cheat__frame');
      await frame.waitFor({ timeout: 30000 });
      const inside = page.frameLocator('.book-cheat__frame');
      await page.waitForFunction(() => document.querySelector('.book-cheat__frame')?.contentDocument?.getElementById('K001'), null, { timeout: 30000 });
      assert.equal(await page.locator('.book-step').count(), 0, `${width}px: the reading surface is not under it`);
      const text = await inside.locator('body').innerText();
      for (const part of ['答题模板', '题干信号矩阵', '易混对照', '公式', '术语卡', 'K001', 'Architecture decision', 'T01', 'C001', 'Compare and contrast']) assert.ok(text.includes(part), `${width}px: the sheet has ${part}`);
      assert.ok(await inside.locator('.math math').count() >= 2, `${width}px: formulas drawn as MathML`);
      assert.ok(await inside.locator('.slot').count() >= 6, `${width}px: template slots marked`);
      // The host page does not scroll sideways, nor does the sheet inside its frame.
      const host = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(host <= 0, `${width}px: the app does not scroll sideways: ${host}`);
      const sheetWidth = await frame.evaluate(element => element.contentDocument.documentElement.scrollWidth - element.contentWindow.innerWidth);
      assert.ok(sheetWidth <= 0, `${width}px: the sheet does not scroll sideways: ${sheetWidth}`);
      const lefts = await frame.evaluate(element => [...new Set([...element.contentDocument.querySelectorAll('#sheet-templates .box, #sheet-cards .box')].map(box => Math.round(box.getBoundingClientRect().left)))]);
      assert.equal(lefts.length, width >= 1000 ? 2 : 1, `${width}px: two columns when wide enough, one on a phone (${lefts})`);
      // Inside the sheet, a card links to a card (an anchor in the frame, the app untouched).
      await inside.locator('#K001 a[href="#K003"]').click();
      await page.waitForTimeout(200);
      assert.equal(await inside.locator('#K001').count(), 1, `${width}px: the sheet is still the sheet after a link inside it (a srcdoc frame would load the app's address for a bare #link)`);
      assert.ok(await frame.evaluate(element => { const top = element.contentDocument.getElementById('K003').getBoundingClientRect().top; return top >= -1 && top < element.contentWindow.innerHeight; }), `${width}px: a card link brings the card on screen`);
      assert.equal(await page.evaluate(() => window.location.hash), '', `${width}px: and leaves the app's own address alone`);
      await settleAnimations(page);
      await frame.evaluate(element => element.contentWindow.scrollTo(0, 0));
      await page.locator('.book-mode__bar').scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: join(shots, `sheet-${width}.png`) });

      // The save, from the view and from 导出…, is the same page.
      const fromView = page.waitForEvent('download');
      await page.getByRole('button', { name: '下载 .html' }).click();
      const saved = await fromView, name = saved.suggestedFilename();
      assert.equal(name, '复习全书 · SA 速查表.html');
      const html = await readFile(await saved.path(), 'utf8');
      assert.doesNotMatch(html, /https?:\/\/|<script|<link|<img|data-go=/, `${width}px: the file names no address, runs no script and has no link back into the app`);
      assert.match(html, /@media print/);

      // A point's code goes back to reading at that point.
      const hid = await inside.locator('a[data-go]').first().getAttribute('data-go');
      await inside.locator('a[data-go]').first().click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-cheat__frame').count(), 0, `${width}px: back on the reading surface`);

      // 导出… has the button too.
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: /^导出…/ }).click();
      const fromExport = page.waitForEvent('download');
      await page.locator('.book-export').getByRole('button', { name: '速查表（.html）' }).click();
      const second = await fromExport;
      assert.equal(second.suggestedFilename(), name);
      assert.equal(await readFile(await second.path(), 'utf8'), html, `${width}px: the same page from both`);
      // The frame is sandboxed without scripts, and the init scripts the harness puts into every frame (storage, layout observer) are what Chrome refuses there.
      assert.deepEqual(errors.filter(message => !/^Blocked script execution in 'about:srcdoc'/.test(message)), [], `${width}px: no page errors`);
      await context.close();

      // The saved file on its own, offline: nothing is requested but the file; the cards and the formulas are all there; printed, it is two columns without the strip.
      const offline = await browser.newContext({ viewport: { width, height: 900 }, offline: true });
      const sheet = await offline.newPage(), requested = [];
      sheet.on('request', request => requested.push(request.url()));
      const path = join(work, `sheet-${width}.html`);
      await writeFile(path, html, 'utf8');
      await sheet.goto(pathToFileURL(path).href);
      await sheet.locator('#K003').waitFor();
      assert.deepEqual(requested.filter(url => !url.startsWith('file:')), [], `${width}px: offline, no request left the file`);
      assert.ok(await sheet.locator('.math math').count() >= 2);
      if (shots) await sheet.screenshot({ path: join(shots, `file-offline-${width}.png`), fullPage: true });
      await sheet.emulateMedia({ media: 'print' });
      assert.equal(await sheet.locator('.nav').evaluate(element => window.getComputedStyle(element).display), 'none', `${width}px: no contents strip on paper`);
      assert.equal(await sheet.locator('#sheet-cards .cols').first().evaluate(element => window.getComputedStyle(element).columnCount), '2', `${width}px: two columns on paper`);
      if (width === 1440 && shots) {
        await sheet.pdf({ path: join(shots, 'sheet-print.pdf'), preferCSSPageSize: true, printBackground: true });
        await sheet.screenshot({ path: join(shots, 'sheet-print-media.png'), fullPage: true });
      }
      await offline.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});
