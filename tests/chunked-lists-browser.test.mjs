/* global document, window, Element, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreview } from "../scripts/build.mjs";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { frames, openPage, settleAnimations, startLateServer, until } from "../scripts/qa/layout-late.mjs";
import { revealNavRow } from "../scripts/qa/nav-reveal.mjs";
import { noonZone, seedChunkLibrary, SHORT_DRAFT, SIMILAR_AT } from "../scripts/qa/chunked-lists.mjs";

/* #900: the sources page, the wrong book and a long draft draw their rows in growing chunks, on the fixture of scripts/qa/chunked-lists.mjs (1000 notes and a 160-page book
   in one day group, 1000 wrong answers in two decks, a draft of 500 questions with two near-duplicates far down). What it proves, in a browser: the first paint draws one
   chunk; the next chunk comes when the end is near (scrolling, or focus moving there) and the first visible row stays where it is; folding a group or changing the filter starts
   from the first chunk; every way of jumping to a row (a new import, 找功能 anchors, the wrong book's group jump, adding a question) lands on a row that is drawn;
   and what counts or acts on all rows still does (the group's count, 选择当前范围). */

const CHUNK = 120, DRAFT_CHUNK = 80;
const DOCUMENTS = 1000, MISTAKES = 1000, QUESTIONS = 500;
/** Every document of the page: the notes, the book, and the four sources scripts/qa/perf-seed.mjs writes. */
const ALL_DOCUMENTS = DOCUMENTS + 1 + 4;
/* The notes are dated up to 150 minutes after now, so a note imported "now" lands at index 300 of the day group: beyond the first chunk, not at the end. */
const NEWER_THAN_NOW = 300;

const count = (page, selector) => page.locator(selector).count();
/** Scroll the page (or the pane it sits in) to its end, the way the wheel would: one scroll event, at the very end. */
const scrollToEnd = (page) => page.evaluate(() => {
  let element = document.querySelector(".page");
  while (element && !(element.scrollHeight > element.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(element).overflowY))) element = element.parentElement;
  const scroller = element || document.scrollingElement;
  scroller.scrollTop = scroller.scrollHeight;
});
/** Scroll to a hundred pixels from the end of the page (the end of the drawn rows is then within a screen), and say which row is first in sight and where, in the same breath:
    the next chunk is drawn after this returns. */
const scrollNearEnd = (page, selector, attribute) => page.evaluate(([rows, name]) => {
  let element = document.querySelector(".page");
  while (element && !(element.scrollHeight > element.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(element).overflowY))) element = element.parentElement;
  const scroller = element || document.scrollingElement;
  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 100;
  for (const row of document.querySelectorAll(rows)) {
    const box = row.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight) return { key: row.getAttribute(name), top: Math.round(box.top * 10) / 10 };
  }
  return null;
}, [selector, attribute]);
const topOfKey = (page, attribute, key) => page.evaluate(([name, value]) => { const row = document.querySelector(`[${name}="${value}"]`); return row ? Math.round(row.getBoundingClientRect().top * 10) / 10 : null; }, [attribute, key]);
const inView = (page, selector) => page.evaluate((query) => {
  const element = document.querySelector(query);
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
}, selector);

