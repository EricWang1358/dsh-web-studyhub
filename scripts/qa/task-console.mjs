/* node scripts/qa/task-console.mjs [--lang zh|en] [--theme dark|light] [--width 1280|420] [--out output/task-console] [--dist dist] [--ended [--bar N]] [--output]
   [--plan [--tab=目标|Goal]]  the question run already has its plan listed: 目标与知识点 has its points.
   [--flow=select|archived|dialog]  (2.6.1) two tasks have ended and one runs: select (everything selected, the bar of the selection), archived (archived, 已归档 open, read-only),
   dialog (the confirmation of 删除 open).
   [--accent=jade|ochre|graphite|plum] [--palette=oled|paper]  an accent preset / a theme of Settings; [--hover=all|archive|delete|clear|row [--focus]] points at (or focuses) that control so its tooltip is open.
   --ended lets the held jobs finish, then opens the N-th bar of the timeline (an ended call): 实时输出 shows what it wrote (2.6.1), model JSON indented.
   The 任务 console in the browser preview, on a seeded temporary library with the fake model: a three-recording audio batch (one of them named .mp3 but a
   WAV) and a question run, both held in flight, with the text of the model's replies streamed in small pieces so 实时输出 has something to show, and
   Gemini's transcription answered by a fake in this process. Writes <out>/console-<lang>-<theme>-<width>.png and prints one JSON line of measurements.
   The same functions drive tests/task-console-browser.test.mjs. No network, every key/token/base-url variable removed. */
/* global document, getComputedStyle, innerWidth, innerHeight */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { seedLibrary } from "./perf-seed.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { drainLayoutStability } from "./layout-stability.mjs";
import { openPage, settleAnimations, until, frames } from "./layout-late.mjs";
import { dayOf, DAILY } from "../../lib/coach-daily.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms, signal) => new Promise((resolveSleep, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolveSleep, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** A WAV of `seconds` of silence: an audio file the import accepts. */
export function wav(seconds = 1, fill = 1) {
  const data = Buffer.alloc(16000 * seconds, fill), header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const lecture = (name, paragraphs = 120) => Array.from({ length: paragraphs }, (_, index) => `${name} · paragraph ${index + 1}: the lecture explains how a service boundary, a queue and a cache change the latency and the consistency of a system.`).join("\n\n");

/** Four days of 为你定制 as the coach keeps them (lib/coach-daily.js): a past week for the history, and today with a few batches, one of them skipped. */
export async function seedCoachDays(root) {
  const day = (back) => dayOf(Date.now() - back * 86400000), at = (back, minutes) => new Date(Date.now() - back * 86400000 - (90 - minutes) * 60000).toISOString();
  const batch = (back, n, extra = {}) => ({ id: `seed-${back}-${n}`, startedAt: at(back, n * 20), endedAt: at(back, n * 20 + 1), status: "ok", targets: 4, generated: 4, passed: 3, skipped: 1,
    tokens: { input: 9000 + n * 700, output: 1500 + n * 90, cache: 6000 }, message: "", ...extra });
  const days = { [day(0)]: { batches: [batch(0, 1), batch(0, 2, { status: "skipped", generated: 0, passed: 0, skipped: 0, reason: "limit", tokens: { input: 0, output: 0, cache: 0 } }), batch(0, 3, { generated: 3, passed: 3, skipped: 0 })] },
    [day(1)]: { batches: [batch(1, 1), batch(1, 2)] }, [day(3)]: { batches: [batch(3, 1, { status: "failed", generated: 0, passed: 0, reason: "error", message: "模型服务暂时不可用", tokens: { input: 0, output: 0, cache: 0 } }), batch(3, 2)] },
    [day(5)]: { batches: [batch(5, 1)] } };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, DAILY.file), JSON.stringify({ version: 1, settings: {}, days }), "utf8");
}

/**
 * The preview with a fake model that streams, a fake Gemini, and a held gate: while held, the calls of the jobs stay in flight (after their text has streamed),
 * so the page can be looked at, measured and screenshot with work in progress.
 */
