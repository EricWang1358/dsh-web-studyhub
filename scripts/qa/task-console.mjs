/* node scripts/qa/task-console.mjs [--lang zh|en] [--theme dark|light] [--width 1280|420] [--out output/task-console] [--dist dist]
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
export async function startConsole({ distDir, lang = "zh", hold = true, streamStepMs = 60, transcribeMs = 250 } = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-console-")), root = join(base, "library");
  await seedLibrary(root, { sources: 12, decks: 3, cardsPerDeck: 8, runs: 1, attempts: 0, courses: 1, largeSources: 0 });
  await seedCoachDays(root);
  const inner = createFakeModel({ latencyMs: 20 });
  const gate = { held: hold, waiters: [] };
  const release = () => { gate.held = false; for (const open of gate.waiters.splice(0)) open(); };
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
    await holdHere(options.signal);
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
  return { base, server, api, lang, release, close, gate };
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
export async function openConsole(browser, running, { lang = "zh", theme = "dark", width = 1280, height = 900, nav = "tasks" } = {}) {
  const opened = await openPage(browser, running, { lang, theme, width, height });
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
  const running = await startConsole({ lang, ...(args.dist ? { distDir: resolve(repoRoot, args.dist) } : {}) });
  try {
    await startJobs(running);
    const nav = args.page === "audio" ? "audio" : args.page === "library" ? "library" : "tasks";
    const { page, errors, context } = await openConsole(browser, running, { lang, theme, width, height, nav });
    if (nav !== "tasks") {
      await frames(page, 6); await page.waitForTimeout(1500); await drainLayoutStability(page);
      const shot = join(out, `cards-${nav}-${lang}-${theme}-${width}.png`);
      await page.screenshot({ path: shot });
      console.log(JSON.stringify({ shot, errors, ...(await measureCards(page)) }));
      await context.close();
      return;
    }
    if (args.pick) await page.locator(".tc-row").nth(Number(args.pick)).dispatchEvent("click");
    // A task with nothing in flight (a day of 为你定制) shows no call: `--calls=0` does not wait for one.
    if (args.calls !== "0") await until(async () => (await page.locator(".tc-callrow").count()) > 0, "a call in flight");
    if (args.tab) await page.getByRole("tab", { name: new RegExp(args.tab) }).first().dispatchEvent("click");
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
