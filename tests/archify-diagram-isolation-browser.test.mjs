/* global document requestAnimationFrame setTimeout */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* The Archify diagram viewer (ui/SkeletonDiagrams.jsx, docs/companions.md "Threat note") is the trust boundary for HTML an outside tool wrote:
   the loaded file may only ever reach the sandboxed iframe of ui/diagram-frame.js, never the page's own DOM (that would be script execution
   with the app's origin: XSS). This replaces a source-text assertion removed in #1616 with what a learner's browser can observe: the file's
   marker (an element id, a text node and a node its own script draws) is inside the isolated frame and nowhere in the top document outside
   the frame's srcdoc; no window or tab was opened and the page's address did not change (window.open, location writes).
   Fake model, seeded temporary library, no network. Not covered: reads (eval, location.href) that write nothing into a DOM. */

const CANARY = 'archify-canary-7f3a9c21';
const quote = 'Retries amplify load and replicas absorb failures when properly isolated.';
// The title (read from the file's <title>) and the file name stay free of the marker: they legitimately show on the page.
const diagramHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Isolation sample</title></head>
<body><h1 id="${CANARY}-static">Static ${CANARY}</h1>
<p id="${CANARY}-drawn"></p>
<script>document.getElementById('${CANARY}-drawn').textContent = 'Drawn ${CANARY}'; document.body.setAttribute('data-ran', '1');</script>
</body></html>`;

async function seed(root) {
  const service = new StudyService(root);
  await service.call('source.add', { id: 's1', title: 'Reliability', text: quote });
  const cards = ['a1', 'a2'].map(id => ({ id, kind: 'quiz', topic: `Topic ${id}`, objective: `why ${id}`, prompt: `Why does ${id} need isolation?`, answer: 'A', hint: 'h', misconception: 'm',
    explanation: 'Isolation keeps a failure local so that it cannot cascade into an outage, which is why it exists.', citations: [{ sourceId: 's1', quote }],
    options: [{ id: 'a', text: 'A', correct: true, explanation: 'yes' }, { id: 'b', text: 'B', correct: false, explanation: 'no' }, { id: 'c', text: 'C', correct: false, explanation: 'no' }] }));
  await service.call('draft.save', { deck: { id: 'arch', title: 'Reliability', course: 'QA', cards } });
  await service.call('draft.publish', { id: 'arch' });
  const saved = await service.call('skeleton.save', { skeleton: { title: 'Reliability outline', scope: [{ deckId: 'arch' }], overview: 'Availability depends on isolation.',
    nodes: [{ id: 'availability', term: 'Availability', meaning: 'The share of time a service answers.', cards: [{ deckId: 'arch', cardId: 'a1' }] },
      { id: 'isolation', term: 'Isolation', meaning: 'Limiting how far one failure spreads.', parent: 'availability', cards: [{ deckId: 'arch', cardId: 'a2' }] }],
    relations: [{ from: 'availability', to: 'isolation', type: 'prerequisite' }] } });
  service.dispose();
  await mkdir(join(root, 'diagrams'), { recursive: true });
  await writeFile(join(root, 'diagrams', 'sample.html'), diagramHtml);
  return { skeletonId: saved.id, workspace: root };
}

test('Archify diagram viewer: the loaded HTML reaches only the isolated frame, never the page DOM, a new window or the address', { timeout: 240000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-archify-isolation-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  try {
    const { skeletonId, workspace } = running.seeded;
    await running.api('skeleton.diagram.attach', { id: skeletonId, path: 'diagrams/sample.html', workspace });
    const { page, context, errors } = await openPage(browser, running, { width: 1280, height: 900 });
    const popups = [];
    context.on('page', opened => popups.push(opened.url()));
    await page.goto(running.server.url);
    const pagesBefore = context.pages().length;

    await (await revealNavRow(page, 'skeleton')).dispatchEvent('click');
    await page.locator('.sk-saved-item').first().click();
    await page.locator('.sk-diagrams__row').first().waitFor({ timeout: 30000 });
    const urlBefore = page.url();
    await page.locator('.sk-diagrams__row').first().getByRole('button', { name: '打开', exact: true }).click();

    // Ready state first: the frame is on screen and its own script ran inside it. Only then are the absences below meaningful.
    const handle = await page.locator('dialog[open] iframe.sk-diagram-frame').elementHandle({ timeout: 30000 });
    assert.equal(await handle.getAttribute('sandbox'), 'allow-scripts');
    const frame = await handle.contentFrame();
    await frame.waitForSelector("body[data-ran='1']", { timeout: 15000 });
    assert.equal(await frame.locator(`#${CANARY}-static`).count(), 1, 'the marker element is inside the isolated frame');
    assert.equal((await frame.locator(`#${CANARY}-drawn`).innerText()).trim(), `Drawn ${CANARY}`, 'the text its own script drew is inside the isolated frame');
    assert.ok((await handle.getAttribute('srcdoc')).includes(CANARY), 'the frame carries the file as its srcdoc');
    // Let anything the page would do with the loaded file after its first render happen (effects, a frame, a timer) before asserting absence.
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 300)))));

    const top = await page.evaluate(canary => {
      const clone = document.documentElement.cloneNode(true);
      for (const frameElement of clone.querySelectorAll('iframe')) frameElement.removeAttribute('srcdoc');
      return { byId: document.getElementById(`${canary}-static`) !== null || document.getElementById(`${canary}-drawn`) !== null,
        idContaining: document.querySelector(`[id*="${canary}"]`) !== null, text: document.body.innerText.includes(canary), html: clone.outerHTML.includes(canary) };
    }, CANARY);
    assert.deepEqual(top, { byId: false, idContaining: false, text: false, html: false }, 'the marker is nowhere in the top document outside the frame');

    assert.equal(context.pages().length, pagesBefore, `no window or tab was opened: ${JSON.stringify(popups)}`);
    assert.deepEqual(popups, [], 'no popup event');
    assert.equal(page.url(), urlBefore, 'the page address did not change');
    assert.deepEqual(errors, [], 'no console or page errors');
  } finally {
    await browser.close();
    await running.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
