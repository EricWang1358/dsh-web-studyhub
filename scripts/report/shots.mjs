/* node scripts/report/shots.mjs <deck.html> --out <dir> [--theme light|dark|both]
   Opens a built deck in Chromium at 1280x720 and 390x800 and saves per slide: NN.png (the whole slide) and NN-view.png (what the first screen
   shows, the slide scrolled to its top). Fails (exit 1) when a page scrolls sideways, when text (captions and table cells included) sticks out of
   the screen outside a box that scrolls on its own or is squeezed into a sliver of a column, when the text of a diagram leaves its picture,
   when a diagram needs sideways scrolling at desktop width (on a phone that is only a warning), or when the keyboard and the wheel leave the
   slide counter wrong. Look at the images too: the checks cannot see an ugly slide. Not part of the fast test suite. */
/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChromium } from "../qa/browser.mjs";

const SIZES = [["desktop", 1280, 720], ["phone", 390, 800]];
const WARNING = "warning: ";

function parseArgs(argv) {
  const args = { deck: null, out: null, theme: "both" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--theme") args.theme = argv[++i];
    else if (!args.deck) args.deck = argv[i];
  }
  return args;
}

/** Runs in the page: problems found in the laid-out deck (lines that start with "warning: " are not failures). */
function probe(warning) {
  const problems = [];
  const page = document.documentElement;
  const view = page.clientWidth;
  if (page.scrollWidth > page.clientWidth + 1) problems.push(`the page scrolls sideways (${page.scrollWidth} > ${page.clientWidth})`);
  const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
  const say = (el) => `"${el.textContent.trim().slice(0, 30)}"`;
  for (const el of document.querySelectorAll(".dk-inner :is(h1,h2,h3,h4,p,li,td,th,caption,summary,figcaption,.dk-stat__num,.dk-stat__label,.dk-sub,.dk-meta)")) {
    if (view <= 640 && el.closest("thead")) continue; // a phone shows the table head only to screen readers
    const box = el.getBoundingClientRect();
    if (!box.width) continue; // not shown (the swipe hint is for phones only)
    // a sliver is wrong wherever it is, even inside a box that scrolls
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (el.textContent.trim().length > 8 && box.width < size * 3.5) problems.push(`${say(el)} is squeezed into a sliver of a column (${Math.round(box.width)}px wide)`);
    if (scrolls(el)) continue;
    if ((box.right > view + 1 || box.left < -1)) problems.push(`${say(el)} sticks out of the screen (${Math.round(box.left)}..${Math.round(box.right)} of ${view})`);
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") problems.push(`${say(el)} is cut off inside its box`);
  }
  for (const box of document.querySelectorAll(".rk-scroll")) {
    if (box.scrollWidth <= box.clientWidth + 1) continue;
    problems.push(`${view > 640 ? "" : warning}a diagram needs sideways scrolling (${box.scrollWidth} > ${box.clientWidth}px)${view > 640 ? " at this width" : ""}`);
  }
  for (const svg of document.querySelectorAll("svg.rk-seq")) {
    const [, , w, h] = svg.getAttribute("viewBox").split(" ").map(Number);
    for (const text of svg.querySelectorAll("text")) {
      const b = text.getBBox();
      if (b.x < -0.5 || b.y < -0.5 || b.x + b.width > w + 0.5 || b.y + b.height > h + 0.5) problems.push(`diagram text "${text.textContent.slice(0, 20)}" leaves the picture`);
    }
    // a step's text must stay between the lifelines it belongs to
    for (const step of svg.querySelectorAll(".rk-step")) {
      const t = step.querySelector(".rk-t"), line = step.querySelector(".rk-line");
      if (!t || !line) continue;
      const tb = t.getBBox(), lb = line.getBBox();
      if (!step.querySelector(".rk-head") || line.getAttribute("d").includes("V")) continue; // self loops put the text beside the loop
      if (tb.x < lb.x - 1 || tb.x + tb.width > lb.x + lb.width + 10) problems.push(`step text "${t.textContent.slice(0, 20)}" is wider than its arrow`);
    }
    // a group's label must stay inside its tab
    for (const tab of svg.querySelectorAll(".rk-tab-t")) {
      const frame = tab.parentElement.querySelector(".rk-tab").getBBox(), tb = tab.getBBox();
      if (tb.x + tb.width > frame.x + frame.width + 1 || tb.y + tb.height > frame.y + frame.height + 1) problems.push(`group label "${tab.textContent.slice(0, 20)}" runs past its tab`);
    }
  }
  return problems;
}