export async function startConsole({ distDir, lang = "zh", hold = true, streamStepMs = 60, transcribeMs = 250, passPlan = false } = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-console-")), root = join(base, "library");
  await seedLibrary(root, { sources: 12, decks: 3, cardsPerDeck: 8, runs: 1, attempts: 0, courses: 1, largeSources: 0 });
  await seedCoachDays(root);
  const inner = createFakeModel({ latencyMs: 20 });
  const gate = { held: hold, waiters: [] };
  const release = () => { gate.held = false; for (const open of gate.waiters.splice(0)) open(); };
  const holdAgain = () => { gate.held = true; };
  const holdHere = (signal) => (gate.held ? new Promise((resolveHold, reject) => {
    gate.waiters.push(resolveHold);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) : undefined);
  const complete = async (system, prompt, options = {}) => {
    options.signal?.throwIfAborted();
    const reply = await inner(system, prompt, options);
    if (typeof options.onOutput === "function") {
      const text = String(reply), size = Math.max(16, Math.ceil(text.length / 16));
      for (let at = 0; at < text.length; at += size) { options.signal?.throwIfAborted(); options.onOutput(text.slice(at, at + size)); await sleep(streamStepMs, options.signal); }
    }
    // `passPlan`: the planning call is answered at once, so a held run already has its knowledge points listed (目标与知识点) while its later calls stay in flight.
    if (!(passPlan && String(system).startsWith("Plan a source-grounded"))) await holdHere(options.signal);
    return reply;
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage.googleapis.com") && String(url).includes("transcribe:")) {
      await sleep(transcribeMs, init?.signal);
      const name = Buffer.from(JSON.parse(init.body).contents[0].parts.find((part) => part.inlineData).inlineData.data, "base64").at(-1) === 1 ? "Lecture A" : "Lecture B";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: lecture(name) }] } }], usageMetadata: {} }));
    }
    return realFetch(url, init);
  };
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, "home"), port: 0, model: complete, ...(distDir ? { distDir } : {}) });
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: lang });
  const close = async () => {
    await previewCall(server, "job.cancel", { all: true }).catch(() => {});
    release();
    await sleep(300);
    await server.close();
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  };
  return { base, root, server, api, lang, release, hold: holdAgain, close, gate };
}

/**
 * Finish what startJobs started (the audio batch and the question run end), then hold the model again and start one more question run that stays in flight: the list
 * then has finished tasks (selectable) and a running one (not), the state 归档 and 批量删除 are drawn from. Returns the id of the running one.
 */
export async function finishJobsThenHoldOne(running) {
  running.release();
  await until(async () => !(await running.api("snapshot")).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)), "the first jobs to finish");
  running.hold();
  const snapshot = await running.api("snapshot");
  const again = await running.api("generate", { sourceIds: snapshot.sources.slice(3, 5).map((source) => source.id), count: 6, kind: "quiz", title: running.lang === "en" ? "Another run" : "另一次出题" });
  await until(async () => (await running.api("snapshot")).jobs.some((job) => job.id === again.jobId && ["queued", "running"].includes(job.status)), "the second run to be in flight");
  return again.jobId;
}

/** Start the jobs the console shows: an audio batch of three recordings (the second named .mp3 though it is a WAV) and a question run. */
export async function startJobs(running, { count = 10 } = {}) {
  const { api, base } = running, files = [];
  for (const [index, name] of ["A.wav", "B.mp3", "C.wav"].entries()) { const path = join(base, name); await writeFile(path, wav(1, index + 1)); files.push({ path }); }
  await api("audio.settings.set", { paidKey: "AIzaTaskConsoleQa_000000000000001", textProvider: "host", transcribeConcurrency: 2, textConcurrency: 3 });
  const audio = await api("audio.import", { files, title: running.lang === "en" ? "Week 3 · distributed systems lectures" : "第 3 周 · 分布式系统讲座" });
  const snapshot = await api("snapshot");
  const generation = await api("generate", { sourceIds: snapshot.sources.slice(0, 3).map((source) => source.id), count, kind: "quiz", title: running.lang === "en" ? "Consistency models" : "一致性模型" });
  return { audio, generation };
}

