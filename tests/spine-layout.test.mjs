/* global document, window, getComputedStyle */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { buildSpineHarness, openSpine, measureSpine } from "../scripts/qa/spine-layout.mjs";
import { spineFixture } from "../scripts/qa/spine-fixture.mjs";

/* The 本次脉络 panel in a real browser, with the skeleton of the owner's screenshot (5 stations, 8 points, station 4 holds five):
   before, it was ~730px tall at every wide width (each column took the height of the longest), pushed the lesson below the fold,
   ran off the right edge mid-word and clipped descriptions with "…". Needs a Chromium; without one the test says so. */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const COMBOS = [["zh", "dark", 1440], ["en", "light", 1194], ["zh", "light", 768], ["en", "dark", 420]];
// Bounds in CSS px, measured on the finished design with ~10% headroom. The old panel, open, was 729 at every wide width and
// 1413 (zh) / 1669 (en) at 420; folded is new (the old one was a closed <details>).
const BOUNDS = (width) => width >= 1100
  ? { folded: 64, foldedLessonTop: 260, openWorst: 520, openShort: 340 }
  : width >= 640
    ? { folded: 96, foldedLessonTop: 300, openWorst: 520, openShort: 320 }
    : { folded: 150, foldedLessonTop: 330, openWorst: 940, openShort: 480 };

const selected = (page) => page.locator('.spine-tab[aria-selected="true"]').evaluateAll((els) => els.map((el) => el.querySelector(".spine-marker").textContent.trim()));

