/* global document, window, localStorage, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, holdActions, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { LECTURE_PAGES, makeTextPdf } from './helpers/text-pdf.mjs';

/* #1609 (items 2 & 3): while a multi-page PDF is still opening (materials.document.get / materials.document.bytes in flight),
   each page's 看原页 placeholder holds its exact box invisibly without shifting layout on arrival, and the 正在打开资料…
   pill stays inside .reader-layout without covering the first page header or floating above the narrow 目录 overlay at 420px. */

const PDF_TITLE = 'Lecture Notes';
const PDF_FILENAME = `${PDF_TITLE}.pdf`;

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function assertBoxStable(before, after, label) {
  assert.ok(before && after, `${label}: missing bounding box`);
  for (const key of ['x', 'y', 'width', 'height']) {
    const delta = Math.abs(after[key] - before[key]);
    assert.ok(delta <= 1, `${label} ${key} shifted by ${delta.toFixed(2)}px (${before[key]} -> ${after[key]})`);
  }
}

async function seedPdf(root) {
  const runtime = createStudyRuntime(root);
  try {
    const bytes = await makeTextPdf(LECTURE_PAGES);
    await runtime.call('materials.document.import', {
      filename: PDF_FILENAME,
      dataBase64: bytes.toString('base64'),
      courses: ['QA'],
    });
  } finally {
    runtime.dispose();
  }
}

async function readPagePeeks(page) {
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll('.study-document-viewer .reader-section[data-study-page]')];
    return sections.map((section) => {
      const button = section.querySelector('.reader-section__head .reader-peek');
      if (!button) return { page: Number(section.dataset.studyPage), present: false };
      const box = button.getBoundingClientRect();
      return {
        page: Number(section.dataset.studyPage),
        present: true,
        reserved: button.getAttribute('data-reserved'),
        ariaHidden: button.getAttribute('aria-hidden'),
        tabIndex: button.getAttribute('tabindex'),
        disabled: button.disabled,
        visibility: getComputedStyle(button).visibility,
        width: box.width,
        height: box.height,
      };
    });
  });
}

async function assertHeldPeeks(page, width, stage, minCount) {
  const peeks = await readPagePeeks(page);
  assert.ok(peeks.length >= minCount, `${width}px (${stage}): expected at least ${minCount} page sections, got ${peeks.length}`);
  for (const peek of peeks) {
    assert.equal(peek.present, true, `${width}px (${stage}): page ${peek.page} missing .reader-peek`);
    assert.equal(peek.reserved, '', `${width}px (${stage}): page ${peek.page} .reader-peek must have data-reserved=""`);
    assert.equal(peek.ariaHidden, 'true', `${width}px (${stage}): page ${peek.page} .reader-peek must have aria-hidden="true"`);
    assert.equal(peek.tabIndex, '-1', `${width}px (${stage}): page ${peek.page} .reader-peek must have tabindex="-1"`);
    assert.equal(peek.disabled, true, `${width}px (${stage}): page ${peek.page} .reader-peek must be disabled`);
    assert.equal(peek.visibility, 'hidden', `${width}px (${stage}): page ${peek.page} .reader-peek must have visibility: hidden`);
    assert.ok(peek.width > 0 && peek.height > 0, `${width}px (${stage}): page ${peek.page} .reader-peek must reserve non-zero box (${peek.width}x${peek.height})`);
  }
}