async function openApp(browser, running, zone, { width = 1280, height = 900 } = {}) {
  const opened = await openPage(browser, running, { lang: "zh", theme: "light", width, height, timezoneId: zone });
  await opened.page.goto(running.server.url);
  await opened.page.locator(".sidebar, .nav-menu-toggle").first().waitFor({ timeout: 30000 });
  return opened;
}
async function openNav(page, id) {
  await (await revealNavRow(page, id)).dispatchEvent("click");
}
const scrollerTop = (page, to) => page.evaluate((value) => {
  let element = document.querySelector(".page");
  while (element && !(element.scrollHeight > element.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(element).overflowY))) element = element.parentElement;
  const scroller = element || document.scrollingElement;
  if (value !== undefined) scroller.scrollTop = value;
  return scroller.scrollTop;
}, to);
/** Count the scrollIntoView calls of the page from now on, and how many of them ask for a smooth scroll. */
const recordScrolls = (page) => page.evaluate(() => {
  window.__scrolls = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoViewRecorded(arg) { window.__scrolls.push(arg && typeof arg === "object" && arg.behavior ? arg.behavior : "auto"); return original.apply(this, arguments); };
});
const scrollsOf = (page) => page.evaluate(() => ({ calls: window.__scrolls.length, smooth: window.__scrolls.filter((behavior) => behavior === "smooth").length }));
/** Wait until the page has stopped scrolling (the same position over 40 frames): a smooth scroll that is still on its way is not a landing. */
async function scrollSettled(page) {
  let last = -1;
  await until(async () => { const now = await scrollerTop(page); await frames(page, 40); const again = await scrollerTop(page); const settled = now === again && now === last; last = again; return settled; }, "the page stopped scrolling", { timeoutMs: 30000 });
}
/** Import a note through the dialog of the sources page; returns the selector of its row and the row's index among the drawn rows once it is drawn. */
async function importFreshNote(page) {
  await page.locator('[data-tour="sources-add"]').first().click();
  const dialog = page.locator("dialog[open], [role=\"dialog\"]").first();
  await dialog.waitFor({ timeout: 30000 });
  await dialog.locator(".sh-drop input[type=\"file\"]").first().setInputFiles([{ name: "fresh-note.md", mimeType: "text/markdown", buffer: Buffer.from("# Fresh\n\nA note imported just now about quorum reads.\n") }]);
  await until(async () => (await count(page, "dialog[open]")) === 0, "the dialog closed after the import", { timeoutMs: 60000 });
  const fresh = '.source-doc[data-new="true"]';
  await page.locator(fresh).first().waitFor({ timeout: 30000 });
  const at = await page.evaluate(() => [...document.querySelectorAll(".sources-page .source-doc")].findIndex((row) => row.dataset.new === "true"));
  return { fresh, at };
}
/** 找功能: Ctrl K, the search words, and 带我去 on the entry; the focus starts inside the app, as the shortcut needs. */
async function goViaFinder(page, focusSelector, words, entry) {
  await page.locator(focusSelector).first().focus();
  await page.keyboard.press("Control+K");
  await page.getByRole("combobox", { name: "搜索功能" }).fill(words);
  const row = page.locator(`[role="option"][data-entry="${entry}"]`);
  await row.waitFor({ timeout: 10000 });
  await row.hover();
  await row.locator(".finder-row__go").click();
}