test("the folded panel is one short line, the open panel follows the current station, nothing is clipped", { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dir = await mkdtemp(join(tmpdir(), "study-spine-"));
  try {
    const harness = await buildSpineHarness(dir);
    for (const [lang, theme, width] of COMBOS) {
      const tag = `${lang}-${theme}-${width}`, bound = BOUNDS(width), fixture = spineFixture(lang);
      const { page, errors, close } = await openSpine(browser, harness, { lang, theme, width, mode: "peek" });
      try {
        // Folded by default in a lesson: the lesson text starts near the top.
        const folded = await measureSpine(page);
        assert.equal(await page.locator(".spine-toggle").getAttribute("aria-expanded"), "false", `${tag}: folded by default`);
        assert.ok(folded.panel.height <= bound.folded, `${tag}: folded panel ${folded.panel.height}px must be ≤ ${bound.folded}`);
        assert.ok(folded.lessonTop <= bound.foldedLessonTop, `${tag}: the lesson starts at ${folded.lessonTop}px, must be ≤ ${bound.foldedLessonTop}`);
        assert.equal(folded.pageOverflow, 0, `${tag}: no horizontal page overflow when folded`);
        // The folded chip still moves between stations.
        assert.match(await page.locator(".spine-chip").innerText(), /1 \/ 5/);
        await page.locator(".spine-chip-next").click();
        assert.match(await page.locator(".spine-chip").innerText(), /2 \/ 5/, `${tag}: next station from the folded chip`);
        await page.locator(".spine-chip-prev").click();
        // Open it.
        await page.locator(".spine-toggle").click();
        await sleep(200);
        assert.equal(await page.locator(".spine-toggle").getAttribute("aria-expanded"), "true");
        assert.deepEqual(await selected(page), ["1"]);
        const openShort = await measureSpine(page);
        // Station 4 is the longest: five points.
        await page.locator(".spine-tab").nth(3).click();
        await sleep(200);
        assert.deepEqual(await selected(page), ["4"]);
        const openWorst = await measureSpine(page);
        assert.ok(openWorst.panel.height <= bound.openWorst, `${tag}: open on the longest station ${openWorst.panel.height}px must be ≤ ${bound.openWorst}`);
        assert.ok(openShort.panel.height <= bound.openShort, `${tag}: open on station 1 ${openShort.panel.height}px must be ≤ ${bound.openShort}`);
        assert.ok(openWorst.panel.height - openShort.panel.height >= 60, `${tag}: the panel follows the current station (${openShort.panel.height} vs ${openWorst.panel.height}), it is not stretched to the tallest`);
        assert.equal(openWorst.pageOverflow, 0, `${tag}: no horizontal page overflow`);
        assert.equal(openWorst.overflowRight, 0, `${tag}: nothing runs off the right edge`);
        // Nothing in the detail pane is clipped or cut with an ellipsis, and every point's full text is there.
        assert.deepEqual(openWorst.clipped.filter((c) => c.inPane), [], `${tag}: the detail pane clips nothing`);
        const paneText = await page.locator(".spine-detail").innerText();
        for (const node of fixture.nodes.filter((n) => n.id === "s4" || n.parent === "s4")) {
          assert.ok(paneText.includes(node.term), `${tag}: ${node.term}`);
          assert.ok(paneText.includes(node.meaning), `${tag}: the full description of ${node.term}`);
        }
        // The strip: one baseline, titles ellipsised with the full text in the tooltip, no hidden horizontal scroll without a cue.
        const tabs = await page.locator(".spine-tab").evaluateAll((els) => els.map((el) => ({ title: el.getAttribute("title"), top: el.querySelector(".spine-marker").getBoundingClientRect().top, size: el.getBoundingClientRect() })));
        assert.equal(tabs.length, 5);
        assert.ok(tabs.every((tab) => Math.abs(tab.top - tabs[0].top) < 0.6), `${tag}: the numbered circles share one baseline whatever the title length`);
        assert.ok(tabs.every((tab) => tab.size.height >= 32 && tab.size.width >= 32), `${tag}: every tab is at least 32px`);
        assert.deepEqual(tabs.map((tab) => tab.title), fixture.nodes.filter((n) => !n.parent).map((n) => n.term));
        assert.ok(openWorst.scrollers.every((s) => s.cls.includes("spine-strip")), `${tag}: only the strip may scroll sideways`);
        if (openWorst.scrollers.length) assert.ok(await page.locator(".spine-pos").isVisible(), `${tag}: a scrolling strip says where you are`);
        const arrows = await page.locator(".spine-prev, .spine-next").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; }));
        assert.equal(arrows.length, 2);
        assert.ok(arrows.every(([w, h]) => w >= 32 && h >= 32), `${tag}: the arrows are real targets`);
        // Show all stations: a vertical accordion whose rows follow their own content.
        await page.locator(".spine-all-toggle").click();
        await sleep(200);
        assert.equal(await page.locator(".spine-all-toggle").getAttribute("aria-expanded"), "true");
        const all = await measureSpine(page);
        assert.equal(all.stationSlack.length, 5, `${tag}: every station is listed`);
        assert.ok(all.stationSlack.every((slack) => slack <= 14), `${tag}: no station is stretched to a taller sibling (${all.stationSlack})`);
        assert.equal(all.pageOverflow, 0);
        assert.deepEqual(all.scrollers, [], `${tag}: the overview is vertical, with no horizontal scroll`);
        const everyText = await page.locator(".spine").innerText();
        for (const node of fixture.nodes) assert.ok(everyText.includes(node.meaning), `${tag}: overview shows ${node.term} in full`);
        await page.locator(".spine-all-toggle").click();
      } finally { await close(); }
      assert.deepEqual(errors, [], `${tag}: the page threw`);
    }
  } finally {
    await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("keys move the current station, the fold is remembered per step type, and a spine that is the subject starts open", { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dir = await mkdtemp(join(tmpdir(), "study-spine-keys-"));
  try {
    const harness = await buildSpineHarness(dir);
    const { page, errors, close } = await openSpine(browser, harness, { lang: "zh", theme: "dark", width: 1194, mode: "peek" });
    try {
      await page.locator(".spine-toggle").click();
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute("role") === "tab" ? document.activeElement.querySelector(".spine-marker").textContent.trim() : document.activeElement?.className);
      await page.locator('.spine-tab[aria-selected="true"]').focus();
      await page.keyboard.press("ArrowRight");
      assert.deepEqual(await selected(page), ["2"]);
      assert.equal(await focused(), "2", "focus follows the selection");
      assert.match(await page.locator(".spine-detail").innerText(), /同步调用与异步消息的取舍/);
      await page.keyboard.press("End");
      assert.deepEqual(await selected(page), ["5"]);
      await page.keyboard.press("ArrowRight");
      assert.deepEqual(await selected(page), ["5"], "the last station stays the last");
      await page.keyboard.press("ArrowLeft");
      assert.deepEqual(await selected(page), ["4"]);
      await page.keyboard.press("Home");
      assert.deepEqual(await selected(page), ["1"]);
      assert.equal(await page.locator('.spine-tab[tabindex="0"]').count(), 1, "roving tabindex");
      assert.equal(await page.locator(".spine-pos").innerText(), "1 / 5");
      // The arrows beside the strip do the same.
      await page.locator(".spine-next").click();
      assert.deepEqual(await selected(page), ["2"]);
      await page.locator(".spine-prev").click();
      assert.deepEqual(await selected(page), ["1"]);
      assert.equal(await page.locator(".spine-prev").isDisabled(), true);
      // Remembered for lessons only.
      await page.reload();
      await page.locator("#lesson-marker").waitFor({ state: "attached" });
      assert.equal(await page.locator(".spine-toggle").getAttribute("aria-expanded"), "true", "a lesson's open spine stays open after a reload");
      await page.locator(".spine-toggle").click();
      await page.reload();
      await page.locator("#lesson-marker").waitFor({ state: "attached" });
      assert.equal(await page.locator(".spine-toggle").getAttribute("aria-expanded"), "false");
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => /spine/.test(k))), ["study-spine-lesson"], "kept per step type");
    } finally { await close(); }
    assert.deepEqual(errors, []);

    // Where the skeleton is the subject it starts open; a blocked localStorage changes nothing visible.
    const subject = await openSpine(browser, harness, { lang: "en", theme: "light", width: 1440, mode: "subject" });
    try {
      assert.equal(await subject.page.locator(".spine-toggle").getAttribute("aria-expanded"), "true");
      assert.equal(await subject.page.locator(".spine-tab").count(), 5);
      const m = await measureSpine(subject.page);
      assert.ok(m.panel.height <= 640, `the subject spine open ${m.panel.height}px (was 925)`);
      await subject.page.locator(".spine-toggle").click();
      assert.equal(await subject.page.locator(".spine-tab").count(), 0, "folded: the strip is gone");
      assert.ok((await measureSpine(subject.page)).panel.height <= 140);
    } finally { await subject.close(); }
    assert.deepEqual(subject.errors, []);

    const blocked = await browser.newContext({ viewport: { width: 1194, height: 900 } });
    await blocked.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
    const bp = await blocked.newPage();
    const berrors = [];
    bp.on("pageerror", (error) => berrors.push(String(error)));
    await bp.goto(`${harness}?lang=zh&theme=dark&mode=peek`);
    await bp.locator(".spine-toggle").waitFor();
    await bp.locator(".spine-toggle").click();
    assert.equal(await bp.locator(".spine-tab").count(), 5, "toggling still works without storage");
    assert.deepEqual(berrors.filter((e) => !/blocked/.test(e)), []);
    await blocked.close();
  } finally {
    await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("reduced motion removes the scrolling and fading, and the focus ring is drawn", { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dir = await mkdtemp(join(tmpdir(), "study-spine-motion-"));
  try {
    const harness = await buildSpineHarness(dir);
    const { page, close } = await openSpine(browser, harness, { lang: "zh", theme: "dark", width: 1194, mode: "subject", reducedMotion: true });
    try {
      const motion = await page.evaluate(() => [...document.querySelectorAll(".spine *")].map((el) => getComputedStyle(el)).filter((cs) => cs.scrollBehavior === "smooth" || cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0.01)).length);
      assert.equal(motion, 0, "no smooth scroll or transition under prefers-reduced-motion");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains("spine-toggle")), true, "the fold toggle is the first stop");
      const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return [cs.outlineStyle, parseFloat(cs.outlineWidth)]; });
      assert.notEqual(ring[0], "none", "a focused control has an outline");
      assert.ok(ring[1] >= 2);
    } finally { await close(); }
  } finally {
    await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