async function assertActivePeeks(page, width, minCount) {
  const peeks = await readPagePeeks(page);
  assert.ok(peeks.length >= minCount, `${width}px (after release): expected at least ${minCount} page sections, got ${peeks.length}`);
  for (const peek of peeks) {
    assert.equal(peek.present, true, `${width}px (after release): page ${peek.page} missing .reader-peek`);
    assert.equal(peek.reserved, null, `${width}px (after release): page ${peek.page} .reader-peek must lose data-reserved`);
    assert.equal(peek.ariaHidden, null, `${width}px (after release): page ${peek.page} .reader-peek must lose aria-hidden`);
    assert.notEqual(peek.tabIndex, '-1', `${width}px (after release): page ${peek.page} .reader-peek must lose tabindex="-1"`);
    assert.equal(peek.disabled, false, `${width}px (after release): page ${peek.page} .reader-peek must be enabled`);
    assert.equal(peek.visibility, 'visible', `${width}px (after release): page ${peek.page} .reader-peek must be visible`);
    assert.ok(peek.width > 0 && peek.height > 0, `${width}px (after release): page ${peek.page} .reader-peek must keep non-zero box`);
  }
}

async function assertLoadingPillPlacement(page, width, stage) {
  const info = await page.evaluate(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const viewer = document.querySelector('.study-document-viewer');
    const layout = viewer?.querySelector('.reader-layout');
    const pill = viewer?.querySelector('.reader-loading');
    const first = viewer?.querySelector('.reader-section[data-study-page="1"]');
    return {
      layout: rectOf(layout),
      pill: rectOf(pill),
      position: pill ? getComputedStyle(pill).position : null,
      head: rectOf(first?.querySelector('.reader-section__head')),
      label: rectOf(first?.querySelector('.reader-section__label')),
    };
  });
  assert.ok(info.pill && info.pill.width > 0 && info.pill.height > 0, `${width}px (${stage}): .reader-loading must be visible`);
  assert.equal(info.position, 'absolute', `${width}px (${stage}): .reader-loading must be position: absolute`);
  assert.ok(info.layout, `${width}px (${stage}): .reader-layout missing`);
  assert.ok(
    info.pill.left >= info.layout.left - 0.5 && info.pill.right <= info.layout.right + 0.5
      && info.pill.top >= info.layout.top - 0.5 && info.pill.bottom <= info.layout.bottom + 0.5,
    `${width}px (${stage}): .reader-loading (${JSON.stringify(info.pill)}) must stay inside .reader-layout (${JSON.stringify(info.layout)})`,
  );
  assert.ok(info.head && info.label, `${width}px (${stage}): first page header/label missing`);
  assert.equal(
    rectsIntersect(info.pill, info.head),
    false,
    `${width}px (${stage}): .reader-loading (${JSON.stringify(info.pill)}) must not intersect page 1 .reader-section__head (${JSON.stringify(info.head)})`,
  );
  assert.equal(
    rectsIntersect(info.pill, info.label),
    false,
    `${width}px (${stage}): .reader-loading (${JSON.stringify(info.pill)}) must not intersect page 1 .reader-section__label (${JSON.stringify(info.label)})`,
  );
}