test("the sources page, the wrong book and a long draft draw their rows in chunks, and every jump to a row still lands", { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split("\n")[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), "study-chunk-dist-"));
  await buildPreview({ outdir: dist });
  const now = Date.now(), zone = noonZone(now);
  const running = await startLateServer({ distDir: dist, seed: (root) => seedChunkLibrary(root, { documents: DOCUMENTS, mistakes: MISTAKES, questions: QUESTIONS, newest: now + NEWER_THAN_NOW * 30_000 }) });
  try {
    await t.test("资料: one chunk at first, the next at the end, the first visible row stays, folding starts again, counts and 选择当前范围 cover all rows", async () => {
      const { page, context, errors } = await openApp(browser, running, zone);
      await openNav(page, "sources");
      const rows = ".sources-page .source-doc";
      await page.locator(rows).first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.equal(await count(page, rows), CHUNK, "the newest day opens with one chunk");
      assert.match(await page.locator(".source-group--open .source-group-head").first().innerText(), new RegExp(`${DOCUMENTS + 1} 份`), "the group's count is of all its rows");

      // Near the end: the next chunk is drawn after the first one, and the row that was first in sight has not moved; the same again for the third.
      for (const chunks of [2, 3]) {
        const sight = await scrollNearEnd(page, rows, "data-document-key");
        await until(async () => (await count(page, rows)) === chunks * CHUNK, `${chunks} chunks drawn after scrolling to the end`, { timeoutMs: 15000 });
        await frames(page, 3);
        const after = await topOfKey(page, "data-document-key", sight.key);
        assert.notEqual(after, null);
        assert.ok(Math.abs(after - sight.top) <= 1, `the first visible row moved from ${sight.top} to ${after} when chunk ${chunks} was appended`);
      }

      // 选择当前范围 selects every row of the page, drawn or not; the header says so.
      await page.locator(".source-organize > summary").click();
      await page.getByRole("button", { name: "选择当前范围" }).click();
      assert.match(await page.locator(".source-organize").innerText(), new RegExp(`已选择 ${ALL_DOCUMENTS} 份资料`));
      await page.locator(".source-organize > summary").click();

      // Folding the group and opening it again: one chunk.
      const head = page.locator(".source-group-head").first();
      await head.click();
      await until(async () => (await count(page, rows)) === 0, "the group folded");
      await head.click();
      await until(async () => (await count(page, rows)) > 0, "the group opened");
      assert.equal(await count(page, rows), CHUNK, "a group that is opened again starts from the first chunk");

      // The keyboard: focus moving to the last rows of the chunk draws the next one.
      await page.locator(`${rows} .source-main`).nth(CHUNK - 3).focus();
      await until(async () => (await count(page, rows)) > CHUNK, "the next chunk after focus reached the end", { timeoutMs: 15000 });
      assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      await context.close();
    });

    await t.test("资料: a note imported now lands beyond the first chunk, and the row is drawn, in view and focused", async () => {
      const { page, context, errors } = await openApp(browser, running, zone);
      await openNav(page, "sources");
      await page.locator(".sources-page .source-doc").first().waitFor({ timeout: 30000 });
      // The notes dated after the import come first (about NEWER_THAN_NOW of them: the clock has moved on since the library was written): the new row is far past two chunks.
      const { fresh, at } = await importFreshNote(page);
      assert.ok(at > 2 * CHUNK, `the new row is beyond the first chunks: index ${at}`);
      const drawn = await count(page, ".sources-page .source-doc");
      // The group is drawn up to the new row, and the end of what is drawn is then in sight just below it, so it may draw one more chunk: never the rest of the thousand.
      assert.ok(drawn >= at + 1 && drawn <= at + 1 + CHUNK, `the group draws up to the new row and at most one chunk further: ${drawn} rows for index ${at}`);
      await until(() => inView(page, fresh), "the new row scrolled into view", { timeoutMs: 15000 });
      assert.equal(await page.evaluate(() => document.activeElement?.closest?.(".source-doc")?.getAttribute("data-new")), "true", "the focus is on the new row");
      assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      await context.close();
    });

    await t.test("找功能: the anchor on a row beyond the first chunk (the book's 深度定制) is drawn and shown", async () => {
      const { page, context } = await openApp(browser, running, zone);
      await openNav(page, "sources");
      await page.locator(".sources-page .source-doc").first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.equal(await count(page, '[data-tour="custom-book-row"]'), 0, "the book's row is not drawn yet");
      await goViaFinder(page, '[data-tour="sources-archived"]', "资料那一行", "custom-book-row");
      await until(() => inView(page, '[data-tour="custom-book-row"]'), "the 深度定制 button of the book in view", { timeoutMs: 20000 });
      await context.close();
    });

    /* The two jumps below start above an open group that is longer than a chunk and end below it. A smooth scroll takes a moment on its way, and the end of that group passes
       through the window, so the group draws its next chunk and pushes the row down while the scroll still heads for the old place: those jumps are one scroll, not an animation.
       Each gets a library of its own, smaller than the one above, with a long open group between the top of the page and the row. */
    const withLibrary = async (options, body, view = {}) => {
      const own = await startLateServer({ distDir: dist, seed: (root) => seedChunkLibrary(root, { mistakes: 2, questions: 4, similarAt: 1, newest: now + NEWER_THAN_NOW * 30_000, ...options }) });
      const { page, context, errors } = await openApp(browser, own, zone, view);
      try {
        await openNav(page, "sources");
        await page.locator(".sources-page .source-doc").first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await recordScrolls(page);
        await body(page);
        assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      } finally { await context.close(); await own.close(); }
    };

    await t.test("资料: a note imported now lands below a pinned group of more than a chunk, which draws its next chunk on the way", async () => {
      await withLibrary({ documents: 600, pinned: 150 }, async (page) => {
        assert.equal(await count(page, ".source-group--open .source-group-head"), 2, "the pinned group and the day are open");
        const { fresh, at } = await importFreshNote(page);
        assert.ok(at > CHUNK, `the new row is past the first chunk of the day: index ${at}`);
        await scrollSettled(page);
        assert.ok(await inView(page, fresh), "the new row is in view when the scroll has stopped");
        const scrolls = await scrollsOf(page);
        assert.ok(scrolls.calls > 0 && scrolls.smooth === 0, `the jump is one scroll, not an animation: ${JSON.stringify(scrolls)}`);
        assert.equal(await page.evaluate(() => document.activeElement?.closest?.(".source-doc")?.getAttribute("data-new")), "true", "the focus is on the new row");
      });
    });

    await t.test("找功能: the book's 深度定制 button lands when a day of more than a chunk is open far above it", async () => {
      // The days, newest first: the notes (450), the four small sources, the book alone. The book is more than half a window below the end of the first day, so the end of
      // that day is not in sight when the book is: only the way down passes it, and a smooth scroll would let the day draw a chunk on that way and move the book.
      await withLibrary({ documents: 450, bookOlderDays: 400 }, async (page) => {
        await page.locator(".source-group-head").nth(2).dispatchEvent("click");
        await page.locator(".source-group-head").nth(1).dispatchEvent("click");
        await page.locator('[data-tour="custom-book-row"]').first().waitFor({ timeout: 15000 });
        await scrollerTop(page, 0);
        await frames(page, 6);
        assert.equal(await count(page, ".source-group--open:first-child .source-doc"), CHUNK, "the open day above draws one chunk");
        await goViaFinder(page, '[data-tour="sources-archived"]', "资料那一行", "custom-book-row");
        await scrollSettled(page);
        assert.ok(await inView(page, '[data-tour="custom-book-row"]'), "the 深度定制 button of the book is in view when the scroll has stopped");
        const scrolls = await scrollsOf(page);
        assert.ok(scrolls.calls > 0 && scrolls.smooth === 0, `the jump is one scroll, not an animation: ${JSON.stringify(scrolls)}`);
      }, { height: 600 });
    });

    await t.test("#930: 找功能 lands on the book's 深度定制 button even when its day sits immediately below an open >120-row day", async () => {
      // Group 0 (today): 300 notes (120 drawn initially). Group 1 (yesterday, bookOlderDays: 1): the book alone, right under Group 0's end marker.
      // Landing on the book brings Group 0's end marker into the viewport so Group 0 appends chunks; scrollToAnchor re-checks and keeps the book in view.
      await withLibrary({ documents: 300, bookOlderDays: 1 }, async (page) => {
        await page.locator(".source-group-head").nth(1).dispatchEvent("click");
        await page.locator('[data-tour="custom-book-row"]').first().waitFor({ timeout: 15000 });
        await scrollerTop(page, 0);
        await frames(page, 6);
        assert.equal(await count(page, ".source-group--open:first-child .source-doc"), CHUNK, "the open day right above draws one chunk at first");
        await goViaFinder(page, '[data-tour="sources-archived"]', "资料那一行", "custom-book-row");
        await scrollSettled(page);
        assert.ok(await inView(page, '[data-tour="custom-book-row"]'), "the 深度定制 button of the book stays in view after adjacent chunks settle");
        const scrolls = await scrollsOf(page);
        assert.ok(scrolls.calls > 0 && scrolls.smooth === 0, `every scroll is instant: ${JSON.stringify(scrolls)}`);
      }, { height: 600 });
    });

    await t.test("错题: one chunk of a group, the next at the end, a new filter starts again, the group jump lands, 练这一组 takes every row", async () => {
      const { page, context, errors } = await openApp(browser, running, zone);
      await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* blocked */ } });
      await openNav(page, "wrongbook");
      await page.locator(".wb-retrain").waitFor({ timeout: 30000 });
      const rows = ".wb-row";
      const toggles = page.locator(".wb-group .wb-group-toggle");
      await toggles.first().click();
      await page.locator(rows).first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.equal(await count(page, rows), CHUNK, "the opened group draws one chunk");
      assert.match(await page.locator(".wb-group").first().locator(".wb-group-title").innerText(), new RegExp(`${MISTAKES / 2} 题`), "the group's count is of all its rows");

      // The group jump (a topic spans both decks, so its segment of 薄弱点分布 goes to the group instead of filtering): three groups are open, the sixth is far below,
      // and the jump lands on its head in one scroll, without drawing the chunks of the open groups it passes.
      await page.locator(".wb-view").getByText("按主题", { exact: true }).click();
      await page.locator(".wb-group").nth(5).waitFor();
      // (Bottom up: a group's end that is in sight draws its next chunk, so opening a group right under an open one would do that.)
      for (const at of [2, 1, 0]) await toggles.nth(at).click();
      await until(async () => (await count(page, rows)) === 3 * CHUNK, "three open groups, one chunk each");
      await page.locator(".wb-dist-seg").nth(5).click();
      await until(async () => (await page.evaluate(() => { const top = document.querySelectorAll(".wb-group")[5].getBoundingClientRect().top; return top >= -2 && top < 250; })), "the sixth group's head at the top of the window", { timeoutMs: 15000 });
      await frames(page, 6);
      assert.equal(await count(page, rows), 4 * CHUNK, "the jump opened the sixth group (one chunk) and drew no other chunk of the groups it passed");
      assert.ok(await page.evaluate(() => { const top = document.querySelectorAll(".wb-group")[5].getBoundingClientRect().top; return top >= -2 && top < 250; }), "and the head is still where the jump put it");

      // At the end of the open groups: the next chunk of the last one; a search starts every group from its first chunk again.
      await scrollToEnd(page);
      await until(async () => (await count(page, rows)) > 4 * CHUNK, "the next chunk after scrolling to the end", { timeoutMs: 15000 });
      // (Every prompt ends with a full stop, so the search keeps every row: only the chunk can change.)
      await page.locator(".wb-search-input").fill(".");
      await until(async () => (await count(page, rows)) === 4 * CHUNK, "a new filter starts every group from the first chunk", { timeoutMs: 15000 });
      await page.locator(".wb-search-input").fill("");

      // 练这一组 takes the rows of the group, all of them, drawn or not: the round that opens counts every one. (A round holds at most 200 questions: a topic of both decks is 168.)
      const size = Number((await page.locator(".wb-group").filter({ hasText: "Topic 1" }).first().locator(".wb-group-title small").first().innerText()).match(/\d+/)[0]);
      assert.ok(size > CHUNK && size <= 200, `a group of ${size} rows, more than a chunk`);
      // (A programmatic click: the way to the button passes the end of open groups, which draw a chunk and move the button while a pointer click is on its way.)
      await page.getByRole("button", { name: /练这一组：Topic 1/ }).dispatchEvent("click");
      await page.getByText(`所选 ${size} 道题`).locator("visible=true").first().waitFor({ timeout: 30000 }); // (the visible one: the navigation also names the round in a tooltip)

      // #928: a deck group of 500 (> 200) caps to the first 200 with a toast instead of failing checkScope.
      await openNav(page, "wrongbook");
      await page.locator(".wb-view").getByText("按题组", { exact: true }).click();
      await page.locator(".wb-group").first().waitFor();
      await page.locator(".wb-group").first().getByRole("button", { name: /练这一组/ }).dispatchEvent("click");
      await page.getByText("所选 200 道题").locator("visible=true").first().waitFor({ timeout: 30000 });
      await page.getByText(/一次最多 200 道：先练前 200 道/).first().waitFor({ timeout: 15000 });
      assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      await context.close();
    });

    await t.test("草稿: one chunk of 80 questions, the next at the end, 找功能 to a similar question beyond it, adding a question draws it", async () => {
      const { page, context, errors } = await openApp(browser, running, zone);
      await openNav(page, "library");
      const fold = page.locator("details.home-drafts").first();
      if (await fold.count() && !await fold.evaluate((element) => element.open)) await fold.locator("summary").first().click();
      const asked = page.waitForResponse((response) => /\/api\/call/.test(response.url()) && /"draft\.similar"/.test(response.request().postData() || ""), { timeout: 60000 });
      await page.locator(".draft-row").filter({ hasText: "A long draft" }).locator(".draft-open").click();
      const cards = ".draft-card";
      await page.locator(cards).first().waitFor({ timeout: 30000 });
      await asked;
      await frames(page, 4);
      await settleAnimations(page);
      assert.equal(await count(page, cards), DRAFT_CHUNK, "a draft of more than 80 questions draws 80 first");
      assert.match(await page.locator(".draft-edit-heading").innerText(), new RegExp(`${QUESTIONS} 题`), "the heading counts all the questions");

      // #927: the near-duplicate notice is on question SIMILAR_AT (index 100): past the first chunk, inside the fold's summary. 找功能 reveals the row, keeps the question's own
      // fold closed so the summary notice stays visible, scrolls it into view and focuses it.
      assert.equal(await count(page, '[data-tour="draft-similar"]'), 0);
      await goViaFinder(page, ".draft-title-field__input", "相似题", "draft-similar");
      await until(() => inView(page, '[data-tour="draft-similar"]'), "the similar-question notice visible and in view", { timeoutMs: 20000 });
      await until(() => page.evaluate(() => !!document.activeElement?.closest('[data-tour="draft-similar"]')), "the similar-question notice focused", { timeoutMs: 10000 });
      assert.equal(await page.evaluate(() => document.querySelector('[data-tour="draft-similar"]')?.closest("details.draft-card")?.open), false, "its card stayed closed");
      const drawn = await count(page, cards);
      assert.ok(drawn >= SIMILAR_AT + 1 && drawn < QUESTIONS, `the list drew the question with the notice without drawing the whole draft: ${drawn} cards`);

      // The end: the next chunk.
      await scrollToEnd(page);
      await until(async () => (await count(page, cards)) > drawn, "the next chunk after scrolling to the end", { timeoutMs: 15000 });

      assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      await context.close();
    });

    await t.test("草稿: a question added to a draft of 90 is drawn, and 查看详情 draws every question before it scrolls to the details after them", async () => {
      const { page, context, errors } = await openApp(browser, running, zone);
      await openNav(page, "library");
      const fold = page.locator("details.home-drafts").first();
      if (await fold.count() && !await fold.evaluate((element) => element.open)) await fold.locator("summary").first().click();
      await page.locator(".draft-row").filter({ hasText: "A draft of ninety" }).locator(".draft-open").click();
      const cards = ".draft-card";
      await page.locator(cards).first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      assert.equal(await count(page, cards), DRAFT_CHUNK, "ninety questions: one chunk of 80 at first");

      // 查看详情 (a question was sent back) goes to the details that follow the last question: all ninety are drawn first, and the details are in view.
      await page.getByRole("button", { name: "查看详情" }).click();
      await until(async () => (await count(page, cards)) === SHORT_DRAFT, "every question drawn for the details", { timeoutMs: 15000 });
      await until(() => inView(page, ".draft-generation-details"), "the details in view", { timeoutMs: 15000 });
      await frames(page, 6);
      assert.equal(await count(page, cards), SHORT_DRAFT);
      assert.ok(await inView(page, ".draft-generation-details"), "and still in view");
      assert.equal(await page.locator(".draft-generation-details").evaluate((element) => element.open), true);

      // 添加闪卡 appends question 91: it is drawn.
      await page.getByRole("button", { name: /添加闪卡/ }).click();
      await until(async () => (await count(page, cards)) === SHORT_DRAFT + 1, "the added question drawn", { timeoutMs: 15000 });
      assert.deepEqual(errors.filter((error) => !/favicon/.test(error)), []);
      await context.close();
    });
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