/** Open a page of the app by its sidebar entry (the 任务 console by default). */
export async function openConsole(browser, running, { lang = "zh", theme = "dark", width = 1280, height = 900, nav = "tasks", accent, palette } = {}) {
  const opened = await openPage(browser, running, { lang, theme, width, height });
  // An accent preset (ui/accent.css) and, with `palette` (oled|paper), the theme of Settings: stored the way Settings stores them.
  if (palette) await opened.context.addInitScript((value) => { try { localStorage.setItem("study-theme", value); } catch { /* blocked */ } }, palette);
  if (accent && accent !== "cinnabar") await opened.context.addInitScript((value) => { try { localStorage.setItem("study-interface", JSON.stringify({ accent: value })); } catch { /* blocked */ } }, accent);
  await opened.page.goto(running.server.url);
  await opened.page.locator("aside, nav").first().waitFor({ timeout: 30000 });
  const entry = opened.page.locator(`[data-tour="nav-${nav}"]`).first();
  await entry.waitFor({ state: "attached" });
  await entry.dispatchEvent("click");
  await opened.page.locator(nav === "tasks" ? ".tc-detail" : ".cjc").first().waitFor({ state: "attached", timeout: 30000 });
  await settleAnimations(opened.page);
  return opened;
}

/** What a layout reader needs: the page and the console against the window, and each scrolling panel against its own box. */
export const measure = (page) => page.evaluate(() => {
  const box = (selector) => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
  const scroller = (selector) => [...document.querySelectorAll(selector)].map((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrolls: element.scrollHeight > element.clientHeight + 1,
    overflow: getComputedStyle(element).overflowY }));
  const app = document.querySelector(".study-app"), main = document.querySelector("main");
  return { viewport: { width: innerWidth, height: innerHeight }, docHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth, appScrolls: app ? app.scrollHeight > app.clientHeight + 1 : null, appHeight: app?.clientHeight, appScrollHeight: app?.scrollHeight,
    main: box("main"), console: box(".tc"), list: box(".tc-list"), detail: box(".tc-detail"), body: box(".tc-body"), cols: [...document.querySelectorAll(".tc-col")].map((element) => { const r = element.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }; }),
    scrollers: { list: scroller(".tc-list .tc-scroll"), panels: scroller(".tc-panel .tc-scroll, .tc-output__body, .tc-log__body, .tc-lanes"), mainScrolls: main ? main.scrollHeight > main.clientHeight + 1 : null } };
});