/** Slide screenshots plus the layout probe, at both sizes. Returns the problems (strings); warnings start with "warning: ". */
export async function takeShots({ deck, out, theme = "both" }) {
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const failures = [];
  try {
    for (const scheme of theme === "both" ? ["light", "dark"] : [theme]) {
      for (const [name, width, height] of SIZES) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce" });
        const page = await context.newPage();
        await page.goto(pathToFileURL(resolve(deck)).href);
        const slides = await page.locator(".dk-slide").count();
        for (let i = 0; i < slides; i++) {
          const slide = page.locator(".dk-slide").nth(i);
          const base = join(out, `${name}-${scheme}-${String(i + 1).padStart(2, "0")}`);
          // to the top of the slide (not centred under the bar), then wait until the counter has caught up
          await slide.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
          await page.waitForFunction((n) => document.getElementById("dk-count").textContent.startsWith(`${n} /`), i + 1);
          await page.waitForTimeout(120);
          await page.screenshot({ path: `${base}-view.png` });
          // the whole slide, without the bars that float over it
          await page.addStyleTag({ content: ".dk-bar,.dk-progress{visibility:hidden}" });
          await slide.screenshot({ path: `${base}.png` });
          await page.evaluate(() => { document.head.lastElementChild.remove(); });
        }
        for (const problem of await page.evaluate(probe, WARNING)) failures.push(`${name}/${scheme}: ${problem}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return failures;
}

/** The keyboard and the wheel against the counter, with and without smooth scrolling. Returns the problems. */
export async function checkNavigation({ deck }) {
  const browser = await launchChromium();
  const failures = [];
  try {
    for (const motion of ["reduce", "no-preference"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: motion });
      const page = await context.newPage();
      await page.goto(pathToFileURL(resolve(deck)).href);
      const count = await page.locator(".dk-slide").count();
      const counter = () => page.locator("#dk-count").textContent();
      const expect = async (label, n) => {
        try { await page.waitForFunction((text) => document.getElementById("dk-count").textContent === text, `${n} / ${count}`, { timeout: 8000 }); } catch { failures.push(`${motion}: ${label}: the counter reads "${await counter()}", expected "${n} / ${count}"`); }
      };
      const steps = Math.min(5, count - 1);
      for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowRight");
      await expect(`${steps} presses of →`, steps + 1);
      await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
      await expect("two presses of ←", Math.max(1, steps - 1));
      await page.keyboard.press("End"); await expect("End", count);
      await page.keyboard.press("Home"); await expect("Home", 1);
      // the wheel: the counter has to name the slide under the middle of the window, going down and coming back
      await page.mouse.move(640, 360);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(motion === "reduce" ? 250 : 700);
        const right = await page.evaluate(() => { const mid = window.pageYOffset + window.innerHeight / 2, all = [...document.querySelectorAll(".dk-slide")]; return all.findIndex((s) => { const t = s.getBoundingClientRect().top + window.pageYOffset; return t <= mid && mid < t + s.offsetHeight; }) + 1; });
        if ((await counter()) !== `${right} / ${count}`) failures.push(`${motion}: after wheel step ${i + 1} the counter reads "${await counter()}" but the middle of the window is in slide ${right}`);
      }
      for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -1500);
      await page.waitForTimeout(1200);
      await expect("scrolling back to the top", 1);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { deck, out, theme } = parseArgs(process.argv.slice(2));
  if (!deck || !out) { console.error("usage: node scripts/report/shots.mjs <deck.html> --out <dir> [--theme light|dark|both]"); process.exit(2); }
  const all = [...await takeShots({ deck, out, theme }), ...await checkNavigation({ deck })];
  const warnings = all.filter((line) => line.includes(WARNING)), failures = all.filter((line) => !line.includes(WARNING));
  for (const line of warnings) console.warn(`WARNING ${line.replace(WARNING, "")}`);
  for (const line of failures) console.error(`PROBLEM ${line}`);
  console.log(failures.length ? `${failures.length} problem(s); screenshots in ${out}` : `no problems found${warnings.length ? ` (${warnings.length} warning(s))` : ""}; screenshots in ${out}`);
  process.exit(failures.length ? 1 : 0);
}