async function assertNarrowOverlayAboveLoading(page) {
  const viewer = page.locator('.study-document-viewer');
  const outlineBtn = viewer.locator('.reader-toolbar__icon-btn[aria-label="目录"]:not([disabled])');
  await outlineBtn.waitFor({ state: 'visible', timeout: 15000 });
  await outlineBtn.click();
  const outline = viewer.locator('.reader-outline');
  const scrim = viewer.locator('.reader-scrim');
  await outline.waitFor({ state: 'visible', timeout: 10000 });
  await scrim.waitFor({ state: 'visible', timeout: 10000 });
  await settleAnimations(page);
  await frames(page, 2);

  const stacking = await page.evaluate(() => {
    const viewerEl = document.querySelector('.study-document-viewer');
    const pillEl = viewerEl.querySelector('.reader-loading');
    const outlineEl = viewerEl.querySelector('.reader-outline');
    const scrimEl = viewerEl.querySelector('.reader-scrim');
    const pillRect = pillEl.getBoundingClientRect();
    const hit = document.elementFromPoint(pillRect.left + pillRect.width / 2, pillRect.top + pillRect.height / 2);
    const zOf = (el) => Number(getComputedStyle(el).zIndex);
    const hitInsideOverlay = Boolean(hit && (outlineEl.contains(hit) || scrimEl.contains(hit)));
    return {
      loadingZ: zOf(pillEl),
      outlineZ: zOf(outlineEl),
      scrimZ: zOf(scrimEl),
      hitInsideLoading: Boolean(hit && pillEl.contains(hit)),
      hitInsideOverlay,
      hitTag: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className)}` : null,
    };
  });
  assert.ok(Number.isFinite(stacking.loadingZ), `420px: .reader-loading z-index must be numeric (got ${stacking.loadingZ})`);
  assert.ok(Number.isFinite(stacking.outlineZ), `420px: .reader-outline z-index must be numeric (got ${stacking.outlineZ})`);
  assert.ok(Number.isFinite(stacking.scrimZ), `420px: .reader-scrim z-index must be numeric (got ${stacking.scrimZ})`);
  assert.ok(stacking.outlineZ > stacking.loadingZ, `420px: .reader-outline z-index (${stacking.outlineZ}) must be > .reader-loading (${stacking.loadingZ})`);
  assert.ok(stacking.scrimZ > stacking.loadingZ, `420px: .reader-scrim z-index (${stacking.scrimZ}) must be > .reader-loading (${stacking.loadingZ})`);
  assert.equal(stacking.hitInsideLoading, false, `420px: elementFromPoint at .reader-loading center must not hit .reader-loading (hit ${stacking.hitTag})`);
  assert.equal(stacking.hitInsideOverlay, true, `420px: elementFromPoint at .reader-loading center must hit .reader-outline or .reader-scrim (hit ${stacking.hitTag})`);

  const scrimBox = await scrim.boundingBox();
  assert.ok(scrimBox && scrimBox.width > 0 && scrimBox.height > 0, '420px: .reader-scrim must have non-zero box');
  await scrim.click({ position: { x: Math.max(4, scrimBox.width - 8), y: Math.max(4, scrimBox.height / 2) } });
  await outline.waitFor({ state: 'hidden', timeout: 10000 });
  await settleAnimations(page);
  await frames(page, 2);
}

async function readLayoutSnapshot(page) {
  return page.evaluate(() => {
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const viewer = document.querySelector('.study-document-viewer');
    const sections = [...(viewer?.querySelectorAll('.reader-section[data-study-page]') || [])].slice(0, 2);
    return {
      scroll: rectOf(viewer?.querySelector('.reader-scroll')),
      sections: sections.map((section) => ({
        page: Number(section.dataset.studyPage),
        head: rectOf(section.querySelector('.reader-section__head')),
        label: rectOf(section.querySelector('.reader-section__label')),
        prose: rectOf(section.querySelector('.reader-prose')),
        peek: rectOf(section.querySelector('.reader-section__head .reader-peek')),
      })),
    };
  });
}

function assertLayoutStable(before, after, width) {
  assertBoxStable(before.scroll, after.scroll, `${width}px .reader-scroll`);
  assert.equal(before.sections.length, 2, `${width}px: expected 2 captured sections while held`);
  assert.equal(after.sections.length, 2, `${width}px: expected 2 captured sections after release`);
  for (let i = 0; i < 2; i++) {
    const b = before.sections[i], a = after.sections[i];
    assert.equal(a.page, b.page, `${width}px: section ${i} page number changed`);
    assertBoxStable(b.head, a.head, `${width}px page ${b.page} .reader-section__head`);
    assertBoxStable(b.label, a.label, `${width}px page ${b.page} .reader-section__label`);
    assertBoxStable(b.prose, a.prose, `${width}px page ${b.page} .reader-prose`);
    assertBoxStable(b.peek, a.peek, `${width}px page ${b.page} .reader-peek`);
  }
}

async function assertPeekOpensCanvas(page, width) {
  const viewer = page.locator('.study-document-viewer');
  await viewer.locator('.reader-section[data-study-page="1"] .reader-peek').first().click();
  const canvas = page.locator('.page-peek canvas');
  await canvas.waitFor({ timeout: 60000 });
  await until(() => canvas.evaluate((el) => el.width > 0 && el.height > 0), `${width}px: page 1 canvas to draw`);
  await until(async () => !(await page.locator('.page-peek').innerText()).includes('正在绘制'), `${width}px: page 1 peek to finish`);
  assert.equal(await page.locator('.page-peek .page-peek__state--note').count(), 0, `${width}px: no original-not-found note`);
  await page.keyboard.press('Escape');
  await until(async () => (await page.locator('.page-peek').count()) === 0, `${width}px: .page-peek to close`, { timeoutMs: 15000 });
}

async function openSourcesList(page, url) {
  await page.goto(url);
  await page.evaluate(() => localStorage.removeItem('studyhub-last-read:v1'));
  await (await revealNavRow(page, 'sources')).click().catch(() => { /* nav already active */ });
  const row = page.locator('.source-doc', { hasText: PDF_TITLE }).first();
  await row.waitFor({ timeout: 30000 });
  return row;
}

async function verifyViewport(browser, running, width) {
  const { context, page, errors } = await openPage(browser, running, { width, height: 900 });
  try {
    const row = await openSourcesList(page, running.server.url);
    const viewer = page.locator('.study-document-viewer');
    const held = await holdActions(page, ['materials.document.get', 'materials.document.bytes']);
    let heldSnapshot;
    try {
      await row.locator('.source-main').click();
      await viewer.waitFor({ timeout: 30000 });
      await until(() => held.seen('materials.document.get'), `${width}px: materials.document.get in flight`);
      await viewer.locator('.reader-loading').waitFor({ state: 'visible', timeout: 15000 });
      await viewer.locator('.reader-section[data-study-page="1"]').waitFor({ state: 'visible', timeout: 15000 });
      await settleAnimations(page);
      await frames(page, 2);

      await assertHeldPeeks(page, width, 'document.get held', 1);
      await assertLoadingPillPlacement(page, width, 'document.get held');

      held.release('materials.document.get');
      await until(() => held.seen('materials.document.bytes'), `${width}px: materials.document.bytes in flight`);
      await viewer.locator('.reader-section[data-study-page="2"]').waitFor({ state: 'visible', timeout: 15000 });
      await viewer.locator('.reader-loading').waitFor({ state: 'visible', timeout: 15000 });
      await settleAnimations(page);
      await frames(page, 2);

      await assertHeldPeeks(page, width, 'document.bytes held', 3);
      await assertLoadingPillPlacement(page, width, 'document.bytes held');
      if (width <= 420) await assertNarrowOverlayAboveLoading(page);
      heldSnapshot = await readLayoutSnapshot(page);
    } finally {
      held.release('materials.document.get');
      held.release('materials.document.bytes');
    }

    await until(async () => (await viewer.locator('.reader-loading').count()) === 0, `${width}px: .reader-loading to disappear`, { timeoutMs: 30000 });
    await settleAnimations(page);
    await frames(page, 2);

    assert.equal(await viewer.locator('.reader-loading').count(), 0, `${width}px: .reader-loading must be gone after release`);
    await assertActivePeeks(page, width, 3);
    assertLayoutStable(heldSnapshot, await readLayoutSnapshot(page), width);
    await assertPeekOpensCanvas(page, width);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${width}px: horizontal overflow ${overflow}px`);
    assert.deepEqual(errors.filter((text) => !/favicon/.test(text)), [], `${width}px: unexpected console/page errors`);
  } finally {
    await context.close();
  }
}

test('reader opening placeholders: held 看原页 prevents shift and 正在打开资料… stays clear of header & narrow 目录 (#1609)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-opening-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: seedPdf });
  t.after(() => running.close?.());

  for (const width of [1280, 420]) {
    await t.test(`${width}x900`, async () => {
      await verifyViewport(browser, running, width);
    });
  }
});