/** The list's selection UI as a reader needs it: the bar, the boxes against the status dots, the rows' places and the colours of the text on what it sits on (for a contrast ratio), the open tooltip against the window. Runs in the page. */
export const measureSelection = (page) => page.evaluate(() => {
  const read = (text) => {
    const srgb = /color\(srgb ([^)]+)\)/.exec(text);
    if (srgb) { const [colour, alpha] = srgb[1].split("/"); const [r, g, b] = colour.trim().split(/\s+/).map((value) => Number(value) * 255); return [r, g, b, alpha === undefined ? 1 : Number(alpha)]; }
    const m = /rgba?\(([^)]+)\)/.exec(text);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => { const alpha = top[3] + under[3] * (1 - top[3]); return alpha ? [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / alpha).concat(alpha) : [0, 0, 0, 0]; };
  /** What is behind an element: every ancestor's background laid over the one above it, from the window down. */
  const backdrop = (element) => { const chain = []; for (let node = element; node; node = node.parentElement) chain.unshift(read(getComputedStyle(node).backgroundColor)); return chain.reduce((under, layer) => over(layer, under), [255, 255, 255, 1]); };
  const sample = (what, element) => element && { what, fg: read(getComputedStyle(element).color), bg: backdrop(element), text: element.textContent.trim().slice(0, 24) };
  const box = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
  const bar = document.querySelector(".tc-pickbar"), scroll = document.querySelector(".tc-scroll");
  const items = [...document.querySelectorAll(".tc-item")];
  const ticked = items.filter((item) => item.dataset.checked === "true"), picked = items.filter((item) => item.querySelector(".tc-row[aria-pressed='true']"));
  const rowSamples = (list, tag) => list.flatMap((item) => [sample(`${tag} title`, item.querySelector(".tc-row__title")), sample(`${tag} sub`, item.querySelector(".tc-row__sub")), sample(`${tag} num`, item.querySelector(".tc-num"))]);
  const tip = document.querySelector(".sh-tooltip:popover-open");
  // A tooltip lets the pointer through: switch that off for the hit test only, so the test sees what is really on top at its middle and at its corners.
  const tipBox = box(tip);
  if (tip) tip.style.pointerEvents = "auto";
  const hits = tipBox ? [[tipBox.cx, tipBox.cy], [tipBox.left + 2, tipBox.top + 2], [tipBox.right - 2, tipBox.bottom - 2]].map(([x, y]) => document.elementFromPoint(x, y)) : [];
  if (tip) tip.style.pointerEvents = "";
  const heads = [...document.querySelectorAll(".tc-head__actions > *")];
  return {
    viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
    bar: box(bar), barScroll: bar && { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth }, barInput: box(bar?.querySelector(".tc-pickbar__all input")), barIndeterminate: bar?.querySelector(".tc-pickbar__all input")?.indeterminate ?? null,
    barChecked: bar?.querySelector(".tc-pickbar__all input")?.checked ?? null, barLabel: bar?.querySelector(".sh-check__label")?.textContent ?? "", labelCut: (() => { const label = bar?.querySelector(".sh-check__label"); return label ? label.scrollWidth > label.clientWidth + 1 : null; })(),
    actions: [...(bar?.querySelectorAll(".tc-pickbar__actions button") ?? [])].map((button) => ({ text: button.textContent.trim(), ...box(button) })),
    listScroll: scroll && { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, top: scroll.getBoundingClientRect().top }, itemTops: items.map((item) => Math.round(item.getBoundingClientRect().top)),
    ticked: ticked.map((item) => ({ input: box(item.querySelector("input")), dot: box(item.querySelector(".tc-dot")), title: box(item.querySelector(".tc-row__title")) })),
    unticked: items.filter((item) => item.dataset.checked !== "true" && item.querySelector("input")).map((item) => ({ input: box(item.querySelector("input")), dot: box(item.querySelector(".tc-dot")) })),
    contrast: [...rowSamples(ticked, "ticked row"), ...rowSamples(picked, "picked row"), sample("bar label", bar?.querySelector(".sh-check__label")), ...[...(bar?.querySelectorAll(".tc-pickbar__actions button") ?? [])].map((button) => sample("bar button", button))].filter(Boolean),
    tooltip: tip ? { ...tipBox, text: tip.textContent.trim(), covered: !hits.every((hit) => hit && tip.contains(hit)), inTopLayer: tip.matches(":popover-open") } : null,
    head: { actions: heads.map((element) => ({ text: element.textContent.trim(), ...box(element) })), title: box(document.querySelector(".tc-head__title h2")), titleCut: (() => { const h2 = document.querySelector(".tc-head__title h2"); return h2 ? h2.scrollWidth > h2.clientWidth + 1 : null; })(), detail: box(document.querySelector(".tc-detail")), box: box(document.querySelector(".tc-head")) },
    focus: document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), inBar: !!bar?.contains(document.activeElement), isBar: document.activeElement === bar } : null,
  };
});

/** The WCAG contrast ratio of two [r, g, b, a] colours (the text over the backdrop it sits on). */
export function contrastRatio(fg, bg) {
  const light = ([r, g, b]) => { const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const solid = fg[3] < 1 ? [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])) : fg;
  const [a, b] = [light(solid), light(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The compact cards of a page: each card's box and the boxes of its parts, so a test can see that they line up (same columns, same height) and that the page does not scroll sideways. */
export const measureCards = (page) => page.evaluate(() => {
  const r = (element) => { if (!element) return null; const b = element.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; };
  return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
    cards: [...document.querySelectorAll(".cjc")].map((card) => ({ id: card.getAttribute("data-job-id"), state: card.getAttribute("data-state"), box: r(card), title: r(card.querySelector(".cjc__title")), line: r(card.querySelector(".cjc__line")),
      slot: r(card.querySelector(".cjc__slot")), go: r(card.querySelector(".cjc__go")), bar: r(card.querySelector(".sh-progress")) })) };
});

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg); return match ? [match[1], match[2] ?? true] : []; }).filter((pair) => pair.length));
  const lang = args.lang === "en" ? "en" : "zh", theme = args.theme === "light" ? "light" : "dark", width = Number(args.width) || 1280, height = Number(args.height) || 900;
  const out = resolve(repoRoot, args.out || "output/task-console");
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const running = await startConsole({ lang, passPlan: !!args.plan, ...(args.dist ? { distDir: resolve(repoRoot, args.dist) } : {}) });
  try {
    await startJobs(running);
    if (args.flow) await finishJobsThenHoldOne(running);
    const nav = args.page === "audio" ? "audio" : args.page === "library" ? "library" : "tasks";
    const { page, errors, context } = await openConsole(browser, running, { lang, theme, width, height, nav, accent: args.accent, palette: args.palette });
    if (nav !== "tasks") {
      await frames(page, 6); await page.waitForTimeout(1500); await drainLayoutStability(page);
      const shot = join(out, `cards-${nav}-${lang}-${theme}-${width}.png`);
      await page.screenshot({ path: shot });
      console.log(JSON.stringify({ shot, errors, ...(await measureCards(page)) }));
      await context.close();
      return;
    }
    if (args.flow) {
      await until(async () => (await page.locator(".tc-item__check input").count()) >= 2, "the finished tasks to be selectable");
      await page.locator(".tc-pickbar__all input").dispatchEvent("click");
      await page.locator(".tc-pickbar__actions").waitFor({ state: "attached" });
      if (args.flow === "archived") {
        await page.locator(".tc-pickbar__actions button").first().dispatchEvent("click");
        await until(async () => (await page.locator(".tc-filter").nth(3).innerText()).trim().endsWith("2"), "the tasks under 已归档");
        await page.locator(".tc-filter").nth(3).dispatchEvent("click");
        await page.locator(".tc-detail[data-archived='true']").waitFor({ state: "attached" });
      }
      if (args.flow === "dialog") {
        await page.locator(".tc-pickbar__actions button").nth(1).dispatchEvent("click");
        await page.locator("dialog.sh-dialog[open]").waitFor({ state: "attached" });
      }
    }
    if (args.pick) await page.locator(".tc-row").nth(Number(args.pick)).dispatchEvent("click");
    // --hover=all|box|archive|delete|clear|row: really point at (or Tab to, with --focus) that control so its tooltip is open for the picture.
    if (args.hover) {
      const target = { box: ".tc-pickbar__all", all: ".tc-pickbar__all", archive: ".tc-pickbar__actions button >> nth=0", delete: ".tc-pickbar__actions button >> nth=1", clear: ".tc-pickbar__actions button >> nth=2", row: ".tc-row >> nth=0" }[args.hover];
      if (!target) throw new Error(`--hover=${args.hover}: unknown target`);
      if (args.focus) await page.locator(target).first().focus(); else await page.locator(target).first().hover();
      await page.waitForTimeout(900);
    }
    // A task with nothing in flight (a day of 为你定制) shows no call: `--calls=0` does not wait for one.
    if (args.calls !== "0" && !args.ended && !args.flow) await until(async () => (await page.locator(".tc-callrow").count()) > 0, "a call in flight");
    if (args.ended) {
      running.release();
      await until(async () => !(await running.api("snapshot")).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)), "the jobs to finish");
      await page.locator(".tc-callbar").nth(Number(args.bar) || 0).dispatchEvent("click");
      await until(async () => (await page.locator(".tc-output__foot").first().innerText()).trim().length > 0, "the ended call's output");
    }
    // stacked (narrow): the panel is below the fold; bring it into the picture
    if (args.output) await page.locator(".tc-output").first().scrollIntoViewIfNeeded();
    if (args.tab) await page.getByRole("tab", { name: new RegExp(args.tab) }).first().dispatchEvent("click");
    // stacked (narrow): the plan panel is below the fold too
    if (args.plan && args.tab) await page.locator(".tc-plan").first().scrollIntoViewIfNeeded();
    if (args.rtab) await page.getByRole("tab", { name: new RegExp(args.rtab) }).last().dispatchEvent("click");
    await frames(page, 6);
    await page.waitForTimeout(1500);
    await drainLayoutStability(page);
    const shot = join(out, `console-${lang}-${theme}-${width}${args.name ? `-${args.name}` : ""}.png`);
    await page.screenshot({ path: shot });
    console.log(JSON.stringify({ shot, errors, ...(await measure(page)) }));
    await context.close();
  } finally { await browser.close(); await running.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
